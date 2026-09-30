-- 0022 A finding can cite more than one source.
--
-- The problem
--   `research_findings.evidence_id` is single-valued. A finding can therefore
--   name exactly one source, which is wrong for the thing research actually
--   produces: "Rumesh Tharanga won javelin gold" is supported by the Asian
--   Games result page AND the federation announcement AND the news report.
--
--   The same limitation already cost something real. During the legacy
--   migration, ten `evidence` rows -- cited URLs captured during September
--   research -- supported nothing reachable, because the findings they belonged
--   to had already spent their one `evidence_id` on a different source. There
--   was no honest way to attach them, so they were removed (0020).
--
-- What this does
--   Adds an explicit join, `research_finding_evidence`, so a finding can cite
--   every source it rests on, each with its role.
--
--   `research_findings.evidence_id` is KEPT and keeps its meaning: the source
--   the finding was written from. Dropping it would break the readback, the
--   apply engine, the proposal schema and the integrity proof that every
--   finding cites evidence or an artifact. The join table is additive, and the
--   backfill copies each existing `evidence_id` in as the `primary` row, so the
--   join table alone can answer "every source behind this finding" without a
--   caller having to remember to union the two.
--
--   Nothing is duplicated into a text field and no finding is cloned to
--   simulate multiple sources.
--
-- Safety
--   Additive only: no column is dropped or retyped, no row is deleted. The
--   backfill is idempotent (`on conflict do nothing`), so re-running changes
--   nothing. Scoping, RLS and grants match the production model exactly: a
--   knowledge table is SELECT-only for `authenticated` and writable only by the
--   server's `service_role`.

-- ---------------------------------------------------------------------------
-- research_findings needs (id, workspace_id) unique before anything can carry a
-- composite foreign key to it. 0006 created these for the parents it knew
-- about; research_findings was not one of them.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    alter table public.research_findings
      add constraint research_findings_id_workspace_key unique (id, workspace_id);
  exception
    when duplicate_table or duplicate_object then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- The join
-- ---------------------------------------------------------------------------
create table if not exists public.research_finding_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  finding_id uuid not null references public.research_findings(id) on delete cascade,
  evidence_id uuid not null references public.evidence(id) on delete cascade,
  -- 'primary': the source the finding was written from, mirroring
  -- research_findings.evidence_id. 'supporting': a source that corroborates it.
  role text not null default 'supporting' check (role in ('primary', 'supporting')),
  /** Where in the source this rests, when the research names it. */
  locator text,
  created_at timestamptz not null default now(),
  unique (finding_id, evidence_id)
);

create index if not exists research_finding_evidence_finding_idx
  on public.research_finding_evidence(finding_id);
create index if not exists research_finding_evidence_evidence_idx
  on public.research_finding_evidence(evidence_id);
create index if not exists research_finding_evidence_workspace_idx
  on public.research_finding_evidence(workspace_id);

-- Composite foreign keys, so a row cannot point at a finding or a source in
-- another workspace. Structural, not merely disallowed by policy -- the same
-- guarantee 0006 gave every other reference.
do $$
begin
  begin
    alter table public.research_finding_evidence
      add constraint research_finding_evidence_finding_ws_fkey
      foreign key (finding_id, workspace_id)
      references public.research_findings(id, workspace_id)
      match simple on update no action on delete no action;
  exception
    when duplicate_object then null;
  end;
  begin
    alter table public.research_finding_evidence
      add constraint research_finding_evidence_evidence_ws_fkey
      foreign key (evidence_id, workspace_id)
      references public.evidence(id, workspace_id)
      match simple on update no action on delete no action;
  exception
    when duplicate_object then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Backfill: every source a finding already names becomes its primary citation.
-- ---------------------------------------------------------------------------
insert into public.research_finding_evidence (workspace_id, finding_id, evidence_id, role)
select f.workspace_id, f.id, f.evidence_id, 'primary'
  from public.research_findings f
 where f.evidence_id is not null
on conflict (finding_id, evidence_id) do nothing;

-- ---------------------------------------------------------------------------
-- RLS and grants: a knowledge table. Readable by a member of its workspace,
-- writable only by the server.
-- ---------------------------------------------------------------------------
alter table public.research_finding_evidence enable row level security;

drop policy if exists research_finding_evidence_member_select on public.research_finding_evidence;
create policy research_finding_evidence_member_select
  on public.research_finding_evidence
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

grant select on public.research_finding_evidence to authenticated;
grant all on public.research_finding_evidence to service_role;
revoke insert, update, delete, truncate, references, trigger
  on public.research_finding_evidence from authenticated;
revoke all on public.research_finding_evidence from anon;
