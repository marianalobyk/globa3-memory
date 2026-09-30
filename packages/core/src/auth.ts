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
import { adminQuery, withOwner, withService, type Queryable } from './db.js';
import { authMode, devAuthEnabled, env, hasSupabaseAuth } from './env.js';
import { AppError, badRequest, forbidden, unauthorized } from './errors.js';

const scrypt = promisify(scryptCb);

export const SESSION_COOKIE = 'g3_session';
export const WORKSPACE_COOKIE = 'g3_workspace';
/** Supabase access token. Short-lived; refreshed from the refresh cookie. */
export const ACCESS_TOKEN_COOKIE = 'g3_at';
/** Supabase refresh token. The only long-lived credential the browser holds. */
export const REFRESH_TOKEN_COOKIE = 'g3_rt';

export interface SupabaseTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  expiresAt: number;
}

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
  options: { resetPassword?: boolean } = {},
): Promise<string> {
  const encrypted = await hashPassword(password);
  const resetPassword = options.resetPassword ?? true;
  return withOwner(async (db) => {
    const user = await db.oneOrFail<{ id: string }>(
      resetPassword
        ? `insert into auth.users (email, encrypted_password) values ($1, $2)
           on conflict (email) do update set encrypted_password = excluded.encrypted_password
           returning id`
        : `insert into auth.users (email, encrypted_password) values ($1, $2)
           on conflict (email) do update set email = excluded.email
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
  if (!devAuthEnabled()) {
    throw forbidden(
      'The local development sign-in is disabled. Set DEV_AUTH_ENABLED=true in a development environment, or configure Supabase Auth.',
    );
  }
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
    // On Supabase, auth.users belongs to Supabase Auth: the user already exists
    // there (that is where the verified token came from), and the application
    // must never write to it. Only the local stand-in table is written to.
    if (authMode() !== 'supabase') {
      await db.query(
        `insert into auth.users (id, email) values ($1, $2)
         on conflict (id) do update set email = excluded.email`,
        [userId, email],
      );
    }
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

/**
 * The session's database part, in ONE round trip: the app user and every active
 * workspace membership. Runs as a single statement outside a transaction, as the
 * server's own role, filtered by the verified user id; it never sees a
 * client-supplied workspace, which is only matched against these memberships.
 *
 * Returns null when the app user row does not exist yet.
 */
async function readSessionRows(userId: string): Promise<{
  user: { id: string; email: string; display_name: string | null };
  workspaces: WorkspaceAccess[];
} | null> {
  const rows = await adminQuery<{
    id: string;
    email: string;
    display_name: string | null;
    workspace_id: string | null;
    workspace_slug: string | null;
    workspace_name: string | null;
    timezone: string | null;
    role: WorkspaceAccess['role'] | null;
    can_approve: boolean | null;
  }>(
    `select u.id, u.email, u.display_name,
            w.id as workspace_id, w.slug as workspace_slug, w.name as workspace_name,
            w.timezone, m.role, m.can_approve
       from public.app_users u
       left join public.workspace_members m on m.user_id = u.id
       left join public.workspaces w on w.id = m.workspace_id and w.status = 'active'
      where u.id = $1
      order by w.name`,
    [userId],
  );
  const first = rows[0];
  if (!first) return null;
  return {
    user: { id: first.id, email: first.email, display_name: first.display_name },
    workspaces: rows
      .filter((r) => r.workspace_id !== null)
      .map((r) => ({
        workspaceId: r.workspace_id as string,
        workspaceSlug: r.workspace_slug as string,
        workspaceName: r.workspace_name as string,
        timezone: r.timezone as string,
        role: r.role as WorkspaceAccess['role'],
        canApprove: Boolean(r.can_approve),
      })),
  };
}

/**
 * Builds the session for an authenticated user id.
 *
 * The app_users mirror used to be upserted on every request, in its own
 * transaction. It is now written only when it is missing or the token's email
 * differs from the stored one, which is the only time the upsert changed
 * anything.
 */
export async function loadSessionForUser(input: {
  userId: string;
  email?: string | null;
  displayName?: string | null;
  requestedWorkspaceId: string | null;
  isDevAuth?: boolean;
}): Promise<Session | null> {
  let loaded = await readSessionRows(input.userId);
  const emailChanged = Boolean(input.email) && loaded !== null && loaded.user.email !== input.email;
  if (input.email && (loaded === null || emailChanged)) {
    await ensureAppUser(input.userId, input.email, input.displayName ?? null);
    loaded = await readSessionRows(input.userId);
  }
  if (!loaded || loaded.workspaces.length === 0) return null;

  const active =
    loaded.workspaces.find((w) => w.workspaceId === input.requestedWorkspaceId) ??
    (loaded.workspaces[0] as WorkspaceAccess);

  return {
    user: { id: loaded.user.id, email: loaded.user.email, displayName: loaded.user.display_name },
    workspaces: loaded.workspaces,
    activeWorkspace: active,
    isDevAuth: input.isDevAuth ?? false,
  };
}

export async function resolveSession(raw: RawRequestAuth): Promise<Session | null> {
  const timing = process.env.G3_DB_TIMING === '1';
  const started = performance.now();
  const mark = (label: string) => {
    if (timing) console.log(`[session] ${label} at ${Math.round(performance.now() - started)}ms`);
  };

  const mode = authMode();

  if (mode === 'supabase') {
    // The access token is verified here, every request. The dev cookie is
    // ignored entirely in this mode, so a stale one cannot be used as a bypass.
    if (!raw.bearerToken) return null;
    let payload;
    try {
      payload = await verifySupabaseJwt(raw.bearerToken);
      mark('jwt verified');
    } catch {
      // Expired or invalid. The middleware refreshes before this point; getting
      // here means there is no usable session.
      return null;
    }
    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    if (!sub) return null;
    const email = typeof payload.email === 'string' ? payload.email : `${sub}@unknown`;
    const meta = payload.user_metadata as { full_name?: string; name?: string } | undefined;
    const session = await loadSessionForUser({
      userId: sub,
      email,
      displayName: meta?.full_name ?? meta?.name ?? null,
      requestedWorkspaceId: raw.requestedWorkspaceId ?? null,
    });
    mark('session loaded');
    return session;
  }

  if (mode === 'dev' && raw.sessionCookie) {
    const userId = readDevSessionToken(raw.sessionCookie);
    if (!userId) return null;
    return loadSessionForUser({ userId, requestedWorkspaceId: raw.requestedWorkspaceId ?? null, isDevAuth: true });
  }

  // No authenticator configured: refuse rather than falling back to anything.
  return null;
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

// ---------------------------------------------------------------------------
// Supabase Auth
// ---------------------------------------------------------------------------

/**
 * Supabase's auth endpoints, called directly over HTTP.
 *
 * Deliberately plain `fetch` rather than the supabase-js client: these run in
 * request handlers and in middleware, the payloads are three fields, and it
 * keeps the token handling explicit and inspectable.
 */
async function supabaseAuthRequest<T>(
  path: string,
  init: { method: string; body?: unknown; accessToken?: string },
): Promise<T> {
  const e = env();
  if (!e.SUPABASE_URL || !e.SUPABASE_ANON_KEY) {
    throw new AppError('Supabase Auth is not configured', 500, 'supabase_auth_not_configured');
  }

  let response: Response;
  try {
    response = await fetch(`${e.SUPABASE_URL}/auth/v1/${path}`, {
      method: init.method,
      headers: {
        apikey: e.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${init.accessToken ?? e.SUPABASE_ANON_KEY}`,
        'content-type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (error) {
    // DNS failure, TLS failure, timeout. Surfaced as a provider error rather
    // than a raw TypeError, so the UI can say the provider is unreachable
    // instead of showing "fetch failed".
    throw new AppError(
      `Could not reach Supabase Auth at ${e.SUPABASE_URL}: ${error instanceof Error ? error.message : 'network error'}`,
      502,
      'supabase_auth_unreachable',
    );
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error_description?: string;
      msg?: string;
      message?: string;
      error?: string;
    };
    const detail =
      payload.error_description ?? payload.msg ?? payload.message ?? payload.error ?? 'Sign-in failed';
    // Do not leak whether the email exists.
    if (response.status === 400 || response.status === 401) {
      throw unauthorized('Unknown email or password');
    }
    throw new AppError(`Supabase Auth: ${detail}`, 502, 'supabase_auth_error');
  }

  return (await response.json()) as T;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: number;
}

function toTokens(payload: TokenResponse): SupabaseTokens {
  const expiresIn = payload.expires_in ?? 3600;
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresIn,
    expiresAt: payload.expires_at ?? Math.floor(Date.now() / 1000) + expiresIn,
  };
}

/**
 * Exchanges an email and password for a Supabase session.
 *
 * The password is handled only here, server-side, and never stored: what the
 * browser receives is an httpOnly cookie pair it cannot read from JavaScript.
 */
export async function signInWithSupabase(email: string, password: string): Promise<SupabaseTokens> {
  if (!hasSupabaseAuth()) {
    throw new AppError('Supabase Auth is not configured', 500, 'supabase_auth_not_configured');
  }
  const payload = await supabaseAuthRequest<TokenResponse>('token?grant_type=password', {
    method: 'POST',
    body: { email: email.toLowerCase().trim(), password },
  });
  return toTokens(payload);
}

/** Exchanges a refresh token for a fresh pair. Used by the middleware. */
export async function refreshSupabaseSession(refreshToken: string): Promise<SupabaseTokens> {
  const payload = await supabaseAuthRequest<TokenResponse>('token?grant_type=refresh_token', {
    method: 'POST',
    body: { refresh_token: refreshToken },
  });
  return toTokens(payload);
}

/**
 * Revokes the session at Supabase.
 *
 * Clearing cookies alone would leave the refresh token valid until it expires,
 * so signing out has to tell Supabase too. A failure here is not fatal -- the
 * cookies are cleared regardless -- but it is reported so it can be noticed.
 */
export async function signOutSupabase(accessToken: string): Promise<{ revoked: boolean; note: string | null }> {
  try {
    await supabaseAuthRequest<unknown>('logout', { method: 'POST', accessToken });
    return { revoked: true, note: null };
  } catch (error) {
    return {
      revoked: false,
      note: error instanceof Error ? error.message : 'Could not revoke the session at Supabase',
    };
  }
}

/** True when the access token is expired, or close enough to treat as expired. */
export function accessTokenNeedsRefresh(token: string, skewSeconds = 60): boolean {
  const claims = decodeJwtClaims(token);
  if (!claims?.exp) return true;
  return claims.exp * 1000 - skewSeconds * 1000 <= Date.now();
}

/**
 * Reads JWT claims WITHOUT verifying the signature.
 *
 * Only ever used to decide whether to refresh. Every security decision goes
 * through verifySupabaseJwt, which does verify.
 */
export function decodeJwtClaims(token: string): { exp?: number; sub?: string; email?: string } | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json) as { exp?: number; sub?: string; email?: string };
  } catch {
    return null;
  }
}

export { authMode, devAuthEnabled };


// ---------------------------------------------------------------------------
// Creating users for seeding and tests
// ---------------------------------------------------------------------------

async function supabaseAdminRequest<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
  const e = env();
  if (!e.SUPABASE_URL || !e.SUPABASE_SERVICE_ROLE_KEY) {
    throw new AppError('Supabase Admin API needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY', 500, 'supabase_admin_not_configured');
  }
  let response: Response;
  try {
    response = await fetch(`${e.SUPABASE_URL}/auth/v1/admin/${path}`, {
      method: init.method,
      headers: {
        apikey: e.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${e.SUPABASE_SERVICE_ROLE_KEY}`,
        'content-type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (error) {
    throw new AppError(
      `Could not reach the Supabase Admin API: ${error instanceof Error ? error.message : 'network error'}`,
      502,
      'supabase_auth_unreachable',
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw new AppError(`Supabase Admin API ${init.method} ${path}: ${response.status} ${text.slice(0, 300)}`, response.status, 'supabase_admin_error');
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Ensures a user exists and can sign in with the given password, and mirrors it
 * into app_users.
 *
 * With Supabase Auth configured, the user is created through the Admin API, so
 * Supabase Auth owns the account exactly as it would for a real sign-up. The
 * password of an existing seed user is reset to the given one, so the live
 * sign-in checks are repeatable; seeding refuses non-test remote targets, so this
 * only ever happens on a local or declared test project.
 *
 * `resetPassword: false` leaves an existing account exactly as it is: the
 * import bootstrap uses it, because the testers of an imported copy set their
 * own passwords and a re-run must not undo that.
 *
 * Without Supabase Auth, the local development table is used.
 */
export async function ensureUser(
  email: string,
  password: string,
  displayName?: string,
  options: { resetPassword?: boolean } = {},
): Promise<string> {
  const normalized = email.toLowerCase().trim();
  const resetPassword = options.resetPassword ?? true;
  if (authMode() !== 'supabase') return upsertDevUser(normalized, password, displayName, { resetPassword });

  type AdminUser = { id: string; email?: string };
  let userId: string | null = null;
  try {
    const created = await supabaseAdminRequest<AdminUser>('users', {
      method: 'POST',
      body: {
        email: normalized,
        password,
        email_confirm: true,
        user_metadata: displayName ? { full_name: displayName } : {},
      },
    });
    userId = created.id;
  } catch (error) {
    if (!(error instanceof AppError) || (error.status !== 422 && error.status !== 400)) throw error;
    // Already registered: find it and reset the password to the seed value.
    for (let page = 1; page <= 20 && !userId; page += 1) {
      const listed = await supabaseAdminRequest<{ users: AdminUser[] }>(`users?page=${page}&per_page=200`, { method: 'GET' });
      const match = listed.users.find((u) => u.email?.toLowerCase() === normalized);
      if (match) userId = match.id;
      if (listed.users.length < 200) break;
    }
    if (!userId) throw error;
    if (resetPassword) {
      await supabaseAdminRequest(`users/${userId}`, { method: 'PUT', body: { password } });
    }
  }

  await ensureAppUser(userId, normalized, displayName ?? normalized.split('@')[0] ?? null);
  return userId;
}
