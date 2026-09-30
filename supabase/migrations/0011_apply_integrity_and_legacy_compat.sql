-- 0011 Apply integrity, and compatibility for pre-0006 callers.
--
-- Three separate concerns, grouped because they are all additive and all needed
-- before the apply path can stop coercing operations.
--
-- 1. Lost-update protection
--    proposal_items.baseline_fingerprint stores md5(row::text) of the target row
--    as it looked when the proposal was built. The apply step then performs the
--    update with that fingerprint in the WHERE clause, so the check and the write
--    are a single atomic statement: if anyone changed the row in between, zero
--    rows match and nothing is overwritten.
--
-- 2. Supersede chain
--    When an approved operation can no longer be applied as approved (a create
--    now collides with a real record, or an update's target is gone), the apply
--    step refuses and generates a replacement proposal. These columns record the
--    link in both directions so the history stays readable.
--
-- 3. Legacy compatibility
--    0006 made workspace_id NOT NULL on tables that pre-existed it. Any caller
--    written before 0006 -- the archive's work/*.mjs scripts, a PostgREST call,
--    a psql session -- inserts without that column and now fails. A DEFAULT
--    resolves it, but only when the answer is unambiguous; see below.

-- ---------------------------------------------------------------------------
-- 1. Baseline fingerprint
-- ---------------------------------------------------------------------------

alter table public.proposal_items
  add column if not exists baseline_fingerprint text;

comment on column public.proposal_items.baseline_fingerprint is
  'md5(row::text) of the target row when the proposal was built. Checked atomically in the UPDATE WHERE clause so a concurrent change cannot be silently overwritten.';

-- ---------------------------------------------------------------------------
-- 2. Supersede chain
-- ---------------------------------------------------------------------------

alter table public.proposals
  add column if not exists supersedes_proposal_id uuid
    references public.proposals(id) on delete set null,
  add column if not exists superseded_by_proposal_id uuid
    references public.proposals(id) on delete set null,
  add column if not exists superseded_reason text;

create index if not exists proposals_supersedes_idx
  on public.proposals(supersedes_proposal_id);
create index if not exists proposals_superseded_by_idx
  on public.proposals(superseded_by_proposal_id);

-- Traceability from a replacement item back to the item it replaces.
alter table public.proposal_items
  add column if not exists origin_item_id uuid
    references public.proposal_items(id) on delete set null;

create index if not exists proposal_items_origin_idx
  on public.proposal_items(origin_item_id);

-- ---------------------------------------------------------------------------
-- 3. Legacy compatibility for the mandatory workspace_id
-- ---------------------------------------------------------------------------

/*
 * Returns the workspace a caller that predates 0006 must have meant.
 *
 * Deliberately refuses to guess:
 *   - an explicit `app.workspace_id` setting always wins, so a script can state
 *     which workspace it is writing to;
 *   - otherwise, only when the database holds exactly ONE active workspace is
 *     the answer unambiguous;
 *   - with several workspaces it raises, because silently picking one would be
 *     a cross-tenant write, which is the failure this whole design exists to
 *     prevent. A NOT NULL error is a far better outcome than the wrong tenant.
 */
create or replace function public.default_workspace_id()
returns uuid
language plpgsql
stable
as $$
declare
  explicit text := current_setting('app.workspace_id', true);
  found_id uuid;
  workspace_count integer;
begin
  if explicit is not null and explicit <> '' then
    return explicit::uuid;
  end if;

  select count(*) into workspace_count
    from public.workspaces
   where status = 'active';

  if workspace_count = 1 then
    -- There is no min() for uuid, and with exactly one row it is unambiguous.
    select id into found_id from public.workspaces where status = 'active';
    return found_id;
  end if;

  if workspace_count = 0 then
    raise exception
      'workspace_id is required and no active workspace exists. Create one, or set app.workspace_id.'
      using errcode = 'not_null_violation';
  end if;

  raise exception
    'workspace_id is required: % active workspaces exist, so it cannot be inferred. Set it explicitly, or run: select set_config(''app.workspace_id'', ''<uuid>'', false);',
    workspace_count
    using errcode = 'not_null_violation';
end;
$$;

comment on function public.default_workspace_id() is
  'Compatibility shim for callers written before 0006 made workspace_id mandatory. Resolves app.workspace_id, else the single active workspace, else raises rather than guessing.';

-- Apply the default to the tables that existed before 0006. New application
-- tables are deliberately excluded: every caller of those is current code that
-- passes the workspace explicitly, and a default there would hide a real bug.
do $$
declare
  t text;
  legacy text[] := array[
    'business_units', 'members', 'member_business_units', 'knowledge', 'rules',
    'meetings', 'external_companies', 'external_contacts', 'relationship_interactions',
    'Globa 3 Automatization & Memory',
    'entities', 'entity_aliases', 'entity_affiliations', 'entity_mentions',
    'evidence', 'research_artifacts', 'research_findings',
    'interactions', 'actions', 'signals', 'signal_entities',
    'opportunities', 'outcomes'
  ];
begin
  foreach t in array legacy loop
    execute format(
      'alter table public.%I alter column workspace_id set default public.default_workspace_id()', t);
  end loop;
end $$;

grant execute on function public.default_workspace_id() to service_role, authenticated;

/*
 * Not handled here: callers that relied on the global unique slug.
 *
 * 0006 re-scoped it to (workspace_id, slug), so `on conflict (slug)` now fails
 * with 42P10, and a lookup by `slug=eq.X` alone can match another workspace's
 * row. A view cannot fix either: ON CONFLICT on a view still needs an arbiter
 * index on the base table matching (slug), and none exists. Migration 0013
 * provides a dedicated, workspace-scoped write function instead.
 */
