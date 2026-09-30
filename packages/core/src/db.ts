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

/**
 * One pool per server process.
 *
 * Kept on globalThis: Next.js may evaluate this module more than once (per
 * route bundle, and again on every dev recompile), and a module-level variable
 * would then give each copy its own pool, each paying its own TLS and pooler
 * handshakes (~0.7-1 s each against Supabase).
 */
const globalPool = globalThis as unknown as { __g3Pool?: pg.Pool | null };

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
  // Read globalThis every time, never a module-level copy: a second copy of this
  // module loaded after the first must find the existing pool, not create one.
  const existing = globalPool.__g3Pool;
  if (existing) return existing;
  const connectionString = env().DATABASE_URL;
  const pool = new pg.Pool({
    connectionString,
    // Supabase requires TLS; the local PGlite socket server does not speak it.
    ssl: isSupabaseUrl(connectionString) ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX ?? 6),
    // A new connection to the Supabase pooler costs ~0.7-1 s (TCP, TLS, auth),
    // ten times a query round trip. Closing idle connections after 30 s meant a
    // short pause between two clicks paid that again, so idle connections are
    // kept for 10 minutes by default. A connection the server drops is
    // discarded by pg ('error' below) and replaced on the next request.
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 600_000),
    keepAlive: true,
    connectionTimeoutMillis: 15_000,
  });
  pool.on('error', (e) => {
    console.error('[db] idle client error:', e.message);
  });
  globalPool.__g3Pool = pool;
  return pool;
}

/**
 * Opens up to `count` connections ahead of the first request, so the first
 * navigation after a server start does not pay the handshakes. Best effort.
 */
export async function warmPool(count = 3): Promise<number> {
  const p = getPool();
  const clients = await Promise.allSettled(Array.from({ length: count }, () => p.connect()));
  let opened = 0;
  for (const result of clients) {
    if (result.status === 'fulfilled') {
      opened += 1;
      result.value.release();
    }
  }
  return opened;
}

export async function closePool(): Promise<void> {
  const p = globalPool.__g3Pool;
  if (p) {
    globalPool.__g3Pool = null;
    await p.end();
  }
}

/**
 * Database tracing, for diagnostics and the performance regression check.
 *
 * Off unless G3_DB_TIMING=1 (which logs one line per transaction) or a listener
 * is registered with onDbTrace() (scripts/perf/nav-profile.mts does). Traces
 * carry timings and a short SQL excerpt, never parameters.
 */
export interface DbTraceEvent {
  /** 'transaction' for withUser/withService/withOwner, 'query' for a single pooled statement. */
  kind: 'transaction' | 'query';
  mode: 'user' | 'service' | 'owner';
  readOnly: boolean;
  totalMs: number;
  /** Time spent waiting for a pooled connection. */
  connectMs: number;
  /** True when no idle connection existed, so a new one was (most likely) opened. */
  newConnection: boolean;
  /** Transaction set-up round trip (begin, claims, role). 0 for single queries. */
  setupMs: number;
  statements: { ms: number; sql: string }[];
}

type DbTraceListener = (event: DbTraceEvent) => void;
const traceRegistry = globalThis as unknown as { __g3DbTrace?: Set<DbTraceListener> };
const traceListeners = (traceRegistry.__g3DbTrace ??= new Set<DbTraceListener>());

export function onDbTrace(listener: DbTraceListener): () => void {
  traceListeners.add(listener);
  return () => traceListeners.delete(listener);
}

const tracingEnabled = () => process.env.G3_DB_TIMING === '1' || traceListeners.size > 0;

interface TxTrace {
  statements: { ms: number; sql: string }[];
}

function sqlExcerpt(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 70);
}

function emitTrace(event: DbTraceEvent): void {
  if (process.env.G3_DB_TIMING === '1') {
    const body = event.statements.map((st) => `${st.ms}ms "${st.sql}"`).join(' | ');
    console.log(
      `[db] ${event.mode} ${event.kind}${event.readOnly ? ' (read only)' : ''} ${event.totalMs}ms: ` +
        `connect ${event.connectMs}ms${event.newConnection ? ' (no idle connection)' : ''}, ` +
        `setup ${event.setupMs}ms, ${event.statements.length} stmt: ${body}`,
    );
  }
  for (const listener of traceListeners) {
    try {
      listener(event);
    } catch {
      // A diagnostics listener must never break a request.
    }
  }
}

function wrap(client: pg.PoolClient | pg.Client, trace?: TxTrace): Queryable {
  const run = async (sql: Sql, params?: Params) => {
    if (!trace) return client.query(sql, params as unknown[]);
    const started = performance.now();
    try {
      return await client.query(sql, params as unknown[]);
    } finally {
      trace.statements.push({ ms: Math.round(performance.now() - started), sql: sqlExcerpt(sql) });
    }
  };
  const q: Queryable = {
    query: (sql, params) => run(sql, params) as never,
    async rows(sql, params) {
      return (await run(sql, params)).rows as never;
    },
    async one(sql, params) {
      const r = await run(sql, params);
      return (r.rows[0] ?? null) as never;
    },
    async oneOrFail(sql, params) {
      const r = await run(sql, params);
      const row = r.rows[0];
      if (!row) throw new AppError('Expected exactly one row, got none', 404, 'not_found');
      return row as never;
    },
  };
  return q;
}

type Mode = { kind: 'user'; userId: string } | { kind: 'service' } | { kind: 'owner' };

const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The statements that open a transaction in the given mode.
 *
 * The simple protocol carries no parameters, so the user id is embedded as a
 * literal. It is only ever the subject of a verified token or a session read
 * from the database, and it is refused here unless it is a strict UUID, which
 * cannot contain a quote or anything else that could change the statement.
 */
function transactionSetupSql(mode: Mode, readOnly: boolean): string {
  const begin = readOnly ? 'begin read only' : 'begin';
  if (mode.kind === 'user') {
    if (!STRICT_UUID.test(mode.userId)) {
      throw new AppError('Refusing to open a user transaction for a malformed user id', 500, 'invalid_user_id');
    }
    // Order matters: bind the claims before switching role, because a
    // non-superuser cannot always set arbitrary GUCs after SET ROLE.
    return (
      `${begin}; ` +
      `select set_config('request.jwt.claim.sub', '${mode.userId.toLowerCase()}', true); ` +
      "select set_config('request.jwt.claim.role', 'authenticated', true); " +
      'set local role authenticated'
    );
  }
  if (mode.kind === 'service') return `${begin}; set local role service_role`;
  return begin;
}

async function runInTransaction<T>(
  mode: Mode,
  fn: (db: Queryable) => Promise<T>,
  options: { readOnly?: boolean } = {},
): Promise<T> {
  const readOnly = options.readOnly === true;
  const trace: TxTrace | undefined = tracingEnabled() ? { statements: [] } : undefined;
  const txStarted = performance.now();
  const newConnection = trace ? getPool().idleCount === 0 : false;
  const client = await getPool().connect();
  const connectMs = Math.round(performance.now() - txStarted);
  // pg removes its own idle-client error handler while a connection is checked
  // out, so a connection the network drops mid-transaction (a laptop sleeping,
  // a hotspot timing out an idle TLS socket while a model call runs) emits an
  // unhandled 'error' and takes the whole process down. Listen for the length
  // of the checkout and let the in-flight query reject normally instead.
  const swallow = (error: Error) => {
    console.error('[db] connection lost during a transaction:', error.message);
  };
  client.on('error', swallow);
  const release = (destroy?: boolean) => {
    client.removeListener('error', swallow);
    client.release(destroy);
  };
  let released = false;
  let setupMs = 0;
  const report = () => {
    if (!trace) return;
    emitTrace({
      kind: 'transaction',
      mode: mode.kind,
      readOnly,
      totalMs: Math.round(performance.now() - txStarted),
      connectMs,
      newConnection,
      setupMs,
      statements: trace.statements,
    });
  };
  try {
    // The whole transaction set-up goes in ONE simple-protocol message: against
    // the Supabase pooler every separate statement is a ~100 ms round trip, and
    // the four statements a user transaction needs used to cost ~400 ms before
    // the first real query. Semantics are unchanged: the statements still run in
    // order inside the transaction that `begin` opens.
    await client.query(transactionSetupSql(mode, readOnly));
    setupMs = Math.round(performance.now() - txStarted) - connectMs;
    const result = await fn(wrap(client, trace));

    if (readOnly) {
      // A READ ONLY transaction cannot have written anything, and everything it
      // read is already in `result`, so the caller does not need to wait for the
      // COMMIT round trip. The connection goes back to the pool only once the
      // commit has completed; if it fails, the connection is discarded.
      released = true;
      client.query('commit').then(
        () => release(),
        (error: unknown) => {
          release(true);
          console.error('[db] commit of a read-only transaction failed:', error instanceof Error ? error.message : error);
        },
      );
      report();
      return result;
    }

    // `set local role` reverts automatically on commit.
    await client.query('commit');
    report();
    return result;
  } catch (error) {
    if (released) throw error;
    if (destroyOnError()) {
      // Do not speak to this connection again. Destroying it makes the backend
      // abort the open transaction, which is the cleanup we would have asked
      // for with ROLLBACK anyway.
      release(true);
      released = true;
    } else {
      try {
        await client.query('rollback');
      } catch {
        release(true);
        released = true;
      }
    }
    throw error;
  } finally {
    if (!released) release();
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
 * Read-only variant of withUser for page loads: same RLS identity, but the
 * transaction is READ ONLY, so any attempt to write fails in the database, and
 * the caller does not wait for the COMMIT round trip.
 */
export function withUserRead<T>(userId: string, fn: (db: Queryable) => Promise<T>): Promise<T> {
  return runInTransaction({ kind: 'user', userId }, fn, { readOnly: true });
}

/**
 * Run `fn` with RLS bypassed. Only the worker and the server-side apply step use
 * this, and they must scope by workspace_id themselves.
 */
export function withService<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  return runInTransaction({ kind: 'service' }, fn);
}

/** Read-only variant of withService; see withUserRead. Callers still scope by workspace_id. */
export function withServiceRead<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  return runInTransaction({ kind: 'service' }, fn, { readOnly: true });
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
  if (!tracingEnabled()) return (await getPool().query<R>(sql, params as unknown[])).rows;
  const started = performance.now();
  const newConnection = getPool().idleCount === 0;
  const r = await getPool().query<R>(sql, params as unknown[]);
  const totalMs = Math.round(performance.now() - started);
  emitTrace({
    kind: 'query',
    mode: 'owner',
    readOnly: false,
    totalMs,
    connectMs: 0,
    newConnection,
    setupMs: 0,
    statements: [{ ms: totalMs, sql: sqlExcerpt(sql) }],
  });
  return r.rows;
}

/** Postgres unique-violation, used to make idempotent writes explicit. */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

export function isForeignKeyViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23503';
}
