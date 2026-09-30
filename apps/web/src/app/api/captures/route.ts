import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { createCapture, listCaptures, MAX_CAPTURE_TEXT, withService } from '@g3/core';
import { handler, ok, readJson } from '@/lib/api';
import { activeWorkspaceId, requireApiSession } from '@/lib/session';

const JsonBody = z.object({
  text: z.string().max(MAX_CAPTURE_TEXT).optional(),
  replacesCaptureId: z.string().uuid().optional(),
  force: z.boolean().optional(),
});

// Node 18's built-in FormData provides file-shaped values but does not expose a
// global File constructor. Check the multipart value itself instead of relying
// on `instanceof File`, so file capture works on every supported runtime.
function isUploadedFile(value: FormDataEntryValue | null): value is File {
  const file = value as Partial<File> | null;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof file?.name === 'string' &&
    typeof file.size === 'number' &&
    typeof file.arrayBuffer === 'function'
  );
}

/**
 * Takes in one capture: typed or pasted text, a URL inside that text, and/or an
 * attached file. The source is stored privately and queued for analysis; nothing
 * is written to knowledge here.
 */
export const POST = handler(async (request: Request) => {
  const session = await requireApiSession();
  const workspaceId = activeWorkspaceId(session);

  let text: string | undefined;
  let replacesCaptureId: string | undefined;
  let force = false;
  let file: { name: string; type: string | null; bytes: Buffer } | null = null;

  if (request.headers.get('content-type')?.includes('multipart/form-data')) {
    const form = await request.formData();
    const raw = form.get('text');
    text = typeof raw === 'string' ? raw : undefined;
    const replaces = form.get('replacesCaptureId');
    replacesCaptureId = typeof replaces === 'string' && replaces.length > 0 ? replaces : undefined;
    force = form.get('force') === 'true';
    const attached = form.get('file');
    if (isUploadedFile(attached) && attached.size > 0) {
      file = {
        name: attached.name,
        type: attached.type || null,
        bytes: Buffer.from(await attached.arrayBuffer()),
      };
    }
  } else {
    const body = JsonBody.parse(await readJson(request));
    text = body.text;
    replacesCaptureId = body.replacesCaptureId;
    force = body.force ?? false;
  }

  const result = await createCapture({
    session,
    workspaceId,
    text,
    file,
    replacesCaptureId: replacesCaptureId ?? null,
    force,
  });

  return ok({
    captureId: result.capture.id,
    created: result.created,
    status: result.capture.status,
    proposalId: result.capture.proposal_id,
  });
});

/** Recent captures with the state of their analysis. */
export const GET = handler(async () => {
  const session = await requireApiSession();
  const workspaceId = activeWorkspaceId(session);
  const captures = await withService((db) => listCaptures(db, workspaceId, 20));
  return ok({ captures });
});
