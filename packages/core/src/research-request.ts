/**
 * Research a person, company or project -- only when a person asks for it.
 *
 * Capture analysis never researches anything: it reads the source, existing
 * memory and entity resolution, nothing else. Deep research spends AI budget and
 * may search external sources, so it runs only through this explicit request,
 * which the client must send with `acknowledgeCost: true` after showing the
 * person what it will do.
 *
 * It reuses the existing research pipeline unchanged: a research target row, a
 * `research` run, and a proposal of its own that keeps facts, inferences and
 * recommendations apart. Research about a contact in a capture does NOT come
 * through here: it goes through contact-research.ts (identity first, results
 * joined to the capture's own proposal), and the HTTP route refuses a captureId.
 */
import { slugify, toZonedDate, type Session } from '@g3/shared';
import { requireWorkspace } from './auth.js';
import { withService } from './db.js';
import { env, hasOpenAi } from './env.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { logActivity } from './activity.js';
import { resolveEntity } from './resolve.js';
import { createRun, requeueRun } from './runs.js';

export type ResearchTargetKind = 'person' | 'company' | 'project';

export interface ExplicitResearchInput {
  session: Session;
  workspaceId: string;
  /** A stored person, company or project. Omit for a name not yet in memory. */
  entityId?: string | null;
  /** The name as the person sees it. Required when there is no entity id. */
  label?: string | null;
  targetType?: ResearchTargetKind | null;
  /** The capture that prompted the request, kept for provenance only. */
  captureId?: string | null;
  /** Must be true: the client showed that this uses AI budget and external sources. */
  acknowledgeCost: boolean;
}

export interface ExplicitResearchResult {
  runId: string;
  created: boolean;
  label: string;
  isMock: boolean;
  budgetWarnings: string[];
}

const ENTITY_TO_TARGET: Record<string, ResearchTargetKind> = {
  person: 'person',
  organization: 'company',
  institution: 'company',
  project: 'project',
};

const TARGET_TO_ENTITY = { person: 'person', company: 'organization', project: 'project' } as const;

export async function requestExplicitResearch(input: ExplicitResearchInput): Promise<ExplicitResearchResult> {
  const access = requireWorkspace(input.session, input.workspaceId);
  if (access.role === 'viewer') throw forbidden('Viewers cannot start research');
  if (input.acknowledgeCost !== true) {
    throw badRequest('Research uses AI budget and may search external sources. Confirm to start it.');
  }
  const workspaceId = input.workspaceId;

  const target = await withService(async (db) => {
    if (input.entityId) {
      const entity = await db.one<{ id: string; display_name: string; entity_type: string }>(
        `select id, display_name, entity_type from public.entities where workspace_id = $1 and id = $2`,
        [workspaceId, input.entityId],
      );
      if (!entity) throw notFound('That record is not in this workspace');
      const kind = ENTITY_TO_TARGET[entity.entity_type];
      if (!kind) throw badRequest('Only a person, company or project can be researched');
      return { label: entity.display_name, kind, entityId: entity.id, resolution: 'existing', candidates: [] as unknown[] };
    }
    const label = (input.label ?? '').trim();
    if (label.length < 2 || label.length > 200) throw badRequest('Name the person, company or project to research');
    const kind = input.targetType ?? null;
    if (!kind || !(kind in TARGET_TO_ENTITY)) throw badRequest('Say whether this is a person, company or project');
    // Resolution follows the same rule as capture: only an exact name or a
    // recorded alias identifies a stored record. A similar name is recorded as
    // a candidate and the research target stays unlinked.
    const resolved = await resolveEntity(db, workspaceId, { name: label, entityType: TARGET_TO_ENTITY[kind] });
    return {
      label,
      kind,
      entityId: resolved.status === 'existing' ? (resolved.best?.id ?? null) : null,
      resolution: resolved.status === 'existing' ? 'existing' : resolved.candidates.length > 0 ? 'ambiguous' : 'not_found',
      candidates: resolved.candidates,
    };
  });

  // One request per target per day: tapping twice does not spend twice.
  const today = toZonedDate(new Date(), input.session.activeWorkspace.timezone || 'UTC');
  const idempotencyKey = `research:explicit:${target.entityId ?? slugify(target.label)}:${today}`;

  const isMock = !hasOpenAi();
  const already = await withService((db) =>
    db.one<{ id: string; status: string }>(`select id, status from public.runs where workspace_id = $1 and idempotency_key = $2`, [
      workspaceId,
      idempotencyKey,
    ]),
  );
  if (already && already.status === 'failed') {
    // A request that failed (for example a model the key cannot use) must not
    // block asking again today: restart the same run. Finished stages are reused.
    await withService(async (db) => {
      await db.query(
        `update public.runs
            set status = 'queued', error = null, finished_at = null,
                max_attempts = attempt + $3, lease_owner = null, lease_expires_at = null, updated_at = now()
          where workspace_id = $1 and id = $2 and status = 'failed'`,
        [workspaceId, already.id, env().WORKER_MAX_ATTEMPTS],
      );
      await logActivity(db, {
        workspaceId,
        actorId: input.session.user.id,
        action: 'research.retried',
        subjectTable: 'runs',
        subjectId: already.id,
        summary: `Research on ${target.label} was requested again after it failed.`,
      });
    });
    await requeueRun(workspaceId, already.id, 'research');
    return { runId: already.id, created: true, label: target.label, isMock, budgetWarnings: [] };
  }
  if (already) return { runId: already.id, created: false, label: target.label, isMock, budgetWarnings: [] };

  const topicId = await withService(async (db) => {
    const row = await db.oneOrFail<{ id: string }>(
      `insert into public.research_topics
         (workspace_id, label, target_type, resolution_status, matched_entity_id, candidate_matches,
          priority, research_question, why_useful, selected, status)
       values ($1,$2,$3,$4,$5,$6::jsonb,'medium',$7,$8,true,'selected')
       returning id`,
      [
        workspaceId,
        target.label,
        target.kind,
        target.resolution,
        target.entityId,
        JSON.stringify(target.candidates),
        `What is useful to know about ${target.label}, beyond what is already in memory?`,
        'Requested explicitly by a person after a capture.',
      ],
    );
    return row.id;
  });

  const created = await createRun({
    session: input.session,
    workspaceId,
    kind: 'research',
    input: { topicIds: [topicId], requestedExplicitly: true, captureId: input.captureId ?? null },
    idempotencyKey,
    isMock,
  });

  await withService(async (db) => {
    if (!created.created) {
      // Lost a race with an identical request: drop the unused target.
      await db.query(`delete from public.research_topics where workspace_id = $1 and id = $2`, [workspaceId, topicId]);
      return;
    }
    await db.query(
      `update public.research_topics set run_id = $3, updated_at = now() where workspace_id = $1 and id = $2`,
      [workspaceId, topicId, created.run.id],
    );
    if (created.created) {
      await logActivity(db, {
        workspaceId,
        actorId: input.session.user.id,
        action: 'research.requested',
        subjectTable: 'runs',
        subjectId: created.run.id,
        summary: `Research requested for ${target.label}${isMock ? ' (mock: no model configured)' : ''}.`,
        data: { targetType: target.kind, entityId: target.entityId, captureId: input.captureId ?? null },
      });
    }
  });

  return {
    runId: created.run.id,
    created: created.created,
    label: target.label,
    isMock,
    budgetWarnings: created.budgetWarnings,
  };
}
