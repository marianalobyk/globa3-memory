import { readOnlyClient, databaseUrl, describe, rows } from './connect.mjs';
const url = databaseUrl();
console.log('target:', JSON.stringify(describe(url)));
const client = await readOnlyClient(url);
try {
  console.log('server  :', (await rows(client, 'select version() as v'))[0].v.split(' ').slice(0, 2).join(' '));
  console.log('database:', (await rows(client, 'select current_database() as d, current_user as u'))[0]);
  console.log('readonly:', (await rows(client, 'show default_transaction_read_only'))[0]);
  try {
    await client.query('create table public._g3_write_probe (x int)');
    console.log('WRITE PROBE: !!! a write SUCCEEDED - this session is NOT read-only');
  } catch (error) {
    console.log('write probe refused as expected:', error.message);
  }
} finally {
  await client.end();
}
