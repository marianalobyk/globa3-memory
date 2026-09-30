import { retryCapture } from '@g3/core';
import { handler, ok } from '@/lib/api';
import { activeWorkspaceId, requireApiSession } from '@/lib/session';

/** Retries a failed analysis. Finished stages keep their result. */
export const POST = handler(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const session = await requireApiSession();
  const workspaceId = activeWorkspaceId(session);
  const { id } = await context.params;
  const capture = await retryCapture(session, workspaceId, id);
  return ok({ id: capture.id, status: capture.status });
});
