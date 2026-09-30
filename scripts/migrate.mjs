#!/usr/bin/env node
/**
 * Applies supabase/migrations in filename order, once each, inside a
 * transaction, recording a checksum in public.schema_migrations.
 *
 *   node scripts/migrate.mjs                 apply pending migrations
 *   node scripts/migrate.mjs --status        show state, change nothing
 *   node scripts/migrate.mjs --to 0011       apply only up to and including 0011
 *   node scripts/migrate.mjs --dry-run       apply every pending migration in ONE
 *                                            transaction, then roll it back
 *   node scripts/migrate.mjs --reconcile <file> --previous <checksum> --reason "<text>"
 *                                            accept a reviewed in-place revision
 *                                            of an already-applied migration
 *
 * Integrity rule: a migration whose file no longer matches the checksum recorded
 * when it was applied is a hard stop. Nothing -- not even unrelated pending
 * migrations -- is applied on top of a database whose history no longer matches
 * the files, because every later migration was written assuming the earlier
 * ones exist as written.
 *
 * The only way past a changed migration is --reconcile, and only for a file
 * listed in supabase/migrations/revisions.json. Reconciliation runs in one
 * transaction: it re-applies the (idempotent) current file plus any reconcile
 * SQL, runs the listed assertions, verifies that no base table in public lost a
 * single row, records the new checksum, and writes an audit row to
 * public.schema_migration_revisions. Any failure rolls all of it back.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertSafeTarget, sslFor } from './lib/target.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(root, 'supabase/migrations');
const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const statusOnly = args.includes('--status');
const dryRun = args.includes('--dry-run');
const reconcileFile = flagValue('--reconcile');
/**
 * Stop after this migration, e.g. `--to 0011`. Prefix match on the filename.
 *
 * For reproducing a database that really is at an earlier point in history, so
 * a test does not have to rewind `schema_migrations` while leaving the schema
 * where it was -- a state no real database can be in.
 */
const stopAfter = flagValue('--to');

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:54329/postgres';

// Before any connection: never production, and remote targets must be declared.
let target;
try {
  target = assertSafeTarget({ databaseUrl: connectionString });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const revisions = existsSync(resolve(dir, 'revisions.json'))
  ? JSON.parse(readFileSync(resolve(dir, 'revisions.json'), 'utf8'))
  : {};

const client = new pg.Client({ connectionString, ssl: sslFor(connectionString) });
await client.connect();

// Read-only modes must not create anything, so bookkeeping tables are only
// created when this run is going to write.
const writes = !statusOnly && !dryRun;
if (writes) {
  await client.query(`create table if not exists public.schema_migrations (
    version text primary key, checksum text not null, applied_at timestamptz not null default now())`);
}
if (reconcileFile) {
  await client.query(`create table if not exists public.schema_migration_revisions (
    id bigserial primary key,
    version text not null,
    previous_checksum text not null,
    new_checksum text not null,
    reason text not null,
    assertions jsonb not null,
    row_counts_before jsonb not null,
    row_counts_after jsonb not null,
    reconciled_by text not null default current_user,
    reconciled_at timestamptz not null default now()
  )`);
}

const hasHistory = (
  await client.query(`select to_regclass('public.schema_migrations') is not null as present`)
).rows[0].present;
const applied = new Map(
  hasHistory
    ? (await client.query('select version, checksum from public.schema_migrations')).rows.map((r) => [
        r.version,
        r.checksum,
      ])
    : [],
);

const state = files.map((file) => {
  const sql = readFileSync(resolve(dir, file), 'utf8');
  const checksum = sha(sql);
  const recorded = applied.get(file);
  return {
    file,
    sql,
    checksum,
    recorded,
    status: recorded === undefined ? 'pending' : recorded === checksum ? 'ok' : 'changed',
  };
});

async function finish(code) {
  await client.end();
  process.exit(code);
}

/** Exact row counts for every base table in public, for the no-data-loss check. */
async function rowCounts() {
  const tables = (
    await client.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
          and c.relname not in ('schema_migrations', 'schema_migration_revisions')
        order by c.relname`,
    )
  ).rows.map((r) => r.relname);
  const counts = {};
  for (const table of tables) {
    const { rows } = await client.query(`select count(*)::bigint as n from public."${table.replace(/"/g, '""')}"`);
    counts[table] = Number(rows[0].n);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// --reconcile
// ---------------------------------------------------------------------------
if (reconcileFile) {
  const previous = flagValue('--previous');
  const reason = flagValue('--reason');
  const entry = state.find((s) => s.file === reconcileFile);
  const revision = revisions[reconcileFile];

  const refuse = async (message) => {
    console.error(`Refusing to reconcile ${reconcileFile}: ${message}`);
    await finish(1);
  };

  if (!entry) await refuse('no such migration file.');
  if (!revision) {
    await refuse(
      'it is not listed in supabase/migrations/revisions.json. An unreviewed change to an applied migration cannot be accepted; restore the file, or put the change in a new migration.',
    );
  }
  if (entry.status === 'pending') await refuse('it has never been applied here; run a normal migrate.');
  if (entry.status === 'ok') await refuse('the recorded checksum already matches the file. Nothing to reconcile.');
  if (!previous) {
    await refuse(`--previous is required. Pass the checksum recorded in this database (${entry.recorded}) to confirm which state you are reconciling.`);
  }
  if (previous !== entry.recorded) {
    await refuse(`--previous ${previous} does not match the checksum recorded in this database (${entry.recorded}).`);
  }
  if (!reason || reason.trim().length < 10) await refuse('--reason is required (at least 10 characters) and is stored in the audit row.');
  if (!revision.reapplyCurrentFile) {
    await refuse('revisions.json does not mark the current file as safe to re-apply (reapplyCurrentFile: true).');
  }

  const extraSql = revision.reconcileSql ? readFileSync(resolve(dir, revision.reconcileSql), 'utf8') : '';
  const assertSql = revision.assertSql ? readFileSync(resolve(dir, revision.assertSql), 'utf8') : null;
  if (!assertSql) await refuse('revisions.json lists no assertSql; reconciliation must be verified.');

  // Reconcile SQL may reshape schema objects, never remove data.
  const destructive = /\b(drop\s+table|truncate|delete\s+from|drop\s+schema|drop\s+column)\b/i;
  if (destructive.test(extraSql)) await refuse('its reconcile SQL contains a data-destroying statement.');

  console.log(`Reconciling ${reconcileFile}: recorded ${entry.recorded} -> file ${entry.checksum}`);
  try {
    await client.query('begin');
    const before = await rowCounts();

    await client.query(entry.sql);
    if (extraSql) await client.query(extraSql);

    const { rows: assertions } = await client.query(assertSql);
    const failedAssertions = assertions.filter((a) => a.ok !== true);
    for (const a of assertions) console.log(`  ${a.ok ? 'ok  ' : 'FAIL'} ${a.check}`);
    if (assertions.length === 0 || failedAssertions.length > 0) {
      throw new Error(
        assertions.length === 0
          ? 'the assertion SQL returned no rows'
          : `${failedAssertions.length} assertion(s) failed`,
      );
    }

    const after = await rowCounts();
    const lost = Object.entries(before).filter(([table, n]) => (after[table] ?? 0) < n);
    if (lost.length > 0) {
      throw new Error(`rows would be lost in: ${lost.map(([t, n]) => `${t} (${n} -> ${after[t] ?? 0})`).join(', ')}`);
    }

    await client.query('update public.schema_migrations set checksum = $2 where version = $1', [
      reconcileFile,
      entry.checksum,
    ]);
    await client.query(
      `insert into public.schema_migration_revisions
         (version, previous_checksum, new_checksum, reason, assertions, row_counts_before, row_counts_after)
       values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)`,
      [reconcileFile, entry.recorded, entry.checksum, reason.trim(), JSON.stringify(assertions), JSON.stringify(before), JSON.stringify(after)],
    );
    await client.query('commit');
    console.log(`Reconciled. No rows lost across ${Object.keys(before).length} table(s). Run migrate again to apply pending migrations.`);
    await finish(0);
  } catch (error) {
    await client.query('rollback').catch(() => {});
    console.error(`Reconciliation rolled back: ${error.message}`);
    await finish(1);
  }
}

// ---------------------------------------------------------------------------
// Integrity pre-check: nothing is applied while history and files disagree.
// ---------------------------------------------------------------------------
for (const s of state) {
  if (s.status === 'ok') console.log(`  ok      ${s.file}`);
  else if (s.status === 'pending') console.log(`  pending ${s.file}`);
  else console.log(`  CHANGED ${s.file} (recorded ${s.recorded}, file ${s.checksum})`);
}

const changed = state.filter((s) => s.status === 'changed');
if (changed.length > 0) {
  console.error('\nStopped: applied migration(s) no longer match their files. Nothing was applied.');
  for (const s of changed) {
    if (revisions[s.file]) {
      console.error(
        `\n  ${s.file} has a reviewed revision (${revisions[s.file].why})\n` +
          `  Reconcile it without losing data:\n` +
          `    node scripts/migrate.mjs --reconcile ${s.file} --previous ${s.recorded} --reason "<why this database had the old version>"\n` +
          `  then run migrate again.`,
      );
    } else {
      console.error(
        `\n  ${s.file} is not a reviewed revision. Restore the file to the version that was applied\n` +
          `  (checksum ${s.recorded}) and put the change in a new migration.`,
      );
    }
  }
  await finish(1);
}

let pending = state.filter((s) => s.status === 'pending');
if (stopAfter) {
  const match = state.find((s) => s.file.startsWith(stopAfter));
  if (!match) {
    console.error(`--to "${stopAfter}" matches no migration.`);
    await finish(2);
  }
  pending = pending.filter((s) => s.file <= match.file);
  console.log(`Stopping after ${match.file}.`);
}
if (statusOnly) {
  console.log(`\n${pending.length} pending. Target: ${target.kind}${target.ref ? ` (${target.ref})` : ''}.`);
  await finish(0);
}
if (pending.length === 0) {
  console.log('\nUp to date.');
  await finish(0);
}

// ---------------------------------------------------------------------------
// --dry-run: everything pending in one transaction, then rolled back.
// ---------------------------------------------------------------------------
if (dryRun) {
  console.log(`\nDry run: applying ${pending.length} migration(s) in a single transaction, then rolling back.`);
  await client.query('begin');
  for (const s of pending) {
    process.stdout.write(`  try     ${s.file} ... `);
    try {
      await client.query(`savepoint dry_run`);
      await client.query(s.sql);
      await client.query(`release savepoint dry_run`);
      console.log('ok');
    } catch (error) {
      console.log('FAILED');
      console.error(`\n${error.message}`);
      if (error.position) {
        const pos = Number(error.position);
        console.error('near:', JSON.stringify(s.sql.slice(Math.max(0, pos - 220), pos + 120)));
      }
      await client.query('rollback').catch(() => {});
      console.error('\nDry run rolled back. Nothing was changed.');
      await finish(1);
    }
  }
  await client.query('rollback');
  console.log('\nDry run succeeded and was rolled back. Nothing was changed.');
  await finish(0);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
for (const s of pending) {
  process.stdout.write(`  apply   ${s.file} ... `);
  try {
    await client.query('begin');
    await client.query(s.sql);
    await client.query(
      `insert into public.schema_migrations (version, checksum) values ($1, $2)`,
      [s.file, s.checksum],
    );
    await client.query('commit');
    console.log('done');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    console.log('FAILED');
    console.error(`\n${error.message}\n`);
    if (error.position) {
      const pos = Number(error.position);
      console.error('near:', JSON.stringify(s.sql.slice(Math.max(0, pos - 220), pos + 120)));
    }
    await finish(1);
  }
}

await finish(0);
