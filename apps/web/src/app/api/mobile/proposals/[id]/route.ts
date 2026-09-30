import { z } from 'zod';
import {
  approveAndSave,
  confirmContactIdentity,
  contactResearchPreflight,
  reanalyseCapture,
  decideProposalItems,
  getProposal,
  withServiceRead,
  discardCaptureProposal,
  notFound,
  rejectProposal,
  requestContactResearch,
  setContactImportant,
} from '@g3/core';
import { handler, ok, readJson } from '@/lib/api';
import { loadProposalView } from '@/lib/capture-view';
import { activeWorkspaceId, requireApiSession } from '@/lib/session';

/** A compact, grouped proposal in plain words, for the mobile review screen. */
export const GET = handler(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const session = await requireApiSession();
  const { id } = await context.params;
  const view = await loadProposalView(session, id);
  if (!view) throw notFound('Proposal not found');
  return ok(view);
});

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    expectedVersion: z.number().int().positive(),
    itemIds: z.array(z.string().uuid()).min(1).max(500),
    /**
     * The simple "Save contact" flow: after saving, whatever the summary did not
     * include (restated facts, a place saved as an event, ...) is marked "not
     * kept", so the capture leaves the inbox. Reversible from the technical view.
     */
    closeRest: z.boolean().optional(),
  }),
  z.object({ action: z.literal('reject'), reason: z.string().max(2000).optional() }),
  z.object({ action: z.literal('discard') }),
  // Read the same stored source again, from scratch.
  z.object({ action: z.literal('reanalyse') }),
  // What research would use and what stays private. Read-only.
  z.object({ action: z.literal('research_preflight'), contactKey: z.string().min(1).max(200) }),
  // Research on one contact: identity first, never automatic, only after the
  // reviewer confirmed cost and disclosure and chose which clues to use.
  z.object({
    action: z.literal('research'),
    contactKey: z.string().min(1).max(200),
    acknowledgeCost: z.literal(true),
    acknowledgeDisclosure: z.literal(true),
    clueIds: z.array(z.string().min(1).max(250)).max(40),
  }),
  z.object({
    action: z.literal('confirm_identity'),
    contactKey: z.string().min(1).max(200),
    choice: z.union([z.number().int().min(0).max(2), z.literal('none'), z.literal('needs_context')]),
  }),
  z.object({ action: z.literal('mark_important'), contactKey: z.string().min(1).max(200), important: z.boolean() }),
]);

/**
 * Approve selected (or all) changes and save them, or reject the proposal.
 *
 * Approval goes through the same guarded steps as the web review -- decision,
 * version- and hash-bound approval, transactional idempotent apply -- composed
 * on the server so a dropped connection cannot leave an approval half-done.
 * Returns the refreshed view, including exactly what was saved.
 */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const session = await requireApiSession();
  const workspaceId = activeWorkspaceId(session);
  const { id } = await context.params;
  const body = Body.parse(await readJson(request));

  if (body.action === 'research_preflight') {
    return ok({ preflight: await contactResearchPreflight({ session, workspaceId, proposalId: id, contactKey: body.contactKey }) });
  }

  let written = 0;
  let alreadySaved = 0;
  if (body.action === 'reject') {
    await rejectProposal(session, workspaceId, id, body.reason ?? 'Rejected on mobile.');
  } else if (body.action === 'discard') {
    await discardCaptureProposal({ session, workspaceId, proposalId: id });
  } else if (body.action === 'reanalyse') {
    const capture = await withServiceRead((db) =>
      db.one<{ id: string }>(`select id from public.captures where workspace_id = $1 and proposal_id = $2`, [workspaceId, id]),
    );
    if (!capture) throw notFound('This proposal did not come from a capture');
    await reanalyseCapture(session, workspaceId, capture.id);
    return ok({ written: 0, alreadySaved: 0, proposal: null, reanalysing: true, captureId: capture.id });
  } else if (body.action === 'research') {
    await requestContactResearch({
      session,
      workspaceId,
      proposalId: id,
      contactKey: body.contactKey,
      acknowledgeCost: body.acknowledgeCost,
      acknowledgeDisclosure: body.acknowledgeDisclosure,
      clueIds: body.clueIds,
    });
  } else if (body.action === 'confirm_identity') {
    await confirmContactIdentity({ session, workspaceId, proposalId: id, contactKey: body.contactKey, choice: body.choice });
  } else if (body.action === 'mark_important') {
    await setContactImportant({ session, workspaceId, proposalId: id, contactKey: body.contactKey, important: body.important });
  } else {
    const result = await approveAndSave({
      session,
      workspaceId,
      proposalId: id,
      expectedVersion: body.expectedVersion,
      itemIds: body.itemIds,
    });
    written = result.applied.filter((a) => a.status === 'applied').length;
    alreadySaved = result.applied.filter((a) => a.status === 'already_applied').length;
    if (body.closeRest) {
      const { items } = await withServiceRead((db) => getProposal(db, workspaceId, id));
      const rest = items.filter((i) => !i.applied_at && i.decision === 'pending' && !body.itemIds.includes(i.id));
      if (rest.length > 0) {
        await decideProposalItems(session, workspaceId, id, rest.map((i) => ({ itemId: i.id, decision: 'rejected' as const })));
      }
    }
  }

  const view = await loadProposalView(session, id);
  return ok({ written, alreadySaved, proposal: view });
});
