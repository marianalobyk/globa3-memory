import Link from 'next/link';
import { ClipboardCheck } from 'lucide-react';
import { withUser } from '@g3/core';
import { requirePageSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/states';
import { ProposalStatusBadge } from '@/components/status';
import { formatRelative } from '@/lib/utils';

export const dynamic = 'force-dynamic';

interface ProposalRow {
  id: string;
  title: string;
  summary: string | null;
  status: string;
  version: number;
  source_kind: string;
  is_mock: boolean;
  created_at: string;
  item_count: number;
  pending_count: number;
  approved_count: number;
  applied_count: number;
  ambiguous_count: number;
  brief_title: string | null;
  format_name: string | null;
}

export default async function ReviewPage() {
  const session = await requirePageSession();
  const workspaceId = session.activeWorkspace.workspaceId;

  const proposals = await withUser(session.user.id, (db) =>
    db.rows<ProposalRow>(
      `select p.id, p.title, p.summary, p.status, p.version, p.source_kind, p.is_mock, p.created_at,
              b.title as brief_title, f.name as format_name,
              (select count(*)::int from public.proposal_items i where i.proposal_id = p.id) as item_count,
              (select count(*)::int from public.proposal_items i
                where i.proposal_id = p.id and i.decision = 'pending' and i.applied_at is null) as pending_count,
              (select count(*)::int from public.proposal_items i
                where i.proposal_id = p.id and i.decision = 'approved' and i.applied_at is null) as approved_count,
              (select count(*)::int from public.proposal_items i
                where i.proposal_id = p.id and i.applied_at is not null) as applied_count,
              (select count(*)::int from public.proposal_items i
                where i.proposal_id = p.id and i.match_status = 'ambiguous') as ambiguous_count
         from public.proposals p
         left join public.brief_documents b on b.id = p.brief_document_id
         left join public.brief_formats f on f.id = b.format_id
        where p.workspace_id = $1
        order by case p.status when 'pending_review' then 0 when 'partially_applied' then 1 else 2 end,
                 p.created_at desc
        limit 80`,
      [workspaceId],
    ),
  );

  const needsAttention = proposals.filter(
    (p) => p.status === 'pending_review' || p.status === 'partially_applied',
  );
  const settled = proposals.filter(
    (p) => p.status !== 'pending_review' && p.status !== 'partially_applied',
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Review</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every proposed change to the knowledge base, with its exact old and new values. Nothing is
          written until you approve it here.
        </p>
        {!session.activeWorkspace.canApprove ? (
          <p className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            You can read proposals but not approve them in this workspace.
          </p>
        ) : null}
      </div>

      {needsAttention.length === 0 && settled.length === 0 ? (
        <EmptyState
          icon={<ClipboardCheck className="size-5" />}
          title="Nothing to review"
          description="Proposals appear here after a research run, or after capturing from an uploaded brief or dossier. Start from a brief and choose topics to research."
        />
      ) : null}

      {needsAttention.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Needs your decision</h2>
          <ul className="space-y-2">
            {needsAttention.map((proposal) => (
              <ProposalCard key={proposal.id} proposal={proposal} />
            ))}
          </ul>
        </section>
      ) : null}

      {settled.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Settled</h2>
          <ul className="space-y-2">
            {settled.map((proposal) => (
              <ProposalCard key={proposal.id} proposal={proposal} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ProposalCard({ proposal }: { proposal: ProposalRow }) {
  return (
    <li>
      <Link
        href={`/review/${proposal.id}`}
        className="block rounded-lg border p-4 transition-colors hover:bg-accent/40"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">{proposal.title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {proposal.format_name ? `${proposal.format_name} · ` : ''}
              {proposal.brief_title ? `${proposal.brief_title} · ` : ''}
              from {proposal.source_kind} · v{proposal.version} · {formatRelative(proposal.created_at)}
            </p>
            {proposal.summary ? (
              <p className="mt-1 text-sm text-muted-foreground">{proposal.summary}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {proposal.is_mock ? <Badge variant="warning">Mock</Badge> : null}
            <ProposalStatusBadge status={proposal.status} />
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
          <Badge variant="outline">{proposal.item_count} proposed</Badge>
          {proposal.pending_count > 0 ? (
            <Badge variant="secondary">{proposal.pending_count} pending</Badge>
          ) : null}
          {proposal.approved_count > 0 ? (
            <Badge variant="default">{proposal.approved_count} approved, not applied</Badge>
          ) : null}
          {proposal.applied_count > 0 ? (
            <Badge variant="success">{proposal.applied_count} applied</Badge>
          ) : null}
          {proposal.ambiguous_count > 0 ? (
            <Badge variant="warning">{proposal.ambiguous_count} ambiguous</Badge>
          ) : null}
        </div>
      </Link>
    </li>
  );
}
