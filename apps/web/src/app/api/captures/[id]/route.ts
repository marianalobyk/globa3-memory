import { notFound } from '@g3/core';
import { handler, ok } from '@/lib/api';
import { loadCaptureView } from '@/lib/capture-view';
import { requireApiSession } from '@/lib/session';

/**
 * One capture's analysis state, polled by the web capture screen and the
 * mobile app. Read under the caller's own access rules, in plain words: no job
 * ids, stage names or database errors.
 */
export const GET = handler(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const session = await requireApiSession();
  const { id } = await context.params;
  const view = await loadCaptureView(session, id);
  if (!view) throw notFound('Capture not found');
  return ok(view);
});
