import { requestTopicResearch } from '@g3/core';
import { z } from 'zod';
import { handler, ok, readJson } from '@/lib/api';
import { activeWorkspaceId, requireApiSession, requireApproval } from '@/lib/session';

const Body = z.object({
  topicIds: z.array(z.string().uuid()).min(1),
  acknowledgeCost: z.literal(true),
  acknowledgeExternalSources: z.literal(true),
});

/** Creates the background research run only after both explicit acknowledgements. */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const session = await requireApiSession();
  const workspaceId = activeWorkspaceId(session);
  requireApproval(session, workspaceId);
  const { id } = await context.params;
  const body = Body.parse(await readJson(request));
  return ok(
    await requestTopicResearch({
      session,
      workspaceId,
      proposalId: id,
      topicIds: body.topicIds,
      acknowledgeCost: body.acknowledgeCost,
      acknowledgeExternalSources: body.acknowledgeExternalSources,
    }),
  );
});
