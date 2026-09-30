-- 0019 Contact research: the identity-confirmation state of one contact in one capture.
--
-- Why a table, and only one:
--   Research on a contact is a short conversation with the person reviewing a
--   capture: "is this who you met?" -> "yes, that one" / "none of these" ->
--   research -> results joined into the SAME capture proposal. That state has
--   nowhere to live today:
--     * research_topics models brief research targets. Its status values
--       (proposed/selected/researching/...) have no "awaiting identity
--       confirmation" or "none of these", and it has no place for candidate
--       identities or a confirmed one.
--     * runs are jobs: they cannot hold a decision the person makes between two
--       jobs (identify, then research).
--     * proposals and their items are what gets approved; unconfirmed public
--       candidates must never become proposal items, because an item is
--       something a person could approve into memory.
--   Everything else is reused: the identify and research steps are `runs`, and
--   the research results are appended to the capture's existing proposal
--   through the same buildProposal engine, with the same version, content hash,
--   approval and apply rules.
--
-- Nothing in this table is knowledge. Candidates are public-web guesses held
-- for a person to confirm; they are readable by workspace members and written
-- only by the server.

create table if not exists public.contact_research (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  capture_id uuid not null,
  proposal_id uuid not null,
  -- The contact within the capture: slug of the name as written, plus the name.
  contact_key text not null,
  contact_name text not null,
  -- The stored record this contact already is, when it resolved exactly.
  entity_id uuid,
  status text not null default 'not_started'
    check (status in (
      'not_started',            -- only marked important so far
      'identifying',            -- looking for who this could be
      'awaiting_confirmation',  -- candidates shown: "Is this the person you met?"
      'no_reliable_match',      -- the search found nobody it could stand behind
      'none_of_these',          -- the person rejected every candidate
      'needs_context',          -- the person chose to add context to the capture
      'researching',            -- identity confirmed; focused research running
      'completed',              -- results joined the capture proposal
      'failed'
    )),
  status_detail text,
  important boolean not null default false,
  -- Exactly the public-safe identity clues the reviewer kept in the privacy
  -- preflight (name, and optionally organisation, role, events, projects). The
  -- raw note, contact details and memory are never stored or sent here.
  search_clues jsonb not null default '[]'::jsonb,
  -- When the reviewer confirmed cost and disclosure. Research cannot run without it.
  disclosure_acknowledged_at timestamptz,
  -- Up to three public candidates with explanations and sources.
  candidates jsonb not null default '[]'::jsonb,
  confirmed_candidate jsonb,
  identify_run_id uuid,
  research_run_id uuid,
  identify_attempts integer not null default 0,
  items_added integer not null default 0,
  requested_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contact_research_capture_contact_key unique (workspace_id, capture_id, contact_key),
  constraint contact_research_id_workspace_key unique (id, workspace_id),
  constraint contact_research_capture_ws_fk foreign key (capture_id, workspace_id)
    references public.captures(id, workspace_id) on delete cascade,
  constraint contact_research_proposal_ws_fk foreign key (proposal_id, workspace_id)
    references public.proposals(id, workspace_id) on delete cascade,
  constraint contact_research_entity_ws_fk foreign key (entity_id, workspace_id)
    references public.entities(id, workspace_id),
  constraint contact_research_identify_run_ws_fk foreign key (identify_run_id, workspace_id)
    references public.runs(id, workspace_id),
  constraint contact_research_research_run_ws_fk foreign key (research_run_id, workspace_id)
    references public.runs(id, workspace_id),
  constraint contact_research_candidates_is_array check (jsonb_typeof(candidates) = 'array'),
  constraint contact_research_search_clues_is_array check (jsonb_typeof(search_clues) = 'array'),
  constraint contact_research_disclosed_before_search check (
    status in ('not_started') or disclosure_acknowledged_at is not null
  ),
  constraint contact_research_candidates_max check (jsonb_array_length(candidates) <= 3)
);

create index if not exists contact_research_proposal_idx on public.contact_research(workspace_id, proposal_id);

do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists set_contact_research_updated_at on public.contact_research;
    create trigger set_contact_research_updated_at before update on public.contact_research
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Access: members read, nobody but the server writes (same rule as 0017/0018)
-- ---------------------------------------------------------------------------

alter table public.contact_research enable row level security;
drop policy if exists contact_research_member_select on public.contact_research;
create policy contact_research_member_select on public.contact_research
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.contact_research from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.contact_research from authenticated';
    execute 'grant select on public.contact_research to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on public.contact_research to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The two steps are runs
-- ---------------------------------------------------------------------------

alter table public.runs drop constraint if exists runs_kind_check;
alter table public.runs add constraint runs_kind_check
  check (kind in ('brief', 'research', 'ask', 'ingest', 'report', 'capture', 'contact_identify', 'contact_research'));

comment on table public.contact_research is
  'Identity confirmation and research state for one contact in one capture. Candidates are unconfirmed public-web guesses, never knowledge; results join the capture proposal and are saved only on approval.';
