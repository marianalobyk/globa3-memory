-- 0018 Client roles hold no database write privilege. Security only; no data changes.
--
-- Why
--   The browser and the mobile app never talk to the database. Every request
--   goes through the Next.js server, which verifies the session and then reads
--   as `authenticated` (so RLS applies) and writes as `service_role` after its
--   own membership, approval and version checks.
--
--   On Supabase, however, the platform's default privileges grant `anon` and
--   `authenticated` ALL on every table, sequence and function created in
--   `public`. Migration 0007 added the SELECT grants the server needs and
--   revoked everything from `anon`, but never took the inherited privileges
--   away from `authenticated`. A signed-in user holding the public anon key and
--   their own access token could therefore reach the database through the Data
--   API (PostgREST) with INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on
--   every table, USAGE/UPDATE on sequences (setval), and EXECUTE on the legacy
--   writer functions. RLS refused the row writes; TRUNCATE is not subject to
--   RLS, and `schema_migrations` has no RLS at all.
--
-- What this does, idempotently
--   1. anon: no privilege on any application table, sequence or function.
--   2. authenticated: every table-level write privilege is revoked
--      (INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER; revoking a
--      table privilege also revokes the column-level grants 0007 made on
--      proposal_items). SELECT is kept ONLY on tables with RLS enabled -- the
--      reads the server performs under the user's own access rules. A table
--      without RLS (schema_migrations) loses SELECT too.
--   3. Sequences: no USAGE, SELECT or UPDATE for client roles.
--   4. Functions in `public` that belong to the application (not to an
--      extension): EXECUTE removed from PUBLIC, anon and authenticated, then
--      granted back to authenticated only for the helpers RLS policies call
--      (is_workspace_member, can_approve_in_workspace). service_role keeps
--      EXECUTE on all of them (default_workspace_id is a column default for
--      server inserts; upsert_legacy_record is the server's legacy writer).
--   5. Default privileges for objects the migration role creates later in
--      `public`: no table, sequence or function privilege for anon or
--      authenticated (this removes Supabase's schema-level defaults). A new
--      table must `grant select ... to authenticated` explicitly (as 0017 does).
--      Limitation: PostgreSQL's built-in default that lets PUBLIC execute new
--      functions can only be removed instance-wide, not per schema, and doing
--      that would also affect extension functions in other schemas. So a NEW
--      function in `public` is still executable by PUBLIC unless its migration
--      revokes it; re-running this migration's step 4, or `npm run
--      verify:grants` / `supabase:test:grants`, catches one that was missed.
--
-- Not touched: service_role (the server and worker), postgres (migrations and
-- import scripts), Supabase-managed schemas (auth, storage, pgmq, extensions,
-- graphql, realtime), and schema USAGE, which PostgREST needs to resolve roles.
-- The insert/update policies 0007 created on user-action tables are left in
-- place; without a grant they can no longer be used.
--
-- Default privileges owned by `supabase_admin` (objects created by the
-- dashboard's internal role) can only be changed by that role; this migration
-- tries and, if refused, reports it with a NOTICE rather than failing.

-- ---------------------------------------------------------------------------
-- 1-2. Tables
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
  client_roles text := concat_ws(', ',
    case when exists (select 1 from pg_roles where rolname = 'anon') then 'anon' end,
    case when exists (select 1 from pg_roles where rolname = 'authenticated') then 'authenticated' end);
begin
  if client_roles = '' then
    raise notice '0018: no anon/authenticated roles; nothing to revoke';
    return;
  end if;

  for r in
    select c.relname, c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and not exists (
         select 1 from pg_depend d
          where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
  loop
    execute format(
      'revoke insert, update, delete, truncate, references, trigger on table public.%I from %s',
      r.relname, client_roles);

    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table public.%I from anon', r.relname);
    end if;

    if not r.relrowsecurity and exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke select on table public.%I from authenticated', r.relname);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Sequences
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'S'
       and not exists (
         select 1 from pg_depend d
          where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
  loop
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on sequence public.%I from anon', r.relname);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on sequence public.%I from authenticated', r.relname);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Functions
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
  rls_helpers text[] := array['is_workspace_member', 'can_approve_in_workspace'];
begin
  for r in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f', 'p')
       and not exists (
         select 1 from pg_depend d
          where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function public.%I(%s) from public', r.proname, r.args);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke execute on function public.%I(%s) from anon', r.proname, r.args);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      if r.proname = any (rls_helpers) then
        execute format('grant execute on function public.%I(%s) to authenticated', r.proname, r.args);
      else
        execute format('revoke execute on function public.%I(%s) from authenticated', r.proname, r.args);
      end if;
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function public.%I(%s) to service_role', r.proname, r.args);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Default privileges for objects created later
-- ---------------------------------------------------------------------------

do $$
declare
  client text;
  owner_role text;
begin
  -- Objects created by the role running migrations.
  foreach client in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = client) then
      execute format('alter default privileges in schema public revoke all on tables from %I', client);
      execute format('alter default privileges in schema public revoke all on sequences from %I', client);
      execute format('alter default privileges in schema public revoke execute on functions from %I', client);
    end if;
  end loop;

  -- Objects created by Supabase's internal admin role, when this role may act for it.
  foreach owner_role in array array['supabase_admin'] loop
    if exists (select 1 from pg_roles where rolname = owner_role) and owner_role <> current_user then
      begin
        foreach client in array array['anon', 'authenticated'] loop
          if exists (select 1 from pg_roles where rolname = client) then
            execute format('alter default privileges for role %I in schema public revoke all on tables from %I', owner_role, client);
            execute format('alter default privileges for role %I in schema public revoke all on sequences from %I', owner_role, client);
            execute format('alter default privileges for role %I in schema public revoke execute on functions from %I', owner_role, client);
          end if;
        end loop;
      exception when insufficient_privilege then
        raise notice '0018: default privileges for role % were not changed (requires that role); objects it creates in public still receive its defaults', owner_role;
      end;
    end if;
  end loop;
end $$;
