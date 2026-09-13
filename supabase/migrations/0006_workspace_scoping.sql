-- 0006 Workspace scoping.
--
-- The existing schema has no tenant column at all. This adds workspace_id to
-- every data table, moves the existing rows into one default workspace, and
-- re-scopes the global unique slugs so a second workspace can reuse a name.
--
-- It also adds composite foreign keys (ref_id, workspace_id) -> parent(id,
-- workspace_id). That makes a cross-workspace reference structurally
-- impossible, not merely disallowed by policy. The pre-existing single-column
-- FKs are left untouched so their on-delete behaviour is preserved; the
-- composite ones use NO ACTION and MATCH SIMPLE, so a SET NULL cascade still
-- resolves cleanly.

-- ---------------------------------------------------------------------------
-- Default workspace
-- ---------------------------------------------------------------------------

insert into public.workspaces (slug, name, timezone)
values ('globa3', 'Globa 3', 'Europe/Paris')
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- Add + backfill workspace_id
-- ---------------------------------------------------------------------------

do $$
declare
  default_ws uuid;
  t text;
  scoped text[] := array[
    -- legacy
    'business_units', 'members', 'member_business_units', 'knowledge', 'rules',
    'meetings', 'external_companies', 'external_contacts', 'relationship_interactions',
    'Globa 3 Automatization & Memory',
    -- phase 1 / 1.1
    'entities', 'entity_aliases', 'entity_affiliations', 'entity_mentions',
    'evidence', 'research_artifacts', 'research_findings',
    'interactions', 'actions', 'signals', 'signal_entities',
    'opportunities', 'outcomes'
  ];
begin
  select id into default_ws from public.workspaces where slug = 'globa3';

  foreach t in array scoped loop
    execute format(
      'alter table public.%I add column if not exists workspace_id uuid references public.workspaces(id) on delete cascade', t);
    execute format('update public.%I set workspace_id = $1 where workspace_id is null', t)
      using default_ws;
    execute format('alter table public.%I alter column workspace_id set not null', t);
    execute format('create index if not exists %I on public.%I(workspace_id)',
      left(replace(lower(t), ' ', '_'), 40) || '_workspace_idx', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Re-scope global unique slugs to (workspace_id, slug)
-- ---------------------------------------------------------------------------

do $$
declare
  rec record;
  t text;
  slugged text[] := array[
    'business_units', 'members', 'knowledge', 'rules', 'meetings',
    'external_companies', 'external_contacts',
    'entities', 'research_artifacts', 'opportunities'
  ];
begin
  foreach t in array slugged loop
    -- Drop any single-column unique constraint/index on slug, whatever it is
    -- named in this particular database.
    for rec in
      select con.conname
      from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
      join pg_namespace ns on ns.oid = cl.relnamespace
      where ns.nspname = 'public'
        and cl.relname = t
        and con.contype = 'u'
        and con.conkey = array[(
          select attnum from pg_attribute
          where attrelid = cl.oid and attname = 'slug' and not attisdropped
        )]
    loop
      execute format('alter table public.%I drop constraint %I', t, rec.conname);
    end loop;

    for rec in
      select i.relname
      from pg_index idx
      join pg_class i on i.oid = idx.indexrelid
      join pg_class cl on cl.oid = idx.indrelid
      join pg_namespace ns on ns.oid = cl.relnamespace
      where ns.nspname = 'public'
        and cl.relname = t
        and idx.indisunique
        and not idx.indisprimary
        and idx.indnatts = 1
        and idx.indkey[0] = (
          select attnum from pg_attribute
          where attrelid = cl.oid and attname = 'slug' and not attisdropped
        )
    loop
      execute format('drop index public.%I', rec.relname);
    end loop;

    execute format(
      'create unique index if not exists %I on public.%I(workspace_id, slug) where slug is not null',
      t || '_workspace_slug_key', t);
  end loop;
end $$;

-- entity_aliases uniqueness is already scoped through entity_id; add the
-- workspace column to the index so lookups stay workspace-local.
create index if not exists entity_aliases_ws_slug_idx
  on public.entity_aliases(workspace_id, alias_slug);
create index if not exists entity_mentions_ws_slug_idx
  on public.entity_mentions(workspace_id, mention_slug);
create index if not exists entities_ws_type_name_idx
  on public.entities(workspace_id, entity_type, display_name);

-- ---------------------------------------------------------------------------
-- Composite foreign keys: a row can only ever reference its own workspace
-- ---------------------------------------------------------------------------

do $$
declare
  p text;
  parents text[] := array[
    'business_units', 'members', 'entities', 'evidence', 'research_artifacts',
    'signals', 'interactions', 'actions', 'opportunities', 'external_companies',
    'brief_documents', 'runs', 'run_stages', 'uploads', 'proposals',
    'proposal_items', 'brief_formats', 'prompt_versions', 'research_topics',
    'ask_threads'
  ];
begin
  foreach p in array parents loop
    begin
      execute format(
        'alter table public.%I add constraint %I unique (id, workspace_id)',
        p, left(p || '_id_workspace_key', 63));
    exception
      when duplicate_table or duplicate_object then null;
    end;
  end loop;
end $$;

do $$
declare
  m record;
  mappings jsonb := $j$[
    {"t":"member_business_units","c":"member_id","p":"members"},
    {"t":"member_business_units","c":"business_unit_id","p":"business_units"},
    {"t":"knowledge","c":"business_unit_id","p":"business_units"},
    {"t":"rules","c":"business_unit_id","p":"business_units"},
    {"t":"meetings","c":"business_unit_id","p":"business_units"},
    {"t":"external_contacts","c":"company_id","p":"external_companies"},
    {"t":"relationship_interactions","c":"business_unit_id","p":"business_units"},
    {"t":"entity_aliases","c":"entity_id","p":"entities"},
    {"t":"entity_affiliations","c":"person_entity_id","p":"entities"},
    {"t":"entity_affiliations","c":"organization_entity_id","p":"entities"},
    {"t":"entity_affiliations","c":"evidence_id","p":"evidence"},
    {"t":"entity_mentions","c":"candidate_entity_id","p":"entities"},
    {"t":"entity_mentions","c":"source_evidence_id","p":"evidence"},
    {"t":"entity_mentions","c":"source_artifact_id","p":"research_artifacts"},
    {"t":"entity_mentions","c":"business_unit_id","p":"business_units"},
    {"t":"entities","c":"source_evidence_id","p":"evidence"},
    {"t":"research_artifacts","c":"source_evidence_id","p":"evidence"},
    {"t":"research_findings","c":"artifact_id","p":"research_artifacts"},
    {"t":"research_findings","c":"evidence_id","p":"evidence"},
    {"t":"research_findings","c":"related_entity_id","p":"entities"},
    {"t":"research_findings","c":"business_unit_id","p":"business_units"},
    {"t":"interactions","c":"external_entity_id","p":"entities"},
    {"t":"interactions","c":"internal_business_unit_id","p":"business_units"},
    {"t":"interactions","c":"internal_owner_member_id","p":"members"},
    {"t":"interactions","c":"evidence_id","p":"evidence"},
    {"t":"actions","c":"related_entity_id","p":"entities"},
    {"t":"actions","c":"related_interaction_id","p":"interactions"},
    {"t":"actions","c":"internal_business_unit_id","p":"business_units"},
    {"t":"actions","c":"owner_member_id","p":"members"},
    {"t":"actions","c":"evidence_id","p":"evidence"},
    {"t":"signals","c":"related_entity_id","p":"entities"},
    {"t":"signals","c":"business_unit_id","p":"business_units"},
    {"t":"signals","c":"evidence_id","p":"evidence"},
    {"t":"signal_entities","c":"signal_id","p":"signals"},
    {"t":"signal_entities","c":"entity_id","p":"entities"},
    {"t":"opportunities","c":"related_entity_id","p":"entities"},
    {"t":"opportunities","c":"business_unit_id","p":"business_units"},
    {"t":"opportunities","c":"source_signal_id","p":"signals"},
    {"t":"opportunities","c":"evidence_id","p":"evidence"},
    {"t":"opportunities","c":"owner_member_id","p":"members"},
    {"t":"outcomes","c":"related_opportunity_id","p":"opportunities"},
    {"t":"outcomes","c":"related_action_id","p":"actions"},
    {"t":"outcomes","c":"related_interaction_id","p":"interactions"},
    {"t":"outcomes","c":"related_entity_id","p":"entities"},
    {"t":"outcomes","c":"business_unit_id","p":"business_units"},
    {"t":"outcomes","c":"evidence_id","p":"evidence"},
    {"t":"brief_documents","c":"format_id","p":"brief_formats"},
    {"t":"brief_documents","c":"prompt_version_id","p":"prompt_versions"},
    {"t":"brief_documents","c":"run_id","p":"runs"},
    {"t":"brief_sources","c":"brief_document_id","p":"brief_documents"},
    {"t":"brief_sources","c":"evidence_id","p":"evidence"},
    {"t":"research_topics","c":"brief_document_id","p":"brief_documents"},
    {"t":"research_topics","c":"matched_entity_id","p":"entities"},
    {"t":"research_topics","c":"business_unit_id","p":"business_units"},
    {"t":"upload_documents","c":"upload_id","p":"uploads"},
    {"t":"upload_documents","c":"brief_document_id","p":"brief_documents"},
    {"t":"uploads","c":"parent_upload_id","p":"uploads"},
    {"t":"proposals","c":"run_id","p":"runs"},
    {"t":"proposals","c":"brief_document_id","p":"brief_documents"},
    {"t":"proposals","c":"upload_id","p":"uploads"},
    {"t":"proposal_items","c":"proposal_id","p":"proposals"},
    {"t":"proposal_approvals","c":"proposal_id","p":"proposals"},
    {"t":"applied_changes","c":"proposal_id","p":"proposals"},
    {"t":"applied_changes","c":"proposal_item_id","p":"proposal_items"},
    {"t":"run_stages","c":"run_id","p":"runs"},
    {"t":"run_events","c":"run_id","p":"runs"},
    {"t":"runs","c":"format_id","p":"brief_formats"},
    {"t":"runs","c":"prompt_version_id","p":"prompt_versions"},
    {"t":"prompt_versions","c":"format_id","p":"brief_formats"},
    {"t":"context_items","c":"format_id","p":"brief_formats"},
    {"t":"context_items","c":"related_entity_id","p":"entities"},
    {"t":"context_items","c":"business_unit_id","p":"business_units"},
    {"t":"ask_messages","c":"thread_id","p":"ask_threads"},
    {"t":"usage_events","c":"run_id","p":"runs"},
    {"t":"usage_events","c":"run_stage_id","p":"run_stages"}
  ]$j$::jsonb;
  cname text;
begin
  for m in select * from jsonb_to_recordset(mappings) as x(t text, c text, p text) loop
    cname := left(m.t || '_' || m.c || '_ws_fk', 63);
    begin
      execute format(
        'alter table public.%I add constraint %I
           foreign key (%I, workspace_id) references public.%I(id, workspace_id)
           on update no action on delete no action',
        m.t, cname, m.c, m.p);
    exception
      when duplicate_object or duplicate_table then null;
      when undefined_column or undefined_table then
        raise notice 'skipped composite FK %.% -> % (%).', m.t, m.c, m.p, sqlerrm;
    end;
  end loop;
end $$;
