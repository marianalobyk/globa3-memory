-- 0003 Phase 1.1 signal strength, entity-mention staging, classification fields.
--
-- Taken verbatim (structure unchanged) from the archive's
-- supabase/migrations/20260904_phase1_1_signal_and_staging.sql; the
-- extension/trigger preamble moved to 0000. Additive only.
--
-- entity_mentions is the table that stops the system from silently creating a
-- new entity for every name that appears in a brief.

alter table public.entities
  add column if not exists source_evidence_id uuid references public.evidence(id) on delete set null,
  add column if not exists visibility text not null default 'internal',
  add column if not exists external_use_status text not null default 'not_cleared',
  add column if not exists sensitivity text not null default 'standard',
  add column if not exists provenance_note text,
  add column if not exists capture_source text;

alter table public.evidence
  add column if not exists visibility text not null default 'internal',
  add column if not exists external_use_status text not null default 'source_only',
  add column if not exists sensitivity text not null default 'standard',
  add column if not exists provenance_note text;

alter table public.research_artifacts
  add column if not exists visibility text not null default 'internal',
  add column if not exists external_use_status text not null default 'not_cleared',
  add column if not exists sensitivity text not null default 'standard',
  add column if not exists provenance_note text;

alter table public.research_findings
  add column if not exists visibility text not null default 'internal',
  add column if not exists external_use_status text not null default 'not_cleared',
  add column if not exists sensitivity text not null default 'standard',
  add column if not exists provenance_note text;

alter table public.interactions
  add column if not exists visibility text not null default 'internal',
  add column if not exists external_use_status text not null default 'not_cleared',
  add column if not exists sensitivity text not null default 'standard',
  add column if not exists provenance_note text;

alter table public.actions
  add column if not exists visibility text not null default 'internal',
  add column if not exists external_use_status text not null default 'not_cleared',
  add column if not exists sensitivity text not null default 'standard',
  add column if not exists provenance_note text;

alter table public.signals
  add column if not exists signal_date date,
  add column if not exists signal_strength text not null default 'medium',
  add column if not exists confidence text not null default 'medium',
  add column if not exists original_claim text,
  add column if not exists why_it_matters text,
  add column if not exists decision_question text,
  add column if not exists recommended_next_step text,
  add column if not exists visibility text not null default 'internal',
  add column if not exists external_use_status text not null default 'not_cleared',
  add column if not exists sensitivity text not null default 'standard',
  add column if not exists provenance_note text;

create table if not exists public.entity_mentions (
  id uuid primary key default gen_random_uuid(),
  mention_text text not null,
  mention_slug text not null,
  proposed_entity_type text check (
    proposed_entity_type in (
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
  proposed_display_name text,
  proposed_slug text,
  candidate_entity_id uuid references public.entities(id) on delete set null,
  source_evidence_id uuid references public.evidence(id) on delete set null,
  source_artifact_id uuid references public.research_artifacts(id) on delete set null,
  business_unit_id uuid references public.business_units(id) on delete set null,
  resolution_status text not null default 'pending',
  confidence text not null default 'medium',
  rationale text,
  created_from text,
  visibility text not null default 'internal',
  external_use_status text not null default 'not_cleared',
  sensitivity text not null default 'standard',
  provenance_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists entity_mentions_mention_slug_idx on public.entity_mentions(mention_slug);
create index if not exists entity_mentions_candidate_entity_idx on public.entity_mentions(candidate_entity_id);
create index if not exists entity_mentions_source_evidence_idx on public.entity_mentions(source_evidence_id);
create index if not exists entity_mentions_source_artifact_idx on public.entity_mentions(source_artifact_id);
create index if not exists entity_mentions_business_unit_idx on public.entity_mentions(business_unit_id);
create index if not exists entity_mentions_resolution_status_idx on public.entity_mentions(resolution_status);

drop trigger if exists set_entity_mentions_updated_at on public.entity_mentions;
create trigger set_entity_mentions_updated_at
before update on public.entity_mentions
for each row execute function public.set_updated_at();

create table if not exists public.signal_entities (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references public.signals(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete cascade,
  role text not null default 'mentioned',
  confidence text not null default 'medium',
  notes text,
  created_at timestamptz not null default now(),
  unique(signal_id, entity_id, role)
);

create index if not exists signal_entities_signal_idx on public.signal_entities(signal_id);
create index if not exists signal_entities_entity_idx on public.signal_entities(entity_id);
create index if not exists signal_entities_role_idx on public.signal_entities(role);

create table if not exists public.opportunities (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text not null unique,
  description text,
  opportunity_type text,
  stage text not null default 'idea',
  priority text not null default 'medium',
  related_entity_id uuid references public.entities(id) on delete set null,
  business_unit_id uuid references public.business_units(id) on delete set null,
  source_signal_id uuid references public.signals(id) on delete set null,
  evidence_id uuid references public.evidence(id) on delete set null,
  owner_member_id uuid references public.members(id) on delete set null,
  visibility text not null default 'internal',
  external_use_status text not null default 'not_cleared',
  sensitivity text not null default 'standard',
  provenance_note text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists opportunities_related_entity_idx on public.opportunities(related_entity_id);
create index if not exists opportunities_business_unit_idx on public.opportunities(business_unit_id);
create index if not exists opportunities_source_signal_idx on public.opportunities(source_signal_id);
create index if not exists opportunities_stage_idx on public.opportunities(stage);

drop trigger if exists set_opportunities_updated_at on public.opportunities;
create trigger set_opportunities_updated_at
before update on public.opportunities
for each row execute function public.set_updated_at();

create table if not exists public.outcomes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  outcome_type text,
  outcome_date date,
  related_opportunity_id uuid references public.opportunities(id) on delete set null,
  related_action_id uuid references public.actions(id) on delete set null,
  related_interaction_id uuid references public.interactions(id) on delete set null,
  related_entity_id uuid references public.entities(id) on delete set null,
  business_unit_id uuid references public.business_units(id) on delete set null,
  evidence_id uuid references public.evidence(id) on delete set null,
  visibility text not null default 'internal',
  external_use_status text not null default 'not_cleared',
  sensitivity text not null default 'standard',
  provenance_note text,
  status text not null default 'recorded',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists outcomes_opportunity_idx on public.outcomes(related_opportunity_id);
create index if not exists outcomes_action_idx on public.outcomes(related_action_id);
create index if not exists outcomes_interaction_idx on public.outcomes(related_interaction_id);
create index if not exists outcomes_entity_idx on public.outcomes(related_entity_id);
create index if not exists outcomes_business_unit_idx on public.outcomes(business_unit_id);
create index if not exists outcomes_date_idx on public.outcomes(outcome_date);

drop trigger if exists set_outcomes_updated_at on public.outcomes;
create trigger set_outcomes_updated_at
before update on public.outcomes
for each row execute function public.set_updated_at();

grant all on table
  public.entity_mentions,
  public.signal_entities,
  public.opportunities,
  public.outcomes
to service_role;
