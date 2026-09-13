-- 0001 Legacy Globa 3 memory tables.
--
-- These tables already exist in the production Supabase project. This migration
-- is a faithful reconstruction so a local/test copy can be created from zero,
-- and it is written additively (`if not exists` on every table and column) so
-- running it against production adds nothing it does not already have.
--
-- Column set is taken from the authoritative references in the archive:
--   * supabase/migrations/20260903_phase1_schema_extension.sql (FK + SELECT list)
--   * globa3-supabase-memory/references/table-map.md
--   * work/*.mjs real write payloads

create table if not exists public.business_units (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  type text,
  summary text,
  parent_id uuid references public.business_units(id) on delete set null,
  status text default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.business_units
  add column if not exists type text,
  add column if not exists summary text,
  add column if not exists parent_id uuid,
  add column if not exists status text default 'active';
create index if not exists business_units_parent_idx on public.business_units(parent_id);
create index if not exists business_units_slug_idx on public.business_units(slug);

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  slug text unique,
  email text,
  role_title text,
  status text default 'active',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.member_business_units (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  business_unit_id uuid not null references public.business_units(id) on delete cascade,
  role text,
  created_at timestamptz not null default now(),
  unique (member_id, business_unit_id)
);

create table if not exists public.knowledge (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text unique,
  type text,
  content text,
  business_unit_id uuid references public.business_units(id) on delete set null,
  source text,
  status text default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists knowledge_business_unit_idx on public.knowledge(business_unit_id);

create table if not exists public.rules (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text unique,
  type text,
  content text,
  business_unit_id uuid references public.business_units(id) on delete set null,
  source text,
  status text default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists rules_business_unit_idx on public.rules(business_unit_id);

create table if not exists public.meetings (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text unique,
  meeting_date date,
  summary text,
  transcript text,
  source text,
  business_unit_id uuid references public.business_units(id) on delete set null,
  status text default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists meetings_business_unit_idx on public.meetings(business_unit_id);

create table if not exists public.external_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  type text,
  website_url text,
  region text,
  country text,
  notes text,
  status text default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists external_companies_slug_idx on public.external_companies(slug);

create table if not exists public.external_contacts (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  slug text unique,
  role_title text,
  company_id uuid references public.external_companies(id) on delete set null,
  email text,
  phone text,
  notes text,
  status text default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists external_contacts_company_idx on public.external_contacts(company_id);
create index if not exists external_contacts_slug_idx on public.external_contacts(slug);

create table if not exists public.relationship_interactions (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.external_contacts(id) on delete set null,
  company_id uuid references public.external_companies(id) on delete set null,
  business_unit_id uuid references public.business_units(id) on delete set null,
  interaction_type text,
  occurred_at timestamptz,
  summary text,
  next_step text,
  interest_level text,
  source text,
  review_status text default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists relationship_interactions_contact_idx on public.relationship_interactions(contact_id);
create index if not exists relationship_interactions_company_idx on public.relationship_interactions(company_id);
create index if not exists relationship_interactions_bu_idx on public.relationship_interactions(business_unit_id);

-- Legacy automation/memory notes table. Quoted name preserved exactly as found
-- in the production project.
create table if not exists public."Globa 3 Automatization & Memory" (
  id uuid primary key default gen_random_uuid(),
  title text,
  content text,
  created_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array[
    'business_units','members','knowledge','rules','meetings',
    'external_companies','external_contacts','relationship_interactions'
  ] loop
    execute format('drop trigger if exists set_%1$s_updated_at on public.%1$I', t);
    execute format(
      'create trigger set_%1$s_updated_at before update on public.%1$I
         for each row execute function public.set_updated_at()', t);
  end loop;
end $$;
