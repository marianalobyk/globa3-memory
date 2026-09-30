import { listResearchQuestions, withService } from '@g3/core';
import { handler, ok } from '@/lib/api';
import { activeWorkspaceId, requireApiSession } from '@/lib/session';

/**
 * Lists the research questions that were explicitly saved from this capture.
 * Reading this route is inert: it does not start a run or change a question.
 */
export const GET = handler(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const session = await requireApiSession();
  const workspaceId = activeWorkspaceId(session);
  const { id } = await context.params;
  const questions = await withService((db) => listResearchQuestions(db, workspaceId, id));
  return ok({ questions });
});
