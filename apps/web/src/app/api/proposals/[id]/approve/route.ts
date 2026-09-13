import { z } from 'zod';
import { recordApproval, rejectProposal } from '@g3/core';
import { handler, ok, readJson } from '@/lib/api';
import { activeWorkspaceId, requireApiSession } from '@/lib/session';

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), itemIds: z.array(z.string().uuid()).min(1) }),
  z.object({ action: z.literal('reject'), reason: z.string().max(2000).optional() }),
]);

/** Approves specific items, or rejects the whole proposal. */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const session = await requireApiSession();
  const workspaceId = activeWorkspaceId(session);
  const { id } = await context.params;
  const body = Body.parse(await readJson(request));

  if (body.action === 'reject') {
    await rejectProposal(session, workspaceId, id, body.reason ?? 'Rejected in review.');
    return ok({ ok: true, action: 'reject' });
  }

  const approval = await recordApproval(session, workspaceId, id, body.itemIds);
  return ok({
    ok: true,
    action: 'approve',
    approvalId: approval.id,
    proposalVersion: approval.proposal_version,
    itemCount: body.itemIds.length,
  });
});
