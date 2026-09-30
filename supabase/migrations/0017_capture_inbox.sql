-- 0017 Capture inbox: the raw source a person captured, and its analysis state.
--
-- Why a table, and only one:
--   * A typed note or pasted URL has nowhere to live before approval. `evidence`
--     is a knowledge table written only by the approval-gated apply step, so a
--     raw note cannot be stored there without bypassing review. `uploads` models
--     files only, `upload_documents` requires a file, and `runs.input` is job
--     plumbing with no notion of "this capture was replaced or discarded".
--   * Everything downstream reuses what exists: the file goes through `uploads`
--     and private storage, the analysis is a `runs` row with resumable stages,
--     the result is an ordinary `proposals` row with the same version, content
--     hash, approval and baseline rules, and saving goes through `apply`.
--
-- A capture is UNTRUSTED source material. Nothing in this table is knowledge;
-- it is readable by members of its workspace and writable only by the server.

create table if not exists public.captures (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by uuid references public.app_users(id) on delete set null,
  -- What the person submitted. A note may contain a URL; `source_url` holds the
  -- first one. A file capture points at the private upload row.
  kind text not null check (kind in ('text', 'url', 'file')),
  body_text text,
  source_url text,
  upload_id uuid,
  -- sha256 over the normalised submission. Submitting the same thing twice in a
  -- workspace returns the existing capture instead of analysing it again.
  content_hash text not null,
  -- The hash of the source content alone. A deliberate re-analysis gets a fresh
  -- content_hash (so it is a distinct submission) but keeps this one, which is
  -- what the proposed source record is keyed on -- so re-analysing the same note
  -- proposes the stored source instead of a duplicate.
  source_hash text not null,
  status text not null default 'received'
    check (status in ('received', 'analyzing', 'proposed', 'failed', 'replaced', 'discarded')),
  status_detail text,
  run_id uuid,
  proposal_id uuid,
  -- The capture this one replaced after "edit capture".
  replaces_capture_id uuid references public.captures(id) on delete set null,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint captures_has_content check (
    (kind = 'file' and upload_id is not null)
    or (kind <> 'file' and coalesce(length(body_text), 0) > 0)
  ),
  constraint captures_body_size check (body_text is null or length(body_text) <= 20000),
  constraint captures_id_workspace_key unique (id, workspace_id),
  -- Composite keys: a capture can only point at rows of its own workspace.
  constraint captures_upload_ws_fk foreign key (upload_id, workspace_id)
    references public.uploads(id, workspace_id),
  constraint captures_run_ws_fk foreign key (run_id, workspace_id)
    references public.runs(id, workspace_id),
  constraint captures_proposal_ws_fk foreign key (proposal_id, workspace_id)
    references public.proposals(id, workspace_id)
);

create index if not exists captures_ws_created_idx on public.captures(workspace_id, created_at desc);
create index if not exists captures_proposal_idx on public.captures(proposal_id);
create index if not exists captures_run_idx on public.captures(run_id);

-- Idempotent submission. Replaced and discarded captures do not block
-- submitting the same text again deliberately.
create unique index if not exists captures_live_content_unique
  on public.captures(workspace_id, content_hash)
  where status not in ('replaced', 'discarded');

-- Updated-at trigger, same helper the other application tables use.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists set_captures_updated_at on public.captures;
    create trigger set_captures_updated_at before update on public.captures
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Access: members read, nobody but the server writes
-- ---------------------------------------------------------------------------

revoke all on public.captures from anon;
grant select on public.captures to authenticated;
grant all on public.captures to service_role;

alter table public.captures enable row level security;
drop policy if exists captures_member_select on public.captures;
create policy captures_member_select on public.captures
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- A capture analysis is a run, and its result a proposal
-- ---------------------------------------------------------------------------

alter table public.runs drop constraint if exists runs_kind_check;
alter table public.runs add constraint runs_kind_check
  check (kind in ('brief', 'research', 'ask', 'ingest', 'report', 'capture'));

alter table public.proposals drop constraint if exists proposals_source_kind_check;
alter table public.proposals add constraint proposals_source_kind_check
  check (source_kind in ('brief', 'research', 'upload', 'manual', 'capture'));

comment on table public.captures is
  'Untrusted source material captured by a person (note, URL or file) and its analysis state. Never knowledge: approved changes are written by the apply step only.';
