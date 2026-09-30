#!/usr/bin/env node
/**
 * Seeds a CLEAN local demo database.
 *
 *   npm run db:seed
 *
 * Not for a database with imported Globa 3 data: use db:bootstrap:imported.
 *
 * Credentials come from the environment so they are never committed:
 *   SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
 *   SEED_CLIENT_EMAIL / SEED_CLIENT_PASSWORD
 */
import { closePool } from '../db.js';
import { isAppError } from '../errors.js';
import { seedWorkspace } from '../seed.js';
import { guardTarget } from './guard.js';

const target = await guardTarget('seed');

// The demo seed overwrites the type and summary of business units. On a
// database holding imported Globa 3 data that would replace real records, so
// seedWorkspace refuses there and points at the import-safe bootstrap. Locally,
// a deliberate reset of a demo database can set SEED_OVERWRITE_BUSINESS_UNITS=1.
const allowImportedData = target.kind === 'local' && process.env.SEED_OVERWRITE_BUSINESS_UNITS === '1';

const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.invalid';
const clientEmail = process.env.SEED_CLIENT_EMAIL ?? 'client@example.invalid';
const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMeBeforeUse';
const clientPassword = process.env.SEED_CLIENT_PASSWORD ?? 'ChangeMeBeforeUse';

let result;
try {
  result = await seedWorkspace({
    adminEmail,
    adminPassword,
    clientEmail,
    clientPassword,
    allowImportedData,
  });
} catch (error) {
  if (!isAppError(error) || error.code !== 'imported_data_present') throw error;
  console.error(`[seed] ${error.message}`);
  await closePool();
  process.exit(1);
}

console.log('Seeded workspace', result.workspaceId);
console.log('  admin :', adminEmail);
console.log('  client:', clientEmail);
for (const format of result.formats) {
  console.log(
    `  format: ${format.key} (prompt v${format.promptVersion}, ${format.attachments} desk file(s))`,
  );
}
console.log(`  business units: ${result.businessUnits}`);
console.log(`  context items : ${result.contextItems} new`);
console.log(`  entities      : ${result.entities} new`);
if (!process.env.SEED_ADMIN_PASSWORD) {
  console.log('\nPasswords came from defaults. Set SEED_ADMIN_PASSWORD / SEED_CLIENT_PASSWORD to change them.');
}
await closePool();
