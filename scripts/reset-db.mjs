#!/usr/bin/env node
/**
 * Deletes the local database directory.
 *
 * Refuses while the local database server is still running: PGlite keeps writing
 * to that directory, so deleting it underneath the process leaves a half-removed
 * data directory and a confusing "Directory not empty" error.
 */
import { createConnection } from 'node:net';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.LOCAL_PG_PORT ?? 54329);
const host = process.env.LOCAL_PG_HOST ?? '127.0.0.1';

const isRunning = await new Promise((done) => {
  const socket = createConnection({ port, host });
  socket.setTimeout(1500);
  socket.on('connect', () => {
    socket.destroy();
    done(true);
  });
  socket.on('error', () => done(false));
  socket.on('timeout', () => {
    socket.destroy();
    done(false);
  });
});

if (isRunning) {
  console.error(
    `The local database is still running on ${host}:${port}.\n` +
      'Stop it (Ctrl+C in the `npm run db:local` terminal), then run this again.',
  );
  process.exit(1);
}

for (const dir of ['.data/pgdata', '.data/storage']) {
  await rm(resolve(root, dir), { recursive: true, force: true });
  console.log(`removed ${dir}`);
}
console.log('\nNow run:  npm run db:local   (then, in another terminal)  npm run db:migrate && npm run db:seed');
