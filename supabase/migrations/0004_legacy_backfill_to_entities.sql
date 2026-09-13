-- 0004 Legacy -> Phase 1 entity backfill.
--
-- Mirrors existing external_companies / external_contacts / business_units rows
-- into the canonical `entities` layer and rebuilds the one-company-per-contact
-- link as a proper `entity_affiliations` row. Idempotent: every statement ends
-- in `on conflict`, so re-running changes nothing.
--
-- Preserves the business_units linkage explicitly via
-- entities.legacy_business_unit_id.

insert into public.entities (
  entity_type,
  display_name,
  slug,
  description,
  primary_url,
  region,
  country,
  research_status,
  relationship_status,
  status,
  legacy_external_company_id
)
select
  case
    when type in ('institution', 'event') then type
    else 'organization'
  end,
  name,
  slug,
  notes,
  website_url,
  region,
  country,
  case when notes ilike '%research-only%' then 'research_only' else 'existing' end,
  case when notes ilike '%no relationship confirmed%' then 'none' else 'unknown' end,
  coalesce(status, 'active'),
  id
from public.external_companies
where slug is not null
on conflict (slug) do update set
  legacy_external_company_id = coalesce(public.entities.legacy_external_company_id, excluded.legacy_external_company_id),
  updated_at = now();

insert into public.entities (
  entity_type,
  display_name,
  slug,
  description,
  research_status,
  relationship_status,
  status,
  legacy_external_contact_id
)
select
  'person',
  full_name,
  slug,
  notes,
  case when notes ilike '%research-only%' then 'research_only' else 'existing' end,
  case when notes ilike '%no relationship confirmed%' then 'none' else 'unknown' end,
  coalesce(status, 'active'),
  id
from public.external_contacts
where slug is not null
on conflict (slug) do update set
  legacy_external_contact_id = coalesce(public.entities.legacy_external_contact_id, excluded.legacy_external_contact_id),
  updated_at = now();

insert into public.entities (
  entity_type,
  display_name,
  slug,
  description,
  research_status,
  relationship_status,
  status,
  legacy_business_unit_id
)
select
  'business_unit',
  name,
  slug,
  summary,
  'internal',
  'internal',
  coalesce(status, 'active'),
  id
from public.business_units
where slug is not null
on conflict (slug) do update set
  legacy_business_unit_id = coalesce(public.entities.legacy_business_unit_id, excluded.legacy_business_unit_id),
  updated_at = now();

insert into public.entity_affiliations (
  person_entity_id,
  organization_entity_id,
  role_title,
  context,
  is_primary,
  is_current,
  confidence,
  notes
)
select
  person_entity.id,
  org_entity.id,
  contact.role_title,
  'Migrated from external_contacts.company_id',
  true,
  true,
  'medium',
  'Initial affiliation migrated from legacy external_contacts.company_id.'
from public.external_contacts contact
join public.entities person_entity
  on person_entity.legacy_external_contact_id = contact.id
join public.external_companies company
  on company.id = contact.company_id
join public.entities org_entity
  on org_entity.legacy_external_company_id = company.id
where contact.company_id is not null
on conflict do nothing;

grant usage on schema public to service_role;
grant all on table
  public.entities,
  public.entity_aliases,
  public.entity_affiliations,
  public.evidence,
  public.research_artifacts,
  public.research_findings,
  public.interactions,
  public.actions,
  public.signals
to service_role;
