import { writeFileSync } from 'node:fs';
import { readOnlyClient, rows } from './connect.mjs';
const client = await readOnlyClient();
const q = (sql, p) => rows(client, sql, p);
const out = {};
const show = async (name, sql, params = []) => {
  const r = await q(sql, params);
  out[name] = r;
  console.log(`\n### ${name}`);
  if (r.length === 0) { console.log('  (none)'); return; }
  for (const row of r.slice(0, 40)) console.log('  ' + JSON.stringify(row));
  if (r.length > 40) console.log(`  ... ${r.length - 40} more`);
};
try {
  await show('entities_by_type', `select entity_type, count(*)::int n, count(source_evidence_id)::int with_evidence,
      count(legacy_external_contact_id)::int from_contact, count(legacy_external_company_id)::int from_company,
      count(legacy_business_unit_id)::int from_bu
    from public.entities group by 1 order by 2 desc`);
  await show('entities_by_relationship_status', `select relationship_status, research_status, count(*)::int n from public.entities group by 1,2 order by 3 desc`);
  await show('duplicate_canonical_entities', `select lower(regexp_replace(display_name,'\\s+',' ','g')) nm, entity_type, count(*)::int n, array_agg(id::text) ids
    from public.entities where status='active' group by 1,2 having count(*)>1 order by 3 desc`);
  await show('legacy_contact_link_coverage', `select
      (select count(*)::int from public.external_contacts) total,
      (select count(*)::int from public.external_contacts c where exists (select 1 from public.entities e where e.legacy_external_contact_id=c.id)) linked`);
  await show('legacy_company_link_coverage', `select
      (select count(*)::int from public.external_companies c) total,
      (select count(*)::int from public.external_companies c where exists (select 1 from public.entities e where e.legacy_external_company_id=c.id)) linked`);
  await show('entities_without_provenance', `select count(*)::int n from public.entities where source_evidence_id is null`);
  await show('entities_no_provenance_no_legacy', `select count(*)::int n from public.entities
    where source_evidence_id is null and legacy_external_contact_id is null and legacy_external_company_id is null and legacy_business_unit_id is null`);
  await show('orphan_evidence_unreferenced', `select count(*)::int n from public.evidence ev where not exists (
      select 1 from public.entities x where x.source_evidence_id=ev.id) and not exists (
      select 1 from public.research_findings x where x.evidence_id=ev.id) and not exists (
      select 1 from public.signals x where x.evidence_id=ev.id) and not exists (
      select 1 from public.interactions x where x.evidence_id=ev.id) and not exists (
      select 1 from public.actions x where x.evidence_id=ev.id) and not exists (
      select 1 from public.research_artifacts x where x.source_evidence_id=ev.id) and not exists (
      select 1 from public.entity_affiliations x where x.evidence_id=ev.id) and not exists (
      select 1 from public.entity_mentions x where x.source_evidence_id=ev.id)`);
  await show('evidence_by_source_type', `select source_type, count(*)::int n from public.evidence group by 1 order by 2 desc`);
  await show('findings_provenance', `select
      count(*)::int total,
      count(*) filter (where evidence_id is null and artifact_id is null)::int no_provenance,
      count(*) filter (where related_entity_id is null)::int no_entity,
      count(*) filter (where related_entity_id is null and business_unit_id is null)::int no_subject_at_all
    from public.research_findings`);
  await show('findings_by_type', `select finding_type, status, count(*)::int n from public.research_findings group by 1,2 order by 3 desc`);
  await show('signals_links', `select
      (select count(*)::int from public.signals) signals,
      (select count(*)::int from public.signals s where not exists (select 1 from public.signal_entities se where se.signal_id=s.id)) signals_without_entity_link,
      (select count(*)::int from public.signals s where s.evidence_id is null) signals_without_evidence,
      (select count(*)::int from public.signal_entities) links,
      (select count(*)::int from public.signal_entities se where not exists (select 1 from public.entities e where e.id=se.entity_id)) dangling_links`);
  await show('signals_by_status', `select status, signal_strength, confidence, count(*)::int n from public.signals group by 1,2,3 order by 4 desc`);
  await show('actions_detail', `select id::text, action_type, status, priority, left(title,60) title,
      (related_entity_id is not null) ent, (related_interaction_id is not null) inter,
      (internal_business_unit_id is not null) bu, (owner_member_id is not null) owner, (evidence_id is not null) ev,
      due_at::date, created_at::date
    from public.actions order by created_at`);
  await show('actions_targetless', `select count(*)::int n from public.actions
    where related_entity_id is null and related_interaction_id is null and internal_business_unit_id is null and evidence_id is null`);
  await show('mentions_detail', `select id::text, left(mention_text,40) mention, resolution_status, confidence,
      (candidate_entity_id is not null) has_candidate, (rationale is not null) has_rationale,
      (source_evidence_id is not null) has_evidence, created_from, created_at::date
    from public.entity_mentions order by created_at`);
  await show('affiliations_integrity', `select
      (select count(*)::int from public.entity_affiliations) total,
      (select count(*)::int from public.entity_affiliations a join public.entities p on p.id=a.person_entity_id where p.entity_type<>'person') person_not_person,
      (select count(*)::int from public.entity_affiliations a join public.entities o on o.id=a.organization_entity_id where o.entity_type<>'organization') org_not_org,
      (select count(*)::int from public.entity_affiliations a where a.evidence_id is null) without_evidence`);
  await show('aliases_integrity', `select count(*)::int total, count(distinct entity_id)::int distinct_entities from public.entity_aliases`);
  await show('interactions_detail', `select id::text, interaction_type, status, left(subject,50) subject,
      (external_entity_id is not null) ent, (internal_business_unit_id is not null) bu,
      (internal_owner_member_id is not null) owner, (evidence_id is not null) ev, occurred_at::date
    from public.interactions order by occurred_at nulls last`);
  await show('legacy_relationship_interactions', `select id::text, interaction_type, review_status, left(coalesce(subject,summary),60) s, occurred_at::date,
      (external_contact_id is not null) has_contact, (internal_business_unit_id is not null) has_bu, (internal_owner_member_id is not null) has_owner
    from public.relationship_interactions order by occurred_at`);
  await show('knowledge_breakdown', `select type, status, count(*)::int n from public.knowledge group by 1,2 order by 3 desc`);
  await show('rules_breakdown', `select type, status, count(*)::int n from public.rules group by 1,2 order by 3 desc`);
  await show('automatization_breakdown', `select type, status, count(*)::int n from public."Globa 3 Automatization & Memory" group by 1,2 order by 3 desc`);
  await show('business_units', `select id::text, name, slug, type, status, order_index from public.business_units order by order_index nulls last`);
  await show('members', `select id::text, full_name, slug, role, status, (email is not null) has_email from public.members order by full_name`);
  await show('artifacts', `select id::text, left(title,50) title, artifact_type, status, (source_evidence_id is not null) ev, created_at::date from public.research_artifacts order by created_at`);
} finally { await client.end(); }
writeFileSync('scripts/prod-audit/out-integrity.json', JSON.stringify(out, null, 2));
