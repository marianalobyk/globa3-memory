/**
 * Shared plumbing for every pipeline.
 *
 * Two properties matter here:
 *
 *   Resumability -- `stage()` skips any stage already recorded as succeeded and
 *   returns its stored output. A worker that dies mid-run therefore resumes from
 *   the next unfinished stage instead of repeating (and re-paying for) work.
 *
 *   Accounting -- `record()` writes tokens, web searches and duration against the
 *   stage and the run for every model call, so cost is attributed per stage.
 */
import type { AiProvider, UsageReport } from '../ai/index.js';
import { recordUsage } from '../costs.js';
import { assertScope, withService, type Queryable } from './../db.js';
import {
  finishStage,
  getStages,
  logRunEvent,
  setRunProgress,
  startStage,
  type RunRecord,
  type StageRecord,
} from '../runs.js';

export interface PipelineContext {
  run: RunRecord;
  workspaceId: string;
  provider: AiProvider;
  /** Extends the queue lease; called around long operations. */
  keepAlive: () => Promise<void>;
}

export interface StageHandle {
  record: StageRecord;
  /** Accumulated cost for this stage, in USD. */
  costUsd: number;
  costIsEstimate: boolean;
  tokensIn: number;
  tokensOut: number;
  webSearches: number;
}

export async function loadStageMap(
  workspaceId: string,
  runId: string,
): Promise<Map<string, StageRecord>> {
  const stages = await withService((db) => getStages(db, workspaceId, runId));
  return new Map(stages.map((s) => [s.stage, s]));
}

export async function event(
  ctx: PipelineContext,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  stage?: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await withService((db) => logRunEvent(db, ctx.workspaceId, ctx.run.id, level, message, stage, data));
}

/** Attributes one model call to a stage and returns the money figure. */
export async function accountUsage(
  ctx: PipelineContext,
  stageId: string,
  stage: string,
  operation: string,
  usage: UsageReport,
): Promise<{ costUsd: number; isEstimate: boolean; note: string | null }> {
  return withService((db) =>
    recordUsage(db, {
      workspaceId: ctx.workspaceId,
      runId: ctx.run.id,
      runStageId: stageId,
      stage,
      operation,
      usage,
      isMock: ctx.provider.isMock,
    }),
  );
}

export interface StageResult<T> {
  value: T;
  /** True when the value came from a previous attempt rather than being recomputed. */
  resumed: boolean;
}

/**
 * Runs one stage, or returns the stored output if it already succeeded.
 *
 * `body` receives a mutable handle it can add usage figures to; those are written
 * onto the stage row when it completes.
 */
export async function stage<T>(
  ctx: PipelineContext,
  stageName: string,
  stageIndex: number,
  stageCount: number,
  body: (handle: StageHandle, db: null) => Promise<T>,
): Promise<StageResult<T>> {
  assertScope(ctx.workspaceId, 'stage');
  const existing = await loadStageMap(ctx.workspaceId, ctx.run.id);
  const current = existing.get(stageName);

  if (current?.status === 'succeeded' && current.output !== null && current.output !== undefined) {
    await event(
      ctx,
      'info',
      `Stage "${stageName}" already completed on an earlier attempt; reusing its result.`,
      stageName,
    );
    return { value: current.output as T, resumed: true };
  }

  const started = await withService((db) => startStage(db, ctx.workspaceId, ctx.run.id, stageName));
  await withService((db) =>
    setRunProgress(
      db,
      ctx.workspaceId,
      ctx.run.id,
      Math.round(((stageIndex - 1) / stageCount) * 100),
      stageName,
    ),
  );
  await event(ctx, 'info', `Stage "${stageName}" started.`, stageName);

  const handle: StageHandle = {
    record: started,
    costUsd: 0,
    costIsEstimate: false,
    tokensIn: 0,
    tokensOut: 0,
    webSearches: 0,
  };

  const startedAt = Date.now();
  const value = await body(handle, null);

  await withService((db) =>
    finishStage(db, ctx.workspaceId, ctx.run.id, stageName, value, {
      tokensIn: handle.tokensIn,
      tokensOut: handle.tokensOut,
      webSearches: handle.webSearches,
      durationMs: Date.now() - startedAt,
      costUsd: handle.costUsd,
      costIsEstimate: handle.costIsEstimate,
    }),
  );
  await withService((db) =>
    setRunProgress(
      db,
      ctx.workspaceId,
      ctx.run.id,
      Math.round((stageIndex / stageCount) * 100),
      stageName,
    ),
  );
  await event(ctx, 'info', `Stage "${stageName}" finished.`, stageName);
  return { value, resumed: false };
}

/** Folds a usage report into a stage handle. */
export function addUsage(
  handle: StageHandle,
  usage: UsageReport,
  cost: { costUsd: number; isEstimate: boolean },
): void {
  handle.tokensIn += usage.tokensIn;
  handle.tokensOut += usage.tokensOut;
  handle.webSearches += usage.webSearches;
  handle.costUsd += cost.costUsd;
  handle.costIsEstimate = handle.costIsEstimate || cost.isEstimate;
}

export type { Queryable };
