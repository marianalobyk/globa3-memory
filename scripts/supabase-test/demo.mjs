#!/usr/bin/env node
/**
 * Fast demo run against the TEST Supabase project: production build + `next start`
 * and the worker, in one terminal.
 *
 *   npm run supabase:test:demo              # build, then start web on :3000 and the worker
 *   npm run supabase:test:demo -- --no-build  # reuse the last build
 *
 * Why not `next dev`: dev mode compiles routes on demand, recompiles on file
 * changes and runs unminified React with extra checks. The production server
 * serves prebuilt routes.
 *
 * Both processes go through scripts/supabase-test/run.mjs, so the same guards
 * apply (test project only, never production, dev sign-in forced off).
 *
 * Connection budget: the Supabase session pooler allows 15 clients for the whole
 * project. The web server gets 8 and the worker 3, leaving room for a migration
 * status check or an import verification while the demo runs.
 *
 * Ctrl+C stops both.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextBin } from '../lib/next-bin.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wrapper = resolve(root, 'scripts/supabase-test/run.mjs');
const port = Number(process.env.PORT ?? 3000);
const distDir = '.next-prod';

const portFree = await new Promise((resolvePort) => {
  const probe = createServer()
    .once('error', () => resolvePort(false))
    .once('listening', () => probe.close(() => resolvePort(true)))
    .listen(port, '127.0.0.1');
});
if (!portFree) {
  console.error(`[demo] Port ${port} is in use. Stop the running \`npm run supabase:test:dev\` (Ctrl+C in its terminal) and try again.`);
  process.exit(1);
}

const baseEnv = { ...process.env, NEXT_DIST_DIR: distDir, NEXT_TELEMETRY_DISABLED: '1' };

if (!process.argv.includes('--no-build')) {
  console.log('[demo] building the web app (production)...');
  const build = spawnSync(process.execPath, [wrapper, 'npm', 'run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...baseEnv, NODE_ENV: 'production' },
  });
  if (build.status !== 0) {
    console.error('[demo] build failed; nothing started.');
    process.exit(build.status ?? 1);
  }
}

const children = [
  spawn(process.execPath, [wrapper, nextBin, 'start', 'apps/web', '-p', String(port)], {
    cwd: root,
    stdio: 'inherit',
    env: { ...baseEnv, NODE_ENV: 'production', PG_POOL_MAX: process.env.PG_POOL_MAX ?? '8', G3_WARM_POOL: process.env.G3_WARM_POOL ?? '4' },
  }),
  spawn(process.execPath, [wrapper, 'npm', 'run', 'worker'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...baseEnv, PG_POOL_MAX: process.env.WORKER_PG_POOL_MAX ?? '3' },
  }),
];

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGINT');
  setTimeout(() => process.exit(code), 1500).unref();
};
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
for (const child of children) child.on('exit', (code) => stop(code ?? 0));
console.log(`[demo] web on http://localhost:${port} (production build), worker running. Ctrl+C stops both.`);
