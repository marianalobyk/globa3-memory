import { z } from 'zod';
import { applyApprovedItems } from '@g3/core';
import { handler, ok, readJson } from '@/lib/api';
import { activeWorkspaceId, requireApiSession } from '@/lib/session';

const Body = z.object({
  expectedVersion: z.number().int().positive(),
  itemIds: z.array(z.string().uuid()).min(1),
});

/**
 * Applies approved items.
 *
 * This is the only path that writes to the knowledge tables. It re-verifies
 * permission, the approved version and hash, re-resolves creates against the
 * live database, applies everything in one transaction, and reads the rows back.
 * Repeating the request cannot duplicate anything.
 */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const session = await requireApiSession();
  const workspaceId = activeWorkspaceId(session);
  const { id } = await context.params;
  const body = Body.parse(await readJson(request));

  const result = await applyApprovedItems({
    session,
    workspaceId,
    proposalId: id,
    expectedVersion: body.expectedVersion,
    itemIds: body.itemIds,
  });
  return ok(result);
});
