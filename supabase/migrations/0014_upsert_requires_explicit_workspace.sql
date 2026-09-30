-- 0014 upsert_legacy_record requires an explicit workspace.
--
-- The 0013 version fell back to public.default_workspace_id() when neither
-- p_workspace nor row.workspace_id was given. That fallback resolves
-- app.workspace_id or "the single active workspace", which is exactly the
-- implicit tenant choice this function was meant to remove: today's single
-- workspace silently becomes wrong the day a second one is added.
--
-- This replaces the function in place (same signature, so grants and PostgREST
-- RPC exposure are unchanged). The only behavioural change: a call that names
-- no workspace now fails with not_null_violation (23502), whatever the number of
-- workspaces.
--
-- 0013 is left untouched on purpose. Editing an applied migration changes its
-- checksum, and scripts/migrate.mjs refuses to proceed on a changed migration.

create or replace function public.upsert_legacy_record(
  p_table text,
  p_row jsonb,
  p_on_conflict text default 'skip',
  p_workspace uuid default null
)
returns jsonb
language plpgsql
as $$
declare
  -- Exactly the tables whose unique key 0006 re-scoped to (workspace_id, slug).
  allowed text[] := array[
    'business_units', 'members', 'knowledge', 'rules', 'meetings',
    'external_companies', 'external_contacts',
    'entities', 'research_artifacts', 'opportunities'
  ];
  -- Never writable through this path: identity and timestamps are the table's.
  reserved text[] := array['id', 'created_at', 'updated_at'];
  v_row_workspace uuid;
  v_workspace uuid;
  v_unknown text;
  v_reserved text;
  v_columns text;
  v_select text;
  v_set text;
  v_sql text;
  v_result jsonb;
  v_inserted boolean;
  v_action text;
begin
  if p_table is null or not (p_table = any(allowed)) then
    raise exception 'upsert_legacy_record: table % is not supported. Supported: %',
      coalesce(p_table, 'null'), array_to_string(allowed, ', ')
      using errcode = 'invalid_parameter_value';
  end if;

  if p_on_conflict is null or p_on_conflict not in ('skip', 'update') then
    raise exception 'upsert_legacy_record: p_on_conflict must be ''skip'' or ''update'', got %',
      coalesce(p_on_conflict, 'null')
      using errcode = 'invalid_parameter_value';
  end if;

  if p_row is null or jsonb_typeof(p_row) <> 'object' then
    raise exception 'upsert_legacy_record: p_row must be a JSON object'
      using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(p_row ->> 'slug', '') = '' then
    raise exception 'upsert_legacy_record: slug is required; it is the conflict key'
      using errcode = 'not_null_violation';
  end if;

  -- Workspace: the explicit parameter, or one carried in the row. Nothing else.
  -- No default_workspace_id(), no app.workspace_id, no "the only workspace":
  -- this function exists to make old write paths safe for a multi-tenant
  -- database, so a write that does not name its workspace is refused even when
  -- only one workspace exists today.
  v_row_workspace := nullif(p_row ->> 'workspace_id', '')::uuid;
  if p_workspace is not null and v_row_workspace is not null and p_workspace <> v_row_workspace then
    raise exception 'upsert_legacy_record: p_workspace (%) and row.workspace_id (%) disagree',
      p_workspace, v_row_workspace
      using errcode = 'invalid_parameter_value';
  end if;
  v_workspace := coalesce(p_workspace, v_row_workspace);
  if v_workspace is null then
    raise exception 'upsert_legacy_record: a workspace is required. Pass p_workspace or row.workspace_id; it is never inferred.'
      using errcode = 'not_null_violation';
  end if;

  if not exists (select 1 from public.workspaces where id = v_workspace) then
    raise exception 'upsert_legacy_record: workspace % does not exist', v_workspace
      using errcode = 'foreign_key_violation';
  end if;

  -- Reject reserved and unknown keys instead of dropping them silently: a typo
  -- in an old script must fail, not quietly lose a field.
  select string_agg(k, ', ' order by k) into v_reserved
    from jsonb_object_keys(p_row) as k
   where k = any(reserved);
  if v_reserved is not null then
    raise exception 'upsert_legacy_record: column(s) % cannot be written through this function', v_reserved
      using errcode = 'invalid_parameter_value';
  end if;

  select string_agg(k, ', ' order by k) into v_unknown
    from jsonb_object_keys(p_row) as k
   where k <> 'workspace_id'
     and not exists (
       select 1 from pg_attribute a
        where a.attrelid = format('public.%I', p_table)::regclass
          and a.attname = k and a.attnum > 0 and not a.attisdropped
     );
  if v_unknown is not null then
    raise exception 'upsert_legacy_record: unknown column(s) for %: %', p_table, v_unknown
      using errcode = 'undefined_column';
  end if;

  select string_agg(format('%I', k), ', ' order by k),
         string_agg(format('r.%I', k), ', ' order by k),
         string_agg(format('%I = excluded.%I', k, k), ', ' order by k)
           filter (where k <> 'slug')
    into v_columns, v_select, v_set
    from jsonb_object_keys(p_row) as k
   where k <> 'workspace_id';

  -- One statement: the existence check and the write cannot be interleaved by
  -- another caller, unlike the old GET-then-POST.
  v_sql := format(
    'insert into public.%1$I (workspace_id, %2$s)
     select $1, %3$s from jsonb_populate_record(null::public.%1$I, $2) as r
     on conflict (workspace_id, slug) do %4$s
     returning to_jsonb(%1$I.*), (%1$I.xmax::text = ''0'')',
    p_table,
    v_columns,
    v_select,
    case
      when p_on_conflict = 'update' and v_set is not null then 'update set ' || v_set
      else 'nothing'
    end
  );

  execute v_sql into v_result, v_inserted using v_workspace, p_row;

  if v_result is null then
    -- ON CONFLICT DO NOTHING matched an existing row in THIS workspace.
    execute format(
      'select to_jsonb(t.*) from public.%I t where t.workspace_id = $1 and t.slug = $2',
      p_table
    ) into v_result using v_workspace, p_row ->> 'slug';
    v_action := 'skipped_existing';
  elsif v_inserted then
    v_action := 'created';
  else
    v_action := 'updated';
  end if;

  return jsonb_build_object(
    'action', v_action,
    'table', p_table,
    'workspace_id', v_workspace,
    'row', v_result
  );
end;
$$;

comment on function public.upsert_legacy_record(text, jsonb, text, uuid) is
  'Workspace-scoped, atomic replacement for pre-0006 writes that relied on a globally unique slug. Requires p_workspace or row.workspace_id; never infers one. Conflict key is (workspace_id, slug). p_on_conflict: skip (default) or update.';

revoke all on function public.upsert_legacy_record(text, jsonb, text, uuid) from public;
grant execute on function public.upsert_legacy_record(text, jsonb, text, uuid) to service_role;
