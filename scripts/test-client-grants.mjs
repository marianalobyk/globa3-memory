#!/usr/bin/env node
/**
 * Migration 0018 against Supabase-style grants, on an ISOLATED throwaway database.
 *
 *   npm run verify:grants
 *
 * A local database does not inherit Supabase's default privileges, so applying
 * the migrations alone would not prove anything. This test migrates a fresh
 * database, then recreates what Supabase grants by default (ALL on tables and
 * sequences, EXECUTE on functions, to anon and authenticated, plus the matching
 * default ACLs), re-runs 0018 twice to show it is idempotent, and checks the
 * result with the same checker used against the test project. It then proves
 * the behaviour: a signed-in role cannot TRUNCATE, insert, update, delete,
 * setval or call the legacy writer; it can still read under RLS; the server
 * role can still write.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { checkClientGrants, inspectClientGrants, summariseGrants } from './lib/client-grants.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = 56000 + Math.floor(Math.random() * 900);
const dir = mkdtempSync(join(tmpdir(), 'g3-grants-'));
const url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
const env = { ...process.env, DATABASE_URL: url, G3_SKIP_ROOT_ENV: '1', SUPABASE_URL: '', G3_TARGET_ENV: '', SUPABASE_TEST_PROJECT_REF: '' };
const migration = readFileSync(resolve(root, 'supabase/migrations/0018_revoke_client_write_privileges.sql'), 'utf8');

let failures = 0;
const show = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? `\n        ${detail}` : ''}`);
};

const server = spawn(process.execPath, ['scripts/local-db.mjs'], {
  cwd: root,
  env: { ...process.env, LOCAL_PG_PORT: String(port), LOCAL_PG_DATA: join(dir, 'pgdata') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const client = new pg.Client({ connectionString: url });
try {
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('database did not start')), 30_000);
    server.stdout.on('data', (c) => String(c).includes('listening') && (clearTimeout(timer), ok()));
    server.on('exit', (code) => fail(new Error(`database exited (${code})`)));
  });
  const migrate = spawnSync(process.execPath, ['scripts/migrate.mjs'], { cwd: root, env, encoding: 'utf8' });
  if (migrate.status !== 0) throw new Error(`migrate failed:\n${migrate.stdout}\n${migrate.stderr}`);
  await client.connect();

  console.log('\x1b[1mClient grants (migration 0018)\x1b[0m\n\n1. After migrating a fresh database');
  for (const r of checkClientGrants(await inspectClientGrants(client))) show(r.name, r.ok, r.detail);

  console.log('\n2. After recreating Supabase default grants, then re-running 0018 twice');
  await client.query(`
    grant all on all tables in schema public to anon, authenticated;
    grant all on all sequences in schema public to anon, authenticated;
    grant execute on all functions in schema public to anon, authenticated, public;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated, public;`);
  const simulated = summariseGrants(await inspectClientGrants(client));
  show('the simulation reproduces the Supabase finding', simulated.authenticatedWriteTables === simulated.tables && simulated.clientSequences > 0 && simulated.anonFunctions > 0, JSON.stringify({ authenticatedWriteTables: simulated.authenticatedWriteTables, clientSequences: simulated.clientSequences, anonFunctions: simulated.anonFunctions }));
  await client.query(migration);
  await client.query(migration);
  const after = await inspectClientGrants(client);
  for (const r of checkClientGrants(after)) show(r.name, r.ok, r.detail);

  console.log('\n3. Behaviour');
  const ws = (await client.query(`insert into public.workspaces (slug, name, timezone) values ($1,'Grants','UTC') returning id`, [`grants-${randomUUID().slice(0, 8)}`])).rows[0].id;
  const future = `grants_future_${randomUUID().slice(0, 6)}`;
  await client.query(`create table public.${future} (id int)`);
  const futureGrants = (await client.query(`select grantee from information_schema.role_table_grants where table_schema='public' and table_name=$1 and grantee in ('anon','authenticated')`, [future])).rows;
  show('a table created later gives anon/authenticated no privilege', futureGrants.length === 0);
  await client.query(`drop table public.${future}`);

  // One connection per attempt: a refused statement can leave a local PGlite
  // connection out of sync, which would turn the next check into noise.
  const asRole = async (role, sql, params = []) => {
    const one = new pg.Client({ connectionString: url });
    one.on('error', () => undefined);
    await one.connect();
    try {
      await one.query('begin');
      await one.query(`select set_config('request.jwt.claim.sub', '${randomUUID()}', true)`);
      await one.query(`set local role ${role}`);
      const res = await one.query(sql, params);
      return { ok: true, rows: res.rowCount };
    } catch (error) {
      return { ok: false, code: error.code };
    } finally {
      await one.query('rollback').catch(() => undefined);
      await one.end().catch(() => undefined);
    }
  };
  const denied = (r) => !r.ok && r.code === '42501';
  show('authenticated: TRUNCATE refused', denied(await asRole('authenticated', 'truncate public.entities')));
  show('authenticated: INSERT refused', denied(await asRole('authenticated', `insert into public.entities (workspace_id, entity_type, display_name, slug) values ($1,'person','x','x')`, [ws])));
  show('authenticated: UPDATE refused', denied(await asRole('authenticated', `update public.captures set status = 'discarded'`)));
  show('authenticated: DELETE refused', denied(await asRole('authenticated', 'delete from public.proposal_items')));
  show('authenticated: update of proposal_items decision columns refused', denied(await asRole('authenticated', `update public.proposal_items set decision = 'approved'`)));
  show('authenticated: writing migration history refused', denied(await asRole('authenticated', 'delete from public.schema_migrations')));
  show('authenticated: setval on a sequence refused', denied(await asRole('authenticated', `select setval('public.activity_log_id_seq', 1)`)));
  show('authenticated: legacy writer function refused', denied(await asRole('authenticated', `select public.upsert_legacy_record('knowledge', '{}'::jsonb, 'skip', $1)`, [ws])));
  show('anon: SELECT refused', denied(await asRole('anon', 'select 1 from public.entities limit 1')));
  const read = await asRole('authenticated', 'select id from public.entities limit 1');
  show('authenticated: SELECT under RLS still works (no rows for a non-member)', read.ok && read.rows === 0, read.code ?? '');
  const service = await asRole('service_role', `insert into public.activity_log (workspace_id, actor_kind, action, summary) values ($1,'system','grants.check','check')`, [ws]);
  show('service_role: writes still work (insert, using the sequence)', service.ok, service.code ?? '');
  const serviceFn = await asRole('service_role', `select public.upsert_legacy_record('knowledge', $1::jsonb, 'skip', $2)`, [JSON.stringify({ slug: 'grants-check', title: 't', content: 'c' }), ws]);
  show('service_role: legacy writer function still executes', serviceFn.ok, serviceFn.code ?? '');
} catch (error) {
  failures += 1;
  console.error(error instanceof Error ? error.message : error);
} finally {
  await client.end().catch(() => undefined);
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${failures === 0 ? 'All client grant checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
