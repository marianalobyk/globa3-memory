#!/usr/bin/env node
/**
 * Proves server secrets cannot reach a client bundle.
 *
 *   npm run verify:client-secrets
 *
 * Builds the web app (production build) and exports the iOS app bundle with
 * planted, fake secret values in the environment -- a model key, a Supabase
 * service-role key and JWT secret, a database URL with a password, and the dev
 * auth secret -- then searches every file a browser or phone would download for
 * those values. Only the web server's own output (.next/server) may contain
 * server code; nothing under .next/static or the iOS export may.
 *
 * The planted values are fake and the builds make no network calls with them.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextBin } from './lib/next-bin.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tag = randomBytes(6).toString('hex');
const planted = {
  OPENAI_API_KEY: `sk-planted-openai-${tag}`,
  SUPABASE_SERVICE_ROLE_KEY: `planted-service-role-${tag}`,
  SUPABASE_JWT_SECRET: `planted-jwt-secret-${tag}`,
  DEV_AUTH_SECRET: `planted-dev-auth-${tag}`,
  DATABASE_URL: `postgres://planted_user:planted-db-password-${tag}@127.0.0.1:9/planted`,
};
const needles = [...Object.values(planted), `planted-db-password-${tag}`];

const baseEnv = {
  ...process.env,
  ...planted,
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  G3_SKIP_ROOT_ENV: '1',
  NEXT_TELEMETRY_DISABLED: '1',
  EXPO_NO_TELEMETRY: '1',
};

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? `\n        ${detail}` : ''}`);
};

function files(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else out.push(full);
  }
  return out;
}

function scan(dir) {
  const hits = [];
  const list = files(dir);
  for (const file of list) {
    const text = readFileSync(file).toString('latin1');
    for (const needle of needles) if (text.includes(needle)) hits.push(`${relative(root, file)} contains a planted value`);
  }
  return { count: list.length, hits };
}

const webDist = '.next-secret-scan';
const iosDist = resolve(root, 'apps/mobile/dist-secret-scan');
try {
  console.log('\x1b[1mClient bundles cannot carry server secrets\x1b[0m');

  console.log('\nBuilding the web app with planted secrets…');
  const web = spawnSync(nextBin, ['build'], {
    cwd: resolve(root, 'apps/web'),
    env: { ...baseEnv, NEXT_DIST_DIR: webDist },
    encoding: 'utf8',
  });
  check('web production build succeeds', web.status === 0, web.status === 0 ? '' : (web.stdout + web.stderr).slice(-1500));
  if (web.status === 0) {
    const result = scan(resolve(root, 'apps/web', webDist, 'static'));
    check(`web browser bundle (${result.count} files) contains no planted secret`, result.hits.length === 0, result.hits.join('\n        '));
  }

  console.log('\nExporting the iOS bundle with planted secrets…');
  const ios = spawnSync(resolve(root, 'apps/mobile/node_modules/.bin/expo'), ['export', '--platform', 'ios', '--output-dir', iosDist], {
    cwd: resolve(root, 'apps/mobile'),
    env: { ...baseEnv, EXPO_PUBLIC_API_URL: 'https://globa3.example.test', CI: '1' },
    encoding: 'utf8',
  });
  check('iOS bundle export succeeds', ios.status === 0, ios.status === 0 ? '' : (ios.stdout + ios.stderr).slice(-1500));
  if (ios.status === 0) {
    const result = scan(iosDist);
    check(`iOS app bundle (${result.count} files) contains no planted secret`, result.hits.length === 0, result.hits.join('\n        '));
    const bundles = files(iosDist).filter((f) => f.endsWith('.hbc') || f.endsWith('.js'));
    const joined = bundles.map((f) => readFileSync(f).toString('latin1')).join('\n');
    check('the iOS bundle contains the public server URL it was built with', joined.includes('https://globa3.example.test'));
    check('the iOS bundle does not include the server database or model clients', !/pg-protocol|pgmq|openai\/resources|withServiceRead/.test(joined));
  }
} finally {
  rmSync(resolve(root, 'apps/web', webDist), { recursive: true, force: true });
  if (existsSync(iosDist)) rmSync(iosDist, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'All client bundle checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
