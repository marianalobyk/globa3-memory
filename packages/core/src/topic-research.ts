/**
 * Topic and gap research: the gate between "this question is worth asking" and
 * "go and ask it on the open web".
 *
 * A capture review can offer research questions -- a gap the material leaves,
 * an ownership question, a rights question, an unconfirmed commercial claim.
 * Offering one costs nothing and reaches nothing. Three separate, explicit acts
 * stand between the offer and a search:
 *
 *   1. The question is proposed as a `research_topics` item, unselected. A
 *      capture approval that does not include it writes nothing at all.
 *   2. The person selects it. That creates the `research_topics` row and still
 *      starts nothing: the row is a request, not a search.
 *   3. The person confirms, here, acknowledging cost and that external sources
 *      will be consulted. Only then is a run created.
 *
 * This module owns step 3, and it refuses everything else. It mirrors
 * `contact-research.ts`, which guards identity research the same way, because
 * the two flows must behave identically from the person's side: nothing
 * reaches the network without a confirmation that names what will be asked.
 *
 * Identity research is NOT handled here. It carries extra protections (the
 * clue preflight, redaction, the search-input guard) and keeps them.
 */
import { badRequest, conflict, notFound } from './errors.js';
import { createRun } from './runs.js';
import { withService } from './db.js';
import { logActivity } from './activity.js';
import { hasOpenAi } from './env.js';
import type { Queryable } from './db.js';
import type { Session } from '@g3/shared';

/** Shown verbatim before research runs. The person sees this, not a paraphrase. */
export const TOPIC_RESEARCH_DISCLOSURE =
  'Research looks for answers in public sources on the open web. It uses these questions together with a short, relevant excerpt and the related proposed items from this capture. Anything found comes back for you to review before it is saved.';

export interface ResearchQuestion {
  /** The proposal item id. Stable, and what the UI selects. */
  id: string;
  label: string;
  question: string;
  whyItMatters: string | null;
  priority: 'high' | 'medium' | 'low' | 'skip';
  targetType: string;
  /** The canonical entity this is about, when memory already holds one. */
  matchedEntityId: string | null;
  subject: string | null;
  status: string;
  selected: boolean;
}

/**
 * The research questions this proposal created, i.e. the ones the person
 * selected. A question that was never selected has no row here, which is the
 * property the "inert until chosen" tests rest on.
 */
export async function listResearchQuestions(
  db: Queryable,
  workspaceId: string,
  proposalId: string,
): Promise<ResearchQuestion[]> {
  return db.rows<ResearchQuestion>(
    `select t.id,
            t.label,
            coalesce(t.research_question, t.label) as "question",
            t.why_useful as "whyItMatters",
            t.priority,
            t.target_type as "targetType",
            t.matched_entity_id::text as "matchedEntityId",
            coalesce(e.display_name, t.label) as subject,
            t.status,
            t.selected
       from public.research_topics t
       left join public.entities e on e.id = t.matched_entity_id
      where t.workspace_id = $1
        and exists (
          select 1 from public.applied_changes ac
           where ac.workspace_id = t.workspace_id
             and ac.table_name = 'research_topics'
             and ac.row_id = t.id
             and ac.proposal_id = $2)
      order by case t.priority when 'high' then 0 when 'medium' then 1 when 'low' then 2 else 3 end,
               t.created_at`,
    [workspaceId, proposalId],
  );
}

/**
 * Everything that must be true before a capture-originated research run may be
 * created. Throws on the first thing that is not.
 *
 * All of it runs before any run, status change, activity row or model call, so
 * an invalid request leaves the capture, the proposal and memory exactly as
 * they were. The error is the same shape a caller gets for any bad request, so
 * a future UI can show it without special-casing.
 */
export async function validateCaptureResearchRequest(input: {
  workspaceId: string;
  proposalId: string;
  topicIds: string[];
}): Promise<{ questions: ResearchQuestion[]; proposal: { id: string; status: string } }> {
  if (input.topicIds.length === 0) {
    throw badRequest('Choose at least one research question first.');
  }
  const unique = [...new Set(input.topicIds)];
  if (unique.length !== input.topicIds.length) {
    throw badRequest('The same research question was asked for twice.');
  }

  return withService(async (db) => {
    // The proposal must exist IN THIS WORKSPACE. A id from another tenant is
    // indistinguishable from one that never existed, by design.
    const proposal = await db.one<{ id: string; status: string; source_kind: string }>(
      `select id, status, source_kind from public.proposals where workspace_id = $1 and id = $2`,
      [input.workspaceId, input.proposalId],
    );
    if (!proposal) throw notFound('That capture review no longer exists');
    if (proposal.status === 'superseded') {
      throw badRequest('This capture has been read again since. Open the newer review and choose the questions there.');
    }
    if (proposal.status === 'rejected') {
      throw badRequest('This capture was discarded, so its research questions cannot be researched.');
    }

    const all = await listResearchQuestions(db, input.workspaceId, input.proposalId);
    const known = new Map(all.map((q) => [q.id, q]));
    const missing = unique.filter((id) => !known.has(id));
    if (missing.length > 0) {
      // Deliberately not saying whether the id exists elsewhere.
      throw badRequest('Only research questions saved from this capture can be researched.');
    }

    const questions = unique.map((id) => known.get(id)!);
    const already = questions.filter((q) => q.status === 'researching' || q.status === 'researched' || q.status === 'captured');
    if (already.length === questions.length) {
      throw badRequest('Research for these questions has already started.');
    }
    const dismissed = questions.filter((q) => q.status === 'dismissed');
    if (dismissed.length > 0) {
      throw badRequest('A question that was dismissed cannot be researched. Choose it again on the review first.');
    }

    // Idempotency: an active run already covering any of these means the
    // request is a repeat, not a new instruction.
    const active = await db.one<{ id: string }>(
      `select r.id from public.runs r
        where r.workspace_id = $1 and r.kind = 'research'
          and r.status in ('queued', 'running')
          and r.input->>'proposalId' = $2
        limit 1`,
      [input.workspaceId, input.proposalId],
    );
    if (active) {
      throw conflict('Research for this capture is already running. Wait for it to finish before starting more.');
    }

    return { questions: questions.filter((q) => !already.some((a) => a.id === q.id)), proposal };
  });
}

/**
 * What confirming would do, in the person's words. Reads only: no run, no model
 * call, no network request, no write. Safe to call to render a screen.
 */
export async function topicResearchPreflight(input: {
  session: Session;
  workspaceId: string;
  proposalId: string;
  topicIds: string[];
}): Promise<{
  questions: ResearchQuestion[];
  disclosure: string;
  affects: string[];
}> {
  const all = await withService((db) => listResearchQuestions(db, input.workspaceId, input.proposalId));
  const wanted = new Set(input.topicIds);
  const questions = all.filter((q) => wanted.has(q.id));
  const unknown = input.topicIds.filter((id) => !all.some((q) => q.id === id));
  if (unknown.length > 0) {
    throw badRequest('Only research questions saved from this capture can be researched.');
  }
  return {
    questions,
    disclosure: TOPIC_RESEARCH_DISCLOSURE,
    // Who or what changes if this finds something. Named, so the confirmation
    // is about people and projects rather than about records.
    affects: [...new Set(questions.map((q) => q.subject ?? q.label).filter((s): s is string => Boolean(s)))],
  };
}

/**
 * Starts topic research, and only with both acknowledgements.
 *
 * Every refusal happens before anything is created: no run, no status change,
 * no activity row. Cancelling is therefore simply not calling this, and a
 * failed call leaves the capture and memory exactly as they were.
 */
export async function requestTopicResearch(input: {
  session: Session;
  workspaceId: string;
  proposalId: string;
  topicIds: string[];
  acknowledgeCost: boolean;
  acknowledgeExternalSources: boolean;
}): Promise<{ runId: string; questions: ResearchQuestion[] }> {
  if (input.acknowledgeCost !== true) {
    throw badRequest('Research uses AI budget and may search external sources. Confirm to start it.');
  }
  if (input.acknowledgeExternalSources !== true) {
    throw badRequest('Confirm that public sources may be searched for these questions before research starts.');
  }
  if (input.topicIds.length === 0) {
    throw badRequest('Choose at least one research question first.');
  }

  const validated = await validateCaptureResearchRequest({
    workspaceId: input.workspaceId,
    proposalId: input.proposalId,
    topicIds: input.topicIds,
  });
  const pending = validated.questions;
  const first = pending[0];
  if (!first) throw badRequest('Research for these questions has already started.');
  const affects = [...new Set(pending.map((q) => q.subject ?? q.label).filter((s): s is string => Boolean(s)))];

  const run = await createRun({
    session: input.session,
    workspaceId: input.workspaceId,
    kind: 'research',
    input: { kind: 'capture_proposal', proposalId: input.proposalId, topicIds: pending.map((q) => q.id) },
    idempotencyKey: `topic-research:${input.proposalId}:${pending.map((q) => q.id).sort().join(',')}`,
    isMock: !hasOpenAi(),
  });

  await withService(async (db) => {
    await db.query(
      `update public.research_topics
          set status = 'researching', selected = true, run_id = $3, updated_at = now()
        where workspace_id = $1 and id = any($2::uuid[])`,
      [input.workspaceId, pending.map((q) => q.id), run.run.id],
    );
    await logActivity(db, {
      workspaceId: input.workspaceId,
      actorId: input.session.user.id,
      action: 'topic_research.requested',
      subjectTable: 'research_topics',
      subjectId: first.id,
      summary:
        pending.length === 1
          ? `Confirmed research for one question: ${first.question}`
          : `Confirmed research for ${pending.length} questions.`,
      data: { questions: pending.map((q) => q.question), affects },
    });
  });

  return { runId: run.run.id, questions: pending };
}
