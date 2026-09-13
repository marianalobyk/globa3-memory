#!/usr/bin/env node
/**
 * Seeds the local/test database.
 *
 *   npm run db:seed
 *
 * Credentials come from the environment so they are never committed:
 *   SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
 *   SEED_CLIENT_EMAIL / SEED_CLIENT_PASSWORD
 */
import { closePool } from '../db.js';
import { seedWorkspace } from '../seed.js';

const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'mariana@erizos.tv';
const clientEmail = process.env.SEED_CLIENT_EMAIL ?? 'client@example.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'local-dev-admin';
const clientPassword = process.env.SEED_CLIENT_PASSWORD ?? 'local-dev-client';

const result = await seedWorkspace({
  adminEmail,
  adminPassword,
  clientEmail,
  clientPassword,
});

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
