#!/usr/bin/env node
/**
 * Migration integrity and legacy-upsert tests, on an ISOLATED throwaway database.
 *
 *   npm run verify:migrations
 *
 * Starts a second PGlite server on its own port and temp directory, so the
 * scenarios can rewrite migration history freely without touching the working
 * local database. Covers:
 *
 *   A. (removed: the legacy upsert path was dropped in migration 0021)
 *   B. A database that applied an earlier draft of 0011:
 *      - migrate stops before applying anything;
 *      - --reconcile refuses without, or with the wrong, --previous checksum;
 *      - --reconcile succeeds with the right one, loses no rows, fixes the schema
 *        and writes an audit row;
 *      - migrate then applies the remaining migrations.
 *   C. An unreviewed change to an applied migration cannot be reconciled.
 *   D. The target guard refuses production refs and undeclared remote targets
 *      before connecting.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = 54000 + Math.floor(Math.random() * 900);
const dataDir = mkdtempSync(join(tmpdir(), 'g3-migrations-'));
const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;

const checks = [];
const record = (name, passed, detail = '') => {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (detail) console.log(`        ${detail}`);
};
const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

/** Runs migrate.mjs against the throwaway database. */
function migrate(args = [], extraEnv = {}) {
  const out = spawnSync(process.execPath, ['scripts/migrate.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      SUPABASE_URL: '',
      G3_TARGET_ENV: '',
      SUPABASE_TEST_PROJECT_REF: '',
      ...extraEnv,
    },
  });
  if (out.error) throw out.error;
  return { code: out.status, output: `${out.stdout}\n${out.stderr}` };
}

const server = spawn(process.execPath, ['scripts/local-db.mjs'], {
  cwd: root,
  env: { ...process.env, LOCAL_PG_PORT: String(port), LOCAL_PG_DATA: join(dataDir, 'pgdata') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolveReady, rejectReady) => {
  const timer = setTimeout(() => rejectReady(new Error('throwaway database did not start in 30s')), 30_000);
  server.stdout.on('data', (chunk) => {
    if (String(chunk).includes('listening')) {
      clearTimeout(timer);
      resolveReady();
    }
  });
  server.on('exit', (code) => rejectReady(new Error(`throwaway database exited early (${code})`)));
});

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const q = async (sql, params) => (await pool.query(sql, params)).rows;
/** As service_role, in its own transaction; returns rows or the error. */
async function asService(sql, params) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('begin');
    await client.query('set local role service_role');
    const { rows } = await client.query(sql, params);
    await client.query('commit');
    return { rows };
  } catch (error) {
    // Destroy rather than reuse: the local server desyncs after a failed
    // parameterised query (see packages/core/src/db.ts).
    broken = true;
    return { error };
  } finally {
    client.release(broken);
  }
}

let exitCode = 1;
try {
  console.log('\x1b[1mMigration integrity verification\x1b[0m');
  console.log(`Throwaway database on port ${port}`);

  section('Setup');
  const fresh = migrate();
  record('a fresh database migrates cleanly', fresh.code === 0, fresh.output.trim().split('\n').slice(-1)[0]);
  const workspaces = await q(`select id from public.workspaces where status = 'active'`);
  record('it has exactly one active workspace', workspaces.length === 1, `${workspaces.length} active workspace(s)`);
  const workspaceId = workspaces[0].id;

  // =========================================================================
  section('B. A database that applied an earlier draft of 0011');

  const file0011 = '0011_apply_integrity_and_legacy_compat.sql';
  const currentChecksum = createHash('sha256')
    .update(readFileSync(resolve(root, 'supabase/migrations', file0011), 'utf8'))
    .digest('hex')
    .slice(0, 16);
  const oldChecksum = 'a1b2c3d4e5f60718';

  // Reproduce the old state as it really was: the draft views, the draft
  // default_workspace_id() body, and nothing after 0011 applied yet.
  // Rebuild the database so it really is at 0011, rather than rewinding the
  // migration records under a schema that is at the latest migration. The old
  // approach produced a state no real database can be in -- records saying
  // 0011, tables that only 0021 could have dropped -- and the replay then
  // failed for reasons that had nothing to do with reconciliation.
  await q(`drop schema public cascade`);
  await q(`create schema public`);
  {
    const rebuilt = migrate(['--to', '0011']);
    if (rebuilt.code !== 0) throw new Error(`could not rebuild at 0011:\n${rebuilt.output.slice(-1500)}`);
  }
  const rebuiltWorkspaceId = (await q(`select id from public.workspaces where status = 'active' limit 1`))[0].id;
  await q(`update public.schema_migrations set checksum = $2 where version = $1`, [file0011, oldChecksum]);
  await q(`drop function if exists public.upsert_legacy_record(text, jsonb, text, uuid)`);
  await q(`drop function if exists public.backfill_legacy_entities(uuid)`);
  await q(`create or replace function public.default_workspace_id() returns uuid language plpgsql stable as $$
    declare found_id uuid; workspace_count integer;
    begin select count(*), min(id) into workspace_count, found_id from public.workspaces where status = 'active';
      return found_id; end $$`);
  await q(`create or replace view public.entities_default_workspace as
           select * from public.entities where workspace_id = public.default_workspace_id()`);
  await q(`create or replace view public.business_units_default_workspace as
           select * from public.business_units where workspace_id = public.default_workspace_id()`);
  // Real data that must survive.
  await q(`insert into public.business_units (workspace_id, name, slug) values ($1, 'Old Unit', 'old-unit')`, [rebuiltWorkspaceId]);
  await q(`insert into public.entities (workspace_id, entity_type, display_name, slug) values ($1, 'organization', 'Old Org', 'old-org')`, [rebuiltWorkspaceId]);
  const countsBefore = await q(`select
     (select count(*)::int from public.entities) as entities,
     (select count(*)::int from public.business_units) as units,
     (select count(*)::int from public.evidence) as evidence`);

  const blocked = migrate();
  const applied0012 = await q(`select count(*)::int as n from public.schema_migrations where version like '0012%'`);
  record(
    'migrate stops on the changed 0011 and applies nothing after it',
    blocked.code === 1 && /CHANGED 0011/.test(blocked.output) && /Nothing was applied/.test(blocked.output) && applied0012[0].n === 0,
    `exit=${blocked.code}; 0012 applied=${applied0012[0].n > 0}`,
  );
  record(
    'the stop message gives the exact reconcile command with the recorded checksum',
    blocked.output.includes(`--reconcile ${file0011} --previous ${oldChecksum}`),
    'points at --reconcile with --previous',
  );

  const statusBlocked = migrate(['--status']);
  record('--status reports the same stop without changing anything', statusBlocked.code === 1 && /CHANGED 0011/.test(statusBlocked.output), `exit=${statusBlocked.code}`);

  const noPrevious = migrate(['--reconcile', file0011, '--reason', 'test database had the draft']);
  record('reconcile without --previous is refused', noPrevious.code === 1 && /--previous is required/.test(noPrevious.output), `exit=${noPrevious.code}`);

  const wrongPrevious = migrate(['--reconcile', file0011, '--previous', 'ffffffffffffffff', '--reason', 'test database had the draft']);
  record('reconcile with the wrong --previous is refused', wrongPrevious.code === 1 && /does not match/.test(wrongPrevious.output), `exit=${wrongPrevious.code}`);

  const noReason = migrate(['--reconcile', file0011, '--previous', oldChecksum]);
  record('reconcile without a reason is refused', noReason.code === 1 && /--reason is required/.test(noReason.output), `exit=${noReason.code}`);

  const stillOld = await q(`select checksum from public.schema_migrations where version = $1`, [file0011]);
  record('refused reconciliations changed nothing', stillOld[0].checksum === oldChecksum, `recorded checksum still ${stillOld[0].checksum}`);

  const reconciled = migrate([
    '--reconcile', file0011, '--previous', oldChecksum,
    '--reason', 'Local test database had applied the draft 0011 with views and min(uuid).',
  ]);
  record('reconcile with the recorded checksum and a reason succeeds', reconciled.code === 0, reconciled.output.trim().split('\n').filter(Boolean).slice(-1)[0]);

  const countsAfter = await q(`select
     (select count(*)::int from public.entities) as entities,
     (select count(*)::int from public.business_units) as units,
     (select count(*)::int from public.evidence) as evidence`);
  record('no rows were lost', JSON.stringify(countsBefore) === JSON.stringify(countsAfter), `before ${JSON.stringify(countsBefore[0])} after ${JSON.stringify(countsAfter[0])}`);

  const schemaNow = await q(`select
     (select count(*)::int from information_schema.views where table_schema = 'public'
        and table_name in ('entities_default_workspace','business_units_default_workspace')) as views,
     (select prosrc not ilike '%min(id)%' from pg_proc where proname = 'default_workspace_id') as fixed_function,
     (select checksum from public.schema_migrations where version = $1) as checksum`, [file0011]);
  record(
    'the schema now matches the current 0011 and the checksum is updated',
    schemaNow[0].views === 0 && schemaNow[0].fixed_function === true && schemaNow[0].checksum === currentChecksum,
    `views=${schemaNow[0].views}, function fixed=${schemaNow[0].fixed_function}, checksum=${schemaNow[0].checksum}`,
  );

  const audit = await q(`select previous_checksum, new_checksum, reason, jsonb_array_length(assertions) as n from public.schema_migration_revisions where version = $1`, [file0011]);
  record(
    'an audit row records the previous checksum, the new one, the reason and the assertions',
    audit.length === 1 && audit[0].previous_checksum === oldChecksum && audit[0].new_checksum === currentChecksum && audit[0].n >= 5,
    audit[0] ? `${audit[0].previous_checksum} -> ${audit[0].new_checksum}, ${audit[0].n} assertion(s)` : 'no audit row',
  );

  const again = migrate(['--reconcile', file0011, '--previous', currentChecksum, '--reason', 'second attempt should be refused']);
  record('reconciling an already-matching migration is refused', again.code === 1 && /Nothing to reconcile/.test(again.output), `exit=${again.code}`);

  const resumed = migrate();
  const statusFinal = migrate(['--status']);
  record(
    'migrate then applies the remaining migrations and reports up to date',
    resumed.code === 0 && /apply\s+0012/.test(resumed.output) && /apply\s+0014/.test(resumed.output) && statusFinal.code === 0 && /0 pending/.test(statusFinal.output),
    `exit=${resumed.code}; status: ${statusFinal.output.trim().split('\n').slice(-1)[0]}`,
  );
  const stillThere = await q(`select count(*)::int as n from public.entities where slug = 'old-org'`);
  record('data written before reconciliation is still there', stillThere[0].n === 1, `old-org rows=${stillThere[0].n}`);

  // =========================================================================
  section('C. An unreviewed change cannot be reconciled');

  const file0012 = (await q(`select version, checksum from public.schema_migrations where version like '0012%'`))[0];
  await q(`update public.schema_migrations set checksum = 'deadbeefdeadbeef' where version = $1`, [file0012.version]);
  const unlisted = migrate();
  record(
    'migrate stops and says to restore the file or add a new migration',
    unlisted.code === 1 && /not a reviewed revision/.test(unlisted.output),
    `exit=${unlisted.code}`,
  );
  const unlistedReconcile = migrate(['--reconcile', file0012.version, '--previous', 'deadbeefdeadbeef', '--reason', 'trying to bypass the check']);
  record(
    '--reconcile refuses a migration not listed in revisions.json',
    unlistedReconcile.code === 1 && /not listed in supabase\/migrations\/revisions\.json/.test(unlistedReconcile.output),
    `exit=${unlistedReconcile.code}`,
  );
  await q(`update public.schema_migrations set checksum = $2 where version = $1`, [file0012.version, file0012.checksum]);

  // =========================================================================
  section('D. Target guard (no connection is attempted)');

  const production = migrate(['--status'], {
    DATABASE_URL: 'postgresql://postgres.dlwircxhmaffntlxmyje:not-a-real-password@127.0.0.1:1/postgres',
  });
  record(
    'a production project ref is refused, even with G3_TARGET_ENV=test',
    production.code === 1 && /production project/.test(production.output),
    production.output.trim().split('\n')[0],
  );
  const productionWithFlag = migrate(['--status'], {
    DATABASE_URL: 'postgresql://postgres.dlwircxhmaffntlxmyje:x@aws-0-eu-central-1.pooler.supabase.com:6543/postgres',
    G3_TARGET_ENV: 'test',
    SUPABASE_TEST_PROJECT_REF: 'dlwircxhmaffntlxmyje',
  });
  record('there is no flag that allows production', productionWithFlag.code === 1 && /production project/.test(productionWithFlag.output), `exit=${productionWithFlag.code}`);

  const undeclared = migrate(['--status'], {
    DATABASE_URL: 'postgresql://postgres.abcdefghijklmnopqrst:x@aws-0-eu-central-1.pooler.supabase.com:6543/postgres',
  });
  record('a remote target without G3_TARGET_ENV=test is refused', undeclared.code === 1 && /G3_TARGET_ENV/.test(undeclared.output), `exit=${undeclared.code}`);

  const mismatch = migrate(['--status'], {
    DATABASE_URL: 'postgresql://postgres.abcdefghijklmnopqrst:x@aws-0-eu-central-1.pooler.supabase.com:6543/postgres',
    G3_TARGET_ENV: 'test',
    SUPABASE_TEST_PROJECT_REF: 'zyxwvutsrqponmlkjihg',
  });
  record('a URL for a different project than SUPABASE_TEST_PROJECT_REF is refused', mismatch.code === 1 && /but SUPABASE_TEST_PROJECT_REF/.test(mismatch.output), `exit=${mismatch.code}`);

  const failed = checks.filter((c) => !c.passed);
  console.log(`\n\x1b[1mSummary\x1b[0m\n  ${checks.length - failed.length}/${checks.length} checks passed`);
  for (const c of failed) console.log(`  - ${c.name}\n      ${c.detail}`);
  exitCode = failed.length > 0 ? 1 : 0;
} catch (error) {
  console.error(error);
} finally {
  await pool.end().catch(() => {});
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(exitCode);
