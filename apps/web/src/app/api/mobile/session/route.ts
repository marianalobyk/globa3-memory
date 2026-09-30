import { headers } from 'next/headers';
import { z } from 'zod';
import {
  AppError,
  authMode,
  createDevSessionToken,
  decodeJwtClaims,
  hasOpenAi,
  hasSupabaseAuth,
  loadWorkspaceAccess,
  signInWithPassword,
  signInWithSupabase,
  signOutSupabase,
  unauthorized,
} from '@g3/core';
import { handler, ok, readJson } from '@/lib/api';
import { requireApiSession } from '@/lib/session';

const Body = z.object({ email: z.string().email(), password: z.string().min(1).max(500) });

const DEV_TOKEN_SECONDS = 60 * 60 * 24 * 14;

/**
 * Sign-in for the mobile app.
 *
 * Same authenticators as the web sign-in, but the app has no cookie jar, so the
 * credential comes back in the body for the app to keep in the iOS Keychain:
 *
 *   supabase -- the password is exchanged with Supabase HERE, server-side. The
 *               app receives the user's own access and refresh tokens. It never
 *               holds the anon key, the service-role key or anything else.
 *   dev      -- local development only: a signed session token.
 *
 * Every later request sends the token as `Authorization: Bearer`, and the
 * server verifies it on every request exactly as it verifies the web cookie.
 */
export const POST = handler(async (request: Request) => {
  const body = Body.parse(await readJson(request));
  const mode = authMode();

  if (mode === 'none') {
    throw new AppError('Sign-in is not configured on this server.', 503, 'auth_not_configured');
  }

  if (mode === 'supabase') {
    const tokens = await signInWithSupabase(body.email, body.password);
    const sub = decodeJwtClaims(tokens.accessToken)?.sub;
    if (!sub) throw unauthorized('Sign-in returned no user');
    const workspaces = await loadWorkspaceAccess(sub);
    if (workspaces.length === 0) {
      throw new AppError('This account is not a member of any workspace.', 403, 'no_workspace_access');
    }
    return ok({
      provider: 'supabase',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      workspaceId: workspaces[0]!.workspaceId,
    });
  }

  const userId = await signInWithPassword(body.email, body.password);
  const workspaces = await loadWorkspaceAccess(userId);
  if (workspaces.length === 0) throw unauthorized('This account has no workspace access.');
  return ok({
    provider: 'dev',
    accessToken: createDevSessionToken(userId, DEV_TOKEN_SECONDS),
    refreshToken: null,
    expiresAt: Math.floor(Date.now() / 1000) + DEV_TOKEN_SECONDS,
    workspaceId: workspaces[0]!.workspaceId,
  });
});

/** Who is signed in, where, and what they may do. The app's first call on launch. */
export const GET = handler(async () => {
  const session = await requireApiSession();
  const active = session.activeWorkspace;
  return ok({
    user: { email: session.user.email, displayName: session.user.displayName },
    workspace: {
      id: active.workspaceId,
      name: active.workspaceName,
      timezone: active.timezone,
      role: active.role,
      canApprove: active.canApprove,
      isAdmin: active.role === 'admin',
    },
    workspaces: session.workspaces.map((w) => ({ id: w.workspaceId, name: w.workspaceName })),
    isDevAuth: session.isDevAuth,
    // Mock mode is shown in the app so synthetic output is never mistaken for analysis.
    aiMode: hasOpenAi() ? 'live' : 'mock',
  });
});

/** Sign-out: revokes the refresh token at Supabase. The app then forgets its tokens. */
export const DELETE = handler(async () => {
  const authorization = (await headers()).get('authorization') ?? '';
  const token = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
  if (hasSupabaseAuth() && token) {
    const result = await signOutSupabase(token);
    return ok({ ok: true, revokedAtProvider: result.revoked });
  }
  return ok({ ok: true, revokedAtProvider: false });
});
