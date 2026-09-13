-- 0009 Make the workspace/slug unique indexes non-partial.
--
-- 0006 created them as partial (`where slug is not null`). A partial index cannot
-- serve as an ON CONFLICT arbiter unless every statement repeats the predicate,
-- which is an easy thing to forget and a confusing error when you do.
--
-- A plain unique index behaves identically here: Postgres treats NULLs as
-- distinct by default, so rows with a null slug still do not conflict with each
-- other.

do $$
declare
  t text;
  slugged text[] := array[
    'business_units', 'members', 'knowledge', 'rules', 'meetings',
    'external_companies', 'external_contacts',
    'entities', 'research_artifacts', 'opportunities'
  ];
begin
  foreach t in array slugged loop
    execute format('drop index if exists public.%I', t || '_workspace_slug_key');
    execute format(
      'create unique index if not exists %I on public.%I(workspace_id, slug)',
      t || '_workspace_slug_key', t);
  end loop;
end $$;
