import { z } from 'zod';
import { editProposalItem } from '@g3/core';
import { handler, ok, readJson } from '@/lib/api';
import { activeWorkspaceId, requireApiSession } from '@/lib/session';

const Body = z.object({ edits: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])) });

/**
 * Edits one proposed record.
 *
 * Deliberately consequential: the response carries the new version, and the
 * server has already revoked any outstanding approval, because an approval only
 * ever applies to the content the approver saw.
 */
export const PATCH = handler(
  async (request: Request, context: { params: Promise<{ id: string; itemId: string }> }) => {
    const session = await requireApiSession();
    const workspaceId = activeWorkspaceId(session);
    const { id, itemId } = await context.params;
    const body = Body.parse(await readJson(request));

    const result = await editProposalItem(session, workspaceId, id, itemId, body.edits);
    return ok({
      ok: true,
      version: result.version,
      contentHash: result.contentHash,
      approvalRevoked: true,
      message:
        'Saved. Any earlier approval of this proposal was revoked, and every item is pending again.',
    });
  },
);
