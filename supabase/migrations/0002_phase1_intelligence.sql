-- 0002 Phase 1 Globa 3 Intelligence schema.
--
-- Taken verbatim (structure unchanged) from the archive's
-- supabase/migrations/20260903_phase1_schema_extension.sql, with two changes:
--   * the `create extension pgcrypto` / set_updated_at preamble moved to 0000;
--   * the legacy -> entities backfill moved to 0004 so schema and data movement
--     stay separable and re-runnable.
-- Additive only: creates new structures, drops nothing.

create table if not exists public.entities (

  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (
    entity_type in (
      'person',
      'organization',
      'project',
      'institution',
      'event',
      'business_unit',
      'artifact',
      'source',
      'other'
    )
  ),
  display_name text not null,
  slug text not null unique,
  description text,
  primary_url text,
  region text,
  country text,
  research_status text default 'unverified',
  relationship_status text default 'none',
  relationship_confidence text,
  status text not null default 'active',
  legacy_external_company_id uuid,
  legacy_external_contact_id uuid,
  legacy_business_unit_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists entities_entity_type_idx on public.entities(entity_type);
create index if not exists entities_research_status_idx on public.entities(research_status);
create index if not exists entities_relationship_status_idx on public.entities(relationship_status);
create index if not exists entities_legacy_external_company_id_idx on public.entities(legacy_external_company_id);
create index if not exists entities_legacy_external_contact_id_idx on public.entities(legacy_external_contact_id);
create index if not exists entities_legacy_business_unit_id_idx on public.entities(legacy_business_unit_id);

drop trigger if exists set_entities_updated_at on public.entities;
create trigger set_entities_updated_at
before update on public.entities
for each row execute function public.set_updated_at();

create table if not exists public.entity_aliases (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  alias text not null,
  alias_slug text not null,
  alias_type text not null default 'name',
  source_note text,
  created_at timestamptz not null default now(),
  unique(entity_id, alias_slug)
);

create index if not exists entity_aliases_entity_id_idx on public.entity_aliases(entity_id);
create index if not exists entity_aliases_alias_slug_idx on public.entity_aliases(alias_slug);

create table if not exists public.evidence (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (
    source_type in (
      'url',
      'pdf',
      'email',
      'meeting_note',
      'chatgpt_capture',
      'brief',
      'dossier',
      'database_row',
      'other'
    )
  ),
  title text not null,
  url text,
  file_reference text,
  source_date date,
  accessed_at timestamptz,
  reliability text default 'unverified',
  excerpt text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists evidence_source_type_idx on public.evidence(source_type);
create index if not exists evidence_url_idx on public.evidence(url);
create index if not exists evidence_source_date_idx on public.evidence(source_date);

drop trigger if exists set_evidence_updated_at on public.evidence;
create trigger set_evidence_updated_at
before update on public.evidence
for each row execute function public.set_updated_at();

create table if not exists public.entity_affiliations (
  id uuid primary key default gen_random_uuid(),
  person_entity_id uuid not null references public.entities(id) on delete cascade,
  organization_entity_id uuid not null references public.entities(id) on delete cascade,
  role_title text,
  context text,
  start_date date,
  end_date date,
  is_primary boolean not null default false,
  is_current boolean not null default true,
  evidence_id uuid references public.evidence(id) on delete set null,
  confidence text default 'medium',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (person_entity_id <> organization_entity_id)
);

create index if not exists entity_affiliations_person_idx on public.entity_affiliations(person_entity_id);
create index if not exists entity_affiliations_organization_idx on public.entity_affiliations(organization_entity_id);
create index if not exists entity_affiliations_evidence_idx on public.entity_affiliations(evidence_id);
create unique index if not exists entity_affiliations_unique_current_context
  on public.entity_affiliations(person_entity_id, organization_entity_id, coalesce(role_title, ''), coalesce(context, ''))
  where is_current = true;

drop trigger if exists set_entity_affiliations_updated_at on public.entity_affiliations;
create trigger set_entity_affiliations_updated_at
before update on public.entity_affiliations
for each row execute function public.set_updated_at();

create table if not exists public.research_artifacts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text not null unique,
  artifact_type text not null default 'research_dossier',
  summary text,
  source_evidence_id uuid references public.evidence(id) on delete set null,
  capture_source text,
  source_file text,
  status text not null default 'draft',
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists research_artifacts_source_evidence_idx on public.research_artifacts(source_evidence_id);
create index if not exists research_artifacts_status_idx on public.research_artifacts(status);

drop trigger if exists set_research_artifacts_updated_at on public.research_artifacts;
create trigger set_research_artifacts_updated_at
before update on public.research_artifacts
for each row execute function public.set_updated_at();

create table if not exists public.research_findings (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid references public.research_artifacts(id) on delete set null,
  evidence_id uuid references public.evidence(id) on delete set null,
  related_entity_id uuid references public.entities(id) on delete set null,
  business_unit_id uuid references public.business_units(id) on delete set null,
  finding_type text not null check (finding_type in ('fact', 'inference', 'recommendation', 'gap', 'risk')),
  title text not null,
  content text not null,
  confidence text default 'medium',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists research_findings_artifact_idx on public.research_findings(artifact_id);
create index if not exists research_findings_evidence_idx on public.research_findings(evidence_id);
create index if not exists research_findings_related_entity_idx on public.research_findings(related_entity_id);
create index if not exists research_findings_business_unit_idx on public.research_findings(business_unit_id);
create index if not exists research_findings_type_idx on public.research_findings(finding_type);

drop trigger if exists set_research_findings_updated_at on public.research_findings;
create trigger set_research_findings_updated_at
before update on public.research_findings
for each row execute function public.set_updated_at();

create table if not exists public.interactions (
  id uuid primary key default gen_random_uuid(),
  interaction_type text not null,
  interaction_direction text,
  occurred_at timestamptz,
  subject text not null,
  summary text,
  external_entity_id uuid references public.entities(id) on delete set null,
  internal_business_unit_id uuid references public.business_units(id) on delete set null,
  internal_owner_member_id uuid references public.members(id) on delete set null,
  evidence_id uuid references public.evidence(id) on delete set null,
  source_system text,
  source_reference text,
  status text not null default 'completed',
  tags text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists interactions_external_entity_idx on public.interactions(external_entity_id);
create index if not exists interactions_business_unit_idx on public.interactions(internal_business_unit_id);
create index if not exists interactions_owner_idx on public.interactions(internal_owner_member_id);
create index if not exists interactions_occurred_at_idx on public.interactions(occurred_at);

drop trigger if exists set_interactions_updated_at on public.interactions;
create trigger set_interactions_updated_at
before update on public.interactions
for each row execute function public.set_updated_at();

create table if not exists public.actions (
  id uuid primary key default gen_random_uuid(),
  action_type text not null default 'follow_up',
  title text not null,
  description text,
  due_at timestamptz,
  status text not null default 'proposed',
  priority text default 'medium',
  related_entity_id uuid references public.entities(id) on delete set null,
  related_interaction_id uuid references public.interactions(id) on delete set null,
  internal_business_unit_id uuid references public.business_units(id) on delete set null,
  owner_member_id uuid references public.members(id) on delete set null,
  evidence_id uuid references public.evidence(id) on delete set null,
  source_system text,
  source_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists actions_related_entity_idx on public.actions(related_entity_id);
create index if not exists actions_related_interaction_idx on public.actions(related_interaction_id);
create index if not exists actions_business_unit_idx on public.actions(internal_business_unit_id);
create index if not exists actions_owner_idx on public.actions(owner_member_id);
create index if not exists actions_due_at_idx on public.actions(due_at);
create index if not exists actions_status_idx on public.actions(status);

drop trigger if exists set_actions_updated_at on public.actions;
create trigger set_actions_updated_at
before update on public.actions
for each row execute function public.set_updated_at();

create table if not exists public.signals (
  id uuid primary key default gen_random_uuid(),
  signal_type text not null,
  title text not null,
  description text,
  priority text default 'medium',
  promotion_trigger text,
  related_entity_id uuid references public.entities(id) on delete set null,
  business_unit_id uuid references public.business_units(id) on delete set null,
  evidence_id uuid references public.evidence(id) on delete set null,
  status text not null default 'watch',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists signals_related_entity_idx on public.signals(related_entity_id);
create index if not exists signals_business_unit_idx on public.signals(business_unit_id);
create index if not exists signals_status_idx on public.signals(status);

drop trigger if exists set_signals_updated_at on public.signals;
create trigger set_signals_updated_at
before update on public.signals
for each row execute function public.set_updated_at();
