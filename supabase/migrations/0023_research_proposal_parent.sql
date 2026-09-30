-- 0023 A research result knows which capture it came from.
--
-- Why
--   Selecting a research question on a capture review starts a research run,
--   and that run produces its own proposal: source-backed facts, readings,
--   gaps, risks. That proposal has to be reviewed separately -- research
--   results must never be mixed into, or double-counted with, the capture's own
--   records -- but it is meaningless on its own. It needs to point back at the
--   capture proposal that asked the question.
--
--   `proposals` already carries `run_id`, `brief_document_id` and `upload_id`,
--   so the shape is familiar: one more nullable pointer, not a new workflow
--   table.
--
-- What this does
--   Adds `proposals.parent_proposal_id`, self-referencing and nullable. Every
--   existing proposal keeps a null parent, which is correct: nothing before
--   this migration was derived from another proposal.
--
-- Cross-workspace safety
--   A composite foreign key `(parent_proposal_id, workspace_id) ->
--   proposals(id, workspace_id)`, the same device 0006 used everywhere else.
--   A proposal in one workspace cannot name a parent in another -- not by
--   policy, but because the row will not insert. A self-reference is refused
--   too: a proposal cannot be its own parent.
--
-- Additive only: no column dropped or retyped, no row changed, no privilege
-- widened. `proposals` already has RLS and its grants from 0007/0018; a new
-- nullable column inherits them, so nothing here touches either.

-- ---------------------------------------------------------------------------
-- (id, workspace_id) must be unique before anything can reference it that way.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    alter table public.proposals
      add constraint proposals_id_workspace_key unique (id, workspace_id);
  exception
    when duplicate_table or duplicate_object then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- The parent pointer
-- ---------------------------------------------------------------------------
alter table public.proposals
  add column if not exists parent_proposal_id uuid references public.proposals(id) on delete set null;

do $$
begin
  -- Workspace-aware: the parent must live in the same workspace as the child.
  begin
    alter table public.proposals
      add constraint proposals_parent_workspace_fkey
      foreign key (parent_proposal_id, workspace_id)
      references public.proposals(id, workspace_id)
      match simple on update no action on delete no action;
  exception
    when duplicate_object then null;
  end;

  -- A proposal cannot be its own parent.
  begin
    alter table public.proposals
      add constraint proposals_parent_not_self
      check (parent_proposal_id is null or parent_proposal_id <> id);
  exception
    when duplicate_object then null;
  end;
end $$;

create index if not exists proposals_parent_idx
  on public.proposals(parent_proposal_id)
  where parent_proposal_id is not null;
