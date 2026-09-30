-- Every row must come back ok = true, or reconciliation rolls back.
with legacy(table_name) as (
  values ('business_units'), ('members'), ('member_business_units'), ('knowledge'), ('rules'),
         ('meetings'), ('external_companies'), ('external_contacts'), ('relationship_interactions'),
         ('Globa 3 Automatization & Memory'),
         ('entities'), ('entity_aliases'), ('entity_affiliations'), ('entity_mentions'),
         ('evidence'), ('research_artifacts'), ('research_findings'),
         ('interactions'), ('actions'), ('signals'), ('signal_entities'),
         ('opportunities'), ('outcomes')
)
select 'the draft compatibility views are gone' as "check",
       not exists (
         select 1 from information_schema.views
          where table_schema = 'public'
            and table_name in ('entities_default_workspace', 'business_units_default_workspace')
       ) as ok
union all
select 'default_workspace_id() is the revised body (no min(uuid))',
       exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'default_workspace_id'
            and p.prosrc not ilike '%min(id)%'
       )
union all
select 'proposal_items.baseline_fingerprint exists',
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'proposal_items'
                  and column_name = 'baseline_fingerprint')
union all
select 'proposal_items.origin_item_id exists',
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'proposal_items'
                  and column_name = 'origin_item_id')
union all
select 'proposals supersede columns exist',
       (select count(*) = 3 from information_schema.columns
         where table_schema = 'public' and table_name = 'proposals'
           and column_name in ('supersedes_proposal_id', 'superseded_by_proposal_id', 'superseded_reason'))
union all
select 'every pre-0006 table still present defaults workspace_id through default_workspace_id()',
       not exists (
         select 1 from legacy l
          -- Seven of these were dropped by 0021 once their content had been
          -- migrated into the final model. A table that no longer exists cannot
          -- carry a default, and asserting otherwise would make this check fail
          -- for a database that is correctly up to date.
          where to_regclass('public.' || quote_ident(l.table_name)) is not null
            and not exists (
            select 1 from information_schema.columns c
             where c.table_schema = 'public' and c.table_name = l.table_name
               and c.column_name = 'workspace_id'
               and c.column_default ilike '%default_workspace_id%'
          )
       );
