import { readFileSync, writeFileSync } from 'node:fs';
import { readOnlyClient, rows } from './connect.mjs';
const inv = JSON.parse(readFileSync('scripts/prod-audit/out-inventory.json','utf8'));
const tables = inv.tables.filter(t => t.relkind === 'r').map(t => t.table);
const client = await readOnlyClient();
const counts = {};
try {
  for (const t of tables) {
    const r = await rows(client, `select count(*)::int as n from public."${t.replace(/"/g,'""')}"`);
    counts[t] = r[0].n;
  }
} finally { await client.end(); }
writeFileSync('scripts/prod-audit/out-counts.json', JSON.stringify(counts, null, 2));

const byTable = {};
for (const c of inv.columns) (byTable[c.table_name] ||= []).push(c.column_name);
const marker = ['workspace_id','created_at','updated_at','id','status','confidence','source_status'];
console.log('TABLE                                   ROWS   ' + marker.join(' '));
for (const t of tables) {
  const cols = byTable[t] || [];
  const flags = marker.map((m) => (cols.includes(m) ? m.padEnd(m.length,' ') : '·'.repeat(m.length))).join(' ');
  console.log(`${t.padEnd(38)} ${String(counts[t]).padStart(5)}   ${flags}`);
}
console.log('\nTables WITH workspace_id:', tables.filter(t=>(byTable[t]||[]).includes('workspace_id')).join(', ') || '(NONE)');
