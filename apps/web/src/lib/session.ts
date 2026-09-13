import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  hasSupabaseAuth,
  requireApproval as coreRequireApproval,
  requireSession,
  requireWorkspace as coreRequireWorkspace,
  resolveSession,
  SESSION_COOKIE,
  WORKSPACE_COOKIE,
} from '@g3/core';
import type { Session, WorkspaceAccess } from '@g3/shared';

/**
 * Resolves the signed-in user for a server component or route handler.
 *
 * Supabase Auth is the primary provider: the access token arrives as a bearer
 * header or in the session cookie, and is verified server-side before the
 * subject is bound to the database transaction for RLS.
 *
 * When Supabase Auth is not configured, the dev provider's signed cookie is used
 * instead, and the resulting session is flagged isDevAuth so the UI can say so.
 */
export async function getSession(): Promise<Session | null> {
  const cookieStore = await cookies();
  const headerStore = await headers();

  const authorization = headerStore.get('authorization');
  const bearerToken = authorization?.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : (hasSupabaseAuth() ? (cookieStore.get(SESSION_COOKIE)?.value ?? null) : null);

  return resolveSession({
    bearerToken,
    sessionCookie: cookieStore.get(SESSION_COOKIE)?.value ?? null,
    requestedWorkspaceId: cookieStore.get(WORKSPACE_COOKIE)?.value ?? null,
  });
}

/** For pages: redirects to the sign-in screen when there is no session. */
export async function requirePageSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

/** For route handlers: throws a 401-mapped error instead of redirecting. */
export async function requireApiSession(): Promise<Session> {
  return requireSession(await getSession());
}

export function requireWorkspace(session: Session, workspaceId: string): WorkspaceAccess {
  return coreRequireWorkspace(session, workspaceId);
}

export function requireApproval(session: Session, workspaceId: string): WorkspaceAccess {
  return coreRequireApproval(session, workspaceId);
}

/** The active workspace id, which the server never takes from the client body. */
export function activeWorkspaceId(session: Session): string {
  return session.activeWorkspace.workspaceId;
}
