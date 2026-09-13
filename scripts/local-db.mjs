#!/usr/bin/env node
/**
 * Local/test Postgres for development.
 *
 * Runs PGlite (real Postgres 18 compiled to WASM) with a persistent data
 * directory and exposes it on the Postgres wire protocol, so the Next.js app,
 * the worker and psql-style tooling all connect to one shared database with an
 * ordinary `pg` client and an ordinary DATABASE_URL.
 *
 * This exists because the project's Supabase host does not resolve and this
 * machine has no Docker/Postgres/Supabase CLI. Production uses Supabase
 * Postgres with the same migrations and the same SQL.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.LOCAL_PG_DATA ?? resolve(root, '.data/pgdata');
const port = Number(process.env.LOCAL_PG_PORT ?? 54329);
const host = process.env.LOCAL_PG_HOST ?? '127.0.0.1';

mkdirSync(dirname(dataDir), { recursive: true });

const db = await PGlite.create({ dataDir });
const version = (await db.query('select version() as v')).rows[0].v;

// PGlite is single-threaded, so the socket server serialises queries through
// one queue with transaction affinity. maxConnections must still be > 1: the
// web app and the worker are separate processes, each with its own pool.
const server = new PGLiteSocketServer({
  db,
  port,
  host,
  maxConnections: Number(process.env.LOCAL_PG_MAX_CONNECTIONS ?? 24),
  idleTimeout: 0,
  debug: process.env.LOCAL_PG_DEBUG === '1',
});
await server.start();

console.log(`[local-db] ${String(version).split(' on ')[0]}`);
console.log(`[local-db] data dir: ${dataDir}`);
console.log(`[local-db] listening on postgres://postgres:postgres@${host}:${port}/postgres`);
console.log('[local-db] leave this running; Ctrl+C to stop');

let closing = false;
const shutdown = async (signal) => {
  if (closing) return;
  closing = true;
  console.log(`\n[local-db] ${signal} -> flushing and closing`);
  try { await server.stop(); } catch {}
  try { await db.close(); } catch {}
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
