/**
 * Upload ingestion: Markdown, PDF and ZIP.
 *
 *   expand -> parse -> persist
 *
 * A ZIP can contain many briefs or dossiers, so each entry becomes its own upload
 * row with its own status, and a single file's contents can still split into
 * several documents. Every file the user sees has an individual status and reason.
 *
 * Archive safety, all enforced before anything is written:
 *   - per-file and total uncompressed size ceilings;
 *   - an entry-count ceiling;
 *   - a compression-ratio ceiling, which is what catches a zip bomb;
 *   - path traversal and absolute paths rejected;
 *   - nested archives are recorded and skipped rather than expanded recursively.
 */
import { Buffer } from 'node:buffer';
import { FORMAT_KEYS, type FormatKey } from '@g3/shared';
import { Open as unzipOpen } from 'unzipper';
import { withService } from '../db.js';
import { env } from '../env.js';
import { badRequest, tooLarge } from '../errors.js';
import { getStorage } from '../storage.js';
import { STAGE_PLANS } from '../runs.js';
import { event, stage, type PipelineContext } from './context.js';

const STAGE_COUNT = STAGE_PLANS.ingest.length;

const TEXT_EXTENSIONS = ['.md', '.markdown', '.txt'];
const PDF_EXTENSIONS = ['.pdf'];
const ARCHIVE_EXTENSIONS = ['.zip'];

export function classifyFilename(filename: string): 'md' | 'pdf' | 'zip' | 'other' {
  const lower = filename.toLowerCase();
  if (TEXT_EXTENSIONS.some((e) => lower.endsWith(e))) return 'md';
  if (PDF_EXTENSIONS.some((e) => lower.endsWith(e))) return 'pdf';
  if (ARCHIVE_EXTENSIONS.some((e) => lower.endsWith(e))) return 'zip';
  return 'other';
}

/** Rejects traversal, absolute paths, and macOS resource-fork noise. */
function isSafeArchivePath(path: string): { safe: boolean; reason?: string } {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) {
    return { safe: false, reason: 'Absolute paths are not allowed inside an archive.' };
  }
  if (normalized.split('/').some((segment) => segment === '..')) {
    return { safe: false, reason: 'Path traversal is not allowed inside an archive.' };
  }
  if (normalized.includes('\0')) return { safe: false, reason: 'Invalid characters in path.' };
  if (/(^|\/)__MACOSX\//i.test(normalized) || /(^|\/)\._/.test(normalized)) {
    return { safe: false, reason: 'macOS resource fork entry, skipped.' };
  }
  if (/(^|\/)\.DS_Store$/i.test(normalized)) {
    return { safe: false, reason: 'Finder metadata, skipped.' };
  }
  return { safe: true };
}

async function extractPdfText(bytes: Buffer): Promise<{ text: string; pages: number }> {
  // Imported lazily: pdf-parse reads a sample file at import time in some
  // versions, which is undesirable at module load.
  const mod = (await import('pdf-parse')) as unknown as {
    default: (b: Buffer) => Promise<{ text: string; numpages: number }>;
  };
  const parsed = await mod.default(bytes);
  return { text: parsed.text, pages: parsed.numpages };
}

/** Detects which format an uploaded brief belongs to, from its own text. */
export function detectFormatKey(text: string): FormatKey | null {
  const head = text.slice(0, 4000).toLowerCase();
  const candidates: [FormatKey, RegExp[]][] = [
    [
      'amv_daily',
      [/amv\b.*daily.*(athlete ownership|platform intelligence)/, /daily athlete ownership/],
    ],
    ['amv_creative_radar', [/amv creative radar/]],
    ['globa3_creative_radar', [/globa\s*3 creative radar/, /^#\s*creative radar/m]],
  ];
  for (const [key, patterns] of candidates) {
    if (patterns.some((p) => p.test(head))) return key;
  }
  return null;
}

export function detectRunDate(text: string): string | null {
  const iso = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso?.[1]) return iso[1];
  const long = text.match(
    /\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})\b/i,
  );
  if (long) {
    const months = [
      'january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december',
    ];
    const month = months.indexOf((long[2] ?? '').toLowerCase()) + 1;
    if (month > 0) {
      return `${long[3]}-${String(month).padStart(2, '0')}-${String(long[1]).padStart(2, '0')}`;
    }
  }
  return null;
}

/**
 * Splits one file into documents. A file holding several briefs or dossiers is
 * split on top-level headings that look like document titles.
 */
export function splitDocuments(
  text: string,
  fallbackTitle: string,
): { title: string; docType: 'brief' | 'dossier' | 'other'; body: string }[] {
  const lines = text.split(/\r?\n/);
  const boundaries: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^#\s+\S/.test(line)) boundaries.push(i);
  }

  const makeDoc = (title: string, body: string) => {
    const lower = `${title}\n${body.slice(0, 1500)}`.toLowerCase();
    const docType: 'brief' | 'dossier' | 'other' =
      /\bbrief\b|\bradar\b|\bbriefing\b|\bintelligence\b/.test(lower)
        ? 'brief'
        : /\bdossier\b|\bprofile\b|\bmemo\b/.test(lower)
          ? 'dossier'
          : 'other';
    return { title: title.trim().slice(0, 300), docType, body };
  };

  // Fewer than two top-level headings means it is one document.
  if (boundaries.length < 2) {
    const heading = lines.find((l) => /^#\s+\S/.test(l));
    return [makeDoc(heading ? heading.replace(/^#\s+/, '') : fallbackTitle, text)];
  }

  const docs: { title: string; docType: 'brief' | 'dossier' | 'other'; body: string }[] = [];
  for (let i = 0; i < boundaries.length; i += 1) {
    const start = boundaries[i] as number;
    const end = i + 1 < boundaries.length ? (boundaries[i + 1] as number) : lines.length;
    const body = lines.slice(start, end).join('\n').trim();
    if (body.length < 40) continue;
    const title = (lines[start] ?? '').replace(/^#\s+/, '');
    docs.push(makeDoc(title, body));
  }
  return docs.length > 0 ? docs : [makeDoc(fallbackTitle, text)];
}

interface ExpandedFile {
  uploadId: string;
  filename: string;
  archivePath: string | null;
  kind: 'md' | 'pdf' | 'zip' | 'other';
  storagePath: string;
  byteSize: number;
}

export interface IngestPipelineResult {
  fileCount: number;
  parsedCount: number;
  skippedCount: number;
  failedCount: number;
  documentCount: number;
}

export async function runIngestPipeline(ctx: PipelineContext): Promise<IngestPipelineResult> {
  const { run, workspaceId } = ctx;
  const input = run.input as { uploadId?: string };
  if (!input.uploadId) throw badRequest('An ingest run requires an upload id');
  const storage = getStorage();
  const limits = env();

  // ------------------------------------------------------------------ expand
  const expanded = await stage(ctx, 'expand', 1, STAGE_COUNT, async () => {
    const root = await withService((db) =>
      db.oneOrFail<{
        id: string;
        filename: string;
        kind: 'md' | 'pdf' | 'zip' | 'other';
        storage_path: string;
        byte_size: string;
        batch_id: string | null;
        created_by: string | null;
      }>(
        `select id, filename, kind, storage_path, byte_size, batch_id, created_by
           from public.uploads where workspace_id = $1 and id = $2`,
        [workspaceId, input.uploadId],
      ),
    );

    await withService((db) =>
      db.query(
        `update public.uploads set status = 'processing', updated_at = now()
          where workspace_id = $1 and id = $2`,
        [workspaceId, root.id],
      ),
    );

    const files: ExpandedFile[] = [];

    if (root.kind !== 'zip') {
      files.push({
        uploadId: root.id,
        filename: root.filename,
        archivePath: null,
        kind: root.kind,
        storagePath: root.storage_path,
        byteSize: Number(root.byte_size),
      });
      return { files, rootUploadId: root.id };
    }

    // --- archive expansion, with the safety ceilings applied as we go -------
    const archiveBytes = await storage.get(workspaceId, root.storage_path.split('/').slice(1).join('/'));
    const directory = await unzipOpen.buffer(archiveBytes);
    const entries = directory.files.filter((f) => f.type === 'File');

    if (entries.length > limits.MAX_ARCHIVE_ENTRIES) {
      throw tooLarge(
        `The archive holds ${entries.length} files; the limit is ${limits.MAX_ARCHIVE_ENTRIES}.`,
      );
    }

    const declaredTotal = entries.reduce((sum, e) => sum + (e.uncompressedSize ?? 0), 0);
    if (declaredTotal > limits.MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw tooLarge(
        `The archive expands to ${(declaredTotal / 1_048_576).toFixed(1)} MB; the limit is ${(limits.MAX_ARCHIVE_UNCOMPRESSED_BYTES / 1_048_576).toFixed(0)} MB.`,
      );
    }
    const ratio = archiveBytes.byteLength > 0 ? declaredTotal / archiveBytes.byteLength : 0;
    if (ratio > limits.MAX_ARCHIVE_COMPRESSION_RATIO) {
      throw tooLarge(
        `The archive's compression ratio is ${ratio.toFixed(0)}:1, above the ${limits.MAX_ARCHIVE_COMPRESSION_RATIO}:1 limit. Refusing to expand it.`,
      );
    }

    let writtenTotal = 0;
    for (const entry of entries) {
      const safety = isSafeArchivePath(entry.path);
      const kind = classifyFilename(entry.path);
      const basename = entry.path.split('/').pop() ?? entry.path;

      const child = await withService((db) =>
        db.oneOrFail<{ id: string }>(
          `insert into public.uploads
             (workspace_id, batch_id, parent_upload_id, filename, archive_path, kind,
              byte_size, status, status_detail, created_by, run_id)
           values ($1,$2,$3,$4,$5,$6,$7,'pending',null,$8,$9)
           returning id`,
          [
            workspaceId,
            root.batch_id,
            root.id,
            basename,
            entry.path,
            kind === 'other' ? 'other' : kind,
            entry.uncompressedSize ?? 0,
            root.created_by,
            run.id,
          ],
        ),
      );

      const reject = async (reason: string): Promise<void> => {
        await withService((db) =>
          db.query(
            `update public.uploads set status = 'skipped', status_detail = $3, updated_at = now()
              where workspace_id = $1 and id = $2`,
            [workspaceId, child.id, reason],
          ),
        );
      };

      if (!safety.safe) {
        await reject(safety.reason ?? 'Unsafe archive entry.');
        continue;
      }
      if (kind === 'zip') {
        await reject('Nested archive. Upload it separately rather than expanding it recursively.');
        continue;
      }
      if (kind === 'other') {
        await reject(`Unsupported file type. Supported: Markdown, plain text and PDF.`);
        continue;
      }
      if ((entry.uncompressedSize ?? 0) > limits.MAX_UPLOAD_BYTES) {
        await reject(
          `File is ${((entry.uncompressedSize ?? 0) / 1_048_576).toFixed(1)} MB; the per-file limit is ${(limits.MAX_UPLOAD_BYTES / 1_048_576).toFixed(0)} MB.`,
        );
        continue;
      }

      const bytes = await entry.buffer();
      writtenTotal += bytes.byteLength;
      if (writtenTotal > limits.MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
        // The declared sizes understated the real contents.
        await reject('Archive exceeded the total uncompressed size limit while expanding.');
        throw tooLarge('Archive exceeded the total uncompressed size limit while expanding.');
      }

      const stored = await storage.put(
        workspaceId,
        `uploads/${child.id}/${basename.replace(/[^\w.\-]+/g, '_')}`,
        bytes,
        kind === 'pdf' ? 'application/pdf' : 'text/markdown',
      );
      await withService((db) =>
        db.query(
          `update public.uploads
              set storage_path = $3, byte_size = $4, checksum = $5, status = 'queued', updated_at = now()
            where workspace_id = $1 and id = $2`,
          [workspaceId, child.id, stored.key, stored.byteSize, stored.checksum],
        ),
      );

      files.push({
        uploadId: child.id,
        filename: basename,
        archivePath: entry.path,
        kind,
        storagePath: stored.key,
        byteSize: stored.byteSize,
      });
    }

    await event(
      ctx,
      'info',
      `Archive expanded: ${files.length} usable file(s) of ${entries.length} entr(ies).`,
      'expand',
    );
    return { files, rootUploadId: root.id };
  });

  const files = expanded.value.files as ExpandedFile[];
  const rootUploadId = expanded.value.rootUploadId as string;

  // ------------------------------------------------------------------- parse
  const parsed = await stage(ctx, 'parse', 2, STAGE_COUNT, async () => {
    const results: {
      uploadId: string;
      status: 'parsed' | 'failed' | 'skipped';
      detail: string | null;
      pages: number | null;
      documents: {
        title: string;
        docType: 'brief' | 'dossier' | 'other';
        body: string;
        formatKey: FormatKey | null;
        runDate: string | null;
      }[];
    }[] = [];

    for (const file of files) {
      await ctx.keepAlive();
      try {
        const bytes = await storage.get(workspaceId, file.storagePath.split('/').slice(1).join('/'));
        let text: string;
        let pages: number | null = null;

        if (file.kind === 'pdf') {
          const extracted = await extractPdfText(bytes);
          text = extracted.text;
          pages = extracted.pages;
          if (text.trim().length < 40) {
            results.push({
              uploadId: file.uploadId,
              status: 'skipped',
              detail:
                'No extractable text. This looks like a scanned PDF; OCR is not part of this version.',
              pages,
              documents: [],
            });
            continue;
          }
        } else {
          text = bytes.toString('utf8');
        }

        if (text.trim().length < 40) {
          results.push({
            uploadId: file.uploadId,
            status: 'skipped',
            detail: 'File holds no usable text.',
            pages,
            documents: [],
          });
          continue;
        }

        const docs = splitDocuments(text, file.filename).map((doc) => ({
          ...doc,
          formatKey: detectFormatKey(`${doc.title}\n${doc.body}`),
          runDate: detectRunDate(`${doc.title}\n${doc.body.slice(0, 3000)}`),
        }));

        results.push({
          uploadId: file.uploadId,
          status: 'parsed',
          detail: `${docs.length} document(s) found.`,
          pages,
          documents: docs,
        });
      } catch (error) {
        results.push({
          uploadId: file.uploadId,
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
          pages: null,
          documents: [],
        });
      }
    }
    return { results };
  });

  // ----------------------------------------------------------------- persist
  const persisted = await stage(ctx, 'persist', 3, STAGE_COUNT, async () => {
    let documentCount = 0;
    let parsedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const result of parsed.value.results) {
      await withService(async (db) => {
        await db.query(
          `update public.uploads
              set status = $3, status_detail = $4, page_count = $5,
                  document_count = $6, updated_at = now()
            where workspace_id = $1 and id = $2`,
          [
            workspaceId,
            result.uploadId,
            result.status,
            result.detail,
            result.pages,
            result.documents.length,
          ],
        );

        for (const [index, doc] of result.documents.entries()) {
          await db.query(
            `insert into public.upload_documents
               (workspace_id, upload_id, seq, title, doc_type, detected_format_key,
                detected_run_date, body_md, char_count)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              workspaceId,
              result.uploadId,
              index + 1,
              doc.title,
              doc.docType,
              doc.formatKey && FORMAT_KEYS.includes(doc.formatKey) ? doc.formatKey : null,
              doc.runDate,
              doc.body,
              doc.body.length,
            ],
          );
          documentCount += 1;
        }
      });

      if (result.status === 'parsed') parsedCount += 1;
      else if (result.status === 'skipped') skippedCount += 1;
      else failedCount += 1;
    }

    await withService((db) =>
      db.query(
        `update public.uploads
            set status = case when $3 > 0 then 'parsed' else 'failed' end,
                status_detail = $4,
                document_count = $5,
                updated_at = now()
          where workspace_id = $1 and id = $2`,
        [
          workspaceId,
          rootUploadId,
          parsedCount,
          `${parsedCount} parsed, ${skippedCount} skipped, ${failedCount} failed.`,
          documentCount,
        ],
      ),
    );

    return { documentCount, parsedCount, skippedCount, failedCount };
  });

  return {
    fileCount: files.length,
    parsedCount: persisted.value.parsedCount,
    skippedCount: persisted.value.skippedCount,
    failedCount: persisted.value.failedCount,
    documentCount: persisted.value.documentCount,
  };
}
