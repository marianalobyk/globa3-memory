-- 0012 Workspace-aware legacy -> entities backfill.
--
-- 0004 mirrors external_companies / external_contacts / business_units into
-- `entities` with `on conflict (slug)`. That runs correctly in sequence, because
-- 0004 executes before 0006. But 0006 re-scoped the unique slug to
-- (workspace_id, slug), so the 0004 SQL can never be run again: every later
-- attempt fails with 42P10 ("no unique or exclusion constraint matching the ON
-- CONFLICT specification").
--
-- That matters because legacy rows keep arriving after the migration -- the
-- archive's work/*.mjs scripts still POST to those tables -- and without a
-- re-runnable backfill they never gain an `entities` mirror, and the
-- business_units linkage through entities.legacy_business_unit_id silently stops
-- covering new units.
--
-- This function is the re-runnable replacement. It is scoped to one workspace,
-- resolves conflicts on (workspace_id, slug), never moves a row between
-- workspaces, and is idempotent.
--
-- It is NOT called automatically. Run it deliberately, per workspace:
--   select * from public.backfill_legacy_entities('<workspace uuid>');

create or replace function public.backfill_legacy_entities(p_workspace uuid)
returns table (
  companies_mirrored integer,
  contacts_mirrored integer,
  business_units_mirrored integer,
  affiliations_created integer
)
language plpgsql
as $$
declare
  v_companies integer := 0;
  v_contacts integer := 0;
  v_units integer := 0;
  v_affiliations integer := 0;
begin
  if p_workspace is null then
    raise exception 'backfill_legacy_entities requires a workspace id';
  end if;
  if not exists (select 1 from public.workspaces where id = p_workspace) then
    raise exception 'workspace % does not exist', p_workspace;
  end if;

  insert into public.entities (
    workspace_id, entity_type, display_name, slug, description, primary_url,
    region, country, research_status, relationship_status, status,
    legacy_external_company_id
  )
  select
    c.workspace_id,
    case when c.type in ('institution', 'event') then c.type else 'organization' end,
    c.name, c.slug, c.notes, c.website_url, c.region, c.country,
    case when c.notes ilike '%research-only%' then 'research_only' else 'existing' end,
    case when c.notes ilike '%no relationship confirmed%' then 'none' else 'unknown' end,
    coalesce(c.status, 'active'),
    c.id
  from public.external_companies c
  where c.workspace_id = p_workspace and c.slug is not null
  on conflict (workspace_id, slug) do update set
    legacy_external_company_id = coalesce(public.entities.legacy_external_company_id,
                                          excluded.legacy_external_company_id),
    updated_at = now()
  where public.entities.legacy_external_company_id is null;
  get diagnostics v_companies = row_count;

  insert into public.entities (
    workspace_id, entity_type, display_name, slug, description,
    research_status, relationship_status, status, legacy_external_contact_id
  )
  select
    c.workspace_id, 'person', c.full_name, c.slug, c.notes,
    case when c.notes ilike '%research-only%' then 'research_only' else 'existing' end,
    case when c.notes ilike '%no relationship confirmed%' then 'none' else 'unknown' end,
    coalesce(c.status, 'active'),
    c.id
  from public.external_contacts c
  where c.workspace_id = p_workspace and c.slug is not null
  on conflict (workspace_id, slug) do update set
    legacy_external_contact_id = coalesce(public.entities.legacy_external_contact_id,
                                          excluded.legacy_external_contact_id),
    updated_at = now()
  where public.entities.legacy_external_contact_id is null;
  get diagnostics v_contacts = row_count;

  insert into public.entities (
    workspace_id, entity_type, display_name, slug, description,
    research_status, relationship_status, status, legacy_business_unit_id
  )
  select
    b.workspace_id, 'business_unit', b.name, b.slug, b.summary,
    'internal', 'internal', coalesce(b.status, 'active'), b.id
  from public.business_units b
  where b.workspace_id = p_workspace and b.slug is not null
  on conflict (workspace_id, slug) do update set
    legacy_business_unit_id = coalesce(public.entities.legacy_business_unit_id,
                                       excluded.legacy_business_unit_id),
    updated_at = now()
  where public.entities.legacy_business_unit_id is null;
  get diagnostics v_units = row_count;

  -- Rebuild the one-company-per-contact link as an affiliation. Every join is
  -- pinned to the workspace, so a slug collision across tenants can never pair a
  -- person with another workspace's organisation.
  insert into public.entity_affiliations (
    workspace_id, person_entity_id, organization_entity_id, role_title, context,
    is_primary, is_current, confidence, notes
  )
  select
    p_workspace, person_entity.id, org_entity.id, contact.role_title,
    'Migrated from external_contacts.company_id', true, true, 'medium',
    'Affiliation mirrored from legacy external_contacts.company_id.'
  from public.external_contacts contact
  join public.entities person_entity
    on person_entity.legacy_external_contact_id = contact.id
   and person_entity.workspace_id = p_workspace
  join public.external_companies company
    on company.id = contact.company_id
   and company.workspace_id = p_workspace
  join public.entities org_entity
    on org_entity.legacy_external_company_id = company.id
   and org_entity.workspace_id = p_workspace
  where contact.workspace_id = p_workspace
    and contact.company_id is not null
    and not exists (
      select 1 from public.entity_affiliations a
       where a.workspace_id = p_workspace
         and a.person_entity_id = person_entity.id
         and a.organization_entity_id = org_entity.id
    );
  get diagnostics v_affiliations = row_count;

  return query select v_companies, v_contacts, v_units, v_affiliations;
end;
$$;

comment on function public.backfill_legacy_entities(uuid) is
  'Re-runnable, workspace-scoped replacement for the 0004 backfill, which cannot run after 0006 re-scoped slugs. Idempotent. Not invoked automatically.';

-- Owner and service_role only: it writes knowledge tables, which end users must
-- never do directly.
revoke all on function public.backfill_legacy_entities(uuid) from public;
grant execute on function public.backfill_legacy_entities(uuid) to service_role;
