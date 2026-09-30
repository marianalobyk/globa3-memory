#!/usr/bin/env node
/**
 * Runs a command against the TEST Supabase project.
 *
 *   node scripts/supabase-test/run.mjs <command> [args...]
 *
 * Loads .env.supabase-test (and only that file) over the environment, forces the
 * dev sign-in off, checks the target with the same guard migrate.mjs uses, and
 * refuses a local target, so a command meant for the test project cannot quietly
 * run against the local database instead. Then runs the command.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { assertSafeTarget } from '../lib/target.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = resolve(root, '.env.supabase-test');
if (!existsSync(file)) {
  console.error('Missing .env.supabase-test. Copy .env.supabase-test.example and fill in the TEST project.');
  process.exit(1);
}

const values = parse(readFileSync(file, 'utf8'));
// G3_SKIP_ROOT_ENV stops packages/core from also loading the root .env.local, so
// a value missing here can never be filled in from the local development file.
const env = {
  ...process.env,
  ...values,
  DEV_AUTH_ENABLED: 'false',
  G3_SKIP_ROOT_ENV: '1',
  NODE_ENV: process.env.NODE_ENV ?? 'development',
};

for (const required of ['G3_TARGET_ENV', 'SUPABASE_TEST_PROJECT_REF', 'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[required]) {
    console.error(`Missing ${required} in .env.supabase-test.`);
    process.exit(1);
  }
}

let target;
try {
  target = assertSafeTarget({ databaseUrl: env.DATABASE_URL, supabaseUrl: env.SUPABASE_URL, env });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
if (target.kind !== 'supabase-test') {
  console.error('Refusing: .env.supabase-test resolves to a local target. Point it at the test project.');
  process.exit(1);
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('Usage: run.mjs <command> [args...]');
  process.exit(2);
}
console.log(`[supabase-test] project ${target.ref} :: ${command} ${args.join(' ')}`);
const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', shell: false });
process.exit(result.status ?? 1);
