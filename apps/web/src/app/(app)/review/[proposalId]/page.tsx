import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, FileText, Link2, Lock, Paperclip, Pencil } from 'lucide-react';
import { captureForProposal, getProposal, readbackProposal, withUser } from '@g3/core';
import { requirePageSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MockBanner } from '@/components/states';
import { ProposalStatusBadge } from '@/components/status';
import { ProposalReview } from '@/components/proposal-review';
import { loadProposalView } from '@/lib/capture-view';
import { formatDateTime } from '@/lib/utils';
import { proposalSourceLabel } from '@/lib/labels';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    // A capture-sourced proposal is read next to the note it came from.
    const capture = await captureForProposal(db, workspaceId, proposalId);
    const brief = loaded.proposal.brief_document_id
      ? await db.one<{ id: string; title: string; run_date: string | null }>(
          `select id, title, run_date from public.brief_documents where workspace_id = $1 and id = $2`,
          [workspaceId, loaded.proposal.brief_document_id],
        )
      : null;

    // The supersede chain, so a refused proposal and its replacement are
    // reachable from each other instead of looking like two unrelated rows.
    const chain = await db.one<{
      supersedes_proposal_id: string | null;
      superseded_by_proposal_id: string | null;
      superseded_reason: string | null;
      supersedes_title: string | null;
      superseded_by_title: string | null;
    }>(
      `select p.supersedes_proposal_id, p.superseded_by_proposal_id, p.superseded_reason,
              prev.title as supersedes_title, next.title as superseded_by_title
         from public.proposals p
         left join public.proposals prev on prev.id = p.supersedes_proposal_id
         left join public.proposals next on next.id = p.superseded_by_proposal_id
        where p.workspace_id = $1 and p.id = $2`,
      [workspaceId, proposalId],
    );

    // Linked records are shown by name, never by id. Collect every id the items
    // and the readback point at, and resolve them in one read under the user's
    // own access rules; an id the user cannot read simply stays unnamed.
    const ids = new Set<string>();
    const collect = (values: Record<string, unknown> | null | undefined) => {
      for (const [key, value] of Object.entries(values ?? {})) {
        if (key.endsWith('_id') && typeof value === 'string' && UUID.test(value)) ids.add(value);
      }
    };
    for (const item of loaded.items) {
      collect(item.new_values);
      collect(item.old_values);
      collect(item.edited_values);
      if (item.target_id) ids.add(item.target_id);
    }
    for (const entry of readback) collect(entry.current);
    const refNames = ids.size
      ? await db.rows<{ id: string; name: string | null }>(
          `select id::text, display_name as name from public.entities where workspace_id = $1 and id = any($2::uuid[])
           union all select id::text, name from public.business_units where workspace_id = $1 and id = any($2::uuid[])
           union all select id::text, title from public.evidence where workspace_id = $1 and id = any($2::uuid[])
           union all select id::text, title from public.research_artifacts where workspace_id = $1 and id = any($2::uuid[])
           union all select id::text, title from public.signals where workspace_id = $1 and id = any($2::uuid[])
           union all select id::text, full_name from public.members where workspace_id = $1 and id = any($2::uuid[])`,
          [workspaceId, [...ids]],
        )
      : [];

    return { ...loaded, readback, approvals, brief, capture, chain, refNames };
  });

  if (!data) notFound();
  const { proposal, items, readback, approvals, brief, capture, chain, refNames } = data;

  // The summary supplies capture-specific defaults for the record selector.
  // The records themselves remain the primary review surface on the web.
  const view = capture ? await loadProposalView(session, proposalId) : null;
  const confirmation = view?.confirmation ?? null;

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
              {confirmation
                ? `From a capture · ${formatDateTime(proposal.created_at)}`
                : `${items.length} proposed change${items.length === 1 ? '' : 's'} · ${proposalSourceLabel(proposal.source_kind).toLowerCase()} · ${formatDateTime(proposal.created_at)}`}
            </p>
            {proposal.summary && !confirmation ? (
              <p className="mt-1.5 text-sm text-muted-foreground">{proposal.summary}</p>
            ) : null}
            {brief ? (
              <p className="mt-1.5 text-sm">
                From an earlier brief: <span className="font-medium">{brief.title}</span>
                {brief.run_date ? ` (${brief.run_date})` : ''}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {proposal.is_mock ? <Badge variant="warning">Mock</Badge> : null}
            {proposal.status === 'rejected' ? (
              <Badge variant="secondary">Discarded</Badge>
            ) : confirmation ? (
              <Badge variant={confirmation.status === 'saved' ? 'success' : 'secondary'}>{confirmation.statusLabel}</Badge>
            ) : (
              <ProposalStatusBadge status={proposal.status} />
            )}
          </div>
        </div>
      </div>

      {confirmation && capture ? (
        <section className="rounded-lg border bg-muted/20 p-4" aria-labelledby="record-review">
          <h2 id="record-review" className="font-semibold">Choose what to save</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Each row below is a proposed record. Review it, keep the useful ones selected, and remove anything
            you do not want in memory.
          </p>
        </section>
      ) : null}

      {proposal.is_mock ? <MockBanner scope="these proposed changes" /> : null}

      <ProposalReview
        proposalId={proposal.id}
        version={proposal.version}
        contentHash={proposal.content_hash}
        status={proposal.status}
        sourceKind={proposal.source_kind}
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
        refNames={Object.fromEntries(refNames.filter((r) => r.name).map((r) => [r.id, r.name as string]))}
        defaultSelectedIds={confirmation?.save.itemIds}
        captureReview={Boolean(confirmation && capture)}
      />

      <TechnicalWrapper enabled={Boolean(confirmation)}>

      {capture ? (
        <section className="space-y-3 rounded-lg border bg-muted/20 p-4" aria-labelledby="review-source">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 id="review-source" className="text-sm font-semibold">
              The capture this came from
            </h2>
            <span className="text-xs text-muted-foreground">
              captured {formatDateTime(capture.captured_at)}
              {capture.captured_by_email ? ` by ${capture.captured_by_email}` : ''}
            </span>
          </div>

          {capture.body_text ? (
            <blockquote className="whitespace-pre-wrap border-l-2 pl-3 text-sm">{capture.body_text}</blockquote>
          ) : null}

          {capture.filename ? (
            <p className="flex items-center gap-2 text-sm">
              <Paperclip className="size-4 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate">{capture.filename}</span>
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Lock className="size-3" aria-hidden />
                private to this workspace
              </span>
            </p>
          ) : null}

          {capture.source_url ? (
            <p className="flex items-center gap-2 text-sm">
              <Link2 className="size-4 text-muted-foreground" aria-hidden />
              <span className="min-w-0 break-all">{capture.source_url}</span>
            </p>
          ) : null}

          <p className="text-xs text-muted-foreground">
            This is untrusted source material, kept as it was submitted. Nothing below is stored knowledge until
            you approve it.
          </p>

          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/capture?edit=${capture.id}`}>
                <Pencil />
                Return to edit the capture
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href={`/capture/${capture.id}`}>
                <FileText />
                Capture details
              </Link>
            </Button>
          </div>
        </section>
      ) : null}

      {chain?.superseded_by_proposal_id ? (
        <div className="rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm">
          <p className="font-medium">This proposal was superseded and can no longer be applied.</p>
          <p className="mt-1 text-muted-foreground">
            {chain.superseded_reason ??
              'The approved changes no longer matched the stored data, so nothing was written.'}
          </p>
          <Button asChild size="sm" className="mt-2">
            <Link href={`/review/${chain.superseded_by_proposal_id}`}>
              Open the replacement{chain.superseded_by_title ? `: ${chain.superseded_by_title}` : ''}
            </Link>
          </Button>
        </div>
      ) : null}

      {chain?.supersedes_proposal_id ? (
        <p className="text-sm text-muted-foreground">
          This replaces an earlier proposal whose approved changes no longer matched the stored data.{' '}
          <Link
            href={`/review/${chain.supersedes_proposal_id}`}
            className="underline underline-offset-2"
          >
            See the original
          </Link>
          . The old values shown below are the values stored right now.
        </p>
      ) : null}

      </TechnicalWrapper>
    </div>
  );
}

/** Capture source material and audit detail stay available without competing with the record decision. */
function TechnicalWrapper({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  if (!enabled) return <>{children}</>;
  return (
    <details className="group rounded-lg border p-4">
      <summary className="cursor-pointer text-sm font-medium text-primary">See technical details</summary>
      <div className="mt-4 space-y-6">{children}</div>
    </details>
  );
}
