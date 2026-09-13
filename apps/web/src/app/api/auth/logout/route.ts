import { SESSION_COOKIE, WORKSPACE_COOKIE } from '@g3/core';
import { handler, ok } from '@/lib/api';

export const POST = handler(async () => {
  const response = ok({ ok: true });
  response.cookies.delete(SESSION_COOKIE);
  response.cookies.delete(WORKSPACE_COOKIE);
  return response;
});
