#!/usr/bin/env node
/**
 * Query-count regression check on an ISOLATED throwaway database.
 *
 *   npm run verify:perf
 *
 * Starts a PGlite server on its own port and temp directory, migrates and seeds
 * it, then runs scripts/perf/nav-profile.mts --assert. Counts (transactions,
 * statements, round trips, read-only) are what this checks; latency on a local
 * WASM database says nothing about Supabase, so it is printed but not judged.
 * Never touches the working local database or any Supabase project.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = 56000 + Math.floor(Math.random() * 900);
const dir = mkdtempSync(join(tmpdir(), 'g3-perf-'));
const env = {
  ...process.env,
  DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  SUPABASE_JWT_SECRET: '',
  G3_TARGET_ENV: '',
  SUPABASE_TEST_PROJECT_REF: '',
  OPENAI_API_KEY: '',
  DEV_AUTH_ENABLED: 'true',
  G3_SKIP_ROOT_ENV: '1',
  G3_DB_TIMING: '',
  SEED_ADMIN_EMAIL: 'perf-admin@example.test',
  SEED_ADMIN_PASSWORD: 'perf-admin-password',
  SEED_CLIENT_EMAIL: 'perf-client@example.test',
  SEED_CLIENT_PASSWORD: 'perf-client-password',
};

const server = spawn(process.execPath, ['scripts/local-db.mjs'], {
  cwd: root,
  env: { ...process.env, LOCAL_PG_PORT: String(port), LOCAL_PG_DATA: join(dir, 'pgdata') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let code = 1;
try {
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('throwaway database did not start')), 30_000);
    server.stdout.on('data', (chunk) => String(chunk).includes('listening') && (clearTimeout(timer), ok()));
    server.on('exit', (c) => fail(new Error(`throwaway database exited (${c})`)));
  });
  const step = (label, command, args) => {
    const r = spawnSync(command, args, { cwd: root, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${label} failed:\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
  };
  step('migrate', process.execPath, ['scripts/migrate.mjs']);
  step('seed', resolve(root, 'node_modules/.bin/tsx'), ['packages/core/src/cli/seed.ts']);
  const profile = spawnSync(
    resolve(root, 'node_modules/.bin/tsx'),
    ['scripts/perf/nav-profile.mts', '--email', env.SEED_ADMIN_EMAIL, '--rounds', '2', '--assert'],
    { cwd: root, env, stdio: 'inherit' },
  );
  code = profile.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
