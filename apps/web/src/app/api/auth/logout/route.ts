import { cookies } from 'next/headers';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  SESSION_COOKIE,
  signOutSupabase,
  WORKSPACE_COOKIE,
  hasSupabaseAuth,
} from '@g3/core';
import { handler, ok } from '@/lib/api';

/**
 * Sign-out.
 *
 * Clearing the cookies is not enough on its own: the refresh token stays valid
 * at Supabase until it expires, so anyone who captured it could keep minting
 * access tokens. The session is revoked at Supabase first, then the cookies are
 * cleared regardless of whether that succeeded.
 */
export const POST = handler(async () => {
  const store = await cookies();
  const accessToken = store.get(ACCESS_TOKEN_COOKIE)?.value;

  let revoked: { revoked: boolean; note: string | null } = { revoked: false, note: null };
  if (hasSupabaseAuth() && accessToken) {
    revoked = await signOutSupabase(accessToken);
  }

  const response = ok({
    ok: true,
    revokedAtProvider: revoked.revoked,
    note: revoked.note,
  });
  for (const name of [ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, SESSION_COOKIE, WORKSPACE_COOKIE]) {
    response.cookies.set(name, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0,
    });
  }
  return response;
});
