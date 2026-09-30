#!/usr/bin/env node
/**
 * Import-safe application bootstrap.
 *
 *   npm run db:bootstrap:imported -- --workspace globa3
 *   npm run supabase:test:bootstrap -- --workspace globa3
 *
 * For a database that already holds imported Globa 3 data. Creates memberships,
 * formats, prompt versions, context items and the budget setting when missing,
 * and never touches an imported record (see ../bootstrap-imported.ts).
 *
 * Credentials come from the environment:
 *   SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
 *   SEED_CLIENT_EMAIL / SEED_CLIENT_PASSWORD (optional; both are required when either is set)
 * On a non-local target the admin credentials must be set explicitly; there
 * are no defaults.
 * Passwords are used only when an account does not exist yet.
 */
import { bootstrapImportedWorkspace } from '../bootstrap-imported.js';
import { closePool } from '../db.js';
import { isAppError } from '../errors.js';
import { guardTarget } from './guard.js';

const target = await guardTarget('bootstrap-imported');

const args = process.argv.slice(2);
const workspaceIndex = args.indexOf('--workspace');
const workspaceSlug = workspaceIndex >= 0 ? args[workspaceIndex + 1] : undefined;
if (!workspaceSlug || workspaceSlug.startsWith('--')) {
  console.error('[bootstrap-imported] --workspace <slug> is required, e.g. --workspace globa3');
  process.exit(1);
}

const required = ['SEED_ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD'] as const;
if (target.kind !== 'local') {
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`[bootstrap-imported] set ${missing.join(', ')}; a remote target has no default credentials.`);
    process.exit(1);
  }
}

const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.invalid';
const clientEmail = process.env.SEED_CLIENT_EMAIL?.trim() || undefined;
const clientPassword = process.env.SEED_CLIENT_PASSWORD || undefined;
if (Boolean(clientEmail) !== Boolean(clientPassword)) {
  console.error('[bootstrap-imported] set both SEED_CLIENT_EMAIL and SEED_CLIENT_PASSWORD, or leave both empty.');
  process.exit(1);
}

try {
  const result = await bootstrapImportedWorkspace({
    workspaceSlug,
    adminEmail,
    adminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMeBeforeUse',
    clientEmail,
    clientPassword,
  });
  console.log(`Bootstrapped workspace ${workspaceSlug} (${result.workspaceId})`);
  console.log(`  admin : ${adminEmail}`);
  if (clientEmail) console.log(`  client: ${clientEmail}`);
  console.log('  created (existing rows are never modified):');
  for (const [name, count] of Object.entries(result.created)) console.log(`    ${name.padEnd(15)} ${count}`);
  for (const note of result.membershipNotes) console.log(`  note: ${note}`);
  console.log(`  imported tables unchanged: ${result.importedTablesChecked} checked`);
} catch (error) {
  console.error(`[bootstrap-imported] ${isAppError(error) ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
