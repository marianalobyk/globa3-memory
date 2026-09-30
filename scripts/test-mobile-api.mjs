#!/usr/bin/env node
/**
 * The mobile capture API, end to end over HTTP, on an ISOLATED throwaway stack.
 *
 *   npm run verify:mobile-api
 *
 * Starts a PGlite database and the Next.js server (dev mode, because local dev
 * auth is refused in production mode) on their own ports, with a private
 * storage directory and a random auth secret, then runs
 * packages/core/src/cli/verify-mobile-api.ts against it. Never touches the
 * working local database, the root .env.local, or any Supabase project.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextBin } from './lib/next-bin.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPort = 57000 + Math.floor(Math.random() * 900);
const webPort = 3900 + Math.floor(Math.random() * 90);
const dir = mkdtempSync(join(tmpdir(), 'g3-mobile-api-'));
const env = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${dbPort}/postgres`,
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  SUPABASE_JWT_SECRET: '',
  G3_TARGET_ENV: '',
  SUPABASE_TEST_PROJECT_REF: '',
  OPENAI_API_KEY: '',
  DEV_AUTH_ENABLED: 'true',
  DEV_AUTH_SECRET: randomBytes(24).toString('hex'),
  G3_SKIP_ROOT_ENV: '1',
  G3_DB_TIMING: '',
  LOCAL_STORAGE_DIR: join(dir, 'storage'),
  NEXT_DIST_DIR: '.next-mobile-api-test',
  NEXT_TELEMETRY_DISABLED: '1',
  MOBILE_API_URL: `http://127.0.0.1:${webPort}`,
};

const children = [];
const childOutput = new Map();
const childExit = new Map();
const start = (command, args, options, readyText, label, timeoutMs) =>
  new Promise((ok, fail) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    childOutput.set(child, () => output);
    const timer = setTimeout(() => fail(new Error(`${label} did not start:\n${output.slice(-1500)}`)), timeoutMs);
    const onData = (chunk) => {
      output = `${output}${String(chunk)}`.slice(-16_000);
      if (output.includes(readyText)) {
        clearTimeout(timer);
        ok(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code, signal) => {
      childExit.set(child, { code, signal });
      fail(new Error(`${label} exited (${code ?? signal ?? 'unknown'}):\n${output.slice(-1500)}`));
    });
  });

let code = 1;
let webServer;
try {
  await start(process.execPath, ['scripts/local-db.mjs'], {
    cwd: root,
    env: { ...process.env, LOCAL_PG_PORT: String(dbPort), LOCAL_PG_DATA: join(dir, 'pgdata') },
  }, 'listening', 'throwaway database', 30_000);

  const migrate = spawnSync(process.execPath, ['scripts/migrate.mjs'], { cwd: root, env, encoding: 'utf8' });
  if (migrate.status !== 0) throw new Error(`migrate failed:\n${migrate.stdout}\n${migrate.stderr}`);

  webServer = await start(nextBin, ['dev', '--port', String(webPort), '--hostname', '127.0.0.1'], {
    cwd: resolve(root, 'apps/web'),
    env,
  }, 'Ready', 'web server', 120_000);

  const run = await new Promise((ok, fail) => {
    const child = spawn(resolve(root, 'node_modules/.bin/tsx'), ['packages/core/src/cli/verify-mobile-api.ts'], {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    child.on('error', fail);
    child.on('exit', (status) => ok(status ?? 1));
  });
  code = run;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  if (code !== 0 && webServer) {
    const output = childOutput.get(webServer)?.() ?? '';
    const exit = childExit.get(webServer) ?? { code: webServer.exitCode, signal: webServer.signalCode };
    console.error(`\n[verify:mobile-api] web server exit: ${exit.code ?? exit.signal ?? 'still running'}`);
    console.error(`[verify:mobile-api] web server output:\n${output.slice(-8_000) || '(no output captured)'}`);
  }
  for (const child of children.reverse()) child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1200));
  rmSync(dir, { recursive: true, force: true });
  rmSync(resolve(root, 'apps/web/.next-mobile-api-test'), { recursive: true, force: true });
}
process.exit(code);
