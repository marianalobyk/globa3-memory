import { env, hasOpenAi } from '../env.js';
import { MockProvider } from './mock.js';
import { OpenAiProvider } from './openai.js';
import type { AiProvider } from './types.js';

export * from './types.js';
export * from './pricing.js';
export { MOCK_PREFIX, MOCK_CAST } from './mock.js';

let provider: AiProvider | null = null;

/**
 * The active provider. Real OpenAI when a key is configured, otherwise the mock
 * -- and callers persist `provider.isMock` so synthetic output is always labelled.
 */
export function getAiProvider(): AiProvider {
  if (!provider) provider = hasOpenAi() ? new OpenAiProvider() : new MockProvider();
  return provider;
}

export function resetAiProviderForTesting(next: AiProvider | null): void {
  provider = next;
}

export interface ModelChoice {
  draft: string;
  research: string;
  deepResearch: string;
  fast: string;
}

export function models(overrides?: Partial<ModelChoice>): ModelChoice {
  const e = env();
  return {
    draft: overrides?.draft ?? e.OPENAI_MODEL,
    research: overrides?.research ?? e.OPENAI_RESEARCH_MODEL,
    deepResearch: overrides?.deepResearch ?? e.OPENAI_DEEP_RESEARCH_MODEL,
    fast: overrides?.fast ?? e.OPENAI_FAST_MODEL,
  };
}
