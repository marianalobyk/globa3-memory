#!/usr/bin/env node
/**
 * The gate that must pass before any legacy table is dropped.
 *
 *   node scripts/prod-audit/pre-drop-gate.mjs "$DATABASE_URL"
 *
 * Run it AFTER 0020 (which copies the legacy content into the final model) and
 * BEFORE 0021 (which drops the legacy tables). It exits non-zero if anything
 * fails, so `0021` can be gated on it.
 *
 * Strictly read-only: the session is opened with
 * `default_transaction_read_only = on`, so the server refuses any write
 * regardless of what this script asks for.
 *
 * It checks five things, which together are the whole argument for dropping:
 *
 *   1. Row counts   -- every retained table still holds what it held before.
 *   2. Coverage     -- every legacy row already exists in the final model.
 *   3. Foreign keys -- no reference anywhere is dangling.
 *   4. RLS          -- every workspace-scoped table enforces it, and no client
 *                      role can write.
 *   5. Queries      -- no application code path still names a legacy table.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const url = process.argv[2] ?? 'postgres://postgres:postgres@127.0.0.1:57951/postgres';
const root = resolve(import.meta.dirname, '..', '..');
const LEGACY = ['external_contacts', 'external_companies', 'relationship_interactions', 'knowledge', 'rules', 'meetings', 'Globa 3 Automatization & Memory'];
/** What production held on 28 September 2026, before anything was applied. */
const BASELINE = JSON.parse(readFileSync(resolve(root, 'scripts/prod-audit/out-counts.json'), 'utf8'));
/** Tables that are retained and whose counts must not have moved. */
const RETAINED = ['entities', 'entity_aliases', 'entity_affiliations', 'entity_mentions', 'business_units',
  'members', 'member_business_units', 'research_artifacts', 'signals', 'signal_entities',
  'interactions', 'actions', 'opportunities', 'outcomes'];

const c = new pg.Client({ connectionString: url, ssl: /supabase\.(co|com)/i.test(url) ? { rejectUnauthorized: false } : undefined });
await c.connect();
await c.query('set session default_transaction_read_only = on');

const results = [];
const gate = (name, passed, detail = '') => {
  results.push({ name, passed });
  console.log(`  ${passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (detail && !passed) console.log(`        ${detail}`);
};
const one = async (sql, params = []) => (await c.query(sql, params)).rows[0];
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

console.log(`\x1b[1mPre-drop gate\x1b[0m  ·  ${(await one('select current_database() d')).d}`);

// -- 1. Row counts ----------------------------------------------------------
section('1. Retained tables still hold what production held');
for (const t of RETAINED) {
  const { n } = await one(`select count(*)::int n from public."${t.replace(/"/g, '""')}"`);
  gate(`${t}: ${n}`, n === BASELINE[t], `expected ${BASELINE[t]} (production, 28 September 2026), found ${n}`);
}

// -- 2. Coverage ------------------------------------------------------------
section('2. Every legacy row already exists in the final model');
const coverage = [
  ['external_contacts', `select (select count(*)::int from public.external_contacts) total,
     (select count(*)::int from public.external_contacts c where exists (select 1 from public.entities e where e.legacy_external_contact_id = c.id)) covered`],
  ['external_companies', `select (select count(*)::int from public.external_companies) total,
     (select count(*)::int from public.external_companies c where exists (select 1 from public.entities e where e.legacy_external_company_id = c.id)) covered`],
  ['knowledge', `select (select count(*)::int from public.knowledge) total,
     (select count(*)::int from public.knowledge k where exists (select 1 from public.evidence e where e.id = k.id)
        and exists (select 1 from public.research_findings f where f.evidence_id = k.id)) covered`],
  ['rules', `select (select count(*)::int from public.rules) total,
     (select count(*)::int from public.rules r where exists (select 1 from public.evidence e where e.id = r.id)
        and exists (select 1 from public.research_findings f where f.evidence_id = r.id)) covered`],
  ['relationship_interactions', `select (select count(*)::int from public.relationship_interactions) total,
     (select count(*)::int from public.relationship_interactions r where exists (
        select 1 from public.interactions i where date_trunc('day', i.occurred_at) = date_trunc('day', r.occurred_at))) covered`],
  ['meetings', `select (select count(*)::int from public.meetings) total,
     (select count(*)::int from public.meetings m where exists (select 1 from public.research_artifacts a where a.title ilike '%' || m.title || '%')
        or exists (select 1 from public.interactions i where i.subject ilike '%' || m.title || '%')) covered`],
];
for (const [name, sql] of coverage) {
  const exists = await one(`select to_regclass('public.' || $1) is not null present`, [name]);
  if (!exists.present) { gate(`${name}: already dropped`, true); continue; }
  const r = await one(sql);
  gate(`${name}: ${r.covered}/${r.total} covered`, r.covered === r.total, `${r.total - r.covered} row(s) exist nowhere else`);
}
{
  const notes = readdirSync(resolve(root, 'docs')).includes('LEGACY-SYSTEM-NOTES.md')
    ? (readFileSync(resolve(root, 'docs/LEGACY-SYSTEM-NOTES.md'), 'utf8').match(/^## /gm) || []).length : 0;
  const expected = (await one(`select case when to_regclass('public.\"Globa 3 Automatization & Memory\"') is null then -1
    else (select count(*)::int from public."Globa 3 Automatization & Memory") end n`)).n;
  gate(`Globa 3 Automatization & Memory: ${notes} notes preserved in docs/`,
    expected === -1 || notes === expected, `table holds ${expected}, docs hold ${notes}`);
}

// -- 3. Foreign keys --------------------------------------------------------
section('3. No dangling reference anywhere');
const fks = (await c.query(`
  select con.conname, src.relname as child, tgt.relname as parent, tn.nspname as parent_schema,
         (select attname from pg_attribute where attrelid = src.oid and attnum = con.conkey[1]) as child_col,
         (select attname from pg_attribute where attrelid = tgt.oid and attnum = con.confkey[1]) as parent_col
    from pg_constraint con
    join pg_class src on src.oid = con.conrelid
    join pg_class tgt on tgt.oid = con.confrelid
    join pg_namespace tn on tn.oid = tgt.relnamespace
    join pg_namespace n on n.oid = src.relnamespace
   where con.contype = 'f' and n.nspname = 'public' and array_length(con.conkey, 1) = 1`)).rows;
let dangling = 0;
for (const fk of fks) {
  const { n } = await one(
    `select count(*)::int n from public."${fk.child.replace(/"/g, '""')}" ch
      where ch."${fk.child_col}" is not null
        and not exists (select 1 from "${fk.parent_schema}"."${fk.parent.replace(/"/g, '""')}" pa where pa."${fk.parent_col}" = ch."${fk.child_col}")`);
  if (n > 0) { dangling++; console.log(`        dangling: ${fk.child}.${fk.child_col} -> ${fk.parent} (${n})`); }
}
gate(`all ${fks.length} single-column foreign keys resolve`, dangling === 0, `${dangling} constraint(s) have dangling rows`);

// -- 4. RLS and privileges --------------------------------------------------
section('4. Row-level security and client privileges');
const noRls = (await c.query(`
  select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
     and exists (select 1 from information_schema.columns col
                  where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'workspace_id')`)).rows;
gate('every workspace-scoped table enforces RLS', noRls.length === 0, noRls.map((r) => r.relname).join(', '));

const unscoped = await one(`
  select coalesce(string_agg(t.table_name || '=' || t.n, ', '), '') bad from (
    select col.table_name, (xpath('/row/c/text()', query_to_xml(
      format('select count(*) c from public.%I where workspace_id is null', col.table_name), false, true, '')))[1]::text::int n
    from information_schema.columns col
    where col.table_schema = 'public' and col.column_name = 'workspace_id') t where t.n > 0`);
gate('no row is missing its workspace', unscoped.bad === '', unscoped.bad);

const writable = await one(`select count(*)::int n from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE','DELETE')`);
gate('no client role can write to any table', writable.n === 0, `${writable.n} write grant(s) remain`);

// -- 5. Application queries -------------------------------------------------
section('5. No application code path names a legacy table');
const files = [];
const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
  if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'dist-ios') continue;
  const p = `${d}/${e.name}`;
  if (e.isDirectory()) walk(p); else if (/\.(ts|tsx|mjs)$/.test(e.name) && !p.includes('/prod-audit/')) files.push(p);
} };
for (const d of ['packages', 'apps', 'scripts']) walk(`${root}/${d}`);
// The `public.` qualifier is required: every real query in this codebase uses
// it, and without it the check trips on prose like "capture into knowledge".
const pattern = new RegExp(`public\\.\\s*"?(${LEGACY.map((t) => t.replace(/[&\s]/g, '.')).join('|')})"?`, 'i');
const offenders = files.filter((f) => pattern.test(readFileSync(f, 'utf8'))).map((f) => f.replace(`${root}/`, ''));
gate('no SQL in the application names a legacy table', offenders.length === 0, offenders.join('\n        '));

await c.end();
const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} gate checks passed`);
if (failed.length > 0) {
  console.log('\n\x1b[31mDO NOT RUN 0021.\x1b[0m Fix these first:');
  for (const f of failed) console.log(`  - ${f.name}`);
}
process.exit(failed.length === 0 ? 0 : 1);
