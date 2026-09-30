-- Production baseline alignment.
--
-- Run ONCE against production, before `migrate.mjs`, and never anywhere else.
--
-- Why this exists
-- ---------------
-- Production's legacy tables were built from an earlier dialect than the one
-- `0001_baseline_legacy.sql` writes. Because `0001` is stamped rather than run
-- (production already holds its data, and re-deriving it is impossible), those
-- divergences survive into the platform migrations, which reference the legacy
-- tables unguarded in 0005, 0006, 0007, 0009, 0011, 0015, 0016, 0017, 0018 and
-- 0019. The rehearsal hit two of them in sequence:
--
--   0001 -> column "business_unit_id" does not exist  (relationship_interactions)
--   0006 -> column "slug" does not exist              (meetings)
--
-- Dropping the legacy tables first is not an option: too many later migrations
-- name them. So this script makes production's legacy tables match the shape
-- the migration set expects. Every statement is additive and idempotent; no
-- column is dropped, retyped or overwritten, and no row is touched except to
-- populate a column that did not exist a moment earlier.
--
-- All of this is temporary by design: six of these tables are dropped at the
-- end of the release by `0021_drop_legacy_tables.sql`. The columns added here
-- exist only so the intervening migrations can run.
--
-- This script is NOT a migration. It is production-specific repair; a database
-- built from `0001` already has the right shape and must never run it.

begin;

-- ---------------------------------------------------------------------------
-- meetings: 0001 gives it a slug, a status, a business unit, a meeting_date
-- and updated_at. Production has only id/title/date/transcript/summary/source.
-- ---------------------------------------------------------------------------
alter table public.meetings add column if not exists slug text;
alter table public.meetings add column if not exists status text default 'active';
alter table public.meetings add column if not exists updated_at timestamptz default now();
alter table public.meetings add column if not exists meeting_date date;
alter table public.meetings add column if not exists business_unit_id uuid references public.business_units(id) on delete set null;

-- A slug is required to be unique per workspace by 0006. Derive one from the
-- title, and fall back to the id so the result cannot collide.
update public.meetings
   set slug = coalesce(
         nullif(regexp_replace(lower(trim(title)), '[^a-z0-9]+', '-', 'g'), ''),
         'meeting-' || left(id::text, 8))
 where slug is null;
update public.meetings set meeting_date = date where meeting_date is null;
update public.meetings set updated_at = created_at where updated_at is null;
update public.meetings set status = 'active' where status is null;

-- ---------------------------------------------------------------------------
-- relationship_interactions: production names the same three references
-- external_contact_id / external_company_id / internal_business_unit_id.
-- 0001 expects contact_id / company_id / business_unit_id, and 0006 indexes
-- the latter. Add them and carry the values across so nothing is lost if a
-- later migration reads them.
-- ---------------------------------------------------------------------------
alter table public.relationship_interactions add column if not exists contact_id uuid references public.external_contacts(id) on delete set null;
alter table public.relationship_interactions add column if not exists company_id uuid references public.external_companies(id) on delete set null;
alter table public.relationship_interactions add column if not exists business_unit_id uuid references public.business_units(id) on delete set null;
alter table public.relationship_interactions add column if not exists next_step text;
alter table public.relationship_interactions add column if not exists interest_level text;
alter table public.relationship_interactions add column if not exists source text;

update public.relationship_interactions
   set contact_id       = coalesce(contact_id, external_contact_id),
       company_id       = coalesce(company_id, external_company_id),
       business_unit_id = coalesce(business_unit_id, internal_business_unit_id),
       next_step        = coalesce(next_step, next_steps),
       source           = coalesce(source, source_system);

-- ---------------------------------------------------------------------------
-- rules, members, member_business_units: single columns the later migrations
-- expect. members and member_business_units are RETAINED tables, so these two
-- additions are permanent and real, not scaffolding.
-- ---------------------------------------------------------------------------
alter table public.rules add column if not exists source text;
alter table public.members add column if not exists role_title text;
alter table public.members add column if not exists notes text;
alter table public.member_business_units add column if not exists role text;

-- members.role holds the role title in production ("Founder & CEO, Globa 3").
-- The application reads role_title. Carry it over rather than leaving the
-- column empty and the role invisible.
update public.members set role_title = role where role_title is null and role is not null;

commit;
