import { topicResearchPreflight } from '@g3/core';
import { z } from 'zod';
import { handler, ok, readJson } from '@/lib/api';
import { activeWorkspaceId, requireApiSession, requireApproval } from '@/lib/session';

const Body = z.object({ topicIds: z.array(z.string().uuid()).min(1) });

/**
 * Shows the exact questions and disclosure before research. This endpoint is
 * deliberately read-only; the following start action is a separate request.
 */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const session = await requireApiSession();
  const workspaceId = activeWorkspaceId(session);
  requireApproval(session, workspaceId);
  const { id } = await context.params;
  const body = Body.parse(await readJson(request));
  return ok(
    await topicResearchPreflight({
      session,
      workspaceId,
      proposalId: id,
      topicIds: body.topicIds,
    }),
  );
});
