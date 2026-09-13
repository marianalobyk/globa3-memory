/**
 * Model prices, used to turn token counts into money.
 *
 * No prices ship with the repository, on purpose: a wrong hardcoded price is
 * worse than an absent one, because it looks authoritative. Configure them and
 * the UI reports real spend; leave them unset and the UI reports token counts
 * with "price not configured" instead of inventing a number.
 *
 * Two ways to configure, checked in this order:
 *   1. OPENAI_PRICES_JSON  - inline JSON, same shape as the file
 *   2. config/model-prices.json at the repository root
 *
 * Shape: { "prices": { "<model>": { "inputPerMTok": 1.25, "outputPerMTok": 10,
 *                                   "webSearchPerCall": 0.01 } } }
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { UsageReport } from './types.js';

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok?: number;
  webSearchPerCall?: number;
}

let priceTable: Record<string, ModelPrice> | null = null;

function loadPrices(): Record<string, ModelPrice> {
  if (priceTable) return priceTable;
  const inline = process.env.OPENAI_PRICES_JSON;
  if (inline) {
    try {
      priceTable = (JSON.parse(inline).prices ?? {}) as Record<string, ModelPrice>;
      return priceTable;
    } catch (error) {
      console.warn('[pricing] OPENAI_PRICES_JSON is not valid JSON, ignoring:', error);
    }
  }
  for (const candidate of ['config/model-prices.json', '../config/model-prices.json', '../../config/model-prices.json']) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(process.cwd(), candidate), 'utf8')) as {
        prices?: Record<string, ModelPrice>;
      };
      priceTable = parsed.prices ?? {};
      return priceTable;
    } catch {
      // try the next location
    }
  }
  priceTable = {};
  return priceTable;
}

export function hasPriceFor(model: string): boolean {
  return Boolean(loadPrices()[model]);
}

export interface CostResult {
  costUsd: number;
  /**
   * True when the figure must be shown to the user as an estimate: either the
   * token counts were not reported, or no price is configured for the model.
   */
  isEstimate: boolean;
  note: string | null;
}

export function computeCost(usage: UsageReport): CostResult {
  const price = loadPrices()[usage.model];
  if (!price) {
    return {
      costUsd: 0,
      isEstimate: true,
      note: `No price configured for "${usage.model}". Set OPENAI_PRICES_JSON or config/model-prices.json to report spend.`,
    };
  }
  const billableInput = Math.max(0, usage.tokensIn - usage.cachedTokens);
  const cached = usage.cachedTokens;
  const cost =
    (billableInput / 1_000_000) * price.inputPerMTok +
    (cached / 1_000_000) * (price.cachedInputPerMTok ?? price.inputPerMTok) +
    (usage.tokensOut / 1_000_000) * price.outputPerMTok +
    usage.webSearches * (price.webSearchPerCall ?? 0);

  return {
    costUsd: Number(cost.toFixed(6)),
    isEstimate: usage.usageIsEstimated,
    note: usage.usageIsEstimated ? 'Token counts were not reported by the provider.' : null,
  };
}

/** Test seam. */
export function __setPricesForTesting(prices: Record<string, ModelPrice> | null): void {
  priceTable = prices;
}
