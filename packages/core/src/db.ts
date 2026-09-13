/**
 * Database access.
 *
 * All data access is plain SQL over `pg`, which means the same code and the same
 * RLS policies run against a local/test Postgres and against Supabase Postgres.
 *
 * Two connection modes, and the distinction matters:
 *
 *   withUser(userId)  -> `set local role authenticated` plus the JWT subject
 *                        bound to the transaction, so every RLS policy applies
 *                        exactly as it would through PostgREST. Used for
 *                        everything done on behalf of a signed-in person.
 *
 *   withService()     -> `set local role service_role` (BYPASSRLS). Used by the
 *                        worker and by the apply step. Every query in this mode
 *                        must filter by workspace_id explicitly; assertScope()
 *                        exists to make that omission loud rather than silent.
 */
import pg from 'pg';
import { env } from './env.js';
import { AppError } from './errors.js';

/**
 * Return dates and timestamps as strings, not JS Date objects.
 *
 * Two reasons. Run dates are calendar dates in a declared timezone (Europe/Paris)
 * and must never be reinterpreted through the host's local timezone -- turning
 * "2026-09-11" into a Date does exactly that. And the row types throughout this
 * package declare these columns as strings, so parsing them to Date would make
 * the types quietly wrong and leak Date formatting into Markdown output.
 */
const OID_DATE = 1082;
const OID_TIMESTAMP = 1114;
const OID_TIMESTAMPTZ = 1184;
pg.types.setTypeParser(OID_DATE, (value) => value);
pg.types.setTypeParser(OID_TIMESTAMPTZ, (value) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
});
pg.types.setTypeParser(OID_TIMESTAMP, (value) => value);

export type Sql = string;
export type Params = readonly unknown[];

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: Sql,
    params?: Params,
  ): Promise<pg.QueryResult<R>>;
  /** Convenience: rows only. */
  rows<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: Sql, params?: Params): Promise<R[]>;
  /** Convenience: first row or null. */
  one<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: Sql, params?: Params): Promise<R | null>;
  /** Convenience: first row, throwing when absent. */
  oneOrFail<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: Sql, params?: Params): Promise<R>;
}

let pool: pg.Pool | null = null;

function isSupabaseUrl(connectionString: string): boolean {
  return /supabase\.(co|com)/.test(connectionString);
}

/**
 * Whether a connection must be destroyed rather than returned to the pool after
 * a failed query.
 *
 * The local PGlite socket server mishandles the extended-protocol error/Sync
 * sequence: after a *parameterised* query fails, leftover backend messages leak
 * into the next query on that connection. Since the apply path deliberately
 * relies on unique-violation errors for idempotency, failed parameterised
 * queries are a normal occurrence, so locally the connection is discarded.
 *
 * Real Postgres does not have this problem, so against Supabase the connection
 * is rolled back and reused as usual. Override with DB_DESTROY_ON_ERROR=1|0.
 */
function destroyOnError(): boolean {
  const override = process.env.DB_DESTROY_ON_ERROR;
  if (override === '1') return true;
  if (override === '0') return false;
  return !isSupabaseUrl(env().DATABASE_URL);
}

export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = env().DATABASE_URL;
  pool = new pg.Pool({
    connectionString,
    // Supabase requires TLS; the local PGlite socket server does not speak it.
    ssl: isSupabaseUrl(connectionString) ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX ?? 6),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });
  pool.on('error', (e) => {
    console.error('[db] idle client error:', e.message);
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

function wrap(client: pg.PoolClient | pg.Client): Queryable {
  const q: Queryable = {
    query: (sql, params) => client.query(sql, params as unknown[]),
    async rows(sql, params) {
      return (await client.query(sql, params as unknown[])).rows as never;
    },
    async one(sql, params) {
      const r = await client.query(sql, params as unknown[]);
      return (r.rows[0] ?? null) as never;
    },
    async oneOrFail(sql, params) {
      const r = await client.query(sql, params as unknown[]);
      const row = r.rows[0];
      if (!row) throw new AppError('Expected exactly one row, got none', 404, 'not_found');
      return row as never;
    },
  };
  return q;
}

type Mode = { kind: 'user'; userId: string } | { kind: 'service' } | { kind: 'owner' };

async function runInTransaction<T>(mode: Mode, fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  let released = false;
  try {
    await client.query('begin');
    if (mode.kind === 'user') {
      // Order matters: bind the claims before switching role, because a
      // non-superuser cannot always set arbitrary GUCs after SET ROLE.
      await client.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', mode.userId]);
      await client.query('select set_config($1, $2, true)', ['request.jwt.claim.role', 'authenticated']);
      await client.query('set local role authenticated');
    } else if (mode.kind === 'service') {
      await client.query('set local role service_role');
    }
    const result = await fn(wrap(client));
    // `set local role` reverts automatically on commit.
    await client.query('commit');
    return result;
  } catch (error) {
    if (destroyOnError()) {
      // Do not speak to this connection again. Destroying it makes the backend
      // abort the open transaction, which is the cleanup we would have asked
      // for with ROLLBACK anyway.
      client.release(true);
      released = true;
    } else {
      try {
        await client.query('rollback');
      } catch {
        client.release(true);
        released = true;
      }
    }
    throw error;
  } finally {
    if (!released) client.release();
  }
}

/**
 * Run `fn` with RLS active for `userId`. Everything read or written inside is
 * subject to the same policies the database would apply to a Supabase client.
 */
export function withUser<T>(userId: string, fn: (db: Queryable) => Promise<T>): Promise<T> {
  return runInTransaction({ kind: 'user', userId }, fn);
}

/**
 * Run `fn` with RLS bypassed. Only the worker and the server-side apply step use
 * this, and they must scope by workspace_id themselves.
 */
export function withService<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  return runInTransaction({ kind: 'service' }, fn);
}

/**
 * Guard for privileged code paths: a workspace id must be a real uuid and must
 * be present. Cheap, but it turns "forgot to scope the query" into an error at
 * the call site instead of a cross-tenant read.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertScope(workspaceId: unknown, context: string): string {
  if (typeof workspaceId !== 'string' || !UUID.test(workspaceId)) {
    throw new AppError(
      `${context}: a valid workspace_id is required for privileged database access`,
      500,
      'missing_workspace_scope',
      { received: workspaceId },
    );
  }
  return workspaceId;
}

/**
 * Run `fn` as the connecting (owner) role, with no SET ROLE at all.
 *
 * Narrow purpose: the local dev-auth provider writes to auth.users, which on
 * Supabase is owned by GoTrue and is never written by the application. Not used
 * for any workspace data.
 */
export function withOwner<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  return runInTransaction({ kind: 'owner' }, fn);
}

/** A single query outside any transaction, as the connecting (owner) role. */
export async function adminQuery<R extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: Sql,
  params?: Params,
): Promise<R[]> {
  const r = await getPool().query<R>(sql, params as unknown[]);
  return r.rows;
}

/** Postgres unique-violation, used to make idempotent writes explicit. */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

export function isForeignKeyViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23503';
}
