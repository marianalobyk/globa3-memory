/**
 * A STRICTLY READ-ONLY connection to whatever DATABASE_URL points at.
 *
 * The production guard (scripts/lib/target.mjs) refuses to connect tooling to a
 * production project at all, because it exists to stop writes. An audit needs to
 * read production and nothing else, so this opens the session with
 * `default_transaction_read_only = on`: Postgres itself then rejects every
 * INSERT, UPDATE, DELETE, CREATE, ALTER and DROP on this connection, regardless
 * of what any caller asks for. It is not a promise in a comment, it is enforced
 * by the server.
 *
 * It never prints the connection string.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import pg from 'pg';

const root = resolve(import.meta.dirname, '..', '..');

export function databaseUrl(file = '.env.local') {
  const values = parse(readFileSync(resolve(root, file), 'utf8'));
  const url = values.DATABASE_URL;
  if (!url) throw new Error(`No DATABASE_URL in ${file}`);
  return url;
}

/** A short description of the target, safe to print. */
export function describe(url) {
  const refs = [...new Set([...String(url).matchAll(/[a-z0-9]{20}/gi)].map((m) => m[0].toLowerCase()))];
  let host = '(unparseable)';
  try { host = new URL(url).hostname; } catch { /* ignore */ }
  return { host, refs };
}

export async function readOnlyClient(url = databaseUrl()) {
  const client = new pg.Client({
    connectionString: url,
    ssl: /supabase\.(co|com)/i.test(url) ? { rejectUnauthorized: false } : undefined,
    application_name: 'g3-readonly-audit',
    statement_timeout: 120_000,
  });
  await client.connect();
  // Enforced by the server for the life of this session.
  await client.query('set session default_transaction_read_only = on');
  await client.query('set session idle_in_transaction_session_timeout = 30000');
  return client;
}

/** Runs a read-only query and returns rows. */
export async function rows(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows;
}
