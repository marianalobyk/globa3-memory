/**
 * A timestamped, recoverable backup of production, written OUTSIDE the
 * repository (so it can never be committed) and outside production.
 *
 * Read-only against production: pg_dump only reads. The connection string is
 * passed to the child process in its environment and is never printed or
 * written to disk.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { databaseUrl, describe } from './connect.mjs';

const PG_DUMP = '/opt/homebrew/opt/libpq/bin/pg_dump';
const url = databaseUrl();
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = join(homedir(), 'globa3-backups', `prod-${stamp}`);
mkdirSync(dir, { recursive: true });

const run = (label, args, file) => {
  const started = Date.now();
  const result = spawnSync(PG_DUMP, [...args, '--file', join(dir, file)], {
    env: { ...process.env, PGCONNECT_TIMEOUT: '30', PGSSLMODE: 'require' },
    encoding: 'utf8',
  });
  const ok = result.status === 0;
  const size = ok ? statSync(join(dir, file)).size : 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(26)} ${file.padEnd(34)} ${(size / 1024).toFixed(0)}KB  ${((Date.now()-started)/1000).toFixed(1)}s`);
  if (!ok) console.error((result.stderr || '').slice(-1200));
  return ok;
};

console.log('target:', JSON.stringify(describe(url)));
console.log('backup dir:', dir, '\n');

const base = [url, '--no-owner', '--no-privileges', '--no-acl'];
const results = [
  // The restorable one: everything in public, schema + data, custom format.
  run('public schema+data (Fc)', [...base, '--schema', 'public', '--format', 'custom', '--compress', '9'], 'public.dump'),
  // Readable equivalents, for diffing and for building the local rehearsal copy.
  run('public schema only (sql)', [...base, '--schema', 'public', '--schema-only'], 'public-schema.sql'),
  run('public data only (sql)', [...base, '--schema', 'public', '--data-only', '--column-inserts'], 'public-data.sql'),
  // The whole database, in case something outside public matters later.
  run('all schemas (Fc)', [...base, '--format', 'custom', '--compress', '9'], 'all.dump'),
];

writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify({
  takenAt: new Date().toISOString(),
  target: describe(url),
  server: 'PostgreSQL 17.6',
  pgDump: '18.4',
  files: ['public.dump', 'public-schema.sql', 'public-data.sql', 'all.dump'],
  note: 'Restore the memory model with: pg_restore --dbname <target> public.dump',
}, null, 2));

console.log('\nmanifest written.');
process.exit(results.every(Boolean) ? 0 : 1);
