import { writeFileSync } from 'node:fs';
import { readOnlyClient, rows } from './connect.mjs';
const client = await readOnlyClient();
const out = {};
const show = async (name, sql) => { const r = await rows(client, sql); out[name]=r; console.log(`\n### ${name} (${r.length})`); for (const x of r.slice(0,25)) console.log('  '+JSON.stringify(x)); if(r.length>25) console.log(`  ... ${r.length-25} more`); };
try {
  await show('affiliation_org_not_org', `select a.id::text, p.display_name person, o.display_name org, o.entity_type org_type, a.role_title, a.context
    from public.entity_affiliations a join public.entities p on p.id=a.person_entity_id join public.entities o on o.id=a.organization_entity_id
    where o.entity_type <> 'organization' order by o.entity_type, o.display_name`);
  await show('orphan_evidence', `select ev.id::text, ev.source_type, left(ev.title,70) title, ev.source_date, ev.created_at::date
    from public.evidence ev where not exists (select 1 from public.entities x where x.source_evidence_id=ev.id)
      and not exists (select 1 from public.research_findings x where x.evidence_id=ev.id)
      and not exists (select 1 from public.signals x where x.evidence_id=ev.id)
      and not exists (select 1 from public.interactions x where x.evidence_id=ev.id)
      and not exists (select 1 from public.actions x where x.evidence_id=ev.id)
      and not exists (select 1 from public.research_artifacts x where x.source_evidence_id=ev.id)
      and not exists (select 1 from public.entity_affiliations x where x.evidence_id=ev.id)
      and not exists (select 1 from public.entity_mentions x where x.source_evidence_id=ev.id) order by ev.created_at`);
  await show('business_unit_entities', `select e.id::text, e.display_name, e.slug, b.name bu_name, b.slug bu_slug
    from public.entities e left join public.business_units b on b.id=e.legacy_business_unit_id where e.entity_type='business_unit' order by e.display_name`);
  await show('legacy_contact_to_entity_map', `select c.id::text legacy_id, c.full_name, e.id::text entity_id, e.display_name, e.slug
    from public.external_contacts c join public.entities e on e.legacy_external_contact_id=c.id order by c.full_name limit 60`);
  await show('meetings_row', `select id::text, title, date, source, length(coalesce(transcript,'')) transcript_len, length(coalesce(summary,'')) summary_len from public.meetings`);
  await show('interaction_without_subject_entity', `select id::text, subject, interaction_type, occurred_at::date, (evidence_id is not null) ev from public.interactions where external_entity_id is null`);
  await show('triggers', `select c.relname tbl, t.tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal order by 1,2`);
  await show('functions', `select p.proname, pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`);
  await show('knowledge_sample', `select left(title,60) title, type, slug, source, length(content) len from public.knowledge order by type, title limit 25`);
  await show('rules_sample', `select left(title,60) title, type, slug, length(content) len from public.rules order by type, title limit 20`);
  await show('automatization_rows', `select left(title,55) title, trim(type) type, source, order_index, length(content) len from public."Globa 3 Automatization & Memory" order by order_index`);
} finally { await client.end(); }
writeFileSync('scripts/prod-audit/out-details.json', JSON.stringify(out, null, 2));
