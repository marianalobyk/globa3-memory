/** Preserves the legacy system-design notes in version control before 0021 drops them. */
import { writeFileSync } from 'node:fs';
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:57951/postgres' });
await c.connect();
const { rows } = await c.query(`select title, trim(type) as type, source, order_index, content
  from public."Globa 3 Automatization & Memory" order by order_index`);
await c.end();
const out = [
  '# Legacy system notes',
  '',
  'The 15 rows that lived in the production table `Globa 3 Automatization & Memory`,',
  'preserved verbatim before `0021_drop_legacy_tables.sql` removed it.',
  '',
  'They are **engineering notes about how the previous memory system was designed**,',
  'not business memory. They were deliberately not migrated into `research_findings`:',
  'putting them there would mean the Ask pipeline answering questions about Globa 3',
  'with the design decisions of the system being replaced. Several of the principles',
  'below still hold and are worth reading; none of them belongs in the memory graph.',
  '',
  'The rows also remain in the backup at `~/globa3-backups/prod-2026-09-28T21-09-54/`.',
  '',
  '---',
  '',
];
for (const r of rows) {
  out.push(`## ${r.order_index}. ${r.title}`, '', `*${r.type}${r.source ? ` · source: ${r.source}` : ''}*`, '', String(r.content).trim(), '');
}
writeFileSync('docs/LEGACY-SYSTEM-NOTES.md', out.join('\n'));
console.log(`wrote docs/LEGACY-SYSTEM-NOTES.md with ${rows.length} notes`);
