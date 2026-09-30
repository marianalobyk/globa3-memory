import { z } from 'zod';
import { AppError, requestExplicitResearch } from '@g3/core';
import { handler, ok, readJson } from '@/lib/api';
import { activeWorkspaceId, requireApiSession } from '@/lib/session';

const Body = z.object({
  entityId: z.string().uuid().nullish(),
  label: z.string().min(2).max(200).nullish(),
  targetType: z.enum(['person', 'company', 'project']).nullish(),
  captureId: z.string().uuid().nullish(),
  // The client must have shown that research uses AI budget and may search
  // external sources, and the person must have confirmed it.
  acknowledgeCost: z.literal(true),
});

/**
 * Starts research on one person, company or project, only on explicit request.
 * Capture analysis never calls this. The result is a separate proposal.
 */
export const POST = handler(async (request: Request) => {
  const session = await requireApiSession();
  const body = Body.parse(await readJson(request));
  if (body.captureId) {
    // A capture's contacts are researched inside its own review -- identity
    // first, results joined to the same proposal -- never as a parallel proposal.
    throw new AppError(
      'Research on a contact from a capture starts from that capture’s review, where you confirm who they are first.',
      409,
      'use_capture_review',
    );
  }
  const result = await requestExplicitResearch({
    session,
    workspaceId: activeWorkspaceId(session),
    entityId: body.entityId ?? null,
    label: body.label ?? null,
    targetType: body.targetType ?? null,
    captureId: body.captureId ?? null,
    acknowledgeCost: body.acknowledgeCost,
  });
  return ok({
    started: result.created,
    alreadyRequestedToday: !result.created,
    label: result.label,
    isMock: result.isMock,
    budgetWarnings: result.budgetWarnings,
  });
});
