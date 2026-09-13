import { z } from 'zod';
import {
  createPromptVersion,
  getFormat,
  listFormats,
  requireAdmin,
  updateFormatConfig,
  withService,
} from '@g3/core';
import { handler, ok, readJson } from '@/lib/api';
import { activeWorkspaceId, requireApiSession } from '@/lib/session';

export const GET = handler(async () => {
  const session = await requireApiSession();
  const workspaceId = activeWorkspaceId(session);
  const formats = await withService((db) => listFormats(db, workspaceId));
  return ok({
    formats: formats.map((f) => ({
      id: f.id,
      key: f.key,
      name: f.name,
      productLine: f.product_line,
      defaultModel: f.default_model,
      researchModel: f.research_model,
      config: f.config,
    })),
  });
});

const PatchBody = z.object({
  formatId: z.string().uuid(),
  defaultModel: z.string().max(120).nullable().optional(),
  researchModel: z.string().max(120).nullable().optional(),
  config: z.unknown().optional(),
  promptBody: z.string().min(50).optional(),
  promptNote: z.string().max(500).optional(),
});

/**
 * Updates a format's models, structured rules, or prompt text.
 *
 * A prompt change creates a new version rather than editing in place, so every
 * past brief still points at the exact prompt that produced it.
 */
export const PATCH = handler(async (request: Request) => {
  const session = await requireApiSession();
  const workspaceId = activeWorkspaceId(session);
  requireAdmin(session, workspaceId);
  const body = PatchBody.parse(await readJson(request));

  const result = await withService(async (db) => {
    const format = await getFormat(db, workspaceId, body.formatId);
    const updated = await updateFormatConfig(
      db,
      workspaceId,
      format.id,
      (body.config as typeof format.config) ?? format.config,
      { defaultModel: body.defaultModel ?? null, researchModel: body.researchModel ?? null },
    );

    let promptVersion: number | null = null;
    if (body.promptBody) {
      const version = await createPromptVersion(db, {
        workspaceId,
        formatId: format.id,
        body: body.promptBody,
        attachments: [],
        note: body.promptNote ?? `Edited in Settings by ${session.user.email}.`,
        createdBy: session.user.id,
        makeActive: true,
      });
      promptVersion = version.version;
    }
    return { format: updated, promptVersion };
  });

  return ok({
    ok: true,
    formatId: result.format.id,
    promptVersion: result.promptVersion,
  });
});
