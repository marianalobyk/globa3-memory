import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  classifyFilename,
  createRun,
  env,
  getStorage,
  hasOpenAi,
  tooLarge,
  uploadKey,
  withService,
  badRequest,
} from '@g3/core';
import { handler, ok } from '@/lib/api';
import { activeWorkspaceId, requireApiSession } from '@/lib/session';

/**
 * Accepts Markdown, PDF and ZIP uploads.
 *
 * Each file gets its own row with its own status before anything is parsed, so
 * the UI can show per-file progress and per-file reasons rather than one opaque
 * batch result. Parsing and archive expansion happen in the worker, where the
 * size, entry-count and compression-ratio ceilings are enforced.
 */
export const POST = handler(async (request: Request) => {
  const session = await requireApiSession();
  const workspaceId = activeWorkspaceId(session);
  const limits = env();
  const storage = getStorage();

  const form = await request.formData().catch(() => null);
  if (!form) throw badRequest('Expected a multipart form upload');

  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) throw badRequest('No files were included in the upload');
  if (files.length > 25) throw badRequest('Upload at most 25 files at a time');

  const batchId = randomUUID();
  const accepted: {
    uploadId: string;
    filename: string;
    kind: string;
    byteSize: number;
    status: string;
    statusDetail: string | null;
    runId: string | null;
  }[] = [];

  for (const file of files) {
    const kind = classifyFilename(file.name);

    // Record the row first, so even a rejected file is visible with its reason.
    const row = await withService((db) =>
      db.oneOrFail<{ id: string }>(
        `insert into public.uploads
           (workspace_id, batch_id, filename, mime_type, byte_size, kind, status, created_by)
         values ($1,$2,$3,$4,$5,$6,'pending',$7)
         returning id`,
        [
          workspaceId,
          batchId,
          file.name,
          file.type || null,
          file.size,
          kind === 'other' ? 'other' : kind,
          session.user.id,
        ],
      ),
    );

    const reject = async (detail: string): Promise<void> => {
      await withService((db) =>
        db.query(
          `update public.uploads set status = 'rejected', status_detail = $3, updated_at = now()
            where workspace_id = $1 and id = $2`,
          [workspaceId, row.id, detail],
        ),
      );
      accepted.push({
        uploadId: row.id,
        filename: file.name,
        kind,
        byteSize: file.size,
        status: 'rejected',
        statusDetail: detail,
        runId: null,
      });
    };

    if (kind === 'other') {
      await reject('Unsupported file type. Markdown (.md, .txt), PDF and ZIP are accepted.');
      continue;
    }
    if (file.size === 0) {
      await reject('The file is empty.');
      continue;
    }
    if (file.size > limits.MAX_UPLOAD_BYTES) {
      await reject(
        `File is ${(file.size / 1_048_576).toFixed(1)} MB; the limit is ${(limits.MAX_UPLOAD_BYTES / 1_048_576).toFixed(0)} MB.`,
      );
      continue;
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.byteLength > limits.MAX_UPLOAD_BYTES) {
      await reject('The file exceeded the size limit while reading.');
      continue;
    }

    const stored = await storage.put(
      workspaceId,
      uploadKey(row.id, file.name),
      bytes,
      file.type || (kind === 'pdf' ? 'application/pdf' : kind === 'zip' ? 'application/zip' : 'text/markdown'),
    );

    // One ingest run per uploaded file, so a failure is isolated to that file.
    const run = await createRun({
      session,
      workspaceId,
      kind: 'ingest',
      input: { uploadId: row.id },
      idempotencyKey: `ingest:${row.id}`,
      isMock: !hasOpenAi(),
    });

    await withService((db) =>
      db.query(
        `update public.uploads
            set storage_path = $3, checksum = $4, status = 'queued', run_id = $5, updated_at = now()
          where workspace_id = $1 and id = $2`,
        [workspaceId, row.id, stored.key, stored.checksum, run.run.id],
      ),
    );

    accepted.push({
      uploadId: row.id,
      filename: file.name,
      kind,
      byteSize: stored.byteSize,
      status: 'queued',
      statusDetail: 'Queued for parsing.',
      runId: run.run.id,
    });
  }

  return ok({ batchId, files: accepted });
});

const ListQuery = z.object({ batchId: z.string().uuid().optional() });

/** Per-file status for the upload panel. */
export const GET = handler(async (request: Request) => {
  const session = await requireApiSession();
  const workspaceId = activeWorkspaceId(session);
  const url = new URL(request.url);
  const query = ListQuery.parse({ batchId: url.searchParams.get('batchId') ?? undefined });

  const rows = await withService((db) =>
    db.rows(
      `select u.id, u.filename, u.archive_path, u.kind, u.byte_size, u.status, u.status_detail,
              u.document_count, u.page_count, u.parent_upload_id, u.batch_id, u.created_at,
              u.run_id,
              (select count(*)::int from public.upload_documents d where d.upload_id = u.id) as documents
         from public.uploads u
        where u.workspace_id = $1
          and ($2::uuid is null or u.batch_id = $2::uuid)
        order by u.created_at desc, u.filename
        limit 200`,
      [workspaceId, query.batchId ?? null],
    ),
  );
  return ok({ uploads: rows });
});
