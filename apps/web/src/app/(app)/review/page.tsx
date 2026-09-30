import Link from 'next/link';
import { proposalSourceLabel } from '@/lib/labels';
import { ClipboardCheck } from 'lucide-react';
import { requirePageSession } from '@/lib/session';
import { loadReviewData, type ProposalRow } from '@/lib/page-data';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/states';
import { ProposalStatusBadge } from '@/components/status';
import { formatRelative } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  const session = await requirePageSession();
  const workspaceId = session.activeWorkspace.workspaceId;

  const proposals = await loadReviewData(session);

  const needsAttention = proposals.filter(
    (p) => p.status === 'pending_review' || p.status === 'partially_applied',
  );
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Review</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Changes proposed for knowledge, shown record by record. Nothing is saved until you approve
          it here.
        </p>
        {!session.activeWorkspace.canApprove ? (
          <p className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            You can read proposals but not approve them in this workspace.
          </p>
        ) : null}
      </div>

      {needsAttention.length === 0 ? (
        <EmptyState
          icon={<ClipboardCheck className="size-5" />}
          title="Nothing to review"
          description="New proposed records appear here after a capture is analysed. Completed and discarded reviews stay in Activity."
        />
      ) : null}

      {needsAttention.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Awaiting review</h2>
          <ul className="space-y-2">
            {needsAttention.map((proposal) => (
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
              {proposalSourceLabel(proposal.source_kind)} · {formatRelative(proposal.created_at)}
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
          <Badge variant="outline">{proposal.item_count} changes</Badge>
          {proposal.pending_count > 0 ? (
            <Badge variant="warning">{proposal.pending_count} awaiting review</Badge>
          ) : null}
          {proposal.approved_count > 0 ? (
            <Badge variant="default">{proposal.approved_count} approved, not saved</Badge>
          ) : null}
          {proposal.applied_count > 0 ? (
            <Badge variant="success">{proposal.applied_count} saved</Badge>
          ) : null}
          {proposal.ambiguous_count > 0 ? (
            <Badge variant="outline">{proposal.ambiguous_count} possible duplicates</Badge>
          ) : null}
        </div>
      </Link>
    </li>
  );
}
