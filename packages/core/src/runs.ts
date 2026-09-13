/**
 * Run orchestration: creation, leasing, progress, retries, crash recovery.
 *
 * A run is a durable row, not an in-flight HTTP request. The web server only
 * validates and enqueues; the worker leases the job, records progress per stage
 * and can resume a partially finished run after a restart because every
 * succeeded stage stores its output.
 */
import { randomUUID } from 'node:crypto';
import type { RunKind, RunStatus, Session, StageStatus } from '@g3/shared';
import { requireWorkspace } from './auth.js';
import { assertScope, isUniqueViolation, withService, type Queryable } from './db.js';
import { env } from './env.js';
import { badRequest, notFound } from './errors.js';
import { logActivity } from './activity.js';
import { assertBudgetAllows } from './costs.js';
import { QUEUE_INGEST, QUEUE_RUNS, sendJob } from './queue.js';

export interface StageDefinition {
  stage: string;
  label: string;
}

export const STAGE_PLANS: Record<RunKind, StageDefinition[]> = {
  brief: [
    { stage: 'preflight', label: 'Validate run metadata and load context' },
    { stage: 'research', label: 'Search sources across every mandatory lane' },
    { stage: 'draft', label: 'Write the reader-facing brief' },
    { stage: 'qa', label: 'Run the QA and release gate' },
    { stage: 'extract', label: 'Extract findings, entities and gaps' },
    { stage: 'persist', label: 'Save the brief, sources and research topics' },
  ],
  research: [
    { stage: 'plan', label: 'Plan the deepened questions per topic' },
    { stage: 'deep_research', label: 'Run deep research in the background' },
    { stage: 'synthesize', label: 'Separate facts, inferences, recommendations and gaps' },
    { stage: 'propose', label: 'Resolve entities and build the proposed changes' },
  ],
  ingest: [
    { stage: 'expand', label: 'Read the upload and expand any archive' },
    { stage: 'parse', label: 'Split into briefs and dossiers' },
    { stage: 'persist', label: 'Save documents and detected formats' },
  ],
  ask: [
    { stage: 'retrieve', label: 'Search stored records' },
    { stage: 'answer', label: 'Answer with citations to those records' },
  ],
  report: [
    { stage: 'collect', label: 'Collect the day\'s applied changes' },
    { stage: 'render', label: 'Render the Markdown report' },
  ],
};

export interface RunRecord {
  id: string;
  workspace_id: string;
  kind: RunKind;
  format_id: string | null;
  prompt_version_id: string | null;
  status: RunStatus;
  run_date: string | null;
  run_variables: Record<string, unknown>;
  input: Record<string, unknown>;
  model: string | null;
  idempotency_key: string;
  attempt: number;
  max_attempts: number;
  progress: number;
  current_stage: string | null;
  stage_count: number | null;
  error: string | null;
  is_mock: boolean;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  queue_msg_id: string | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface StageRecord {
  id: string;
  run_id: string;
  seq: number;
  stage: string;
  label: string | null;
  status: StageStatus;
  progress: number;
  output: unknown;
  provider_response_id: string | null;
  provider_status: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: string | null;
  cost_is_estimate: boolean;
  attempt: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface CreateRunInput {
  session: Session;
  workspaceId: string;
  kind: RunKind;
  formatId?: string | null;
  promptVersionId?: string | null;
  runDate?: string | null;
  input?: Record<string, unknown>;
  runVariables?: Record<string, unknown>;
  model?: string | null;
  /** Deterministic key. The same logical request never creates a second run. */
  idempotencyKey: string;
  isMock: boolean;
  queue?: string;
}

export interface CreateRunResult {
  run: RunRecord;
  created: boolean;
  budgetWarnings: string[];
}

export async function createRun(input: CreateRunInput): Promise<CreateRunResult> {
  const workspaceId = assertScope(input.workspaceId, 'createRun');
  requireWorkspace(input.session, workspaceId);

  return withService(async (db) => {
    // A hard-stop budget blocks new work; a soft one only warns.
    const budgets = await assertBudgetAllows(db, workspaceId);
    const budgetWarnings = budgets
      .filter((b) => b.exceeded && !b.hardStop)
      .map(
        (b) =>
          `The ${b.period} budget of $${b.limitUsd.toFixed(2)} is exceeded ($${b.spentUsd.toFixed(2)}${b.spendIsEstimate ? ', estimated' : ''}).`,
      );

    const existing = await db.one<RunRecord>(
      `select * from public.runs where workspace_id = $1 and idempotency_key = $2`,
      [workspaceId, input.idempotencyKey],
    );
    if (existing) return { run: existing, created: false, budgetWarnings };

    const plan = STAGE_PLANS[input.kind];
    let run: RunRecord;
    try {
      run = await db.oneOrFail<RunRecord>(
        `insert into public.runs
           (workspace_id, kind, format_id, prompt_version_id, run_date, run_variables, input,
            model, idempotency_key, max_attempts, stage_count, is_mock, created_by, status)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,'queued')
         returning *`,
        [
          workspaceId,
          input.kind,
          input.formatId ?? null,
          input.promptVersionId ?? null,
          input.runDate ?? null,
          JSON.stringify(input.runVariables ?? {}),
          JSON.stringify(input.input ?? {}),
          input.model ?? null,
          input.idempotencyKey,
          env().WORKER_MAX_ATTEMPTS,
          plan.length,
          input.isMock,
          input.session.user.id,
        ],
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Two concurrent requests for the same logical run: return the winner.
      const raced = await db.oneOrFail<RunRecord>(
        `select * from public.runs where workspace_id = $1 and idempotency_key = $2`,
        [workspaceId, input.idempotencyKey],
      );
      return { run: raced, created: false, budgetWarnings };
    }

    for (const [index, stage] of plan.entries()) {
      await db.query(
        `insert into public.run_stages (workspace_id, run_id, seq, stage, label)
         values ($1,$2,$3,$4,$5)`,
        [workspaceId, run.id, index + 1, stage.stage, stage.label],
      );
    }

    const queue = input.queue ?? (input.kind === 'ingest' ? QUEUE_INGEST : QUEUE_RUNS);
    const msgId = await sendJob(db, queue, {
      runId: run.id,
      workspaceId,
      kind: input.kind,
      enqueuedAt: new Date().toISOString(),
    });
    await db.query(`update public.runs set queue_msg_id = $3 where workspace_id = $1 and id = $2`, [
      workspaceId,
      run.id,
      msgId,
    ]);

    await logActivity(db, {
      workspaceId,
      actorId: input.session.user.id,
      action: `run.created`,
      subjectTable: 'runs',
      subjectId: run.id,
      summary: `Queued a ${input.kind} run${input.runDate ? ` for ${input.runDate}` : ''}.`,
      data: { kind: input.kind, idempotencyKey: input.idempotencyKey, isMock: input.isMock },
    });

    return { run: { ...run, queue_msg_id: msgId }, created: true, budgetWarnings };
  });
}

/**
 * Claims a run for this worker by taking a lease. Returns null when another
 * worker already holds a live lease, which is what keeps a duplicate queue
 * delivery from running the same job twice.
 */
export async function claimRun(
  runId: string,
  workerId: string,
  leaseSeconds: number,
): Promise<RunRecord | null> {
  return withService(async (db) => {
    const claimed = await db.one<RunRecord>(
      `update public.runs
          set status = 'running',
              lease_owner = $2,
              lease_expires_at = now() + ($3::int || ' seconds')::interval,
              heartbeat_at = now(),
              attempt = attempt + 1,
              started_at = coalesce(started_at, now()),
              error = null,
              updated_at = now()
        where id = $1
          and status in ('queued', 'running')
          and (lease_owner is null or lease_owner = $2 or lease_expires_at < now())
        returning *`,
      [runId, workerId, leaseSeconds],
    );
    return claimed ?? null;
  });
}

export async function heartbeatRun(
  runId: string,
  workerId: string,
  leaseSeconds: number,
): Promise<boolean> {
  return withService(async (db) => {
    const result = await db.query(
      `update public.runs
          set heartbeat_at = now(),
              lease_expires_at = now() + ($3::int || ' seconds')::interval,
              updated_at = now()
        where id = $1 and lease_owner = $2 and status = 'running'`,
      [runId, workerId, leaseSeconds],
    );
    return (result.rowCount ?? 0) > 0;
  });
}

export async function setRunProgress(
  db: Queryable,
  workspaceId: string,
  runId: string,
  progress: number,
  currentStage: string | null,
): Promise<void> {
  assertScope(workspaceId, 'setRunProgress');
  await db.query(
    `update public.runs set progress = $3, current_stage = $4, updated_at = now()
      where workspace_id = $1 and id = $2`,
    [workspaceId, runId, Math.max(0, Math.min(100, Math.round(progress))), currentStage],
  );
}

export async function logRunEvent(
  db: Queryable,
  workspaceId: string,
  runId: string,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  stage?: string | null,
  data?: Record<string, unknown>,
): Promise<void> {
  assertScope(workspaceId, 'logRunEvent');
  await db.query(
    `insert into public.run_events (workspace_id, run_id, level, stage, message, data)
     values ($1,$2,$3,$4,$5,$6::jsonb)`,
    [workspaceId, runId, level, stage ?? null, message, JSON.stringify(data ?? {})],
  );
}

export async function getStages(
  db: Queryable,
  workspaceId: string,
  runId: string,
): Promise<StageRecord[]> {
  assertScope(workspaceId, 'getStages');
  return db.rows<StageRecord>(
    `select * from public.run_stages where workspace_id = $1 and run_id = $2 order by seq`,
    [workspaceId, runId],
  );
}

export async function startStage(
  db: Queryable,
  workspaceId: string,
  runId: string,
  stage: string,
): Promise<StageRecord> {
  assertScope(workspaceId, 'startStage');
  const row = await db.one<StageRecord>(
    `update public.run_stages
        set status = 'running', started_at = coalesce(started_at, now()),
            attempt = attempt + 1, error = null, updated_at = now()
      where workspace_id = $1 and run_id = $2 and stage = $3
      returning *`,
    [workspaceId, runId, stage],
  );
  if (!row) throw notFound(`Stage "${stage}" does not exist on this run`);
  return row;
}

export async function finishStage(
  db: Queryable,
  workspaceId: string,
  runId: string,
  stage: string,
  output: unknown,
  metrics?: {
    tokensIn?: number;
    tokensOut?: number;
    webSearches?: number;
    durationMs?: number;
    costUsd?: number;
    costIsEstimate?: boolean;
  },
): Promise<void> {
  assertScope(workspaceId, 'finishStage');
  await db.query(
    `update public.run_stages
        set status = 'succeeded', progress = 100, finished_at = now(),
            output = $4::jsonb,
            tokens_in = coalesce($5, tokens_in),
            tokens_out = coalesce($6, tokens_out),
            web_searches = coalesce($7, web_searches),
            duration_ms = coalesce($8, duration_ms),
            cost_usd = coalesce($9, cost_usd),
            cost_is_estimate = coalesce($10, cost_is_estimate),
            updated_at = now()
      where workspace_id = $1 and run_id = $2 and stage = $3`,
    [
      workspaceId,
      runId,
      stage,
      JSON.stringify(output ?? null),
      metrics?.tokensIn ?? null,
      metrics?.tokensOut ?? null,
      metrics?.webSearches ?? null,
      metrics?.durationMs ?? null,
      metrics?.costUsd ?? null,
      metrics?.costIsEstimate ?? null,
    ],
  );
}

export async function recordStageProviderResponse(
  db: Queryable,
  workspaceId: string,
  runId: string,
  stage: string,
  responseId: string,
  providerStatus: string,
): Promise<void> {
  assertScope(workspaceId, 'recordStageProviderResponse');
  await db.query(
    `update public.run_stages
        set provider_response_id = $4, provider_status = $5, updated_at = now()
      where workspace_id = $1 and run_id = $2 and stage = $3`,
    [workspaceId, runId, stage, responseId, providerStatus],
  );
}

export async function failStage(
  db: Queryable,
  workspaceId: string,
  runId: string,
  stage: string,
  error: string,
): Promise<void> {
  assertScope(workspaceId, 'failStage');
  await db.query(
    `update public.run_stages
        set status = 'failed', finished_at = now(), error = $4, updated_at = now()
      where workspace_id = $1 and run_id = $2 and stage = $3`,
    [workspaceId, runId, stage, error.slice(0, 4000)],
  );
}

export async function completeRun(workspaceId: string, runId: string): Promise<void> {
  await withService(async (db) => {
    await db.query(
      `update public.runs
          set status = 'succeeded', progress = 100, current_stage = null,
              finished_at = now(), lease_owner = null, lease_expires_at = null, updated_at = now()
        where workspace_id = $1 and id = $2`,
      [workspaceId, runId],
    );
    await logActivity(db, {
      workspaceId,
      actorKind: 'worker',
      action: 'run.succeeded',
      subjectTable: 'runs',
      subjectId: runId,
      summary: 'Run completed.',
    });
  });
}

export interface FailRunOutcome {
  willRetry: boolean;
  attempt: number;
  maxAttempts: number;
}

/**
 * Records a failure. A run below its attempt ceiling goes back to `queued` so the
 * queue can redeliver it; at the ceiling it is marked failed and left alone.
 */
export async function failRun(
  workspaceId: string,
  runId: string,
  error: unknown,
  stage?: string | null,
): Promise<FailRunOutcome> {
  const message = error instanceof Error ? error.message : String(error);
  return withService(async (db) => {
    const run = await db.oneOrFail<{ attempt: number; max_attempts: number }>(
      `select attempt, max_attempts from public.runs where workspace_id = $1 and id = $2`,
      [workspaceId, runId],
    );
    const willRetry = run.attempt < run.max_attempts;
    await db.query(
      `update public.runs
          set status = $3,
              error = $4,
              error_detail = $5::jsonb,
              current_stage = $6,
              lease_owner = null,
              lease_expires_at = null,
              finished_at = case when $3 = 'failed' then now() else null end,
              updated_at = now()
        where workspace_id = $1 and id = $2`,
      [
        workspaceId,
        runId,
        willRetry ? 'queued' : 'failed',
        message.slice(0, 4000),
        JSON.stringify({
          stage: stage ?? null,
          attempt: run.attempt,
          maxAttempts: run.max_attempts,
          stack: error instanceof Error ? error.stack?.slice(0, 4000) : null,
        }),
        stage ?? null,
      ],
    );
    await logRunEvent(
      db,
      workspaceId,
      runId,
      'error',
      willRetry
        ? `Attempt ${run.attempt} of ${run.max_attempts} failed; the run will be retried. ${message}`
        : `Attempt ${run.attempt} of ${run.max_attempts} failed; giving up. ${message}`,
      stage,
    );
    return { willRetry, attempt: run.attempt, maxAttempts: run.max_attempts };
  });
}

/**
 * Returns runs whose worker died: status `running` with an expired lease. The
 * queue redelivers the message on its own, so this exists for visibility and for
 * runs whose queue message was already archived.
 */
export async function reclaimStaleRuns(graceSeconds = 0): Promise<RunRecord[]> {
  return withService(async (db) => {
    const stale = await db.rows<RunRecord>(
      `update public.runs
          set status = 'queued', lease_owner = null, lease_expires_at = null, updated_at = now()
        where status = 'running'
          and lease_expires_at is not null
          and lease_expires_at < now() - ($1::int || ' seconds')::interval
        returning *`,
      [graceSeconds],
    );
    for (const run of stale) {
      await logRunEvent(
        db,
        run.workspace_id,
        run.id,
        'warn',
        `Lease expired while the run was in progress (worker "${run.lease_owner ?? 'unknown'}"). Requeued for another worker; finished stages will be skipped.`,
        run.current_stage,
      );
    }
    return stale;
  });
}

/** Re-enqueues a requeued run whose queue message is gone. */
export async function requeueRun(workspaceId: string, runId: string, kind: RunKind): Promise<void> {
  await withService(async (db) => {
    const msgId = await sendJob(db, kind === 'ingest' ? QUEUE_INGEST : QUEUE_RUNS, {
      runId,
      workspaceId,
      kind,
      enqueuedAt: new Date().toISOString(),
    });
    await db.query(`update public.runs set queue_msg_id = $3 where workspace_id = $1 and id = $2`, [
      workspaceId,
      runId,
      msgId,
    ]);
  });
}

export async function getRun(
  db: Queryable,
  workspaceId: string,
  runId: string,
): Promise<RunRecord | null> {
  assertScope(workspaceId, 'getRun');
  return db.one<RunRecord>(`select * from public.runs where workspace_id = $1 and id = $2`, [
    workspaceId,
    runId,
  ]);
}

export function newRunId(): string {
  return randomUUID();
}

/** `amv_daily_2026-09-11_001`, the shape the run prompts expect for RUN_ID. */
export function formatRunId(formatKey: string, runDate: string, attempt = 1): string {
  return `${formatKey}_${runDate}_${String(attempt).padStart(3, '0')}`;
}

export function briefIdempotencyKey(formatKey: string, runDate: string, suffix?: string): string {
  return `brief:${formatKey}:${runDate}${suffix ? `:${suffix}` : ''}`;
}

export function researchIdempotencyKey(briefDocumentId: string, topicIds: string[]): string {
  return `research:${briefDocumentId}:${[...topicIds].sort().join(',')}`;
}

export function assertRunDate(runDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
    throw badRequest(`Run date must be YYYY-MM-DD, received "${runDate}"`);
  }
  return runDate;
}
