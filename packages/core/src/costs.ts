/**
 * Time and API usage accounting.
 *
 * Every model call records tokens, web searches and duration against the run and
 * the stage. Money is only claimed when a price is configured for the model;
 * otherwise the figure is flagged as an estimate with the reason, so the UI never
 * presents an invented number as actual spend.
 */
import type { CostSummary } from '@g3/shared';
import { computeCost } from './ai/pricing.js';
import type { UsageReport } from './ai/types.js';
import { assertScope, type Queryable } from './db.js';
import { budgetExceeded } from './errors.js';

export interface RecordUsageInput {
  workspaceId: string;
  runId?: string | null;
  runStageId?: string | null;
  stage?: string | null;
  operation: string;
  usage: UsageReport;
  isMock: boolean;
}

export async function recordUsage(
  db: Queryable,
  input: RecordUsageInput,
): Promise<{ costUsd: number; isEstimate: boolean; note: string | null }> {
  assertScope(input.workspaceId, 'recordUsage');
  const cost = computeCost(input.usage);
  await db.query(
    `insert into public.usage_events
       (workspace_id, run_id, run_stage_id, stage, provider, model, operation,
        tokens_in, tokens_out, reasoning_tokens, cached_tokens, web_searches,
        duration_ms, cost_usd, is_estimate, is_mock)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      input.workspaceId,
      input.runId ?? null,
      input.runStageId ?? null,
      input.stage ?? null,
      input.isMock ? 'mock' : 'openai',
      input.usage.model,
      input.operation,
      input.usage.tokensIn,
      input.usage.tokensOut,
      input.usage.reasoningTokens,
      input.usage.cachedTokens,
      input.usage.webSearches,
      input.usage.durationMs,
      cost.costUsd,
      cost.isEstimate,
      input.isMock,
    ],
  );
  return cost;
}

export async function runCostSummary(
  db: Queryable,
  workspaceId: string,
  runId: string,
): Promise<CostSummary> {
  assertScope(workspaceId, 'runCostSummary');
  const rows = await db.rows<{
    stage: string | null;
    model: string | null;
    cost_usd: string;
    is_estimate: boolean;
    tokens_in: number;
    tokens_out: number;
  }>(
    `select stage, model, cost_usd, is_estimate, tokens_in, tokens_out
       from public.usage_events where workspace_id = $1 and run_id = $2`,
    [workspaceId, runId],
  );
  return summarize(rows);
}

export async function workspaceCostSummary(
  db: Queryable,
  workspaceId: string,
  sinceDays = 30,
): Promise<CostSummary & { periodDays: number }> {
  assertScope(workspaceId, 'workspaceCostSummary');
  const rows = await db.rows<{
    stage: string | null;
    model: string | null;
    cost_usd: string;
    is_estimate: boolean;
    tokens_in: number;
    tokens_out: number;
  }>(
    `select stage, model, cost_usd, is_estimate, tokens_in, tokens_out
       from public.usage_events
      where workspace_id = $1 and created_at >= now() - ($2::int || ' days')::interval`,
    [workspaceId, sinceDays],
  );
  return { ...summarize(rows), periodDays: sinceDays };
}

function summarize(
  rows: {
    stage: string | null;
    model: string | null;
    cost_usd: string;
    is_estimate: boolean;
    tokens_in: number;
    tokens_out: number;
  }[],
): CostSummary {
  const byStage = new Map<string, { usd: number; isEstimate: boolean }>();
  const byModel = new Map<string, { usd: number; tokensIn: number; tokensOut: number }>();
  let total = 0;
  let hasEstimates = false;

  for (const row of rows) {
    const usd = Number(row.cost_usd ?? 0);
    total += usd;
    if (row.is_estimate) hasEstimates = true;
    const stage = row.stage ?? 'other';
    const stageEntry = byStage.get(stage) ?? { usd: 0, isEstimate: false };
    stageEntry.usd += usd;
    stageEntry.isEstimate = stageEntry.isEstimate || row.is_estimate;
    byStage.set(stage, stageEntry);

    const model = row.model ?? 'unknown';
    const modelEntry = byModel.get(model) ?? { usd: 0, tokensIn: 0, tokensOut: 0 };
    modelEntry.usd += usd;
    modelEntry.tokensIn += row.tokens_in;
    modelEntry.tokensOut += row.tokens_out;
    byModel.set(model, modelEntry);
  }

  return {
    totalUsd: Number(total.toFixed(6)),
    hasEstimates,
    byStage: [...byStage.entries()].map(([stage, v]) => ({
      stage,
      usd: Number(v.usd.toFixed(6)),
      isEstimate: v.isEstimate,
    })),
    byModel: [...byModel.entries()].map(([model, v]) => ({
      model,
      usd: Number(v.usd.toFixed(6)),
      tokensIn: v.tokensIn,
      tokensOut: v.tokensOut,
    })),
  };
}

export interface BudgetState {
  period: 'day' | 'month';
  limitUsd: number;
  spentUsd: number;
  hardStop: boolean;
  exceeded: boolean;
  /** True when spend is only an estimate, so the check is advisory. */
  spendIsEstimate: boolean;
}

export async function budgetStates(db: Queryable, workspaceId: string): Promise<BudgetState[]> {
  assertScope(workspaceId, 'budgetStates');
  const budgets = await db.rows<{
    period: 'day' | 'month';
    limit_usd: string;
    hard_stop: boolean;
    total: string;
    estimated: boolean;
  }>(
    `select b.period, b.limit_usd, b.hard_stop,
            coalesce(sum(u.cost_usd), 0)::text as total,
            coalesce(bool_or(u.is_estimate), false) as estimated
       from public.budgets b
       left join public.usage_events u
         on u.workspace_id = b.workspace_id
        and u.created_at >= date_trunc(b.period, now())
      where b.workspace_id = $1
      group by b.period, b.limit_usd, b.hard_stop`,
    [workspaceId],
  );
  return budgets.map((budget) => {
    const spentUsd = Number(budget.total);
    const limitUsd = Number(budget.limit_usd);
    return {
      period: budget.period,
      limitUsd,
      spentUsd: Number(spentUsd.toFixed(6)),
      hardStop: budget.hard_stop,
      exceeded: spentUsd >= limitUsd,
      spendIsEstimate: budget.estimated,
    };
  });
}

/**
 * Refuses to start new work when a hard-stop budget is exhausted. A soft budget
 * returns its state for the UI to warn with, rather than blocking.
 */
export async function assertBudgetAllows(db: Queryable, workspaceId: string): Promise<BudgetState[]> {
  const states = await budgetStates(db, workspaceId);
  const blocking = states.find((s) => s.hardStop && s.exceeded);
  if (blocking) {
    throw budgetExceeded(
      `The ${blocking.period} budget of $${blocking.limitUsd.toFixed(2)} is exhausted ($${blocking.spentUsd.toFixed(2)} used). Raise the limit or disable the hard stop to continue.`,
      blocking,
    );
  }
  return states;
}
