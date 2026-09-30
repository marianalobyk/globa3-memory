#!/usr/bin/env node
/**
 * A production-shaped rehearsal database, and the migration rehearsed on it.
 *
 *   node scripts/prod-audit/rehearsal.mjs up       start the rehearsal database
 *   node scripts/prod-audit/rehearsal.mjs restore  load the verified backup into it
 *   node scripts/prod-audit/rehearsal.mjs migrate  dry-run, then apply every migration
 *   node scripts/prod-audit/rehearsal.mjs check    integrity report
 *   node scripts/prod-audit/rehearsal.mjs down     stop it
 *
 * Production is never contacted: the only input is the backup taken on
 * 28 September 2026. The database lives outside the repository and persists
 * between commands so each stage can be inspected on its own.
 *
 * Fidelity, stated plainly: this is a real PostgreSQL 17 cluster -- the same
 * major version production runs -- but it is not Supabase. Migration 0000
 * creates local stand-ins for `auth.users`, `auth.uid()` and the anon /
 * authenticated / service_role roles, so 0007 (RLS) and 0018 (privileges) do
 * execute and their SQL is proven valid, acting on those stand-ins. What this
 * rehearsal proves is that the migration set applies cleanly to production's
 * actual 1183 rows without losing or duplicating one. What it cannot prove is
 * Supabase-specific behaviour; only `migrate.mjs --dry-run` against production
 * itself can, and that is stage 2 of the runbook.
 *
 * PGlite was tried first and cannot do this: it hung indefinitely (0.1% CPU for
 * 25 minutes) while restoring production's foreign keys and indexes.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const root = resolve(import.meta.dirname, '..', '..');
const HOME = join(homedir(), '.globa3-rehearsal');
const DATA = join(HOME, 'pgdata');
const PID = join(HOME, 'db.pid');
const LOG = join(HOME, 'rehearsal.log');
const PGBIN = '/opt/homebrew/opt/postgresql@17/bin';
const PSQL = join(PGBIN, 'psql');
const PG_RESTORE = join(PGBIN, 'pg_restore');
const PORT = 57951;
export const URL = `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres`;
const BACKUP = process.env.G3_BACKUP_DIR ?? join(homedir(), 'globa3-backups', 'prod-2026-09-28T21-09-54');
const migDir = resolve(root, 'supabase/migrations');
const PROD_COUNTS = JSON.parse(readFileSync(join(root, 'scripts/prod-audit/out-counts.json'), 'utf8'));

mkdirSync(HOME, { recursive: true });
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const say = (s) => { console.log(s); appendFileSync(LOG, s + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const migrateEnv = {
  ...process.env,
  DATABASE_URL: URL,
  SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '',
  G3_TARGET_ENV: '', SUPABASE_TEST_PROJECT_REF: '', G3_SKIP_ROOT_ENV: '1',
};

async function reachable() {
  const c = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

async function up({ fresh = false } = {}) {
  if (await reachable()) {
    if (!fresh) { say(`rehearsal database already up on ${PORT}`); return; }
    down();
    await sleep(2000);
  }
  if (fresh) rmSync(DATA, { recursive: true, force: true });
  if (!existsSync(join(DATA, 'PG_VERSION'))) {
    const init = spawnSync(join(PGBIN, 'initdb'), ['--pgdata', DATA, '--encoding', 'UTF8', '--username', 'postgres', '--auth', 'trust'],
      { encoding: 'utf8', env: { ...process.env, LC_ALL: 'en_US.UTF-8' } });
    if (init.status !== 0) throw new Error(`initdb failed:\n${init.stderr}`);
    say(`  initialised a fresh PostgreSQL 17 cluster at ${DATA}`);
  }
  // Without an explicit locale the macOS build aborts with "postmaster became
  // multithreaded during startup".
  const started = spawnSync(join(PGBIN, 'pg_ctl'), ['--pgdata', DATA, '--log', join(HOME, 'postgres.log'),
    '--options', `-p ${PORT} -k ${HOME} -c listen_addresses=127.0.0.1`, '--wait', 'start'],
    { encoding: 'utf8', env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' } });
  if (started.status !== 0) throw new Error(`pg_ctl start failed:\n${started.stdout}\n${started.stderr}`);
  writeFileSync(PID, DATA);
  const version = spawnSync(join(PGBIN, 'psql'), ['--dbname', URL, '-Atc', 'select version()'], { encoding: 'utf8' });
  say(`rehearsal database up on ${PORT}: ${(version.stdout || '').split(' ').slice(0, 2).join(' ')}`);
}

function down() {
  const stopped = spawnSync(join(PGBIN, 'pg_ctl'), ['--pgdata', DATA, '--mode', 'fast', '--wait', 'stop'], { encoding: 'utf8' });
  say(stopped.status === 0 ? 'rehearsal database stopped' : 'rehearsal database was not running');
  rmSync(PID, { force: true });
}

async function client() { const c = new pg.Client({ connectionString: URL }); await c.connect(); return c; }

async function tableCounts(c, { includeMigrationTables = false } = {}) {
  const rows = (await c.query(
    `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' ${includeMigrationTables ? '' : `and c.relname not like 'schema_migration%'`}
      order by 1`)).rows.map((r) => r.relname);
  const out = {};
  for (const t of rows) out[t] = Number((await c.query(`select count(*)::bigint n from public."${t.replace(/"/g, '""')}"`)).rows[0].n);
  return out;
}

async function restore() {
  await up({ fresh: true });
  say('\n== restoring the verified production backup ==');
  say(`  source: ${BACKUP}`);
  // Tables, then rows, then keys and indexes. Loading rows into a schema whose
  // foreign keys already exist silently drops every row whose parent has not
  // been inserted yet -- an alphabetically ordered data file guarantees that,
  // and it cost 210 of 1183 rows the first time this was attempted.
  const errsIn = (txt) => (String(txt).match(/^(ERROR|FATAL):.*$/gm) || []);
  for (const section of ['pre-data', 'data', 'post-data']) {
    const sqlFile = join(HOME, `${section}.sql`);
    const made = spawnSync(PG_RESTORE, ['--section', section, '--no-owner', '--no-privileges', '--file', sqlFile, join(BACKUP, 'public.dump')], { encoding: 'utf8' });
    if (made.status !== 0) throw new Error(`pg_restore --section=${section} failed:\n${made.stderr}`);
    const started = Date.now();
    const loaded = spawnSync(PSQL, ['--dbname', URL, '--quiet', '--no-psqlrc', '-v', 'ON_ERROR_STOP=0', '--file', sqlFile], { encoding: 'utf8' });
    const errs = [...errsIn(loaded.stderr), ...errsIn(loaded.stdout)];
    say(`  ${section.padEnd(9)} ${((Date.now() - started) / 1000).toFixed(1)}s, ${errs.length} error(s)`);
    for (const e of errs.slice(0, 5)) say('      ' + e);
  }
  const c = await client();
  const got = await tableCounts(c);
  await c.end();
  const total = Object.values(got).reduce((a, b) => a + b, 0);
  const wanted = Object.values(PROD_COUNTS).reduce((a, b) => a + b, 0);
  const bad = Object.keys(PROD_COUNTS).filter((t) => got[t] !== PROD_COUNTS[t]);
  say(`  restored ${Object.keys(got).length} tables, ${total} rows (production: ${Object.keys(PROD_COUNTS).length} tables, ${wanted} rows)`);
  if (bad.length === 0) say('  RESTORE IS ROW-FOR-ROW IDENTICAL TO PRODUCTION');
  else { say('  RESTORE MISMATCH:'); for (const t of bad) say(`    ${t.padEnd(34)} copy=${got[t]} production=${PROD_COUNTS[t]}`); }
  return bad.length === 0;
}

/**
 * The migrations whose effects production already has, and which therefore must
 * be recorded rather than run.
 *
 * `0000` is NOT among them: it states of itself that every statement is guarded
 * and additive and that a real Supabase project performs no DDL in `auth`, and
 * it is what creates the local stand-ins the later migrations need. It runs.
 *
 * `0001`-`0004` do have to be stamped, and the rehearsal proved why: production
 * built its legacy tables from an earlier dialect. `0001` would create
 * `relationship_interactions(contact_id, company_id, business_unit_id)`, while
 * production has `(external_contact_id, external_company_id,
 * internal_business_unit_id)`. The `create table if not exists` is skipped, and
 * the index that follows then fails with `column "business_unit_id" does not
 * exist`. The same divergence applies to `meetings`. Those tables are being
 * dropped at the end of this migration anyway, so re-deriving them is pointless
 * as well as impossible.
 */
const BASELINE = [
  '0001_baseline_legacy.sql',
  '0002_phase1_intelligence.sql',
  '0003_phase1_1_signals_staging.sql',
  '0004_legacy_backfill_to_entities.sql',
];

async function migrate() {
  await up();
  const files = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
  say(`\n== baseline: ${BASELINE.length} stamped, ${files.length - BASELINE.length} to run ==`);
  const c0 = await client();
  await c0.query(`create table if not exists public.schema_migrations (
    version text primary key, checksum text not null, applied_at timestamptz not null default now())`);
  for (const f of BASELINE) {
    await c0.query(`insert into public.schema_migrations (version, checksum) values ($1,$2) on conflict (version) do nothing`,
      [f, sha(readFileSync(join(migDir, f), 'utf8'))]);
    say(`  stamped ${f}`);
  }
  await c0.end();
  say(`  will run: 0000 and ${files.filter((f) => !BASELINE.includes(f) && f !== files[0]).length} more`);

  say('\n== production baseline alignment ==');
  const align = spawnSync(PSQL, ['--dbname', URL, '--quiet', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1',
    '--file', join(root, 'scripts/prod-audit/production-baseline-align.sql')], { encoding: 'utf8' });
  if (align.status !== 0) { say('  FAILED:\n' + (align.stderr || '').trim().split('\n').slice(0, 6).map((l) => '    ' + l).join('\n')); return false; }
  say('  legacy tables aligned to the shape the migration set expects');

  say('\n== dry run: every migration in ONE transaction, then rolled back ==');
  const t0 = Date.now();
  const dry = spawnSync(process.execPath, ['scripts/migrate.mjs', '--dry-run'], { cwd: root, encoding: 'utf8', env: migrateEnv });
  say(`${(dry.stdout + dry.stderr).trim().split('\n').filter((l) => /try|FAILED|rolled back|ERROR|applying/.test(l)).map((l) => '  ' + l).join('\n')}`);
  say(`  dry run exit ${dry.status} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (dry.status !== 0) { say('  STOPPING: the dry run failed, so nothing would be applied to production either.'); return false; }

  const cBefore = await client();
  const before = await tableCounts(cBefore);
  await cBefore.end();

  say('\n== applying for real, on the copy ==');
  const t1 = Date.now();
  const run = spawnSync(process.execPath, ['scripts/migrate.mjs'], { cwd: root, encoding: 'utf8', env: migrateEnv });
  say(`${(run.stdout + run.stderr).trim().split('\n').slice(-6).map((l) => '  ' + l).join('\n')}`);
  say(`  apply exit ${run.status} in ${((Date.now() - t1) / 1000).toFixed(0)}s`);
  if (run.status !== 0) return false;

  const c = await client();
  const after = await tableCounts(c);
  say('\n== did any production row move? ==');
  let lost = 0, gained = 0;
  for (const t of Object.keys(PROD_COUNTS)) {
    const b = PROD_COUNTS[t], a = after[t] ?? 0;
    if (a !== b) { say(`  ${(a < b ? 'LOST  ' : 'GAINED')} ${t.padEnd(34)} production=${b} after=${a}`); a < b ? lost++ : gained++; }
  }
  say(lost === 0 && gained === 0
    ? '  EVERY ONE OF THE 23 PRODUCTION TABLES KEPT EXACTLY ITS ROW COUNT'
    : `  ${lost} table(s) lost rows, ${gained} gained rows`);

  const ws = (await c.query('select slug, name from public.workspaces')).rows;
  say(`\n  workspaces: ${ws.map((r) => `${r.slug} (${r.name})`).join(', ') || '(none)'}`);
  const scoped = (await c.query(`select table_name from information_schema.columns where table_schema='public' and column_name='workspace_id' order by 1`)).rows;
  const unscopedRows = [];
  for (const r of scoped) {
    const n = Number((await c.query(`select count(*)::bigint n from public."${r.table_name.replace(/"/g, '""')}" where workspace_id is null`)).rows[0].n);
    if (n > 0) unscopedRows.push(`${r.table_name}=${n}`);
  }
  say(`  tables carrying workspace_id: ${scoped.length}`);
  say(`  rows left without a workspace: ${unscopedRows.length ? unscopedRows.join(', ') : 'none'}`);
  const rls = (await c.query(`select count(*)::int n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname='public' and c.relkind='r' and c.relrowsecurity`)).rows[0].n;
  const pol = (await c.query(`select count(*)::int n from pg_policies where schemaname='public'`)).rows[0].n;
  say(`  RLS enabled on ${rls} tables, ${pol} policies`);
  const created = Object.keys(after).filter((t) => !(t in PROD_COUNTS));
  say(`  platform tables created: ${created.length}`);
  await c.end();
  return lost === 0 && gained === 0;
}

const command = process.argv[2] ?? 'help';
let ok = true;
try {
  if (command === 'up') await up();
  else if (command === 'down') down();
  else if (command === 'restore') ok = await restore();
  else if (command === 'migrate') ok = await migrate();
  else if (command === 'all') { ok = await restore(); if (ok) ok = await migrate(); }
  else { console.log('commands: up | restore | migrate | all | down'); }
} catch (error) {
  say(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  ok = false;
}
process.exit(ok ? 0 : 1);
