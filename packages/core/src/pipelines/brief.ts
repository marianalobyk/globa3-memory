/**
 * Brief generation pipeline.
 *
 *   preflight -> research -> draft -> qa -> extract -> persist
 *
 * The format's own rules drive every stage: its research lanes and source
 * families shape the search, its scoring rubric and thresholds shape elevation,
 * its reader structure shapes the draft, and its QA checklist is the release
 * gate. Dates and windows are computed by code and injected; the model is
 * instructed never to compute one.
 *
 * What is persisted: the prompt version used, the sources with their tier and
 * verification state, the structured findings, the QA check results and the
 * proposed research topics with their entity-resolution status. Model reasoning
 * is not persisted.
 *
 * The QA status stored on a brief is the format's release gate. It is explicitly
 * NOT user approval of any database record; those live on proposals.
 */
import {
  BriefDraft,
  BriefExtraction,
  QaVerdict,
  ResearchLedger,
  slugify,
  type FormatConfig,
  type RunWindows,
  type SourceRef,
} from '@g3/shared';
import { withService } from '../db.js';
import { badRequest } from '../errors.js';
import { getActivePromptVersion, getFormat } from '../formats-repo.js';
import { mergeQaVerdict, runAutomatedQa } from '../qa.js';
import {
  baseSystemPrompt,
  buildRunVariables,
  loadRunContext,
  renderPrompt,
  type RunContext,
} from '../prompt.js';
import { resolveBusinessUnit, resolveEntity, type ResolvableType } from '../resolve.js';
import { formatRunId, STAGE_PLANS } from '../runs.js';
import { accountUsage, addUsage, event, stage, type PipelineContext } from './context.js';

const STAGES = STAGE_PLANS.brief;
const STAGE_COUNT = STAGES.length;

interface PreflightOutput {
  formatKey: string;
  formatName: string;
  promptVersionId: string;
  promptVersion: number;
  runId: string;
  variables: Record<string, string>;
  windows: RunWindows;
  missing: string[];
  contextSummary: Record<string, number>;
  renderedPrompt: string;
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

export interface BriefPipelineResult {
  briefDocumentId: string;
  qaStatus: string;
  sourceCount: number;
  topicCount: number;
  outputMode: string;
}

export async function runBriefPipeline(ctx: PipelineContext): Promise<BriefPipelineResult> {
  const { run, workspaceId } = ctx;
  if (!run.format_id) throw badRequest('A brief run requires a format');
  const runDate = run.run_date;
  if (!runDate) throw badRequest('A brief run requires a run date');

  // ---------------------------------------------------------------- preflight
  const preflight = await stage<PreflightOutput>(ctx, 'preflight', 1, STAGE_COUNT, async () => {
    return withService(async (db) => {
      const format = await getFormat(db, workspaceId, run.format_id as string);
      const promptVersion = await getActivePromptVersion(db, workspaceId, format.id);
      const config = format.config as FormatConfig;

      const context: RunContext = await loadRunContext(db, workspaceId, format.id);
      const runIdLabel = formatRunId(format.key, runDate, run.attempt || 1);
      const built = buildRunVariables(
        config,
        runDate,
        runIdLabel,
        context,
        `outputs/${runDate}/`,
        'production',
      );

      const rendered = renderPrompt(promptVersion.body, built.variables, promptVersion.attachments);

      return {
        formatKey: format.key,
        formatName: format.name,
        promptVersionId: promptVersion.id,
        promptVersion: promptVersion.version,
        runId: runIdLabel,
        variables: built.variables,
        windows: built.windows,
        missing: built.missing,
        contextSummary: {
          priorities: context.priorities.length,
          targets: context.targets.length,
          projects: context.projects.length,
          watchlist: context.watchlist.length,
          openWatchItems: context.openWatchItems.length,
          openActions: context.openActions.length,
          previousAcceptedSignals: context.previousAcceptedSignals.length,
          previousRejectedFingerprints: context.previousRejectedFingerprints.length,
        },
        renderedPrompt: rendered,
      };
    });
  });

  const pre = preflight.value;

  // The metadata gate is a hard stop: no research runs on invalid metadata.
  if (pre.missing.length > 0) {
    throw badRequest(
      `Metadata gate failed before research: missing ${pre.missing.join(', ')}. ` +
        `Per the format rules this is a FAIL - DO NOT DISTRIBUTE condition, so no research was performed.`,
      { missing: pre.missing },
    );
  }

  const format = await withService((db) => getFormat(db, workspaceId, run.format_id as string));
  const config = format.config as FormatConfig;
  const researchModel = run.model ?? format.research_model ?? undefined;
  const draftModel = run.model ?? format.default_model ?? undefined;

  await event(
    ctx,
    'info',
    `Coverage ${pre.windows.coverageStartIso} to ${pre.windows.coverageEndIso} (${pre.windows.timeZone}); prompt version ${pre.promptVersion}.`,
    'preflight',
    { windows: pre.windows, contextSummary: pre.contextSummary },
  );

  // ----------------------------------------------------------------- research
  const research = await stage(ctx, 'research', 2, STAGE_COUNT, async (handle) => {
    await ctx.keepAlive();
    const result = await ctx.provider.generateStructured({
      model: researchModel ?? 'gpt-5.5',
      schema: ResearchLedger,
      schemaName: 'research_ledger',
      label: `brief.research:${pre.formatKey}:${runDate}`,
      tools: ['web_search'],
      reasoningEffort: 'high',
      system: baseSystemPrompt(
        [
          '',
          'You are running the research stage only. Do not write the reader-facing brief yet.',
          'Complete a real scan of every mandatory research lane, then build an internal',
          'candidate ledger. Record each lane outcome honestly, including lanes that found',
          'nothing. If a lane could not be scanned, say so and set research_status to partial.',
          '',
          'Score candidates with the rubric supplied below and assign the tier the',
          'thresholds dictate. Extract every named person, organisation, project,',
          'institution and event as an explicit entity: a named person must never be',
          'dropped just because they are not the headline subject.',
        ].join('\n'),
      ),
      input: [
        pre.renderedPrompt,
        '',
        '---',
        '',
        '## Stage instruction',
        '',
        'Return the internal research ledger for this run as structured data.',
        '',
        '### Mandatory research lanes',
        ...config.researchLanes.map((lane) => `- ${lane.key}. ${lane.label}: ${lane.detail}`),
        '',
        '### Required source families',
        ...config.sourceFamilies.map((f) => `- ${f}`),
        '',
        '### Source tiers',
        ...config.sourceTiers.map((t) => `- ${t.tier} (${t.label}): ${t.detail}`),
        '',
        '### Source rules',
        ...config.sourceRules.map((r) => `- ${r}`),
        '',
        '### Search sequence',
        ...config.searchSequence.map((s, i) => `${i + 1}. ${s}`),
        '',
        '### Freshness labels (use exactly one per candidate)',
        ...config.freshnessLabels.map(
          (f) => `- ${f.key}: ${f.label}${f.elevatable ? '' : ' (may NOT be elevated)'}`,
        ),
        '',
        '### Allowed classifications',
        config.classifications.join('; '),
        '',
        '### Scoring rubric (internal only, never shown to the reader)',
        ...config.scoring.dimensions.map(
          (d) =>
            `- ${d.key} (${d.label}), 0-${d.max}${d.anchors ? `: ${Object.entries(d.anchors).map(([k, v]) => `${k}=${v}`).join('; ')}` : ''}`,
        ),
        `Maximum total: ${config.scoring.maxScore}.`,
        '',
        '### Thresholds',
        ...config.thresholds.map(
          (t) =>
            `- ${t.tier}: ${t.minScore}-${t.maxScore}${t.requires ? ` (requires ${t.requires.join(', ')})` : ''}`,
        ),
        '',
        '### External-use statuses',
        ...config.externalUseStatuses.map((s) => `- ${s.key}: ${s.detail}`),
      ].join('\n'),
    });

    const cost = await accountUsage(ctx, handle.record.id, 'research', 'research_ledger', result.usage);
    addUsage(handle, result.usage, cost);
    await event(
      ctx,
      'info',
      `Research produced ${result.value.candidates.length} candidate(s) across ${result.value.lane_outcomes.length} lane(s); ${result.usage.webSearches} web search call(s).`,
      'research',
      { researchStatus: result.value.research_status, limitations: result.value.limitations },
    );
    return { ledger: result.value, providerSources: result.sources };
  });

  const ledger = research.value.ledger;

  // -------------------------------------------------------------------- draft
  const draft = await stage(ctx, 'draft', 3, STAGE_COUNT, async (handle) => {
    await ctx.keepAlive();
    const result = await ctx.provider.generateStructured({
      model: draftModel ?? 'gpt-5.5',
      schema: BriefDraft,
      schemaName: 'brief_draft',
      label: `brief.draft:${pre.formatKey}:${runDate}`,
      reasoningEffort: 'medium',
      system: baseSystemPrompt(
        [
          '',
          'You are writing the reader-facing brief from the ledger supplied to you.',
          'Use only candidates from that ledger. Do not introduce new claims, sources or',
          'entities, and do not perform new research.',
          '',
          'Follow the required section structure exactly, keeping every required section',
          'even when a section has to say that nothing qualified. Never print internal',
          'numerical scores. Keep the tone direct and non-promotional.',
        ].join('\n'),
      ),
      input: [
        pre.renderedPrompt,
        '',
        '---',
        '',
        '## Stage instruction',
        '',
        'Write the reader-facing brief in Markdown.',
        '',
        '### Required sections, in order',
        ...config.readerSections.map((s) => `- ${s.heading}${s.required ? ' (required)' : ''}`),
        '',
        '### Output modes',
        ...config.outputModes.map((m) => `- ${m.key} (${m.label}): ${m.when}`),
        '',
        '### Must not appear in the output',
        ...config.cleanOutputExclusions.map((x) => `- ${x}`),
        '',
        '### Internal candidate ledger',
        '```json',
        JSON.stringify(ledger, null, 2),
        '```',
      ].join('\n'),
    });

    const cost = await accountUsage(ctx, handle.record.id, 'draft', 'brief_draft', result.usage);
    addUsage(handle, result.usage, cost);
    return result.value;
  });

  // Collect the source list from the ledger, deduplicated by URL.
  const sourceMap = new Map<string, SourceRef>();
  for (const candidate of ledger.candidates) {
    for (const source of candidate.sources) {
      if (!sourceMap.has(source.url)) sourceMap.set(source.url, source);
    }
  }
  const sources = [...sourceMap.values()];

  // ----------------------------------------------------------------------- qa
  const qa = await stage(ctx, 'qa', 4, STAGE_COUNT, async (handle) => {
    await ctx.keepAlive();

    // Code decides every check the format marks automated.
    const automated = runAutomatedQa({
      format: config,
      windows: pre.windows,
      variables: pre.variables,
      missingVariables: pre.missing,
      bodyMd: draft.value.body_md,
      sources,
      outputMode: draft.value.output_mode,
    });

    const judgementChecks = config.qaChecks.filter((c) => !c.automated);
    const modelResult = await ctx.provider.generateStructured({
      model: draftModel ?? 'gpt-5.5',
      schema: QaVerdict,
      schemaName: 'qa_verdict',
      label: `brief.qa:${pre.formatKey}:${runDate}`,
      reasoningEffort: 'medium',
      system: baseSystemPrompt(
        [
          '',
          'You are running a hostile review of the draft against the checklist below.',
          'Be adversarial: your job is to find what is wrong, not to approve the draft.',
          'Judge only the checks listed; the deterministic checks have already been',
          'decided in code and are supplied for context.',
        ].join('\n'),
      ),
      input: [
        '## Checks to judge',
        ...judgementChecks.map((c) => `- ${c.key} (${c.severity}): ${c.assertion}`),
        '',
        '## Release statuses',
        ...config.releaseStatuses.map((s) => `- ${s.key} (${s.label}): ${s.detail}`),
        '',
        '## Checks already decided in code',
        ...automated.map((c) => `- ${c.key}: ${c.passed ? 'PASS' : 'FAIL'} - ${c.note}`),
        '',
        '## Draft under review',
        draft.value.body_md,
        '',
        '## Internal ledger the draft was built from',
        '```json',
        JSON.stringify(ledger, null, 2),
        '```',
      ].join('\n'),
    });

    const cost = await accountUsage(ctx, handle.record.id, 'qa', 'qa_verdict', modelResult.usage);
    addUsage(handle, modelResult.usage, cost);

    const merged = mergeQaVerdict(automated, modelResult.value, config);
    await event(
      ctx,
      merged.release_status.startsWith('pass') ? 'info' : 'warn',
      `QA verdict: ${merged.release_status}. ${merged.summary}`,
      'qa',
      { failed: merged.checks.filter((c) => !c.passed).map((c) => c.key) },
    );
    return merged;
  });

  // ------------------------------------------------------------------ extract
  const extract = await stage(ctx, 'extract', 5, STAGE_COUNT, async (handle) => {
    await ctx.keepAlive();
    const result = await ctx.provider.generateStructured({
      model: draftModel ?? 'gpt-5.5',
      schema: BriefExtraction,
      schemaName: 'brief_extraction',
      label: `brief.extract:${pre.formatKey}:${runDate}`,
      reasoningEffort: 'medium',
      system: baseSystemPrompt(
        [
          '',
          'Extract structured knowledge from the brief and its ledger.',
          '',
          'Keep facts, inferences and recommendations strictly separate, and state gaps',
          'explicitly. Every named person, organisation, project, institution and event',
          'must appear in `entities`, including ones that only appear in passing: an',
          'unresolved or minor mention must never be silently dropped.',
          '',
          'Propose a small research queue -- prefer 3 to 7 useful targets over exhaustive',
          'extraction -- and say for each why it is worth researching.',
        ].join('\n'),
      ),
      input: [
        `Format: ${pre.formatName}`,
        `Entity types that are explicit research targets: ${config.entityTargetTypes.join(', ')}`,
        '',
        '## Brief',
        draft.value.body_md,
        '',
        '## Ledger',
        '```json',
        JSON.stringify(ledger, null, 2),
        '```',
      ].join('\n'),
    });

    const cost = await accountUsage(ctx, handle.record.id, 'extract', 'brief_extraction', result.usage);
    addUsage(handle, result.usage, cost);
    return result.value;
  });

  // ------------------------------------------------------------------ persist
  const persisted = await stage(ctx, 'persist', 6, STAGE_COUNT, async () => {
    return withService(async (db) => {
      const briefDoc = await db.oneOrFail<{ id: string }>(
        `insert into public.brief_documents
           (workspace_id, run_id, format_id, prompt_version_id, title, run_date,
            coverage_start, coverage_end, body_md, output_mode, qa_status, qa_checks,
            qa_notes, structured, gaps, origin, is_mock, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15::jsonb,'generated',$16,$17)
         returning id`,
        [
          workspaceId,
          run.id,
          format.id,
          pre.promptVersionId,
          draft.value.title,
          runDate,
          pre.windows.coverageStartIso,
          pre.windows.coverageEndIso,
          draft.value.body_md,
          draft.value.output_mode,
          qa.value.release_status,
          JSON.stringify(qa.value.checks),
          qa.value.summary,
          JSON.stringify({
            candidates: ledger.candidates.map((c) => ({
              fingerprint: c.fingerprint,
              headline: c.headline,
              tier: c.tier,
              classification: c.classification,
              freshness_label: c.freshness_label,
              confidence: c.confidence,
              external_use_status: c.external_use_status,
              recommended_action: c.recommended_action,
              total_score: c.total_score,
              scores: c.scores,
            })),
            lane_outcomes: ledger.lane_outcomes,
            research_status: ledger.research_status,
            limitations: ledger.limitations,
            findings: extract.value.findings,
            entities: extract.value.entities,
            windows: pre.windows,
            variables: pre.variables,
            prompt_version: pre.promptVersion,
            run_id_label: pre.runId,
          }),
          JSON.stringify(extract.value.gaps),
          ctx.provider.isMock,
          run.created_by,
        ],
      );

      // Sources, with URL validity decided here rather than trusted.
      for (const source of sources) {
        let verification: string = 'unverified';
        try {
          const parsed = new URL(source.url);
          verification = parsed.protocol === 'https:' || parsed.protocol === 'http:' ? 'url_valid' : 'url_invalid';
        } catch {
          verification = 'url_invalid';
        }
        await db.query(
          `insert into public.brief_sources
             (workspace_id, brief_document_id, url, title, publisher, source_tier,
              published_at, freshness_label, is_press_release, verification_state, verification_note)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            workspaceId,
            briefDoc.id,
            source.url,
            source.title,
            source.publisher,
            source.source_tier,
            source.published_date,
            null,
            source.is_press_release,
            verification,
            source.verification_note,
          ],
        );
      }

      // Research topics, each resolved against the workspace so the user sees
      // whether a target already exists, is ambiguous, or is genuinely new.
      let topicCount = 0;
      for (const topic of extract.value.proposed_topics) {
        const resolvableType = toResolvable(topic.target_type);
        const resolution =
          resolvableType === 'other'
            ? null
            : await resolveEntity(db, workspaceId, { name: topic.label, entityType: resolvableType });
        const unit = await resolveBusinessUnit(db, workspaceId, topic.business_unit_hint);

        await db.query(
          `insert into public.research_topics
             (workspace_id, brief_document_id, run_id, label, target_type, resolution_status,
              matched_entity_id, candidate_matches, priority, business_unit_id,
              research_question, why_useful, status)
           values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,'proposed')`,
          [
            workspaceId,
            briefDoc.id,
            run.id,
            topic.label,
            topic.target_type,
            resolution
              ? resolution.status === 'existing'
                ? 'existing'
                : resolution.status === 'ambiguous'
                  ? 'ambiguous'
                  : 'not_found'
              : 'not_found',
            resolution?.status === 'existing' ? resolution.best?.id ?? null : null,
            JSON.stringify(resolution ? { rationale: resolution.rationale, candidates: resolution.candidates } : {}),
            topic.priority,
            unit?.id ?? null,
            topic.research_question,
            topic.why_useful,
          ],
        );
        topicCount += 1;
      }

      // Unresolved entity mentions are staged so they are visible rather than
      // lost. Nothing here creates an entity; that needs approval.
      //
      // One pending row per name: if the same unresolved name appears again in a
      // later brief, the existing row is touched rather than duplicated, so the
      // staging area stays a list of open questions instead of a run log.
      for (const entity of extract.value.entities) {
        const resolvableType = toResolvable(entity.entity_type);
        if (resolvableType === 'other') continue;
        const resolution = await resolveEntity(db, workspaceId, {
          name: entity.name,
          entityType: resolvableType,
        });
        if (resolution.status === 'existing') continue;

        const mentionSlug = slugify(entity.name);
        const existing = await db.one<{ id: string }>(
          `select id from public.entity_mentions
            where workspace_id = $1 and mention_slug = $2 and resolution_status = 'pending'
            limit 1`,
          [workspaceId, mentionSlug],
        );

        if (existing) {
          await db.query(
            `update public.entity_mentions
                set candidate_entity_id = coalesce($3, candidate_entity_id),
                    rationale = $4,
                    provenance_note = left(
                      coalesce(provenance_note || ' | ', '') || $5, 2000),
                    updated_at = now()
              where workspace_id = $1 and id = $2`,
            [
              workspaceId,
              existing.id,
              resolution.best?.id ?? null,
              resolution.rationale,
              `Seen again in ${pre.formatName} for ${runDate}.`,
            ],
          );
          continue;
        }

        await db.query(
          `insert into public.entity_mentions
             (workspace_id, mention_text, mention_slug, proposed_entity_type, proposed_display_name,
              candidate_entity_id, resolution_status, confidence, rationale, created_from,
              provenance_note)
           values ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10)`,
          [
            workspaceId,
            entity.name,
            mentionSlug,
            resolvableType,
            entity.name,
            resolution.best?.id ?? null,
            resolution.status === 'ambiguous' ? 'low' : 'medium',
            resolution.rationale,
            `brief:${pre.formatKey}:${runDate}`,
            `Named in ${pre.formatName} for ${runDate}. ${entity.why_relevant}`,
          ],
        );
      }

      return {
        briefDocumentId: briefDoc.id,
        sourceCount: sources.length,
        topicCount,
      };
    });
  });

  return {
    briefDocumentId: persisted.value.briefDocumentId,
    qaStatus: qa.value.release_status,
    sourceCount: persisted.value.sourceCount,
    topicCount: persisted.value.topicCount,
    outputMode: draft.value.output_mode,
  };
}
