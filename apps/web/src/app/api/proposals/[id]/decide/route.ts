import { z } from 'zod';
import { decideProposalItems } from '@g3/core';
import { handler, ok, readJson } from '@/lib/api';
import { activeWorkspaceId, requireApiSession } from '@/lib/session';

const Body = z.object({
  decisions: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        decision: z.enum(['approved', 'rejected', 'pending']),
      }),
    )
    .min(1),
});

/** Records per-item decisions. Requires approval capability in the workspace. */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const session = await requireApiSession();
  const workspaceId = activeWorkspaceId(session);
  const { id } = await context.params;
  const body = Body.parse(await readJson(request));

  await decideProposalItems(session, workspaceId, id, body.decisions);
  return ok({ ok: true, decided: body.decisions.length });
});
