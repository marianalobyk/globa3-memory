#!/usr/bin/env node
/**
 * Applies supabase/migrations in filename order, once each, inside a
 * transaction, recording a checksum in public.schema_migrations.
 *
 * Works against the local PGlite server and against Supabase Postgres
 * (DATABASE_URL = the project's Postgres connection string). Re-running is a
 * no-op. A changed already-applied file is reported, never silently re-applied.
 *
 *   node scripts/migrate.mjs           # apply pending
 *   node scripts/migrate.mjs --status  # list state only
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(root, 'supabase/migrations');
const statusOnly = process.argv.includes('--status');

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:54329/postgres';

const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

const client = new pg.Client({
  connectionString,
  ssl: connectionString.includes('supabase.co') ? { rejectUnauthorized: false } : undefined,
});
await client.connect();

// 0000 creates schema_migrations itself, so bootstrap it here for the first run.
await client.query(`create table if not exists public.schema_migrations (
  version text primary key, checksum text not null, applied_at timestamptz not null default now())`);

const applied = new Map(
  (await client.query('select version, checksum from public.schema_migrations')).rows.map((r) => [
    r.version,
    r.checksum,
  ]),
);

let failed = false;
for (const file of files) {
  const sql = readFileSync(resolve(dir, file), 'utf8');
  const checksum = sha(sql);
  const prior = applied.get(file);

  if (prior === checksum) {
    console.log(`  ok      ${file}`);
    continue;
  }
  if (prior && prior !== checksum) {
    console.error(`  CHANGED ${file} (applied ${prior}, file ${checksum}) -- add a new migration instead`);
    failed = true;
    continue;
  }
  if (statusOnly) {
    console.log(`  pending ${file}`);
    continue;
  }

  process.stdout.write(`  apply   ${file} ... `);
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query(
      `insert into public.schema_migrations (version, checksum) values ($1, $2)
       on conflict (version) do update set checksum = excluded.checksum, applied_at = now()`,
      [file, checksum],
    );
    await client.query('commit');
    console.log('done');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    console.log('FAILED');
    console.error(`\n${error.message}\n`);
    if (error.position) {
      const pos = Number(error.position);
      console.error('near:', JSON.stringify(sql.slice(Math.max(0, pos - 220), pos + 120)));
    }
    await client.end();
    process.exit(1);
  }
}

await client.end();
process.exit(failed ? 1 : 0);
