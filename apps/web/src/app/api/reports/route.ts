import { z } from 'zod';
import { buildDailyReport, todayInZone } from '@g3/core';
import { handler, ok, readJson } from '@/lib/api';
import { activeWorkspaceId, requireApiSession } from '@/lib/session';

const Body = z.object({ reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

/** Builds (or rebuilds) the Markdown change report for a date. */
export const POST = handler(async (request: Request) => {
  const session = await requireApiSession();
  const workspaceId = activeWorkspaceId(session);
  const body = Body.parse(await readJson(request).catch(() => ({})));
  const reportDate = body.reportDate ?? todayInZone(session.activeWorkspace.timezone);

  const report = await buildDailyReport(workspaceId, reportDate, { actorId: session.user.id });
  return ok(report);
});
