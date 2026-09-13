import { notFound, runCostSummary, withUser } from '@g3/core';
import { handler, ok } from '@/lib/api';
import { activeWorkspaceId, requireApiSession } from '@/lib/session';

/**
 * Run status, stages and events. Polled by the progress view.
 *
 * Reads run as the signed-in user, so RLS is the boundary rather than a
 * hand-written filter.
 */
export const GET = handler(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const session = await requireApiSession();
  const workspaceId = activeWorkspaceId(session);
  const { id } = await context.params;

  const payload = await withUser(session.user.id, async (db) => {
    const run = await db.one<{
      id: string;
      kind: string;
      status: string;
      progress: number;
      current_stage: string | null;
      attempt: number;
      max_attempts: number;
      error: string | null;
      is_mock: boolean;
      run_date: string | null;
      created_at: string;
      started_at: string | null;
      finished_at: string | null;
      lease_owner: string | null;
      heartbeat_at: string | null;
    }>(
      `select id, kind, status, progress, current_stage, attempt, max_attempts, error,
              is_mock, run_date, created_at, started_at, finished_at, lease_owner, heartbeat_at
         from public.runs where workspace_id = $1 and id = $2`,
      [workspaceId, id],
    );
    if (!run) return null;

    const stages = await db.rows(
      `select seq, stage, label, status, progress, error, started_at, finished_at,
              tokens_in, tokens_out, web_searches, duration_ms, cost_usd, cost_is_estimate,
              provider_response_id is not null as has_background_response
         from public.run_stages where workspace_id = $1 and run_id = $2 order by seq`,
      [workspaceId, id],
    );
    const events = await db.rows(
      `select id, level, stage, message, created_at from public.run_events
        where workspace_id = $1 and run_id = $2 order by id desc limit 60`,
      [workspaceId, id],
    );
    const brief = await db.one<{ id: string }>(
      `select id from public.brief_documents where workspace_id = $1 and run_id = $2 limit 1`,
      [workspaceId, id],
    );
    const proposal = await db.one<{ id: string }>(
      `select id from public.proposals where workspace_id = $1 and run_id = $2 limit 1`,
      [workspaceId, id],
    );
    const cost = await runCostSummary(db, workspaceId, id);

    return { run, stages, events: events.reverse(), briefDocumentId: brief?.id ?? null, proposalId: proposal?.id ?? null, cost };
  });

  if (!payload) throw notFound('Run not found');
  return ok(payload);
});
