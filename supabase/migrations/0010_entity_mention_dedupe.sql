-- 0010 One pending mention per name per workspace.
--
-- entity_mentions is a staging area for names that could not be resolved. It
-- should hold one pending row per name, updated as the name is seen again --
-- not one row per run. Without a constraint, every brief re-staged the same
-- unresolved name and the Knowledge screen filled with duplicates of it.
--
-- Collapses existing duplicates into the oldest row, then enforces uniqueness.

with ranked as (
  select id, workspace_id, mention_slug,
         row_number() over (
           partition by workspace_id, mention_slug
           order by created_at, id
         ) as rn
    from public.entity_mentions
   where resolution_status = 'pending'
)
delete from public.entity_mentions m
 using ranked r
 where m.id = r.id and r.rn > 1;

-- Partial, because a name may legitimately appear again after an earlier
-- mention has been resolved or dismissed.
create unique index if not exists entity_mentions_pending_unique
  on public.entity_mentions (workspace_id, mention_slug)
  where resolution_status = 'pending';
