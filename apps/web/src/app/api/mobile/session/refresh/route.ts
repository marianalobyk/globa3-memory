import { z } from 'zod';
import { AppError, hasSupabaseAuth, refreshSupabaseSession } from '@g3/core';
import { handler, ok, readJson } from '@/lib/api';

const Body = z.object({ refreshToken: z.string().min(10).max(4000) });

/**
 * Exchanges the app's refresh token for a fresh pair. The web client does this
 * in middleware from a cookie; the app, which has no cookies, asks here.
 */
export const POST = handler(async (request: Request) => {
  if (!hasSupabaseAuth()) {
    throw new AppError('This server does not issue refresh tokens.', 400, 'refresh_not_supported');
  }
  const body = Body.parse(await readJson(request));
  const tokens = await refreshSupabaseSession(body.refreshToken);
  return ok({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt });
});
