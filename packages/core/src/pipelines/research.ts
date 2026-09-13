/**
 * Deep research pipeline.
 *
 *   plan -> deep_research -> synthesize -> propose
 *
 * Long research is created as a background provider response and polled by the
 * worker. The response id is stored on the stage row, so a worker restart resumes
 * polling the same research instead of starting (and paying for) it again, and
 * nothing depends on a browser tab or a single HTTP request staying open.
 *
 * Research deepens specific questions using the material already collected: the
 * originating brief, the topic's research question, and whatever the knowledge
 * base already holds about the target. It ends in a proposal, never a write.
 */
import {
  CaptureProposal,
  DeepResearchResult,
  type FormatConfig,
  type ProposedChange,
} from '@g3/shared';
import { withService } from '../db.js';
import { badRequest } from '../errors.js';
import { getFormat } from '../formats-repo.js';
import { baseSystemPrompt } from '../prompt.js';
import { buildProposal } from '../proposals.js';
import { resolveEntity, type ResolvableType } from '../resolve.js';
import { recordStageProviderResponse, STAGE_PLANS } from '../runs.js';
import { accountUsage, addUsage, event, stage, type PipelineContext } from './context.js';

const STAGE_COUNT = STAGE_PLANS.research.length;

/** How long to wait between polls of a background research response. */
const POLL_INTERVAL_MS = 10_000;
/** Ceiling per worker visit. Exceeding it releases the job; the id is kept. */
const MAX_POLL_MS = 20 * 60 * 1000;

export interface ResearchTopicInput {
  id: string;
  label: string;
  targetType: string;
  researchQuestion: string | null;
  whyUseful: string | null;
  matchedEntityId: string | null;
  priority: string;
}

function toResolvable(value: string): ResolvableType {
  switch (value) {
    case 'person':
      return 'person';
    case 'company':
    case 'organization':
      return 'organization';
    case 'project':
      return 'project';
    case 'institution':
      return 'institution';
    case 'event':
      return 'event';
    default:
      return 'other';
  }
}

export interface ResearchPipelineResult {
  proposalId: string;
  topicCount: number;
  itemCount: number;
  findingCounts: { facts: number; inferences: number; recommendations: number; gaps: number; risks: number };
  depthStandardMet: boolean;
}

export async function runResearchPipeline(ctx: PipelineContext): Promise<ResearchPipelineResult> {
  const { run, workspaceId } = ctx;
  const input = run.input as {
    briefDocumentId?: string;
    topicIds?: string[];
  };
  if (!input.topicIds || input.topicIds.length === 0) {
    throw badRequest('A research run requires at least one selected topic');
  }

  // ------------------------------------------------------------------- plan
  const plan = await stage(ctx, 'plan', 1, STAGE_COUNT, async () => {
    return withService(async (db) => {
      const topics = await db.rows<{
        id: string;
        label: string;
        target_type: string;
        research_question: string | null;
        why_useful: string | null;
        matched_entity_id: string | null;
        priority: string;
      }>(
        `select id, label, target_type, research_question, why_useful, matched_entity_id, priority
           from public.research_topics
          where workspace_id = $1 and id = any($2::uuid[])
          order by case priority when 'high' then 0 when 'medium' then 1 else 2 end, label`,
        [workspaceId, input.topicIds],
      );
      if (topics.length === 0) throw badRequest('None of the selected topics exist in this workspace');

      await db.query(
        `update public.research_topics set status = 'researching', updated_at = now()
          where workspace_id = $1 and id = any($2::uuid[])`,
        [workspaceId, input.topicIds],
      );

      // Material already collected: the originating brief, and what the
      // knowledge base already holds about each target.
      const brief = input.briefDocumentId
        ? await db.one<{
            id: string;
            title: string;
            body_md: string;
            run_date: string;
            format_id: string;
            structured: Record<string, unknown>;
          }>(
            `select id, title, body_md, run_date, format_id, structured
               from public.brief_documents where workspace_id = $1 and id = $2`,
            [workspaceId, input.briefDocumentId],
          )
        : null;

      const known: { label: string; existing: string[] }[] = [];
      for (const topic of topics) {
        const facts = topic.matched_entity_id
          ? await db.rows<{ title: string; content: string; finding_type: string }>(
              `select title, content, finding_type from public.research_findings
                where workspace_id = $1 and related_entity_id = $2
                order by created_at desc limit 15`,
              [workspaceId, topic.matched_entity_id],
            )
          : [];
        known.push({
          label: topic.label,
          existing: facts.map((f) => `[${f.finding_type}] ${f.title}: ${f.content}`),
        });
      }

      return {
        topics: topics.map((t) => ({
          id: t.id,
          label: t.label,
          targetType: t.target_type,
          researchQuestion: t.research_question,
          whyUseful: t.why_useful,
          matchedEntityId: t.matched_entity_id,
          priority: t.priority,
        })),
        brief: brief
          ? { id: brief.id, title: brief.title, runDate: brief.run_date, bodyMd: brief.body_md, formatId: brief.format_id }
          : null,
        known,
      };
    });
  });

  const topics = plan.value.topics as ResearchTopicInput[];
  const brief = plan.value.brief;
  const known = plan.value.known as { label: string; existing: string[] }[];

  const format = brief
    ? await withService((db) => getFormat(db, workspaceId, brief.formatId))
    : null;
  const config = format ? (format.config as FormatConfig) : null;

  // ---------------------------------------------------------- deep research
  const deep = await stage(ctx, 'deep_research', 2, STAGE_COUNT, async (handle) => {
    const results: { topicId: string; label: string; text: string; sources: { url: string; title: string | null }[] }[] = [];

    for (const topic of topics) {
      await ctx.keepAlive();
      const priorKnowledge = known.find((k) => k.label === topic.label)?.existing ?? [];

      const system = baseSystemPrompt(
        [
          '',
          'You are running deep research on one specific target, deepening a concrete',
          'question rather than restating an article. Use the material already collected,',
          'then go further with primary sources.',
          '',
          'Meet this depth standard, or say plainly that you could not:',
          '- use primary sources first, then reputable secondary sources for context;',
          '- check at least two independent sources unless the item is explicitly single-source;',
          '- identify the owner or controller, the current status, the geography, the business',
          '  model or rights mechanics, the timing, and any relationship or access path;',
          '- compare your findings against the original claim and state whether it is',
          '  confirmed, partially confirmed or not confirmed;',
          '- state why it matters, which decision it supports, and what would make it actionable;',
          '- state your confidence and every unresolved gap.',
          '',
          'For a named person: give their current role, organisation and geography, and',
          'separate public professional relevance from any actual relationship. Evidence of',
          'a relationship, meeting or planned outreach must be stated only if it genuinely',
          'exists in the material.',
        ].join('\n'),
      );

      const promptInput = [
        `[TOPIC] = ${topic.label}`,
        `[TARGET_TYPE] = ${topic.targetType}`,
        `[PRIORITY] = ${topic.priority}`,
        `[RESEARCH_QUESTION] = ${topic.researchQuestion ?? 'Not specified; determine the most decision-relevant question.'}`,
        `[WHY_USEFUL] = ${topic.whyUseful ?? 'Not specified.'}`,
        '',
        '## Material already collected',
        '',
        brief
          ? `### Originating brief: ${brief.title} (${brief.runDate})\n\n${brief.bodyMd}`
          : '_No originating brief; this topic was raised directly._',
        '',
        '### What the knowledge base already holds about this target',
        priorKnowledge.length > 0
          ? priorKnowledge.map((k) => `- ${k}`).join('\n')
          : '_Nothing stored yet._',
        '',
        config
          ? [
              '### Format research standard',
              ...config.searchSequence.map((s, i) => `${i + 1}. ${s}`),
              '',
              '### Source tiers',
              ...config.sourceTiers.map((t) => `- ${t.tier} (${t.label}): ${t.detail}`),
            ].join('\n')
          : '',
        '',
        'Write a research report in Markdown. Separate facts, inferences,',
        'recommendations, risks and gaps under clear headings, and cite a real URL for',
        'every factual claim.',
      ].join('\n');

      // Resume an in-flight background response if one was already created.
      const existingResponseId = handle.record.provider_response_id;
      let responseId: string;
      if (existingResponseId && existingResponseId.startsWith(`${topic.id}:`)) {
        responseId = existingResponseId.slice(topic.id.length + 1);
        await event(
          ctx,
          'info',
          `Resuming background research ${responseId} for "${topic.label}" instead of starting it again.`,
          'deep_research',
        );
      } else {
        const startedHandle = await ctx.provider.startBackgroundResearch({
          model: run.model ?? 'o3-deep-research',
          system,
          input: promptInput,
          label: `research:${topic.id}`,
          tools: ['web_search'],
        });
        responseId = startedHandle.responseId;
        // Persist immediately, before any polling, so a crash right here still
        // leaves a resumable id behind.
        await withService((db) =>
          recordStageProviderResponse(
            db,
            workspaceId,
            run.id,
            'deep_research',
            `${topic.id}:${responseId}`,
            startedHandle.status,
          ),
        );
        await event(
          ctx,
          'info',
          `Started background research ${responseId} for "${topic.label}".`,
          'deep_research',
        );
      }

      // Poll. The lease is extended on every pass so the job is not redelivered
      // while research is genuinely still running.
      const deadline = Date.now() + MAX_POLL_MS;
      let poll = await ctx.provider.pollBackgroundResearch(responseId);
      while (poll.status === 'queued' || poll.status === 'in_progress') {
        if (Date.now() > deadline) {
          throw new Error(
            `Background research ${responseId} for "${topic.label}" is still running after ${Math.round(MAX_POLL_MS / 60000)} minutes. The response id is stored, so the next attempt resumes polling rather than restarting it.`,
          );
        }
        await ctx.keepAlive();
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        poll = await ctx.provider.pollBackgroundResearch(responseId);
      }

      if (poll.status !== 'completed' || !poll.text) {
        throw new Error(
          `Background research for "${topic.label}" ended as ${poll.status}: ${poll.error ?? 'no output returned'}`,
        );
      }

      if (poll.usage) {
        const cost = await accountUsage(
          ctx,
          handle.record.id,
          'deep_research',
          `deep_research:${topic.label}`,
          poll.usage,
        );
        addUsage(handle, poll.usage, cost);
      }

      results.push({ topicId: topic.id, label: topic.label, text: poll.text, sources: poll.sources });
      await withService((db) =>
        recordStageProviderResponse(db, workspaceId, run.id, 'deep_research', '', 'completed'),
      );
    }

    return { results };
  });

  // ------------------------------------------------------------- synthesize
  const synthesis = await stage(ctx, 'synthesize', 3, STAGE_COUNT, async (handle) => {
    const structured: (typeof DeepResearchResult)['_output'][] = [];
    for (const result of deep.value.results) {
      await ctx.keepAlive();
      const parsed = await ctx.provider.generateStructured({
        model: run.model ?? 'gpt-5.5',
        schema: DeepResearchResult,
        schemaName: 'deep_research_result',
        label: `research.synthesize:${result.topicId}`,
        reasoningEffort: 'medium',
        system: baseSystemPrompt(
          [
            '',
            'Turn the research report into structured findings without adding anything.',
            'Every fact must trace to a URL that appears in the report. Move anything not',
            'directly supported into inferences, and anything unknown into gaps.',
            'Do not upgrade a confidence level or invent an as-of date.',
          ].join('\n'),
        ),
        input: [
          `[TOPIC] = ${result.label}`,
          '',
          '## Research report',
          result.text,
          '',
          '## Sources the provider reported',
          ...result.sources.map((s) => `- ${s.url}${s.title ? ` (${s.title})` : ''}`),
        ].join('\n'),
      });
      const cost = await accountUsage(
        ctx,
        handle.record.id,
        'synthesize',
        `synthesize:${result.label}`,
        parsed.usage,
      );
      addUsage(handle, parsed.usage, cost);
      structured.push(parsed.value);
    }
    return { structured, reports: deep.value.results };
  });

  // ----------------------------------------------------------------- propose
  const proposal = await stage(ctx, 'propose', 4, STAGE_COUNT, async (handle) => {
    await ctx.keepAlive();

    // Give the model the resolution status of every named entity, so it can
    // propose a staged mention rather than a new record where the match is
    // uncertain.
    const resolutionNotes: string[] = [];
    await withService(async (db) => {
      const seen = new Set<string>();
      for (const result of synthesis.value.structured) {
        for (const entity of result.entities) {
          const type = toResolvable(entity.entity_type);
          if (type === 'other') continue;
          const key = `${type}:${entity.name.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const resolution = await resolveEntity(db, workspaceId, { name: entity.name, entityType: type });
          resolutionNotes.push(
            `- "${entity.name}" (${type}): ${resolution.status.toUpperCase()}. ${resolution.rationale}`,
          );
        }
      }
    });

    const captureResult = await ctx.provider.generateStructured({
      model: run.model ?? 'gpt-5.5',
      schema: CaptureProposal,
      schemaName: 'capture_proposal',
      label: `research.propose:${run.id}`,
      reasoningEffort: 'medium',
      system: baseSystemPrompt(
        [
          '',
          'Propose database changes from the research. You are proposing only; a person',
          'reviews and approves each item before anything is written.',
          '',
          'Storage rules:',
          '- evidence for each underlying source;',
          '- entities for people, organisations, projects, institutions and events that are',
          '  relevant, with research_status research_only and relationship_status none when',
          '  no relationship exists;',
          '- entity_affiliations for a source-backed person-to-organisation role;',
          '- research_findings for facts, inferences, recommendations, risks and gaps, with',
          '  finding_type set correctly;',
          '- signals for why something entered the system, with why_it_matters and a',
          '  decision_question;',
          '- signal_entities to link a signal to every relevant entity;',
          '- interactions ONLY for something that actually happened;',
          '- actions ONLY for a real intended next step;',
          '- opportunities only when there is a genuine commercial opening beyond a watch.',
          '',
          'Hard rules:',
          '- Where the resolution status below says AMBIGUOUS, propose an entity_mentions',
          '  row, not a new entity and not a merge. A similar name is not evidence of the',
          '  same record.',
          '- Never propose a contact or relationship record just because a person appeared',
          '  in research. A person may be stored before any contact exists.',
          '- Reference other records you propose by their exact label in depends_on_labels',
          '  and in the *_label fields. Never invent an id.',
          '- Use *_label fields for references: related_entity_label, person_entity_label,',
          '  organization_entity_label, evidence_label, signal_label, business_unit_label.',
        ].join('\n'),
      ),
      input: [
        '## Entity resolution already performed by the server',
        resolutionNotes.length > 0 ? resolutionNotes.join('\n') : '_No named entities found._',
        '',
        '## Structured research findings',
        '```json',
        JSON.stringify(synthesis.value.structured, null, 2),
        '```',
        '',
        brief ? `## Originating brief\n\n${brief.title} (${brief.runDate})` : '',
      ].join('\n'),
    });

    const cost = await accountUsage(
      ctx,
      handle.record.id,
      'propose',
      'capture_proposal',
      captureResult.usage,
    );
    addUsage(handle, captureResult.usage, cost);

    const built = await withService((db) =>
      buildProposal(db, {
        workspaceId,
        runId: run.id,
        sourceKind: 'research',
        briefDocumentId: brief?.id ?? null,
        proposal: captureResult.value as (typeof CaptureProposal)['_output'],
        createdBy: run.created_by ?? '',
        isMock: ctx.provider.isMock,
        provenance: {
          run_id: run.id,
          brief_document_id: brief?.id ?? null,
          brief_run_date: brief?.runDate ?? null,
          topics: topics.map((t) => ({ id: t.id, label: t.label })),
          depth_standard_met: synthesis.value.structured.every((s) => s.depth_standard_met),
        },
      }),
    );

    await withService(async (db) => {
      await db.query(
        `update public.research_topics set status = 'researched', updated_at = now()
          where workspace_id = $1 and id = any($2::uuid[])`,
        [workspaceId, input.topicIds],
      );
      // Persist the research artifact and its findings as proposal-backed only;
      // nothing is written into the knowledge tables here.
      await db.query(
        `insert into public.run_events (workspace_id, run_id, level, stage, message, data)
         values ($1,$2,'info','propose',$3,$4::jsonb)`,
        [
          workspaceId,
          run.id,
          `Built proposal with ${built.items.length} item(s) awaiting review.`,
          JSON.stringify({
            proposalId: built.proposalId,
            ambiguous: built.items.filter((i) => i.matchStatus === 'ambiguous').length,
            existing: built.items.filter((i) => i.matchStatus === 'existing').length,
            new: built.items.filter((i) => i.matchStatus === 'new').length,
          }),
        ],
      );
    });

    return { proposalId: built.proposalId, itemCount: built.items.length };
  });

  const counts = synthesis.value.structured.reduce(
    (acc, s) => ({
      facts: acc.facts + s.facts.length,
      inferences: acc.inferences + s.inferences.length,
      recommendations: acc.recommendations + s.recommendations.length,
      gaps: acc.gaps + s.gaps.length,
      risks: acc.risks + s.risks.length,
    }),
    { facts: 0, inferences: 0, recommendations: 0, gaps: 0, risks: 0 },
  );

  return {
    proposalId: proposal.value.proposalId,
    topicCount: topics.length,
    itemCount: proposal.value.itemCount,
    findingCounts: counts,
    depthStandardMet: synthesis.value.structured.every((s) => s.depth_standard_met),
  };
}

/** Re-export so the worker can type a proposal-shaped payload. */
export type { ProposedChange };
