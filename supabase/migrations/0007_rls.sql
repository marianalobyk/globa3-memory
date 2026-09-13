-- 0007 Row level security.
--
-- Access model, in three layers:
--
--   1. RLS scopes every row to the caller's workspaces via
--      public.is_workspace_member(workspace_id). Nothing is visible otherwise.
--   2. Knowledge tables are SELECT-only for end users. A signed-in user cannot
--      insert an entity, a finding, an interaction or a signal from the client
--      at all -- those writes exist only in the server apply path running as
--      service_role. This is what makes "unapproved records cannot be written"
--      a structural property rather than a convention.
--   3. The server additionally checks membership and approval capability before
--      it acts, and the apply step re-verifies the approved proposal version.
--
-- The application connects as `authenticated` with the verified Supabase JWT
-- subject bound to the transaction, so auth.uid() behaves exactly as it does
-- through PostgREST.

revoke all on all tables in schema public from anon;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
  -- Everything a signed-in user may read.
  readable text[] := array[
    'workspaces', 'app_users', 'workspace_members',
    'business_units', 'members', 'member_business_units', 'knowledge', 'rules',
    'meetings', 'external_companies', 'external_contacts', 'relationship_interactions',
    'entities', 'entity_aliases', 'entity_affiliations', 'entity_mentions',
    'evidence', 'research_artifacts', 'research_findings',
    'interactions', 'actions', 'signals', 'signal_entities',
    'opportunities', 'outcomes',
    'brief_formats', 'prompt_versions', 'context_items',
    'runs', 'run_stages', 'run_events',
    'brief_documents', 'brief_sources', 'research_topics',
    'uploads', 'upload_documents',
    'proposals', 'proposal_items', 'proposal_approvals', 'applied_changes',
    'ask_threads', 'ask_messages',
    'usage_events', 'budgets', 'activity_log', 'daily_reports'
  ];
begin
  foreach t in array readable loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
  execute 'grant select on public."Globa 3 Automatization & Memory" to authenticated';
  execute 'grant all on public."Globa 3 Automatization & Memory" to service_role';
  execute 'grant usage, select on all sequences in schema public to service_role';
  execute 'grant usage on schema public to anon, authenticated, service_role';
end $$;

-- User-action tables: things a person does in the UI, which are not knowledge
-- records. Creating a run request, selecting research topics, asking a
-- question, editing format settings, deciding on a proposal item.
do $$
declare t text;
begin
  foreach t in array array['research_topics', 'context_items', 'ask_threads', 'ask_messages'] loop
    execute format('grant insert, update, delete on public.%I to authenticated', t);
  end loop;
  execute 'grant insert, update on public.uploads to authenticated';
  execute 'grant insert, update on public.brief_formats to authenticated';
  execute 'grant insert, update, delete on public.budgets to authenticated';
  execute 'grant usage, select on all sequences in schema public to authenticated';
end $$;

-- A proposal item is decided by a person, but only these columns may move.
-- Everything the apply step actually writes from (target table, new_values,
-- applied_row_id) stays server-only.
grant update (decision, decided_by, decided_at, edited_values, was_edited, updated_at)
  on public.proposal_items to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS and attach the workspace policy
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
  -- Workspace-scoped tables: readable to members, never client-writable.
  read_only text[] := array[
    'business_units', 'members', 'member_business_units', 'knowledge', 'rules',
    'meetings', 'external_companies', 'external_contacts', 'relationship_interactions',
    'entities', 'entity_aliases', 'entity_affiliations', 'entity_mentions',
    'evidence', 'research_artifacts', 'research_findings',
    'interactions', 'actions', 'signals', 'signal_entities',
    'opportunities', 'outcomes',
    'prompt_versions', 'runs', 'run_stages', 'run_events',
    'brief_documents', 'brief_sources', 'upload_documents',
    'proposals', 'proposal_approvals', 'applied_changes',
    'usage_events', 'activity_log', 'daily_reports',
    'Globa 3 Automatization & Memory'
  ];
  writable text[] := array[
    'research_topics', 'context_items', 'ask_threads', 'ask_messages',
    'uploads', 'brief_formats', 'budgets'
  ];
begin
  foreach t in array read_only loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_member_select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated
         using (public.is_workspace_member(workspace_id))',
      t || '_member_select', t);
  end loop;

  foreach t in array writable loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_member_select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated
         using (public.is_workspace_member(workspace_id))',
      t || '_member_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_member_write', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated
         with check (public.is_workspace_member(workspace_id))',
      t || '_member_write', t);
    execute format('drop policy if exists %I on public.%I', t || '_member_update', t);
    execute format(
      'create policy %I on public.%I for update to authenticated
         using (public.is_workspace_member(workspace_id))
         with check (public.is_workspace_member(workspace_id))',
      t || '_member_update', t);
  end loop;
end $$;

-- proposal_items: read for members, update restricted to the granted columns
-- and to users who actually hold approval capability in the workspace.
alter table public.proposal_items enable row level security;
drop policy if exists proposal_items_member_select on public.proposal_items;
create policy proposal_items_member_select on public.proposal_items
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
drop policy if exists proposal_items_decide on public.proposal_items;
create policy proposal_items_decide on public.proposal_items
  for update to authenticated
  using (public.can_approve_in_workspace(workspace_id))
  with check (public.can_approve_in_workspace(workspace_id));

-- Workspace and membership visibility.
alter table public.workspaces enable row level security;
drop policy if exists workspaces_member_select on public.workspaces;
create policy workspaces_member_select on public.workspaces
  for select to authenticated
  using (public.is_workspace_member(id));

alter table public.workspace_members enable row level security;
drop policy if exists workspace_members_self_select on public.workspace_members;
create policy workspace_members_self_select on public.workspace_members
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

alter table public.app_users enable row level security;
drop policy if exists app_users_shared_workspace_select on public.app_users;
create policy app_users_shared_workspace_select on public.app_users
  for select to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.workspace_members mine
      join public.workspace_members theirs on theirs.workspace_id = mine.workspace_id
      where mine.user_id = auth.uid()
        and theirs.user_id = public.app_users.id
    )
  );

-- Default deny for any table added later without an explicit policy.
alter default privileges in schema public revoke all on tables from anon;
