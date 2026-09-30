import { z } from 'zod';
import {
  ACCESS_TOKEN_COOKIE,
  authMode,
  createDevSessionToken,
  loadWorkspaceAccess,
  REFRESH_TOKEN_COOKIE,
  SESSION_COOKIE,
  signInWithPassword,
  signInWithSupabase,
  unauthorized,
  WORKSPACE_COOKIE,
  type SupabaseTokens,
} from '@g3/core';
import { AppError } from '@g3/core';
import { handler, ok, readJson } from '@/lib/api';

const Body = z.object({ email: z.string().email(), password: z.string().min(1) });

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  };
}

/**
 * Sign-in.
 *
 * Routes to whichever authenticator is actually configured:
 *
 *   supabase -- the password is exchanged with Supabase server-side and the
 *               resulting tokens are stored as httpOnly cookies. The browser
 *               never holds a token it can read from JavaScript, and the
 *               password is never persisted anywhere.
 *   dev      -- a local password table, only when DEV_AUTH_ENABLED is set and
 *               only outside production.
 *   none     -- refused, with the configuration that is missing named.
 */
export const POST = handler(async (request: Request) => {
  const body = Body.parse(await readJson(request));
  const mode = authMode();

  if (mode === 'none') {
    throw new AppError(
      'No authentication provider is configured. Set SUPABASE_URL and SUPABASE_ANON_KEY, or set DEV_AUTH_ENABLED=true for local development.',
      503,
      'auth_not_configured',
    );
  }

  if (mode === 'supabase') {
    const tokens: SupabaseTokens = await signInWithSupabase(body.email, body.password);

    const claims = JSON.parse(
      Buffer.from(tokens.accessToken.split('.')[1] ?? '', 'base64').toString('utf8') || '{}',
    ) as { sub?: string };
    if (!claims.sub) throw unauthorized('Supabase returned a token without a subject');

    const workspaces = await loadWorkspaceAccess(claims.sub);
    if (workspaces.length === 0) {
      // Authenticated, but not a member of anything. Say so plainly instead of
      // leaving an empty app.
      throw new AppError(
        'This account is not a member of any workspace. Ask an administrator to add you.',
        403,
        'no_workspace_access',
      );
    }

    const response = ok({ ok: true, provider: 'supabase', workspaces: workspaces.length });
    response.cookies.set(ACCESS_TOKEN_COOKIE, tokens.accessToken, cookieOptions(tokens.expiresIn));
    response.cookies.set(REFRESH_TOKEN_COOKIE, tokens.refreshToken, cookieOptions(60 * 60 * 24 * 30));
    response.cookies.set(WORKSPACE_COOKIE, workspaces[0]!.workspaceId, cookieOptions(60 * 60 * 24 * 30));
    return response;
  }

  // Local development sign-in. signInWithPassword refuses unless enabled.
  const userId = await signInWithPassword(body.email, body.password);
  const workspaces = await loadWorkspaceAccess(userId);
  if (workspaces.length === 0) throw unauthorized('This account has no workspace access.');

  const response = ok({ ok: true, provider: 'dev', workspaces: workspaces.length });
  response.cookies.set(SESSION_COOKIE, createDevSessionToken(userId), cookieOptions(60 * 60 * 24 * 14));
  response.cookies.set(WORKSPACE_COOKIE, workspaces[0]!.workspaceId, cookieOptions(60 * 60 * 24 * 14));
  return response;
});
