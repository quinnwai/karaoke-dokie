// Calls OpenAI's Chat Completions API with plain fetch (no SDK, so no new dependency). Used
// offline by the mood labeller; nothing calls the model at request time. Retries are
// fetchWithRetries' (ask.ts). No sampling settings are sent: OpenAI's reasoning models accept
// only their defaults, and the labeller wants the model's default behaviour anyway.

import { fetchWithRetries, type Ask, type AskResult, type HttpDeps } from './ask';

export const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

export function createOpenAI({ apiKey, ...deps }: { apiKey: string } & HttpDeps): Ask {
  return async (req) => {
    const body = JSON.stringify({
      model: req.model,
      // Reasoning models count their thinking against this budget too.
      max_completion_tokens: req.maxTokens,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      // Strict mode makes the API hold the reply to the schema; parseLabels still checks it.
      ...(req.schema ? { response_format: { type: 'json_schema', json_schema: { name: 'reply', strict: true, schema: req.schema } } } : {}),
    });
    const res = await fetchWithRetries(
      'OpenAI',
      CHAT_URL,
      { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body },
      deps,
    );
    return toResult(await res.json());
  };
}

interface ChatResponse {
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** OpenAI's finish reasons in the labeller's terms (see AskResult.stopReason). */
const STOP: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', content_filter: 'refusal' };

function toResult(json: ChatResponse): AskResult {
  const choice = json.choices?.[0];
  const reason = choice?.finish_reason ?? null;
  return {
    text: typeof choice?.message?.content === 'string' ? choice.message.content : '',
    inputTokens: json.usage?.prompt_tokens ?? 0,
    // Includes the reasoning tokens, which are billed as output.
    outputTokens: json.usage?.completion_tokens ?? 0,
    stopReason: choice?.message?.refusal ? 'refusal' : reason === null ? null : (STOP[reason] ?? reason),
  };
}
