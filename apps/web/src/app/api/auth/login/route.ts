import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  badRequest,
  createDevSessionToken,
  hasSupabaseAuth,
  loadWorkspaceAccess,
  SESSION_COOKIE,
  signInWithPassword,
  unauthorized,
  WORKSPACE_COOKIE,
} from '@g3/core';
import { handler, ok, readJson } from '@/lib/api';

const Body = z.object({ email: z.string().email(), password: z.string().min(1) });

/**
 * Sign-in.
 *
 * With Supabase Auth configured, the browser obtains the access token from
 * Supabase and this endpoint only stores it; passwords are never handled here.
 * Without it, the local development provider verifies a password against the
 * local database and issues a signed cookie.
 */
export const POST = handler(async (request: Request) => {
  const body = Body.parse(await readJson(request));

  if (hasSupabaseAuth()) {
    throw badRequest(
      'Supabase Auth is configured, so sign-in happens against Supabase and the access token is sent as a bearer token. This local password endpoint is disabled.',
    );
  }

  const userId = await signInWithPassword(body.email, body.password);
  const workspaces = await loadWorkspaceAccess(userId);
  if (workspaces.length === 0) throw unauthorized('This account has no workspace access.');

  const response = ok({ ok: true, workspaces: workspaces.length });
  response.cookies.set(SESSION_COOKIE, createDevSessionToken(userId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 14,
  });
  response.cookies.set(WORKSPACE_COOKIE, workspaces[0]!.workspaceId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 14,
  });
  return response;
});
