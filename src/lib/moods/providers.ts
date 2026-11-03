// The model providers the mood labeller can use (moods:label --provider). Each has its own API
// client, key variable and default model, and its labels are stored under its source name, which
// the import's precedence reads (merge.ts).

import { createClaude } from './anthropic';
import type { Ask, HttpDeps } from './ask';
import { createGemini } from './gemini';
import { createOpenAI } from './openai';

export type Provider = 'anthropic' | 'openai' | 'gemini';
export const PROVIDER_NAMES: Provider[] = ['anthropic', 'openai', 'gemini'];

export interface ProviderInfo {
  /** Environment variable holding the API key. */
  keyEnv: string;
  defaultModel: string;
  /** Source of its rows in the store; "claude" for Anthropic, as before there were providers. */
  source: string;
  create: (opts: { apiKey: string } & HttpDeps) => Ask;
}

export const PROVIDERS: Record<Provider, ProviderInfo> = {
  anthropic: { keyEnv: 'ANTHROPIC_API_KEY', defaultModel: 'claude-haiku-5-5', source: 'claude', create: createClaude },
  openai: { keyEnv: 'OPENAI_API_KEY', defaultModel: 'gpt-6-luna', source: 'openai', create: createOpenAI },
  gemini: { keyEnv: 'GEMINI_API_KEY', defaultModel: 'gemini-3.8-flash', source: 'gemini', create: createGemini },
};

export const isProvider = (v: unknown): v is Provider => typeof v === 'string' && (PROVIDER_NAMES as string[]).includes(v);
