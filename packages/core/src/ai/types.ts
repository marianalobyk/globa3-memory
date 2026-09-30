import type { z } from 'zod';

export type ToolName = 'web_search';

export interface UsageReport {
  model: string;
  tokensIn: number;
  tokensOut: number;
  reasoningTokens: number;
  cachedTokens: number;
  webSearches: number;
  durationMs: number;
  /** True when the provider did not report real token counts. */
  usageIsEstimated: boolean;
}

export interface CollectedSource {
  url: string;
  title: string | null;
}

export interface GenerateOptions {
  model: string;
  system: string;
  input: string;
  tools?: ToolName[];
  maxOutputTokens?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  /**
   * Transport ceiling for a synchronous model call. Long-running research uses
   * the separate background API and is not governed by this value.
   */
  timeoutMs?: number;
  /** Correlation id, logged by the provider adapter. */
  label: string;
}

export interface StructuredResult<T> {
  value: T;
  usage: UsageReport;
  sources: CollectedSource[];
  raw: unknown;
}

export interface TextResult {
  text: string;
  usage: UsageReport;
  sources: CollectedSource[];
  raw: unknown;
}

export type BackgroundStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface BackgroundHandle {
  responseId: string;
  status: BackgroundStatus;
}

export interface BackgroundPoll {
  status: BackgroundStatus;
  text: string | null;
  usage: UsageReport | null;
  sources: CollectedSource[];
  error: string | null;
}

export interface AiProvider {
  readonly kind: 'openai' | 'mock';
  /** True when outputs are synthetic and must be labelled as such. */
  readonly isMock: boolean;

  generateStructured<T>(
    options: GenerateOptions & { schema: z.ZodType<T>; schemaName: string },
  ): Promise<StructuredResult<T>>;

  generateText(options: GenerateOptions): Promise<TextResult>;

  /**
   * Starts long-running research as a background response. Nothing about it
   * depends on the caller staying connected: the id is persisted and polled by
   * the worker, across restarts if necessary.
   */
  startBackgroundResearch(options: GenerateOptions): Promise<BackgroundHandle>;
  pollBackgroundResearch(responseId: string): Promise<BackgroundPoll>;
  cancelBackgroundResearch(responseId: string): Promise<void>;
}
