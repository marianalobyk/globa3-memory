import { z } from 'zod';
import {
  assertRunDate,
  briefIdempotencyKey,
  createRun,
  getFormat,
  hasOpenAi,
  researchIdempotencyKey,
  withService,
} from '@g3/core';
import { handler, ok, readJson } from '@/lib/api';
import { activeWorkspaceId, requireApiSession } from '@/lib/session';

const BriefBody = z.object({
  kind: z.literal('brief'),
  formatId: z.string().uuid(),
  runDate: z.string(),
  /** Set when deliberately re-running a format for a date that already ran. */
  force: z.boolean().optional(),
  model: z.string().optional(),
});

const ResearchBody = z.object({
  kind: z.literal('research'),
  briefDocumentId: z.string().uuid(),
  topicIds: z.array(z.string().uuid()).min(1),
  model: z.string().optional(),
});

const Body = z.discriminatedUnion('kind', [BriefBody, ResearchBody]);

/**
 * Creates a run and enqueues it. The server only validates, checks access and
 * the budget, and writes the job; the worker does the work, so the response
 * returns immediately and nothing depends on this request staying open.
 */
export const POST = handler(async (request: Request) => {
  const session = await requireApiSession();
  const workspaceId = activeWorkspaceId(session);
  const body = Body.parse(await readJson(request));
  const isMock = !hasOpenAi();

  if (body.kind === 'brief') {
    const runDate = assertRunDate(body.runDate);
    const format = await withService((db) => getFormat(db, workspaceId, body.formatId));
    const created = await createRun({
      session,
      workspaceId,
      kind: 'brief',
      formatId: format.id,
      runDate,
      model: body.model ?? null,
      idempotencyKey: briefIdempotencyKey(
        format.key,
        runDate,
        body.force ? `manual-${Date.now()}` : undefined,
      ),
      isMock,
    });
    return ok({
      runId: created.run.id,
      created: created.created,
      status: created.run.status,
      budgetWarnings: created.budgetWarnings,
      isMock,
    });
  }

  // Mark the chosen topics as selected, which is also what the Research screen
  // reads back, then queue the run. Written by the server role, scoped to the
  // session's verified workspace: client roles hold no write privilege (0018).
  await withService((db) =>
    db.query(
      `update public.research_topics
          set selected = true, status = 'selected', updated_at = now()
        where workspace_id = $1 and id = any($2::uuid[])`,
      [workspaceId, body.topicIds],
    ),
  );

  const created = await createRun({
    session,
    workspaceId,
    kind: 'research',
    input: { briefDocumentId: body.briefDocumentId, topicIds: body.topicIds },
    model: body.model ?? null,
    idempotencyKey: researchIdempotencyKey(body.briefDocumentId, body.topicIds),
    isMock,
  });

  return ok({
    runId: created.run.id,
    created: created.created,
    status: created.run.status,
    budgetWarnings: created.budgetWarnings,
    isMock,
  });
});
