import { withUserRead } from '@g3/core';
import { handler, ok } from '@/lib/api';
import { loadProposalView } from '@/lib/capture-view';
import { displayLabel, proposalSourceLabel } from '@/lib/labels';
import { requireApiSession } from '@/lib/session';

/**
 * The Review inbox: captures waiting for confirmation, newest first. Each row
 * is the same human summary the review opens with -- who, one line, where it
 * stands -- never counts of records.
 */
export const GET = handler(async () => {
  const session = await requireApiSession();
  const workspaceId = session.activeWorkspace.workspaceId;
  const rows = await withUserRead(session.user.id, (db) =>
    db.rows<{
      id: string;
      title: string;
      source_kind: string;
      is_mock: boolean;
      created_at: string;
      awaiting: number;
      saved: number;
    }>(
      `select p.id, p.title, p.source_kind, p.is_mock, p.created_at,
              count(*) filter (where i.decision = 'pending' and i.applied_at is null)::int as awaiting,
              count(*) filter (where i.applied_at is not null)::int as saved
         from public.proposals p
         join public.proposal_items i on i.proposal_id = p.id
        where p.workspace_id = $1 and p.status in ('pending_review', 'partially_applied')
        group by p.id
       having count(*) filter (where i.decision in ('pending', 'approved') and i.applied_at is null) > 0
        order by p.created_at desc
        limit 30`,
      [workspaceId],
    ),
  );
  // A few at a time: each summary is a handful of small reads.
  const summaries = new Map<string, Awaited<ReturnType<typeof loadProposalView>>>();
  for (let i = 0; i < rows.length; i += 4) {
    const batch = rows.slice(i, i + 4);
    const views = await Promise.all(batch.map((row) => loadProposalView(session, row.id).catch(() => null)));
    batch.forEach((row, index) => summaries.set(row.id, views[index] ?? null));
  }
  return ok({
    proposals: rows.map((row) => {
      const confirmation = summaries.get(row.id)?.confirmation ?? null;
      return {
        proposalId: row.id,
        title: displayLabel(row.title),
        name: confirmation?.contact?.name ?? displayLabel(row.title),
        summary: confirmation?.summary ?? null,
        status: confirmation?.status ?? 'ready',
        statusLabel: confirmation?.statusLabel ?? 'Ready to review',
        sourceLabel: proposalSourceLabel(row.source_kind),
        awaiting: row.awaiting,
        saved: row.saved,
        createdAt: row.created_at,
        isMock: row.is_mock,
      };
    }),
  });
});
