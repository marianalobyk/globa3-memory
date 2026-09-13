/**
 * OpenAI provider, on the Responses API.
 *
 * Web search uses the current tool shape `{ type: 'web_search' }`, and requests
 * `web_search_call.action.sources` so the full source list is available rather
 * than only the sources that happened to be cited inline.
 *
 * Long-running research is created with `background: true` and polled by the
 * worker via responses.retrieve(id). The response id is persisted on the run
 * stage, so a worker restart resumes the same research instead of paying for it
 * twice, and nothing depends on an HTTP request or a browser tab staying open.
 */
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';
import { env } from '../env.js';
import { AppError } from '../errors.js';
import type {
  AiProvider,
  BackgroundHandle,
  BackgroundPoll,
  BackgroundStatus,
  CollectedSource,
  GenerateOptions,
  StructuredResult,
  TextResult,
  UsageReport,
} from './types.js';

type AnyResponse = Record<string, unknown> & {
  id?: string;
  status?: string;
  output?: unknown[];
  output_text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
};

const SOURCE_INCLUDE = ['web_search_call.action.sources'] as const;

function mapStatus(status: string | undefined): BackgroundStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'queued':
      return 'queued';
    case 'in_progress':
      return 'in_progress';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
    case 'incomplete':
      return 'failed';
    default:
      return 'in_progress';
  }
}

/** Counts search calls and harvests both inline citations and the source list. */
function collect(response: AnyResponse): { sources: CollectedSource[]; webSearches: number } {
  const seen = new Map<string, CollectedSource>();
  let webSearches = 0;

  const addSource = (url: unknown, title: unknown): void => {
    if (typeof url !== 'string' || url.length === 0) return;
    if (!seen.has(url)) seen.set(url, { url, title: typeof title === 'string' ? title : null });
  };

  for (const item of response.output ?? []) {
    const node = item as Record<string, unknown>;
    if (node.type === 'web_search_call') {
      webSearches += 1;
      const action = node.action as { sources?: unknown[] } | undefined;
      for (const source of action?.sources ?? []) {
        const s = source as Record<string, unknown>;
        addSource(s.url, s.title);
      }
    }
    if (node.type === 'message') {
      for (const part of (node.content as unknown[]) ?? []) {
        const p = part as Record<string, unknown>;
        for (const annotation of (p.annotations as unknown[]) ?? []) {
          const a = annotation as Record<string, unknown>;
          if (a.type === 'url_citation') addSource(a.url, a.title);
        }
      }
    }
  }
  return { sources: [...seen.values()], webSearches };
}

function usageOf(
  response: AnyResponse,
  model: string,
  durationMs: number,
  webSearches: number,
): UsageReport {
  const u = response.usage;
  return {
    model,
    tokensIn: u?.input_tokens ?? 0,
    tokensOut: u?.output_tokens ?? 0,
    reasoningTokens: u?.output_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: u?.input_tokens_details?.cached_tokens ?? 0,
    webSearches,
    durationMs,
    usageIsEstimated: !u || u.input_tokens === undefined,
  };
}

function textOf(response: AnyResponse): string {
  if (typeof response.output_text === 'string' && response.output_text.length > 0) {
    return response.output_text;
  }
  const chunks: string[] = [];
  for (const item of response.output ?? []) {
    const node = item as Record<string, unknown>;
    if (node.type !== 'message') continue;
    for (const part of (node.content as unknown[]) ?? []) {
      const p = part as Record<string, unknown>;
      if (typeof p.text === 'string') chunks.push(p.text);
    }
  }
  return chunks.join('\n').trim();
}

export class OpenAiProvider implements AiProvider {
  readonly kind = 'openai' as const;
  readonly isMock = false;
  private client: OpenAI;

  constructor() {
    const e = env();
    if (!e.OPENAI_API_KEY) throw new AppError('OPENAI_API_KEY is not set', 500, 'missing_api_key');
    this.client = new OpenAI({
      apiKey: e.OPENAI_API_KEY,
      baseURL: e.OPENAI_BASE_URL,
      // Deep research can run for tens of minutes; background mode means the
      // create call returns immediately, but keep a generous ceiling anyway.
      timeout: 15 * 60 * 1000,
      maxRetries: 3,
    });
  }

  private toolList(options: GenerateOptions): Record<string, unknown>[] {
    return (options.tools ?? []).map((tool) => ({ type: tool }));
  }

  async generateStructured<T>(
    options: GenerateOptions & { schema: z.ZodType<T>; schemaName: string },
  ): Promise<StructuredResult<T>> {
    const started = Date.now();
    const tools = this.toolList(options);
    const response = (await this.client.responses.parse({
      model: options.model,
      instructions: options.system,
      input: options.input,
      ...(tools.length > 0 ? { tools: tools as never, include: [...SOURCE_INCLUDE] as never } : {}),
      ...(options.maxOutputTokens ? { max_output_tokens: options.maxOutputTokens } : {}),
      ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
      text: { format: zodTextFormat(options.schema as never, options.schemaName) },
    })) as unknown as AnyResponse & { output_parsed?: T };

    if (response.status && mapStatus(response.status) === 'failed') {
      throw new AppError(
        `Model call "${options.label}" failed: ${response.error?.message ?? response.incomplete_details?.reason ?? 'unknown'}`,
        502,
        'provider_error',
      );
    }
    const parsed = response.output_parsed;
    if (parsed === undefined || parsed === null) {
      throw new AppError(
        `Model call "${options.label}" returned no structured output`,
        502,
        'provider_error',
      );
    }
    const { sources, webSearches } = collect(response);
    return {
      value: parsed,
      usage: usageOf(response, options.model, Date.now() - started, webSearches),
      sources,
      raw: response,
    };
  }

  async generateText(options: GenerateOptions): Promise<TextResult> {
    const started = Date.now();
    const tools = this.toolList(options);
    const response = (await this.client.responses.create({
      model: options.model,
      instructions: options.system,
      input: options.input,
      ...(tools.length > 0 ? { tools: tools as never, include: [...SOURCE_INCLUDE] as never } : {}),
      ...(options.maxOutputTokens ? { max_output_tokens: options.maxOutputTokens } : {}),
      ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
    })) as unknown as AnyResponse;

    const { sources, webSearches } = collect(response);
    return {
      text: textOf(response),
      usage: usageOf(response, options.model, Date.now() - started, webSearches),
      sources,
      raw: response,
    };
  }

  async startBackgroundResearch(options: GenerateOptions): Promise<BackgroundHandle> {
    const response = (await this.client.responses.create({
      model: options.model,
      instructions: options.system,
      input: options.input,
      background: true,
      // Deep research requires at least one data source.
      tools: [{ type: 'web_search' }] as never,
      include: [...SOURCE_INCLUDE] as never,
      ...(options.maxOutputTokens ? { max_output_tokens: options.maxOutputTokens } : {}),
    })) as unknown as AnyResponse;

    if (!response.id) throw new AppError('Background research did not return an id', 502, 'provider_error');
    return { responseId: response.id, status: mapStatus(response.status) };
  }

  async pollBackgroundResearch(responseId: string): Promise<BackgroundPoll> {
    const response = (await this.client.responses.retrieve(responseId)) as unknown as AnyResponse;
    const status = mapStatus(response.status);
    const { sources, webSearches } = collect(response);
    return {
      status,
      text: status === 'completed' ? textOf(response) : null,
      usage: status === 'completed' ? usageOf(response, String(response.model ?? ''), 0, webSearches) : null,
      sources,
      error:
        status === 'failed'
          ? (response.error?.message ?? response.incomplete_details?.reason ?? 'Research failed')
          : null,
    };
  }

  async cancelBackgroundResearch(responseId: string): Promise<void> {
    await this.client.responses.cancel(responseId).catch(() => undefined);
  }
}
