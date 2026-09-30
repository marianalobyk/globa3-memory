#!/usr/bin/env node
/**
 * The eleven proofs the migrated database has to pass.
 *
 *   node scripts/prod-audit/integrity-proofs.mjs [database-url]
 *
 * Runs against the rehearsal copy by default. Read-only: every statement is a
 * SELECT, so it is safe to point at production after the release to confirm the
 * same result there.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const url = process.argv[2] ?? 'postgres://postgres:postgres@127.0.0.1:57951/postgres';
const root = resolve(import.meta.dirname, '..', '..');
const c = new pg.Client({ connectionString: url, ssl: /supabase\.(co|com)/i.test(url) ? { rejectUnauthorized: false } : undefined });
await c.connect();
await c.query('set session default_transaction_read_only = on');

const checks = [];
const check = async (name, sql, ok, detail = (r) => JSON.stringify(r), params = []) => {
  const { rows } = await c.query(sql, params);
  const r = rows[0] ?? {};
  const passed = ok(r, rows);
  checks.push({ name, passed });
  console.log(`  ${passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (!passed) console.log(`        ${detail(r, rows)}`);
  return rows;
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const LEGACY = ['external_contacts', 'external_companies', 'relationship_interactions', 'knowledge', 'rules', 'meetings', 'Globa 3 Automatization & Memory'];

section('1. No legacy table remains');
await check('all seven legacy tables are gone',
  `select coalesce(string_agg(t, ', '), '') as left_over from (select unnest($1::text[]) t) x
    where to_regclass('public.' || quote_ident(t)) is not null`,
  (r) => r.left_over === '', (r) => `still present: ${r.left_over}`, [LEGACY]);
await check('the legacy write function is gone',
  `select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname='upsert_legacy_record'`,
  (r) => r.n === 0);
await check('the legacy pointer columns are gone from entities',
  `select count(*)::int n from information_schema.columns where table_schema='public' and table_name='entities'
     and column_name in ('legacy_external_contact_id','legacy_external_company_id')`,
  (r) => r.n === 0);

section('2. No duplicate canonical identity');
await check('no two active entities share a normalised name and type',
  `select count(*)::int n from (
     select 1 from public.entities where status='active'
      group by workspace_id, lower(regexp_replace(display_name,'\\s+',' ','g')), entity_type having count(*) > 1) d`,
  (r) => r.n === 0);

section('3. Every retained relationship resolves');
await check('every alias points at exactly one existing entity',
  `select count(*)::int n from public.entity_aliases a where not exists (select 1 from public.entities e where e.id=a.entity_id)`,
  (r) => r.n === 0);
await check('every affiliation joins two existing entities',
  `select count(*)::int n from public.entity_affiliations a
    where not exists (select 1 from public.entities p where p.id=a.person_entity_id)
       or not exists (select 1 from public.entities o where o.id=a.organization_entity_id)`,
  (r) => r.n === 0);
await check('the person side of every affiliation is a person',
  `select count(*)::int n from public.entity_affiliations a join public.entities p on p.id=a.person_entity_id where p.entity_type <> 'person'`,
  (r) => r.n === 0);
await check('the other side is an organisation, project or institution (role credits are valid)',
  `select count(*)::int n from public.entity_affiliations a join public.entities o on o.id=a.organization_entity_id
    where o.entity_type not in ('organization','project','institution')`,
  (r) => r.n === 0);
await check('every signal_entities link resolves on both sides',
  `select count(*)::int n from public.signal_entities se
    where not exists (select 1 from public.signals s where s.id=se.signal_id)
       or not exists (select 1 from public.entities e where e.id=se.entity_id)`,
  (r) => r.n === 0);

section('4. Every signal has at least one linked entity');
await check('no signal is about nothing',
  `select count(*)::int n from public.signals s where not exists (select 1 from public.signal_entities se where se.signal_id=s.id)`,
  (r) => r.n === 0);

section('5. Every finding has traceable provenance');
await check('every finding cites evidence or an artifact',
  `select count(*)::int n from public.research_findings where evidence_id is null and artifact_id is null`,
  (r) => r.n === 0);
await check('every finding has a subject: an entity or a business unit',
  `select count(*)::int n from public.research_findings where related_entity_id is null and business_unit_id is null`,
  (r) => r.n === 0);
await check('every cited evidence row exists',
  `select count(*)::int n from public.research_findings f where f.evidence_id is not null
     and not exists (select 1 from public.evidence e where e.id=f.evidence_id)`,
  (r) => r.n === 0);

section('6. Every action has a meaningful target');
await check('no action is disconnected',
  `select count(*)::int n from public.actions
    where related_entity_id is null and related_interaction_id is null
      and internal_business_unit_id is null and evidence_id is null`,
  (r) => r.n === 0);

section('7. Every interaction has a subject');
await check('every interaction names an entity or an internal business unit',
  `select count(*)::int n from public.interactions where external_entity_id is null and internal_business_unit_id is null`,
  (r) => r.n === 0, (r) => `${r.n} interaction(s) with no subject`);

section('8. Every evidence row supports something');
await check('no unattached evidence',
  `select count(*)::int n from public.evidence ev
    where not exists (select 1 from public.entities x where x.source_evidence_id=ev.id)
      and not exists (select 1 from public.research_findings x where x.evidence_id=ev.id)
      and not exists (select 1 from public.research_finding_evidence x where x.evidence_id=ev.id)
      and not exists (select 1 from public.signals x where x.evidence_id=ev.id)
      and not exists (select 1 from public.interactions x where x.evidence_id=ev.id)
      and not exists (select 1 from public.actions x where x.evidence_id=ev.id)
      and not exists (select 1 from public.research_artifacts x where x.source_evidence_id=ev.id)
      and not exists (select 1 from public.entity_affiliations x where x.evidence_id=ev.id)
      and not exists (select 1 from public.entity_mentions x where x.source_evidence_id=ev.id)
      and not exists (select 1 from public.opportunities x where x.evidence_id=ev.id)
      and not exists (select 1 from public.outcomes x where x.evidence_id=ev.id)`,
  (r) => r.n === 0, (r) => `${r.n} evidence row(s) support nothing`);

section('9. Unresolved mentions are genuinely useful');
await check('every pending mention carries a rationale and a source',
  `select count(*)::int n from public.entity_mentions
    where resolution_status='pending' and (rationale is null or source_evidence_id is null)`,
  (r) => r.n === 0);
await check('no pending mention actually matches an existing entity',
  `select count(*)::int n from public.entity_mentions m where m.resolution_status='pending'
     and exists (select 1 from public.entities e where e.workspace_id=m.workspace_id and e.status='active' and e.slug=m.mention_slug)`,
  (r) => r.n === 0);

section('10. Workspace scoping and RLS');
await check('every scoped table has RLS enabled',
  `select count(*)::int n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
    where ns.nspname='public' and c.relkind='r' and not c.relrowsecurity
      and exists (select 1 from information_schema.columns col where col.table_schema='public' and col.table_name=c.relname and col.column_name='workspace_id')`,
  (r) => r.n === 0);
await check('no row anywhere is missing its workspace',
  `select coalesce(string_agg(t.table_name || '=' || t.n, ', '), '') as bad from (
     select col.table_name, (xpath('/row/c/text()',
       query_to_xml(format('select count(*) c from public.%I where workspace_id is null', col.table_name), false, true, '')))[1]::text::int n
     from information_schema.columns col
     where col.table_schema='public' and col.column_name='workspace_id') t where t.n > 0`,
  (r) => r.bad === '', (r) => `unscoped rows: ${r.bad}`);

section('11. No application code path reads a legacy table');
{
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !p.includes('/prod-audit/')) files.push(p);
    }
  };
  for (const d of ['packages', 'apps', 'scripts']) walk(`${root}/${d}`);
  // Require the `public.` qualifier: every real query in this codebase uses it,
  // and without it the check trips on ordinary prose like "capture into
  // knowledge is coming next".
  const pattern = new RegExp(`public\\.\\s*"?(${LEGACY.map((t) => t.replace(/[&\s]/g, '.')).join('|')})"?`, 'i');
  const offenders = files.filter((f) => pattern.test(readFileSync(f, 'utf8')))
    .map((f) => f.replace(`${root}/`, ''));
  const passed = offenders.length === 0;
  checks.push({ name: 'no SQL in the app names a legacy table', passed });
  console.log(`  ${passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  no SQL in the app names a legacy table`);
  if (!passed) for (const o of offenders) console.log(`        ${o}`);
}

section('Counts');
const { rows: counts } = await c.query(`
  select 'entities' t, count(*)::int n from public.entities
  union all select 'evidence', count(*) from public.evidence
  union all select 'research_findings', count(*) from public.research_findings
  union all select 'signals', count(*) from public.signals
  union all select 'signal_entities', count(*) from public.signal_entities
  union all select 'entity_affiliations', count(*) from public.entity_affiliations
  union all select 'entity_aliases', count(*) from public.entity_aliases
  union all select 'entity_mentions', count(*) from public.entity_mentions
  union all select 'interactions', count(*) from public.interactions
  union all select 'actions', count(*) from public.actions
  union all select 'opportunities', count(*) from public.opportunities
  union all select 'outcomes', count(*) from public.outcomes
  union all select 'research_artifacts', count(*) from public.research_artifacts
  union all select 'business_units', count(*) from public.business_units
  union all select 'members', count(*) from public.members
  order by 1`);
for (const r of counts) console.log(`  ${r.t.padEnd(22)} ${r.n}`);

await c.end();
const failed = checks.filter((x) => !x.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} proofs passed`);
process.exit(failed.length === 0 ? 0 : 1);
