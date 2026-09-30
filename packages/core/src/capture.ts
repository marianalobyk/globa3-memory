/**
 * Capture inbox: taking in a note, a link or a file.
 *
 *   Capture -> Analyze -> Resolve -> Propose -> Approve -> Remember
 *
 * This module covers the first step and the state around it. A capture is
 * UNTRUSTED source material: it is stored privately in its workspace, and
 * nothing here writes to a knowledge table. The analysis runs in the worker
 * (pipelines/capture.ts) and ends in an ordinary proposal; saving anything is
 * the approval-gated apply step, exactly as for research.
 *
 * Idempotency:
 *   - submitting the same content again in a workspace returns the live capture
 *     instead of analysing it twice (unique partial index on content_hash);
 *   - each capture has exactly one analysis run (idempotency key capture:<id>);
 *   - the propose stage reuses a proposal already linked to the capture, so a
 *     retried job never builds a second one.
 */
import { createHash } from 'node:crypto';
import type { Session } from '@g3/shared';
import { requireWorkspace } from './auth.js';
import { assertScope, isUniqueViolation, withService, type Queryable } from './db.js';
import { env, hasOpenAi } from './env.js';
import { AppError, badRequest, conflict, forbidden, notFound, tooLarge } from './errors.js';
import { logActivity } from './activity.js';
import { classifyFilename } from './pipelines/ingest.js';
import { rejectProposal } from './proposals.js';
import { createRun, requeueRun } from './runs.js';
import { getStorage, uploadKey } from './storage.js';

export const MAX_CAPTURE_TEXT = 20_000;

export type CaptureKind = 'text' | 'url' | 'file';
export type CaptureStatus = 'received' | 'analyzing' | 'proposed' | 'failed' | 'replaced' | 'discarded';

export interface CaptureRecord {
  id: string;
  workspace_id: string;
  created_by: string | null;
  kind: CaptureKind;
  body_text: string | null;
  source_url: string | null;
  upload_id: string | null;
  content_hash: string;
  source_hash: string;
  status: CaptureStatus;
  status_detail: string | null;
  run_id: string | null;
  proposal_id: string | null;
  replaces_capture_id: string | null;
  captured_at: string;
  created_at: string;
  updated_at: string;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/i;

/** Whitespace-normalised text, so trivial differences do not defeat idempotency. */
export function normalizeCaptureText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** The first http(s) URL in a note, without trailing punctuation. */
export function firstUrl(text: string): string | null {
  const match = text.match(URL_PATTERN);
  if (!match) return null;
  return match[0].replace(/[).,;:!?]+$/, '');
}

export function captureContentHash(input: { text: string; fileChecksum?: string | null }): string {
  return createHash('sha256')
    .update(`text:${input.text.toLowerCase()}\nfile:${input.fileChecksum ?? ''}`)
    .digest('hex');
}

export interface CreateCaptureInput {
  session: Session;
  workspaceId: string;
  text?: string | null;
  file?: { name: string; type: string | null; bytes: Buffer } | null;
  /** The capture this one replaces after "edit capture". */
  replacesCaptureId?: string | null;
  /** Analyse again even when identical content was already captured. */
  force?: boolean;
}

export interface CreateCaptureResult {
  capture: CaptureRecord;
  /** False when identical content was already captured and that capture is returned. */
  created: boolean;
}

export async function createCapture(input: CreateCaptureInput): Promise<CreateCaptureResult> {
  const workspaceId = assertScope(input.workspaceId, 'createCapture');
  const access = requireWorkspace(input.session, workspaceId);
  if (access.role === 'viewer') throw forbidden('Viewers can read captures but cannot add them');

  const text = normalizeCaptureText(input.text ?? '');
  if (text.length > MAX_CAPTURE_TEXT) {
    throw tooLarge(`A capture holds at most ${MAX_CAPTURE_TEXT.toLocaleString('en')} characters; this one has ${text.length.toLocaleString('en')}.`);
  }
  const file = input.file ?? null;
  if (!file && text.length === 0) throw badRequest('Write a note, paste a link or attach a file.');

  let fileKind: 'md' | 'pdf' | null = null;
  let fileChecksum: string | null = null;
  if (file) {
    const kind = classifyFilename(file.name);
    if (kind !== 'md' && kind !== 'pdf') {
      throw badRequest('Attach a PDF, Markdown or plain-text file.');
    }
    if (file.bytes.byteLength === 0) throw badRequest('The attached file is empty.');
    if (file.bytes.byteLength > env().MAX_UPLOAD_BYTES) {
      throw tooLarge(`The file is larger than ${Math.round(env().MAX_UPLOAD_BYTES / 1_048_576)} MB.`);
    }
    fileKind = kind;
    fileChecksum = createHash('sha256').update(file.bytes).digest('hex');
  }

  const kind: CaptureKind = file ? 'file' : /^https?:\/\/\S+$/i.test(text) ? 'url' : 'text';
  const sourceUrl = firstUrl(text);
  const baseHash = captureContentHash({ text, fileChecksum });
  // A deliberate re-analysis of identical content keeps the earlier capture (and
  // whatever was saved from it) and records a distinct submission.
  const contentHash = input.force
    ? createHash('sha256').update(`${baseHash}:reanalysis:${Date.now()}`).digest('hex')
    : baseHash;

  // Identical content already captured: return it rather than analyse twice.
  if (!input.force && !input.replacesCaptureId) {
    const existing = await withService((db) => findLiveCapture(db, workspaceId, contentHash));
    if (existing && !existing.run_id && !existing.proposal_id) {
      // Stored earlier but never queued (the queue call failed): queue it now
      // instead of returning a capture that can never be analysed.
      return { capture: await queueCaptureAnalysis(input.session, workspaceId, existing), created: false };
    }
    if (existing) return { capture: existing, created: false };
  }

  const replaced = input.replacesCaptureId
    ? await withService((db) => getCapture(db, workspaceId, input.replacesCaptureId as string))
    : null;
  if (input.replacesCaptureId && !replaced) throw notFound('The capture being edited was not found');

  // The file goes into the existing private upload store first. It is not
  // parsed as a brief: capture analysis reads it.
  let uploadId: string | null = null;
  if (file && fileKind) {
    const storage = getStorage();
    uploadId = await withService(async (db) => {
      const row = await db.oneOrFail<{ id: string }>(
        `insert into public.uploads
           (workspace_id, filename, mime_type, byte_size, kind, status, status_detail, created_by)
         values ($1,$2,$3,$4,$5,'pending','Attached to a capture.',$6)
         returning id`,
        [workspaceId, file.name, file.type, file.bytes.byteLength, fileKind, input.session.user.id],
      );
      return row.id;
    });
    const stored = await storage.put(
      workspaceId,
      uploadKey(uploadId, file.name),
      file.bytes,
      file.type || (fileKind === 'pdf' ? 'application/pdf' : 'text/markdown'),
    );
    await withService((db) =>
      db.query(
        `update public.uploads
            set storage_path = $3, checksum = $4, status = 'queued',
                status_detail = 'Attached to a capture; read by capture analysis.', updated_at = now()
          where workspace_id = $1 and id = $2`,
        [workspaceId, uploadId, stored.key, stored.checksum],
      ),
    );
  }

  let capture: CaptureRecord;
  try {
    capture = await withService(async (db) => {
      if (replaced) {
        // The capture being edited steps aside; it stays readable in history.
        await db.query(
          `update public.captures set status = 'replaced', status_detail = 'Replaced by an edited capture.', updated_at = now()
            where workspace_id = $1 and id = $2 and status not in ('replaced', 'discarded')`,
          [workspaceId, replaced.id],
        );
        // Editing without changing the content must not collide with itself.
      }
      const row = await db.oneOrFail<CaptureRecord>(
        `insert into public.captures
           (workspace_id, created_by, kind, body_text, source_url, upload_id, content_hash,
            source_hash, status, replaces_capture_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'received',$9)
         returning *`,
        [
          workspaceId,
          input.session.user.id,
          kind,
          text.length > 0 ? text : null,
          sourceUrl,
          uploadId,
          contentHash,
          baseHash,
          replaced?.id ?? null,
        ],
      );
      await logActivity(db, {
        workspaceId,
        actorId: input.session.user.id,
        action: 'capture.created',
        subjectTable: 'captures',
        subjectId: row.id,
        // Deliberately no content: activity is broadly visible and long-lived.
        summary: `Captured ${kind === 'file' ? `a file (${file?.name ?? 'attachment'})` : kind === 'url' ? 'a link' : `a note (${text.length} characters)`}${replaced ? ', replacing an earlier capture' : ''}.`,
        data: { kind, replaces: replaced?.id ?? null },
      });
      return row;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Two identical submissions at the same moment: return the winner.
    const winner = await withService((db) => findLiveCapture(db, workspaceId, contentHash));
    if (!winner) throw error;
    return { capture: winner, created: false };
  }

  // An edited capture replaces a proposal nobody has saved from yet.
  if (replaced?.proposal_id) {
    const untouched = await withService((db) =>
      db.one<{ applied: number; status: string }>(
        `select p.status,
                (select count(*)::int from public.proposal_items i
                  where i.proposal_id = p.id and i.applied_at is not null) as applied
           from public.proposals p where p.workspace_id = $1 and p.id = $2`,
        [workspaceId, replaced.proposal_id],
      ),
    );
    const canApprove = input.session.workspaces.some((w) => w.workspaceId === workspaceId && w.canApprove);
    if (untouched && untouched.applied === 0 && untouched.status === 'pending_review' && canApprove) {
      await rejectProposal(input.session, workspaceId, replaced.proposal_id, 'Replaced by an edited capture.');
    }
  }

  capture = await queueCaptureAnalysis(input.session, workspaceId, capture);

  return { capture, created: true };
}

/**
 * Queues the analysis run for a stored capture and links it. If queueing fails,
 * the capture is marked failed with a plain reason and the error is rethrown;
 * the source itself stays stored, and submitting it again (or Retry) queues it.
 */
async function queueCaptureAnalysis(
  session: Session,
  workspaceId: string,
  stored: CaptureRecord,
  again?: { attempt: number; supersedesProposalId: string },
): Promise<CaptureRecord> {
  try {
    const run = await createRun({
      session,
      workspaceId,
      kind: 'capture',
      input: { captureId: stored.id, supersedesProposalId: again?.supersedesProposalId ?? null },
      // A re-reading is a new job, not a retry of the old one.
      idempotencyKey: again ? `capture:${stored.id}:reread:${again.attempt}` : `capture:${stored.id}`,
      isMock: !hasOpenAi(),
    });
    return await withService((db) =>
      db.oneOrFail<CaptureRecord>(
        `update public.captures set run_id = $3, status = 'analyzing', status_detail = null, updated_at = now()
          where workspace_id = $1 and id = $2 returning *`,
        [workspaceId, stored.id, run.run.id],
      ),
    );
  } catch (error) {
    const message = error instanceof AppError ? error.message : 'The analysis could not be queued.';
    await withService((db) =>
      db.query(
        `update public.captures set status = 'failed', status_detail = $3, updated_at = now()
          where workspace_id = $1 and id = $2`,
        [workspaceId, stored.id, message.slice(0, 500)],
      ),
    );
    throw error;
  }
}

/**
 * Reads a stored capture again, from scratch.
 *
 * For when the analysis got it wrong: the pending proposal is withdrawn and a
 * fresh one is built from the same stored source, so nobody has to edit the
 * original file to test a corrected reading. Refused once anything has been
 * saved from the proposal -- re-reading then could duplicate what is already in
 * memory. The source itself is never touched.
 */
export async function reanalyseCapture(session: Session, workspaceId: string, captureId: string): Promise<CaptureRecord> {
  assertScope(workspaceId, 'reanalyseCapture');
  const access = requireWorkspace(session, workspaceId);
  if (access.role === 'viewer') throw forbidden('Viewers cannot re-read a capture');

  const prepared = await withService(async (db) => {
    const capture = await getCapture(db, workspaceId, captureId);
    if (!capture) throw notFound('Capture not found');
    if (!capture.proposal_id) throw conflict('This capture has nothing to re-read yet');
    const proposal = await db.oneOrFail<{ id: string; status: string; title: string }>(
      `select id, status, title from public.proposals where workspace_id = $1 and id = $2 for update`,
      [workspaceId, capture.proposal_id],
    );
    const saved = await db.oneOrFail<{ n: number }>(
      `select count(*)::int as n from public.proposal_items where proposal_id = $1 and applied_at is not null`,
      [proposal.id],
    );
    if (saved.n > 0) {
      throw conflict('Some of this capture is already saved. Re-reading it now could duplicate what is in memory.');
    }

    // Withdraw the old reading: nothing from it can be approved afterwards.
    await db.query(
      `update public.proposal_items set decision = 'rejected', decided_by = $3, decided_at = now(), updated_at = now()
        where workspace_id = $1 and proposal_id = $2 and applied_at is null and decision <> 'rejected'`,
      [workspaceId, proposal.id, session.user.id],
    );
    await db.query(
      `update public.proposals
          set status = 'superseded', superseded_reason = 'Replaced by a fresh reading of the same source.', updated_at = now()
        where workspace_id = $1 and id = $2`,
      [workspaceId, proposal.id],
    );
    const attempt = await db.oneOrFail<{ n: number }>(
      `select count(*)::int as n from public.runs where workspace_id = $1 and kind = 'capture' and input->>'captureId' = $2`,
      [workspaceId, captureId],
    );
    // The capture goes back to being analysed; the old proposal is unlinked.
    const updated = await db.oneOrFail<CaptureRecord>(
      `update public.captures set proposal_id = null, status = 'analyzing', status_detail = null, updated_at = now()
        where workspace_id = $1 and id = $2 returning *`,
      [workspaceId, captureId],
    );
    await logActivity(db, {
      workspaceId,
      actorId: session.user.id,
      action: 'capture.reanalysed',
      subjectTable: 'captures',
      subjectId: captureId,
      summary: 'Asked for a fresh reading of a stored capture; the previous proposal was withdrawn.',
      data: { supersededProposalId: proposal.id },
    });
    return { capture: updated, supersedesProposalId: proposal.id, attempt: attempt.n };
  });

  return queueCaptureAnalysis(session, workspaceId, prepared.capture, {
    attempt: prepared.attempt,
    supersedesProposalId: prepared.supersedesProposalId,
  });
}

async function findLiveCapture(db: Queryable, workspaceId: string, contentHash: string): Promise<CaptureRecord | null> {
  return db.one<CaptureRecord>(
    `select * from public.captures
      where workspace_id = $1 and content_hash = $2 and status not in ('replaced', 'discarded')
      order by created_at desc limit 1`,
    [workspaceId, contentHash],
  );
}

export async function getCapture(db: Queryable, workspaceId: string, captureId: string): Promise<CaptureRecord | null> {
  assertScope(workspaceId, 'getCapture');
  if (!/^[0-9a-f-]{36}$/i.test(captureId)) return null;
  return db.one<CaptureRecord>(`select * from public.captures where workspace_id = $1 and id = $2`, [
    workspaceId,
    captureId,
  ]);
}

export interface CaptureListRow {
  id: string;
  kind: CaptureKind;
  status: CaptureStatus;
  status_detail: string | null;
  preview: string | null;
  source_url: string | null;
  filename: string | null;
  proposal_id: string | null;
  proposal_status: string | null;
  awaiting: number;
  saved: number;
  run_status: string | null;
  created_at: string;
}

/** Recent captures with the state of their analysis and proposal. */
export async function listCaptures(db: Queryable, workspaceId: string, limit = 20): Promise<CaptureListRow[]> {
  assertScope(workspaceId, 'listCaptures');
  return db.rows<CaptureListRow>(
    `select c.id, c.kind, c.status, c.status_detail,
            left(c.body_text, 160) as preview, c.source_url, u.filename,
            c.proposal_id, p.status as proposal_status,
            coalesce((select count(*)::int from public.proposal_items i
                       where i.proposal_id = c.proposal_id and i.decision = 'pending' and i.applied_at is null), 0) as awaiting,
            coalesce((select count(*)::int from public.proposal_items i
                       where i.proposal_id = c.proposal_id and i.applied_at is not null), 0) as saved,
            r.status as run_status, c.created_at
       from public.captures c
       left join public.uploads u on u.id = c.upload_id
       left join public.proposals p on p.id = c.proposal_id
       left join public.runs r on r.id = c.run_id
      where c.workspace_id = $1 and c.status not in ('replaced', 'discarded')
      order by c.created_at desc
      limit $2`,
    [workspaceId, limit],
  );
}

/** The capture a proposal came from, for the Review screen. */
export async function captureForProposal(
  db: Queryable,
  workspaceId: string,
  proposalId: string,
): Promise<(CaptureRecord & { filename: string | null; captured_by_email: string | null }) | null> {
  assertScope(workspaceId, 'captureForProposal');
  return db.one(
    `select c.*, u.filename, au.email as captured_by_email
       from public.captures c
       left join public.uploads u on u.id = c.upload_id
       left join public.app_users au on au.id = c.created_by
      where c.workspace_id = $1 and c.proposal_id = $2
      limit 1`,
    [workspaceId, proposalId],
  );
}

/**
 * Retries a failed analysis. Stages that already succeeded keep their stored
 * output, so the retry resumes where the failure happened.
 */
export async function retryCapture(session: Session, workspaceId: string, captureId: string): Promise<CaptureRecord> {
  assertScope(workspaceId, 'retryCapture');
  const access = requireWorkspace(session, workspaceId);
  if (access.role === 'viewer') throw forbidden('Viewers cannot retry an analysis');

  // A capture whose analysis was never queued (the queue call failed) is
  // retried by queueing it now.
  const stored = await withService((db) => getCapture(db, workspaceId, captureId));
  if (!stored) throw notFound('Capture not found');
  if (!stored.run_id && !stored.proposal_id && stored.status === 'failed') {
    return queueCaptureAnalysis(session, workspaceId, stored);
  }

  const run = await withService(async (db) => {
    const capture = await getCapture(db, workspaceId, captureId);
    if (!capture) throw notFound('Capture not found');
    if (!capture.run_id) throw conflict('This capture has no analysis to retry');
    const row = await db.oneOrFail<{ id: string; status: string; attempt: number }>(
      `select id, status, attempt from public.runs where workspace_id = $1 and id = $2`,
      [workspaceId, capture.run_id],
    );
    if (row.status !== 'failed') throw conflict('Only a failed analysis can be retried');
    await db.query(
      `update public.runs
          set status = 'queued', error = null, finished_at = null,
              max_attempts = attempt + $3, lease_owner = null, lease_expires_at = null, updated_at = now()
        where workspace_id = $1 and id = $2`,
      [workspaceId, row.id, env().WORKER_MAX_ATTEMPTS],
    );
    await db.query(
      `update public.captures set status = 'analyzing', status_detail = null, updated_at = now()
        where workspace_id = $1 and id = $2`,
      [workspaceId, captureId],
    );
    await logActivity(db, {
      workspaceId,
      actorId: session.user.id,
      action: 'capture.retried',
      subjectTable: 'captures',
      subjectId: captureId,
      summary: 'Retried a failed capture analysis.',
    });
    return row;
  });
  await requeueRun(workspaceId, run.id, 'capture');
  const capture = await withService((db) => getCapture(db, workspaceId, captureId));
  return capture as CaptureRecord;
}
