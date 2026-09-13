/**
 * Authentication and workspace access.
 *
 * Primary provider is Supabase Auth: the app verifies the JWT server-side
 * (asymmetric via JWKS when available, otherwise the project's HS256 secret),
 * mirrors the user into app_users, then binds the subject to the database
 * transaction so RLS applies.
 *
 * When Supabase Auth is not configured, a clearly-flagged dev provider signs in
 * against the local auth.users table with a signed cookie. Every session it
 * issues carries isDevAuth: true so the UI states plainly that authentication is
 * local, and no session is ever silently treated as production auth.
 */
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Session, WorkspaceAccess } from '@g3/shared';
import { withOwner, withService, type Queryable } from './db.js';
import { env, hasSupabaseAuth } from './env.js';
import { forbidden, unauthorized } from './errors.js';

const scrypt = promisify(scryptCb);

export const SESSION_COOKIE = 'g3_session';
export const WORKSPACE_COOKIE = 'g3_workspace';

// ---------------------------------------------------------------------------
// Dev auth: local passwords, signed cookie
// ---------------------------------------------------------------------------

async function hashPassword(password: string, salt?: string): Promise<string> {
  const s = salt ?? randomBytes(16).toString('hex');
  const derived = (await scrypt(password, s, 64)) as Buffer;
  return `scrypt$${s}$${derived.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hex] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hex) return false;
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hex, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function sign(value: string): string {
  return createHmac('sha256', env().DEV_AUTH_SECRET).update(value).digest('base64url');
}

export function createDevSessionToken(userId: string, ttlSeconds = 60 * 60 * 24 * 14): string {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${userId}.${expires}`;
  return `${payload}.${sign(payload)}`;
}

function readDevSessionToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expires, mac] = parts as [string, string, string];
  const expected = sign(`${userId}.${expires}`);
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  if (Number(expires) * 1000 < Date.now()) return null;
  return userId;
}

/** Dev-only: create or update a local user with a password. */
export async function upsertDevUser(
  email: string,
  password: string,
  displayName?: string,
): Promise<string> {
  const encrypted = await hashPassword(password);
  return withOwner(async (db) => {
    const user = await db.oneOrFail<{ id: string }>(
      `insert into auth.users (email, encrypted_password) values ($1, $2)
       on conflict (email) do update set encrypted_password = excluded.encrypted_password
       returning id`,
      [email.toLowerCase(), encrypted],
    );
    await db.query(
      `insert into public.app_users (id, email, display_name) values ($1, $2, $3)
       on conflict (id) do update set email = excluded.email,
         display_name = coalesce(excluded.display_name, public.app_users.display_name)`,
      [user.id, email.toLowerCase(), displayName ?? email.split('@')[0]],
    );
    return user.id;
  });
}

export async function signInWithPassword(email: string, password: string): Promise<string> {
  const row = await withOwner((db) =>
    db.one<{ id: string; encrypted_password: string | null }>(
      `select id, encrypted_password from auth.users where email = $1`,
      [email.toLowerCase()],
    ),
  );
  if (!row?.encrypted_password) throw unauthorized('Unknown email or password');
  if (!(await verifyPassword(password, row.encrypted_password))) {
    throw unauthorized('Unknown email or password');
  }
  return row.id;
}

// ---------------------------------------------------------------------------
// Supabase JWT verification
// ---------------------------------------------------------------------------

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${env().SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
  }
  return jwks;
}

async function verifySupabaseJwt(token: string): Promise<JWTPayload> {
  const secret = env().SUPABASE_JWT_SECRET;
  if (secret) {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
    });
    return payload;
  }
  const { payload } = await jwtVerify(token, getJwks(), {
    algorithms: ['RS256', 'ES256'],
  });
  return payload;
}

/** Mirror a Supabase-authenticated user into app_users so joins and FKs work. */
async function ensureAppUser(userId: string, email: string, displayName: string | null): Promise<void> {
  await withOwner(async (db) => {
    await db.query(
      `insert into auth.users (id, email) values ($1, $2)
       on conflict (id) do update set email = excluded.email`,
      [userId, email],
    );
    await db.query(
      `insert into public.app_users (id, email, display_name) values ($1, $2, $3)
       on conflict (id) do update set email = excluded.email,
         display_name = coalesce(public.app_users.display_name, excluded.display_name)`,
      [userId, email, displayName],
    );
  });
}

// ---------------------------------------------------------------------------
// Session assembly
// ---------------------------------------------------------------------------

export async function loadWorkspaceAccess(userId: string): Promise<WorkspaceAccess[]> {
  return withService(async (db) =>
    db.rows<{
      workspace_id: string;
      workspace_slug: string;
      workspace_name: string;
      timezone: string;
      role: WorkspaceAccess['role'];
      can_approve: boolean;
    }>(
      `select m.workspace_id, w.slug as workspace_slug, w.name as workspace_name,
              w.timezone, m.role, m.can_approve
         from public.workspace_members m
         join public.workspaces w on w.id = m.workspace_id
        where m.user_id = $1 and w.status = 'active'
        order by w.name`,
      [userId],
    ),
  ).then((rows) =>
    rows.map((r) => ({
      workspaceId: r.workspace_id,
      workspaceSlug: r.workspace_slug,
      workspaceName: r.workspace_name,
      timezone: r.timezone,
      role: r.role,
      canApprove: r.can_approve,
    })),
  );
}

export interface RawRequestAuth {
  /** `Authorization: Bearer <supabase access token>` */
  bearerToken?: string | null;
  /** Dev-auth session cookie value. */
  sessionCookie?: string | null;
  /** Preferred workspace id from a cookie or query parameter. */
  requestedWorkspaceId?: string | null;
}

export async function resolveSession(raw: RawRequestAuth): Promise<Session | null> {
  let userId: string | null = null;
  let isDevAuth = false;

  if (hasSupabaseAuth() && raw.bearerToken) {
    const payload = await verifySupabaseJwt(raw.bearerToken);
    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    if (!sub) return null;
    const email = typeof payload.email === 'string' ? payload.email : `${sub}@unknown`;
    const meta = payload.user_metadata as { full_name?: string; name?: string } | undefined;
    await ensureAppUser(sub, email, meta?.full_name ?? meta?.name ?? null);
    userId = sub;
  } else if (raw.sessionCookie) {
    userId = readDevSessionToken(raw.sessionCookie);
    isDevAuth = true;
  }

  if (!userId) return null;

  const user = await withService((db) =>
    db.one<{ id: string; email: string; display_name: string | null }>(
      `select id, email, display_name from public.app_users where id = $1`,
      [userId],
    ),
  );
  if (!user) return null;

  const workspaces = await loadWorkspaceAccess(userId);
  if (workspaces.length === 0) return null;

  const active =
    workspaces.find((w) => w.workspaceId === raw.requestedWorkspaceId) ?? (workspaces[0] as WorkspaceAccess);

  return {
    user: { id: user.id, email: user.email, displayName: user.display_name },
    workspaces,
    activeWorkspace: active,
    isDevAuth,
  };
}

export function requireSession(session: Session | null): Session {
  if (!session) throw unauthorized();
  return session;
}

/** Membership check. The server never trusts a workspace id from the client. */
export function requireWorkspace(session: Session, workspaceId: string): WorkspaceAccess {
  const access = session.workspaces.find((w) => w.workspaceId === workspaceId);
  if (!access) throw forbidden('No access to this workspace');
  return access;
}

/** Approval is a distinct capability from membership. */
export function requireApproval(session: Session, workspaceId: string): WorkspaceAccess {
  const access = requireWorkspace(session, workspaceId);
  if (!access.canApprove) throw forbidden('You cannot approve records in this workspace');
  return access;
}

export function requireAdmin(session: Session, workspaceId: string): WorkspaceAccess {
  const access = requireWorkspace(session, workspaceId);
  if (access.role !== 'admin') throw forbidden('Workspace admin required');
  return access;
}

/** Used by seeding and tests. */
export async function grantMembership(
  db: Queryable,
  workspaceId: string,
  userId: string,
  role: WorkspaceAccess['role'],
  canApprove: boolean,
): Promise<void> {
  await db.query(
    `insert into public.workspace_members (workspace_id, user_id, role, can_approve)
     values ($1, $2, $3, $4)
     on conflict (workspace_id, user_id)
       do update set role = excluded.role, can_approve = excluded.can_approve`,
    [workspaceId, userId, role, canApprove],
  );
}
