#!/usr/bin/env node
/**
 * Preflight for the TEST Supabase project. Read-only.
 *
 *   npm run supabase:test:preflight
 *   npm run supabase:test:preflight -- --create-bucket   (the only write: a PRIVATE bucket)
 *
 * Run through scripts/supabase-test/run.mjs, which has already loaded
 * .env.supabase-test and refused production and local targets.
 *
 * Checks, in order, and reports PASS / WARN / FAIL for each:
 *   - Supabase Auth and Admin API are reachable with the given keys
 *   - JWT verification will work (JWKS or legacy secret)
 *   - the storage bucket exists and is private
 *   - Postgres: connection, roles the app switches to, auth schema, pgmq
 *   - whether the database already holds data (a sign it is not a clean test project)
 *   - migration state, then every pending migration applied in ONE transaction
 *     and rolled back (migrate.mjs --dry-run), so a failure is found before
 *     anything is written
 *   - seed credentials are set and are not the local defaults
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertSafeTarget, sslFor } from '../lib/target.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const createBucket = process.argv.includes('--create-bucket');
const e = process.env;

const results = [];
const report = (level, name, detail) => {
  results.push({ level, name, detail });
  const colour = level === 'PASS' ? '\x1b[32m' : level === 'WARN' ? '\x1b[33m' : '\x1b[31m';
  console.log(`  ${colour}${level}\x1b[0m  ${name}${detail ? `\n        ${detail}` : ''}`);
};
const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

section('Target');
let target;
try {
  target = assertSafeTarget({ databaseUrl: e.DATABASE_URL, supabaseUrl: e.SUPABASE_URL });
  if (target.kind !== 'supabase-test') throw new Error('target resolved as local');
  report('PASS', 'target is a declared test project, not production', `ref ${target.ref}`);
} catch (error) {
  report('FAIL', 'target guard', error.message);
  process.exit(1);
}
report(e.DEV_AUTH_ENABLED === 'true' ? 'FAIL' : 'PASS', 'dev sign-in is disabled', `DEV_AUTH_ENABLED=${e.DEV_AUTH_ENABLED ?? 'unset'}`);

async function http(path, key, init = {}) {
  try {
    const response = await fetch(`${e.SUPABASE_URL}${path}`, {
      ...init,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  } catch (error) {
    return { status: 0, body: error.message };
  }
}

// ---------------------------------------------------------------------------
section('Supabase Auth');
const settings = await http('/auth/v1/settings', e.SUPABASE_ANON_KEY);
report(
  settings.status === 200 ? 'PASS' : 'FAIL',
  'Auth API reachable with the anon key',
  settings.status === 200 ? `email provider enabled: ${settings.body?.external?.email ?? 'unknown'}` : `HTTP ${settings.status}: ${String(JSON.stringify(settings.body)).slice(0, 160)}`,
);
if (settings.status === 200 && settings.body?.disable_signup === false) {
  report('WARN', 'public sign-up is enabled on the test project', 'Not required by the app; users are created through the Admin API. Consider disabling it.');
}

const admin = await http('/auth/v1/admin/users?page=1&per_page=1', e.SUPABASE_SERVICE_ROLE_KEY);
report(
  admin.status === 200 ? 'PASS' : 'FAIL',
  'Admin API reachable with the service-role key (needed to create test users)',
  admin.status === 200 ? '' : `HTTP ${admin.status}: ${String(JSON.stringify(admin.body)).slice(0, 160)}`,
);

if (e.SUPABASE_JWT_SECRET) {
  report('PASS', 'JWT verification: legacy HS256 secret provided', 'Tokens are verified with SUPABASE_JWT_SECRET.');
} else {
  const jwks = await http('/auth/v1/.well-known/jwks.json', e.SUPABASE_ANON_KEY);
  const keys = Array.isArray(jwks.body?.keys) ? jwks.body.keys.length : 0;
  report(
    keys > 0 ? 'PASS' : 'FAIL',
    'JWT verification: JWKS endpoint publishes signing keys',
    keys > 0
      ? `${keys} key(s)`
      : `HTTP ${jwks.status}, 0 keys. If the project still signs with the legacy secret, set SUPABASE_JWT_SECRET.`,
  );
}

// ---------------------------------------------------------------------------
section('Storage');
const bucketName = e.SUPABASE_STORAGE_BUCKET || 'workspace-files';
let bucket = await http(`/storage/v1/bucket/${encodeURIComponent(bucketName)}`, e.SUPABASE_SERVICE_ROLE_KEY);
if (bucket.status !== 200 && createBucket) {
  const created = await http('/storage/v1/bucket', e.SUPABASE_SERVICE_ROLE_KEY, {
    method: 'POST',
    body: JSON.stringify({ id: bucketName, name: bucketName, public: false }),
  });
  report(created.status === 200 ? 'PASS' : 'FAIL', `created private bucket "${bucketName}"`, created.status === 200 ? '' : `HTTP ${created.status}: ${JSON.stringify(created.body)}`);
  bucket = await http(`/storage/v1/bucket/${encodeURIComponent(bucketName)}`, e.SUPABASE_SERVICE_ROLE_KEY);
}
if (bucket.status === 200) {
  report(bucket.body?.public === false ? 'PASS' : 'FAIL', `bucket "${bucketName}" exists and is private`, `public=${bucket.body?.public}`);
} else {
  report('FAIL', `bucket "${bucketName}" exists`, 'Missing. Re-run with -- --create-bucket to create it as a private bucket.');
}

// ---------------------------------------------------------------------------
section('Postgres');
const client = new pg.Client({ connectionString: e.DATABASE_URL, ssl: sslFor(e.DATABASE_URL) });
let connected = false;
try {
  await client.connect();
  connected = true;
  const { rows } = await client.query(`select current_user, version(), current_database()`);
  report('PASS', 'connected', `${rows[0].current_user} @ ${rows[0].current_database}; ${String(rows[0].version).split(' on ')[0]}`);
} catch (error) {
  report('FAIL', 'connect with DATABASE_URL', error.message);
}

if (connected) {
  const q = async (sql) => (await client.query(sql)).rows;

  for (const role of ['authenticated', 'service_role']) {
    try {
      await client.query('begin');
      await client.query(`set local role ${role}`);
      await client.query('rollback');
      report('PASS', `can switch to role ${role}`, 'the app uses this for RLS-scoped and privileged transactions');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      report('FAIL', `can switch to role ${role}`, error.message);
    }
  }

  const auth = (await q(`select
      to_regclass('auth.users') is not null as users,
      exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'auth' and p.proname = 'uid') as uid,
      has_schema_privilege(current_user, 'auth', 'CREATE') as can_create_in_auth`))[0];
  report(auth.users && auth.uid ? 'PASS' : 'FAIL', 'Supabase auth schema present (auth.users, auth.uid())', `users=${auth.users}, uid=${auth.uid}`);
  report(
    auth.can_create_in_auth ? 'PASS' : 'WARN',
    `${e.DATABASE_URL ? 'connecting role' : 'role'} has CREATE on schema auth`,
    auth.can_create_in_auth
      ? ''
      : 'Migration 0000 runs `create schema/table if not exists` in auth. If the dry run below fails there, that is the cause; fix 0000 before the first real apply (nothing is recorded by a dry run).',
  );

  const pgmq = (await q(`select
      exists (select 1 from pg_available_extensions where name = 'pgmq') as available,
      exists (select 1 from pg_extension where extname = 'pgmq') as installed`))[0];
  report(
    pgmq.available ? 'PASS' : 'WARN',
    'pgmq (Supabase Queues) is available',
    pgmq.available
      ? `installed=${pgmq.installed}; migration 0008 will use the real extension`
      : 'Not available: 0008 would install the SQL fallback instead of Supabase Queues. Enable Queues in the dashboard.',
  );

  const existing = await q(`select c.relname, c.reltuples::bigint as estimate
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and c.relname in ('entities','business_units','knowledge','external_contacts','external_companies')`);
  const history = (await q(`select to_regclass('public.schema_migrations') is not null as present`))[0].present;
  if (existing.length > 0 && !history) {
    let populated = [];
    for (const { relname } of existing) {
      const n = (await q(`select count(*)::int as n from public."${relname}"`))[0].n;
      if (n > 0) populated.push(`${relname}=${n}`);
    }
    report(
      populated.length ? 'WARN' : 'PASS',
      'the database does not already hold application data',
      populated.length
        ? `Existing rows: ${populated.join(', ')}. This looks like a copy of a live project. Continue only if it is an anonymised test copy.`
        : 'legacy tables exist but are empty',
    );
  } else {
    report('PASS', 'the database does not already hold application data', history ? 'already migrated by this tool before' : 'no application tables yet');
  }
  await client.end();
}

// ---------------------------------------------------------------------------
section('Migrations');
if (connected) {
  const run = (args) => spawnSync(process.execPath, ['scripts/migrate.mjs', ...args], { cwd: root, env: e, encoding: 'utf8' });
  const status = run(['--status']);
  const statusText = `${status.stdout}${status.stderr}`;
  const pendingLine = statusText.trim().split('\n').find((line) => /pending\. Target/.test(line)) ?? '';
  report(status.status === 0 ? 'PASS' : 'FAIL', 'migration history is consistent', status.status === 0 ? pendingLine : statusText.split('\n').filter((l) => /CHANGED|Refusing|Stopped/.test(l)).join(' | '));

  if (status.status === 0 && !/\b0 pending/.test(pendingLine)) {
    const dry = run(['--dry-run']);
    const dryText = `${dry.stdout}${dry.stderr}`;
    const failure = dryText.split('\n').find((line) => /FAILED/.test(line));
    report(
      dry.status === 0 ? 'PASS' : 'FAIL',
      'dry run: every pending migration applies, then rolled back',
      dry.status === 0
        ? 'nothing was changed'
        : `${failure ?? 'failed'}\n        ${dryText.split('\n').slice(dryText.split('\n').findIndex((l) => /FAILED/.test(l)) + 1).filter(Boolean).slice(0, 4).join('\n        ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
section('Seed credentials');
for (const [emailKey, passwordKey, localDefault] of [
  ['SEED_ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD', 'ChangeMeBeforeUse'],
  ['SEED_CLIENT_EMAIL', 'SEED_CLIENT_PASSWORD', 'ChangeMeBeforeUse'],
]) {
  const ok = Boolean(e[emailKey]) && Boolean(e[passwordKey]) && e[passwordKey] !== localDefault && e[passwordKey].length >= 12;
  report(ok ? 'PASS' : 'FAIL', `${emailKey} / ${passwordKey} set, not the local default, 12+ characters`, ok ? e[emailKey] : 'set both in .env.supabase-test');
}
report(e.OPENAI_API_KEY ? 'PASS' : 'WARN', 'OPENAI_API_KEY', e.OPENAI_API_KEY ? 'live model calls will be used' : 'not set: the mock provider will run and results will be labelled synthetic');

// ---------------------------------------------------------------------------
const fails = results.filter((r) => r.level === 'FAIL');
const warns = results.filter((r) => r.level === 'WARN');
console.log(`\n\x1b[1mPreflight\x1b[0m: ${results.length - fails.length - warns.length} pass, ${warns.length} warn, ${fails.length} fail.`);
console.log(fails.length ? 'Fix the failures before running supabase:test:migrate.' : 'Ready for npm run supabase:test:migrate.');
process.exit(fails.length ? 1 : 0);
