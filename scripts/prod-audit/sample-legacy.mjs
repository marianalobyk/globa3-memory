import pg from 'pg';
const c = new pg.Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:57951/postgres' });
await c.connect();
const show = async (label, sql) => {
  const { rows } = await c.query(sql);
  console.log(`\n##### ${label} #####`);
  for (const r of rows) console.log(`- [${(r.type||'').trim()}] ${r.title}\n    ${String(r.content||'').replace(/\s+/g,' ').slice(0,240)}`);
};
await show('knowledge: context/scope/positioning/direction', `select type,title,content from public.knowledge where type in ('context','scope','positioning','direction','roadmap','thesis','commercial_model') order by type limit 8`);
await show('knowledge: insight/market', `select type,title,content from public.knowledge where type in ('insight','market_watch','market_signal','model_watch','story_ip_watch','format_rights_signal','incentive_research') order by type limit 6`);
await show('knowledge: decision/partner', `select type,title,content from public.knowledge where type in ('decision','partner_assessment','partner_context','relationship_context') order by type limit 6`);
await show('knowledge: system_logic', `select type,title,content from public.knowledge where type='system_logic' limit 5`);
await show('rules', `select type,title,content from public.rules order by type limit 8`);
await show('automatization', `select trim(type) type,title,content from public."Globa 3 Automatization & Memory" order by order_index limit 6`);
await c.end();
