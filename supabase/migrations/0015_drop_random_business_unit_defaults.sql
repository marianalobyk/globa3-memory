-- 0015 Remove the random default from knowledge.business_unit_id and
-- rules.business_unit_id.
--
-- In the existing Globa 3 database both columns are declared
--   business_unit_id uuid null default gen_random_uuid()
-- A foreign key with a random default is always wrong: an insert that omits the
-- column either fails the foreign key (a random UUID references nothing) or, if
-- the constraint is ever missing, silently stores a reference to no business
-- unit. An unscoped record must store NULL.
--
-- The migrations in this repository never declared that default, so on a
-- database built only from them this migration changes nothing. It exists so
-- the schema is correct regardless of where the table definition came from
-- (a restore of the source schema, or a table created by hand before 0001 ran
-- its `create table if not exists`).
--
-- Both statements are idempotent. The columns stay nullable; `drop not null` is
-- stated explicitly so that is guaranteed rather than assumed. No row is
-- touched.

alter table public.knowledge
  alter column business_unit_id drop default,
  alter column business_unit_id drop not null;

alter table public.rules
  alter column business_unit_id drop default,
  alter column business_unit_id drop not null;

comment on column public.knowledge.business_unit_id is
  'Business unit this record belongs to. NULL when unscoped. No default: a random UUID can never reference a business unit.';
comment on column public.rules.business_unit_id is
  'Business unit this rule belongs to. NULL when unscoped. No default: a random UUID can never reference a business unit.';
