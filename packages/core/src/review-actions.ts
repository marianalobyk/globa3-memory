/**
 * Review actions as one call, for clients that should not orchestrate them.
 *
 * The web review screen records decisions, then an approval, then applies, in
 * three requests. A phone on a conference floor should not have to: a dropped
 * connection between the second and third request leaves an approval nobody
 * applied. This composes the same three guarded functions in order. It adds no
 * shortcut: every step re-checks the caller's approval right, the approval is
 * bound to the proposal's version and content hash, and the apply step is the
 * same transactional, idempotent writer every other client uses.
 */
import type { Session } from '@g3/shared';
import { applyApprovedItems, type ApplyResult } from './apply.js';
import { requireApproval } from './auth.js';
import { badRequest, conflict } from './errors.js';
import { decideProposalItems, getProposal, recordApproval } from './proposals.js';
import { withServiceRead } from './db.js';

export interface ApproveAndSaveInput {
  session: Session;
  workspaceId: string;
  proposalId: string;
  /** The version the person was looking at. A newer one is refused, not guessed at. */
  expectedVersion: number;
  /** Exactly the changes the person selected. Unselected changes stay awaiting review. */
  itemIds: string[];
}

export async function approveAndSave(input: ApproveAndSaveInput): Promise<ApplyResult> {
  requireApproval(input.session, input.workspaceId);
  const itemIds = [...new Set(input.itemIds)];
  if (itemIds.length === 0) throw badRequest('Select at least one change to approve');

  const { proposal, items } = await withServiceRead((db) => getProposal(db, input.workspaceId, input.proposalId));
  if (proposal.version !== input.expectedVersion) {
    throw conflict('This proposal changed while you were reading it. Reload it and approve again.', {
      reason: 'version_changed',
      currentVersion: proposal.version,
    });
  }
  const known = new Set(items.map((i) => i.id));
  const unknown = itemIds.filter((id) => !known.has(id));
  if (unknown.length > 0) throw badRequest('Some selected changes are not part of this proposal');

  // Already-saved items need no decision; applying them again is a no-op.
  const pending = items.filter((i) => itemIds.includes(i.id) && !i.applied_at);
  if (pending.length > 0) {
    await decideProposalItems(
      input.session,
      input.workspaceId,
      input.proposalId,
      pending.map((i) => ({ itemId: i.id, decision: 'approved' as const })),
    );
    await recordApproval(input.session, input.workspaceId, input.proposalId, pending.map((i) => i.id));
  }

  return applyApprovedItems({
    session: input.session,
    workspaceId: input.workspaceId,
    proposalId: input.proposalId,
    expectedVersion: input.expectedVersion,
    itemIds,
  });
}
