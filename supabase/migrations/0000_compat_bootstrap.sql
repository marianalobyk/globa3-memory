-- 0000 Compatibility bootstrap.
--
-- Purpose: make one migration set runnable against BOTH a local/test Postgres
-- (PGlite or plain Postgres) and a real Supabase project.
--
-- On Supabase every object below already exists, so every statement is guarded
-- and additive. Nothing here overwrites a Supabase-managed object.

-- pgcrypto is present on Supabase and absent in PGlite. gen_random_uuid() has
-- been in Postgres core since 13, so the extension is optional: try, ignore.
do $$
begin
  create extension if not exists pgcrypto;
exception when others then
  raise notice 'pgcrypto unavailable, relying on core gen_random_uuid(): %', sqlerrm;
end $$;

-- Supabase roles. Created only when missing.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- Local stand-in for Supabase Auth's user table. On Supabase this table exists
-- and `create table if not exists` is a no-op, so the real one is never touched.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  created_at timestamptz not null default now()
);

-- auth.uid() / auth.role(): Supabase reads the verified JWT claims that PostgREST
-- puts into the `request.jwt.claims` GUC. The application does exactly the same:
-- it verifies the Supabase JWT server-side, then binds the subject to the
-- transaction with set_local. Created ONLY when absent so Supabase's own
-- definitions always win.
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute $fn$
      create function auth.uid() returns uuid
      language sql stable
      as $body$
        select coalesce(
          nullif(current_setting('request.jwt.claim.sub', true), ''),
          nullif((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')
        )::uuid
      $body$;
    $fn$;
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'role'
  ) then
    execute $fn$
      create function auth.role() returns text
      language sql stable
      as $body$
        select coalesce(
          nullif(current_setting('request.jwt.claim.role', true), ''),
          nullif((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'), ''),
          'anon'
        )
      $body$;
    $fn$;
  end if;
end $$;

-- Shared updated_at trigger used across the schema.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Migration bookkeeping.
create table if not exists public.schema_migrations (
  version text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);
