-- 0005 Application platform layer.
--
-- Everything the web app and worker need that the existing Globa 3 schema does
-- not already provide: workspaces and membership, format/prompt versioning, run
-- orchestration with crash recovery, uploads, the proposal/approval/apply chain,
-- cost accounting and activity.
--
-- Nothing here duplicates the Phase 1 knowledge tables. Knowledge still lives in
-- entities / evidence / research_findings / interactions / actions / signals.

-- ---------------------------------------------------------------------------
-- Workspaces and access
-- ---------------------------------------------------------------------------

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  timezone text not null default 'Europe/Paris',
  status text not null default 'active',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete cascade,
  role text not null default 'editor' check (role in ('admin', 'editor', 'viewer')),
  -- Approval is an explicit capability, not implied by role: both users in the
  -- first workspace can approve records while only one is admin.
  can_approve boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);
create index if not exists workspace_members_user_idx on public.workspace_members(user_id);

-- Single source of truth for "may this user see this workspace".
-- SECURITY DEFINER + a stable search_path so RLS policies can call it without
-- recursing into workspace_members' own policy.
create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = target_workspace
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.can_approve_in_workspace(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = target_workspace
      and m.user_id = auth.uid()
      and m.can_approve
  );
$$;

-- ---------------------------------------------------------------------------
-- Formats and prompt versioning
-- ---------------------------------------------------------------------------

create table if not exists public.brief_formats (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  key text not null,
  name text not null,
  product_line text,
  description text,
  -- Structured, code-consumed rules: research lanes, source families/tiers,
  -- scoring rubric and thresholds, freshness labels, coverage-window shape,
  -- output modes, reader structure, QA checklist.
  config jsonb not null default '{}'::jsonb,
  default_model text,
  research_model text,
  active_prompt_version_id uuid,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, key)
);

create table if not exists public.prompt_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  format_id uuid not null references public.brief_formats(id) on delete cascade,
  version integer not null,
  -- The run prompt with [PLACEHOLDERS] left intact. Code substitutes them.
  body text not null,
  -- Desk files (brief / item memory / rules / QA) attached to this version.
  attachments jsonb not null default '[]'::jsonb,
  structured jsonb not null default '{}'::jsonb,
  checksum text not null,
  note text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (format_id, version)
);
create index if not exists prompt_versions_format_idx on public.prompt_versions(format_id);

alter table public.brief_formats
  add column if not exists active_prompt_version_id uuid references public.prompt_versions(id) on delete set null;

-- Run context: watchlist, priorities, targets, open questions. Injected into
-- prompts instead of being hardcoded in the prompt text.
create table if not exists public.context_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  format_id uuid references public.brief_formats(id) on delete cascade,
  kind text not null check (kind in (
    'priority', 'target', 'project', 'watchlist', 'do_not_contact',
    'special_question', 'open_watch_item', 'priority_geography', 'priority_sport'
  )),
  label text not null,
  detail text,
  related_entity_id uuid references public.entities(id) on delete set null,
  business_unit_id uuid references public.business_units(id) on delete set null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists context_items_ws_kind_idx on public.context_items(workspace_id, kind, status);

-- ---------------------------------------------------------------------------
-- Runs: orchestration, progress, retries, crash recovery
-- ---------------------------------------------------------------------------

create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('brief', 'research', 'ask', 'ingest', 'report')),
  format_id uuid references public.brief_formats(id) on delete set null,
  prompt_version_id uuid references public.prompt_versions(id) on delete set null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  run_date date,
  -- Every date/window in here is computed by code, never by the model.
  run_variables jsonb not null default '{}'::jsonb,
  input jsonb not null default '{}'::jsonb,
  model text,
  -- Replay protection: the same logical request can never create a second run.
  idempotency_key text not null,
  attempt integer not null default 0,
  max_attempts integer not null default 3,
  progress integer not null default 0 check (progress between 0 and 100),
  current_stage text,
  stage_count integer,
  error text,
  error_detail jsonb,
  is_mock boolean not null default false,
  -- Worker lease. A crashed worker's lease expires and the run is reclaimed
  -- rather than being stuck in `running` forever.
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  queue_msg_id bigint,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);
create index if not exists runs_ws_status_idx on public.runs(workspace_id, status);
create index if not exists runs_ws_created_idx on public.runs(workspace_id, created_at desc);
create index if not exists runs_lease_idx on public.runs(status, lease_expires_at);

create table if not exists public.run_stages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null references public.runs(id) on delete cascade,
  seq integer not null,
  stage text not null,
  label text,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  progress integer not null default 0,
  -- Set once the stage produced a durable result. A resumed run skips every
  -- stage that is already `succeeded` instead of re-paying for it.
  output jsonb,
  input_summary jsonb,
  -- Long research runs are created as background provider responses; the id is
  -- stored so a restarted worker resumes polling the same response.
  provider_response_id text,
  provider_status text,
  tokens_in integer,
  tokens_out integer,
  web_searches integer,
  duration_ms integer,
  cost_usd numeric(12, 6),
  cost_is_estimate boolean not null default true,
  attempt integer not null default 0,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, seq)
);
create index if not exists run_stages_run_idx on public.run_stages(run_id, seq);

create table if not exists public.run_events (
  id bigserial primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null references public.runs(id) on delete cascade,
  level text not null default 'info' check (level in ('debug', 'info', 'warn', 'error')),
  stage text,
  message text not null,
  data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists run_events_run_idx on public.run_events(run_id, id desc);

-- ---------------------------------------------------------------------------
-- Brief output
-- ---------------------------------------------------------------------------

create table if not exists public.brief_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid references public.runs(id) on delete set null,
  format_id uuid not null references public.brief_formats(id) on delete cascade,
  prompt_version_id uuid references public.prompt_versions(id) on delete set null,
  upload_id uuid,
  title text not null,
  run_date date,
  coverage_start timestamptz,
  coverage_end timestamptz,
  body_md text not null,
  output_mode text,
  -- QA status is the format's own release gate. It is NOT user approval of any
  -- database record: those are separate and tracked on proposals.
  qa_status text check (qa_status in (
    'pass_internal_only', 'pass_quiet_window_internal_only',
    'review_internal_only', 'fail_do_not_distribute', 'not_run'
  )),
  qa_checks jsonb not null default '[]'::jsonb,
  qa_notes text,
  structured jsonb not null default '{}'::jsonb,
  gaps jsonb not null default '[]'::jsonb,
  origin text not null default 'generated'
    check (origin in ('generated', 'uploaded')),
  is_mock boolean not null default false,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists brief_documents_ws_date_idx on public.brief_documents(workspace_id, run_date desc);
create index if not exists brief_documents_format_idx on public.brief_documents(format_id);

create table if not exists public.brief_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brief_document_id uuid not null references public.brief_documents(id) on delete cascade,
  url text,
  title text,
  publisher text,
  source_tier text check (source_tier in ('tier1_primary', 'tier2_independent', 'tier3_supporting', 'unknown')),
  published_at date,
  accessed_at timestamptz,
  freshness_label text,
  is_press_release boolean not null default false,
  verification_state text not null default 'unverified'
    check (verification_state in ('unverified', 'url_valid', 'url_invalid', 'corroborated', 'flagged')),
  verification_note text,
  evidence_id uuid references public.evidence(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists brief_sources_doc_idx on public.brief_sources(brief_document_id);

-- Research topics proposed from a brief's gaps. The user selects which ones to
-- deep-research; nothing is researched silently.
create table if not exists public.research_topics (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brief_document_id uuid references public.brief_documents(id) on delete set null,
  run_id uuid references public.runs(id) on delete set null,
  label text not null,
  target_type text not null default 'topic'
    check (target_type in ('person', 'company', 'project', 'topic', 'opportunity', 'event', 'institution')),
  -- People, companies and projects are explicit research targets, and an
  -- unresolved one is surfaced rather than dropped.
  resolution_status text not null default 'not_found'
    check (resolution_status in ('existing', 'possible_match', 'ambiguous', 'not_found')),
  matched_entity_id uuid references public.entities(id) on delete set null,
  candidate_matches jsonb not null default '[]'::jsonb,
  priority text not null default 'medium' check (priority in ('high', 'medium', 'low', 'skip')),
  business_unit_id uuid references public.business_units(id) on delete set null,
  research_question text,
  why_useful text,
  selected boolean not null default false,
  status text not null default 'proposed'
    check (status in ('proposed', 'selected', 'researching', 'researched', 'captured', 'dismissed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists research_topics_ws_status_idx on public.research_topics(workspace_id, status);
create index if not exists research_topics_doc_idx on public.research_topics(brief_document_id);

-- ---------------------------------------------------------------------------
-- Uploads (MD / PDF / ZIP)
-- ---------------------------------------------------------------------------

create table if not exists public.uploads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  batch_id uuid,
  parent_upload_id uuid references public.uploads(id) on delete cascade,
  filename text not null,
  -- Path inside the archive, for files extracted from a ZIP.
  archive_path text,
  mime_type text,
  byte_size bigint,
  kind text not null check (kind in ('md', 'pdf', 'zip', 'other')),
  storage_path text,
  checksum text,
  status text not null default 'pending'
    check (status in ('pending', 'queued', 'processing', 'parsed', 'failed', 'skipped', 'rejected')),
  status_detail text,
  document_count integer not null default 0,
  page_count integer,
  run_id uuid references public.runs(id) on delete set null,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists uploads_ws_created_idx on public.uploads(workspace_id, created_at desc);
create index if not exists uploads_batch_idx on public.uploads(batch_id);
create index if not exists uploads_parent_idx on public.uploads(parent_upload_id);

-- One uploaded file can contain several briefs or dossiers.
create table if not exists public.upload_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  upload_id uuid not null references public.uploads(id) on delete cascade,
  seq integer not null default 1,
  title text not null,
  doc_type text not null default 'other' check (doc_type in ('brief', 'dossier', 'other')),
  detected_format_key text,
  detected_run_date date,
  body_md text not null,
  char_count integer,
  brief_document_id uuid references public.brief_documents(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists upload_documents_upload_idx on public.upload_documents(upload_id, seq);

-- ---------------------------------------------------------------------------
-- Proposals: exact proposed changes, partial approval, transactional apply
-- ---------------------------------------------------------------------------

create table if not exists public.proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid references public.runs(id) on delete set null,
  source_kind text not null check (source_kind in ('brief', 'research', 'upload', 'manual')),
  brief_document_id uuid references public.brief_documents(id) on delete set null,
  upload_id uuid references public.uploads(id) on delete set null,
  title text not null,
  summary text,
  status text not null default 'draft' check (status in (
    'draft', 'pending_review', 'partially_applied', 'applied', 'rejected', 'superseded'
  )),
  -- Bumped on every edit. An approval is only valid for the exact version and
  -- content hash it was given for.
  version integer not null default 1,
  content_hash text not null,
  is_mock boolean not null default false,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists proposals_ws_status_idx on public.proposals(workspace_id, status);
create index if not exists proposals_run_idx on public.proposals(run_id);

create table if not exists public.proposal_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  proposal_id uuid not null references public.proposals(id) on delete cascade,
  seq integer not null,
  op text not null check (op in ('create', 'update', 'link', 'attach', 'skip')),
  target_table text not null,
  -- Set for update/link/attach: the row that will change.
  target_id uuid,
  -- Resolution outcome. `ambiguous` must be shown to the user and can never be
  -- auto-merged: a similar name is not sufficient to merge.
  match_status text not null default 'new'
    check (match_status in ('new', 'existing', 'ambiguous')),
  candidates jsonb not null default '[]'::jsonb,
  label text not null,
  claim_type text check (claim_type in ('fact', 'inference', 'recommendation', 'next_step', 'gap', 'risk')),
  confidence text,
  reason text,
  -- Exact old/new values for every field the apply step will write.
  new_values jsonb not null default '{}'::jsonb,
  old_values jsonb,
  edited_values jsonb,
  was_edited boolean not null default false,
  provenance jsonb not null default '{}'::jsonb,
  evidence_ref jsonb,
  -- Items applied together in one transaction share a group.
  apply_group integer not null default 1,
  depends_on_seq integer[] not null default '{}',
  decision text not null default 'pending'
    check (decision in ('pending', 'approved', 'rejected')),
  decided_by uuid references public.app_users(id) on delete set null,
  decided_at timestamptz,
  applied_at timestamptz,
  applied_row_id uuid,
  apply_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (proposal_id, seq)
);
create index if not exists proposal_items_proposal_idx on public.proposal_items(proposal_id, seq);
create index if not exists proposal_items_decision_idx on public.proposal_items(proposal_id, decision);

-- An approval is recorded against a specific proposal version + content hash.
create table if not exists public.proposal_approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  proposal_id uuid not null references public.proposals(id) on delete cascade,
  proposal_version integer not null,
  content_hash text not null,
  item_ids uuid[] not null,
  approved_by uuid not null references public.app_users(id) on delete restrict,
  approved_at timestamptz not null default now(),
  -- Set when a later edit invalidates this approval.
  revoked_at timestamptz,
  revoked_reason text
);
create index if not exists proposal_approvals_proposal_idx on public.proposal_approvals(proposal_id);

-- Audit of what the server actually wrote. The unique constraint on
-- proposal_item_id is the duplicate guard: a repeated apply request cannot
-- write the same item twice.
create table if not exists public.applied_changes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  proposal_id uuid not null references public.proposals(id) on delete cascade,
  proposal_item_id uuid not null references public.proposal_items(id) on delete cascade,
  approval_id uuid references public.proposal_approvals(id) on delete set null,
  table_name text not null,
  row_id uuid not null,
  op text not null,
  before_values jsonb,
  after_values jsonb,
  -- Values re-read from the database after the write.
  readback_values jsonb,
  readback_ok boolean,
  readback_note text,
  applied_by uuid not null references public.app_users(id) on delete restrict,
  applied_at timestamptz not null default now(),
  unique (proposal_item_id)
);
create index if not exists applied_changes_ws_applied_idx on public.applied_changes(workspace_id, applied_at desc);
create index if not exists applied_changes_proposal_idx on public.applied_changes(proposal_id);
create index if not exists applied_changes_row_idx on public.applied_changes(table_name, row_id);

-- ---------------------------------------------------------------------------
-- Ask Knowledge
-- ---------------------------------------------------------------------------

create table if not exists public.ask_threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ask_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  thread_id uuid not null references public.ask_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  -- Every answer cites the saved records it came from.
  citations jsonb not null default '[]'::jsonb,
  retrieved jsonb,
  is_mock boolean not null default false,
  cost_usd numeric(12, 6),
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists ask_messages_thread_idx on public.ask_messages(thread_id, created_at);

-- ---------------------------------------------------------------------------
-- Cost accounting, budgets, activity, reports
-- ---------------------------------------------------------------------------

create table if not exists public.usage_events (
  id bigserial primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid references public.runs(id) on delete set null,
  run_stage_id uuid references public.run_stages(id) on delete set null,
  stage text,
  provider text not null default 'openai',
  model text,
  operation text,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  reasoning_tokens integer not null default 0,
  cached_tokens integer not null default 0,
  web_searches integer not null default 0,
  duration_ms integer,
  cost_usd numeric(12, 6) not null default 0,
  -- False only when the provider reported real usage AND a price is known for
  -- the model. Otherwise the UI must show the figure as an estimate.
  is_estimate boolean not null default true,
  is_mock boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists usage_events_ws_created_idx on public.usage_events(workspace_id, created_at desc);
create index if not exists usage_events_run_idx on public.usage_events(run_id);

create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  period text not null check (period in ('day', 'month')),
  limit_usd numeric(12, 2) not null,
  -- true: block new runs once exceeded. false: warn only.
  hard_stop boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, period)
);

create table if not exists public.activity_log (
  id bigserial primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_id uuid references public.app_users(id) on delete set null,
  actor_kind text not null default 'user' check (actor_kind in ('user', 'worker', 'system')),
  action text not null,
  subject_table text,
  subject_id uuid,
  summary text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists activity_log_ws_created_idx on public.activity_log(workspace_id, created_at desc);

create table if not exists public.daily_reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  report_date date not null,
  body_md text not null,
  storage_path text,
  change_count integer not null default 0,
  generated_at timestamptz not null default now(),
  unique (workspace_id, report_date)
);

do $$
declare t text;
begin
  foreach t in array array[
    'workspaces','app_users','workspace_members','brief_formats','context_items',
    'runs','run_stages','brief_documents','research_topics','uploads',
    'proposals','proposal_items','ask_threads','budgets'
  ] loop
    execute format('drop trigger if exists set_%1$s_updated_at on public.%1$I', t);
    execute format(
      'create trigger set_%1$s_updated_at before update on public.%1$I
         for each row execute function public.set_updated_at()', t);
  end loop;
end $$;
