#!/usr/bin/env node
/**
 * Client-role privileges on the TEST project, read-only.
 *
 *   npm run supabase:test:grants            # checks; exit 1 on any failure
 *   npm run supabase:test:grants -- --json  # also prints a summary as JSON
 *
 * Reads the catalog only, in a READ ONLY transaction. Prints table, sequence and
 * function names and privilege names; no data, no credentials.
 */
import pg from 'pg';
import { checkClientGrants, inspectClientGrants, summariseGrants } from '../lib/client-grants.mjs';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query('begin read only');
let failures = 0;
try {
  const inv = await inspectClientGrants(client);
  for (const r of checkClientGrants(inv)) {
    if (!r.ok) failures += 1;
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n        ${r.detail}` : ''}`);
  }
  if (process.argv.includes('--json')) console.log(`SUMMARY ${JSON.stringify(summariseGrants(inv))}`);
} finally {
  await client.query('rollback');
  await client.end();
}
console.log(`\n${failures === 0 ? 'All client grant checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
