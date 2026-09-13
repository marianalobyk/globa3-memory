import { z } from 'zod';
import { WORKSPACE_COOKIE } from '@g3/core';
import { handler, ok, readJson } from '@/lib/api';
import { requireApiSession, requireWorkspace } from '@/lib/session';

const Body = z.object({ workspaceId: z.string().uuid() });

/** Switches the active workspace, after checking membership server-side. */
export const POST = handler(async (request: Request) => {
  const session = await requireApiSession();
  const body = Body.parse(await readJson(request));
  requireWorkspace(session, body.workspaceId);

  const response = ok({ ok: true });
  response.cookies.set(WORKSPACE_COOKIE, body.workspaceId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 14,
  });
  return response;
});
