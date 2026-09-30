import pg from 'pg';
const c = new pg.Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:57951/postgres' });
await c.connect();
for (const t of ['structure','writing','visual']) {
  const { rows } = await c.query(`select title, content from public.rules where type=$1 order by title limit 5`, [t]);
  console.log(`\n##### rules / ${t} #####`);
  for (const r of rows) console.log(`- ${r.title}\n    ${String(r.content).replace(/\s+/g,' ').slice(0,190)}`);
}
const { rows: bu } = await c.query(`select coalesce(b.name,'(none)') bu, count(*)::int n from public.knowledge k left join public.business_units b on b.id=k.business_unit_id group by 1 order by 2 desc`);
console.log('\n##### knowledge by business unit #####'); for (const r of bu) console.log(`  ${r.bu.padEnd(24)} ${r.n}`);
const { rows: rbu } = await c.query(`select coalesce(b.name,'(none)') bu, count(*)::int n from public.rules r left join public.business_units b on b.id=r.business_unit_id group by 1 order by 2 desc`);
console.log('\n##### rules by business unit #####'); for (const r of rbu) console.log(`  ${r.bu.padEnd(24)} ${r.n}`);
await c.end();
