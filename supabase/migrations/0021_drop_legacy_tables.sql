-- 0021 Remove the legacy layer.
--
-- Runs only after 0020 has moved the last content that lived nowhere else.
-- After this migration there is no legacy table, no legacy function, no
-- compatibility view and no second representation of a person or a company.
--
-- What is removed
-- ---------------
--   external_contacts          52 rows, all already canonical entities
--   external_companies         54 rows, all already canonical entities
--   relationship_interactions   6 rows, all already interactions
--   meetings                    1 row,  already an interaction and an artifact
--   knowledge                  82 rows, migrated by 0020
--   rules                      59 rows, migrated by 0020
--   Globa 3 Automatization &
--     Memory                   15 rows, preserved in docs/LEGACY-SYSTEM-NOTES.md
--   upsert_legacy_record()     the import-era write path into those tables
--   entities.legacy_external_contact_id / legacy_external_company_id
--
-- `entities.legacy_business_unit_id` is KEPT: it points at `business_units`,
-- which is a retained table, and the link is real.
--
-- Provenance is written onto the entity before the pointers are dropped, so the
-- 106 entities that came from the CRM still say so in words after the rows they
-- pointed at are gone. That statement is true and checkable; no external source
-- is invented for them.

-- ---------------------------------------------------------------------------
-- Preserve the provenance the pointer columns carried
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'entities'
       and column_name = 'legacy_external_contact_id'
  ) then
    update public.entities
       set provenance_note = coalesce(
             nullif(provenance_note, ''),
             'Imported from the Globa 3 CRM contact list before this workspace existed. No external source document was captured for it.'),
           capture_source = coalesce(capture_source, 'legacy_crm_import')
     where legacy_external_contact_id is not null;

    update public.entities
       set provenance_note = coalesce(
             nullif(provenance_note, ''),
             'Imported from the Globa 3 CRM company list before this workspace existed. No external source document was captured for it.'),
           capture_source = coalesce(capture_source, 'legacy_crm_import')
     where legacy_external_company_id is not null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The legacy write path
-- ---------------------------------------------------------------------------
drop function if exists public.upsert_legacy_record(text, jsonb, text, uuid);
drop function if exists public.upsert_legacy_record(text, jsonb, text);
drop function if exists public.upsert_legacy_record(text, jsonb);

-- ---------------------------------------------------------------------------
-- The legacy pointer columns
-- ---------------------------------------------------------------------------
alter table public.entities drop column if exists legacy_external_contact_id;
alter table public.entities drop column if exists legacy_external_company_id;

-- ---------------------------------------------------------------------------
-- The legacy tables.
--
-- Order matters: relationship_interactions references both contacts and
-- companies, and external_contacts references external_companies. Dropping
-- children first means no CASCADE is needed, so nothing outside this list can
-- be removed by accident.
-- ---------------------------------------------------------------------------
drop table if exists public.relationship_interactions;
drop table if exists public.external_contacts;
drop table if exists public.external_companies;
drop table if exists public.meetings;
drop table if exists public.knowledge;
drop table if exists public.rules;
drop table if exists public."Globa 3 Automatization & Memory";
