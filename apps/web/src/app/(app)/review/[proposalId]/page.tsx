import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getProposal, readbackProposal, withUser } from '@g3/core';
import { requirePageSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MockBanner } from '@/components/states';
import { ProposalStatusBadge } from '@/components/status';
import { ProposalReview } from '@/components/proposal-review';
import { formatDateTime } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function ProposalPage({
  params,
}: {
  params: Promise<{ proposalId: string }>;
}) {
  const session = await requirePageSession();
  const workspaceId = session.activeWorkspace.workspaceId;
  const { proposalId } = await params;

  const data = await withUser(session.user.id, async (db) => {
    const loaded = await getProposal(db, workspaceId, proposalId).catch(() => null);
    if (!loaded) return null;

    const readback = await readbackProposal(db, workspaceId, proposalId);
    const approvals = await db.rows<{
      id: string;
      proposal_version: number;
      item_ids: string[];
      approved_at: string;
      revoked_at: string | null;
      revoked_reason: string | null;
      email: string | null;
    }>(
      `select a.id, a.proposal_version, a.item_ids, a.approved_at, a.revoked_at,
              a.revoked_reason, u.email
         from public.proposal_approvals a
         left join public.app_users u on u.id = a.approved_by
        where a.workspace_id = $1 and a.proposal_id = $2
        order by a.approved_at desc`,
      [workspaceId, proposalId],
    );
    const brief = loaded.proposal.brief_document_id
      ? await db.one<{ id: string; title: string; run_date: string | null }>(
          `select id, title, run_date from public.brief_documents where workspace_id = $1 and id = $2`,
          [workspaceId, loaded.proposal.brief_document_id],
        )
      : null;

    return { ...loaded, readback, approvals, brief };
  });

  if (!data) notFound();
  const { proposal, items, readback, approvals, brief } = data;

  const liveApproval = approvals.find(
    (a) => a.revoked_at === null && a.proposal_version === proposal.version,
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/review">
            <ArrowLeft />
            All proposals
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">{proposal.title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Version {proposal.version} · from {proposal.source_kind} ·{' '}
              {formatDateTime(proposal.created_at)}
            </p>
            {proposal.summary ? (
              <p className="mt-1.5 text-sm text-muted-foreground">{proposal.summary}</p>
            ) : null}
            {brief ? (
              <p className="mt-1.5 text-sm">
                From brief{' '}
                <Link
                  href={`/briefs/${brief.id}`}
                  className="font-medium underline underline-offset-2"
                >
                  {brief.title}
                </Link>
                {brief.run_date ? ` (${brief.run_date})` : ''}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {proposal.is_mock ? <Badge variant="warning">Mock</Badge> : null}
            <ProposalStatusBadge status={proposal.status} />
          </div>
        </div>
      </div>

      {proposal.is_mock ? <MockBanner scope="these proposed changes" /> : null}

      <ProposalReview
        proposalId={proposal.id}
        version={proposal.version}
        contentHash={proposal.content_hash}
        status={proposal.status}
        items={items.map((item) => ({
          id: item.id,
          seq: item.seq,
          op: item.op,
          targetTable: item.target_table,
          targetId: item.target_id,
          matchStatus: item.match_status,
          candidates: item.candidates as never,
          label: item.label,
          claimType: item.claim_type,
          confidence: item.confidence,
          reason: item.reason,
          newValues: item.new_values,
          oldValues: item.old_values,
          editedValues: item.edited_values,
          wasEdited: item.was_edited,
          provenance: item.provenance as Record<string, unknown>,
          dependsOnSeq: item.depends_on_seq,
          decision: item.decision,
          appliedAt: item.applied_at,
          appliedRowId: item.applied_row_id,
          applyError: item.apply_error,
        }))}
        canApprove={session.activeWorkspace.canApprove}
        readback={readback.map((entry) => ({
          table: entry.table,
          rowId: entry.rowId,
          label: entry.label,
          op: entry.op,
          readbackOk: entry.readbackOk,
          appliedAt: entry.appliedAt,
          appliedByEmail: entry.appliedByEmail,
          current: entry.current,
        }))}
        approvals={approvals.map((a) => ({
          id: a.id,
          version: a.proposal_version,
          itemCount: a.item_ids.length,
          approvedAt: a.approved_at,
          approvedByEmail: a.email,
          revokedAt: a.revoked_at,
          revokedReason: a.revoked_reason,
        }))}
        hasLiveApproval={Boolean(liveApproval)}
      />
    </div>
  );
}
