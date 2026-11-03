// Calls Claude's Messages API with plain fetch (no SDK, so no new dependency). Used offline by
// the mood labeller; nothing calls the model at request time. Retries are fetchWithRetries'
// (ask.ts). No temperature is sent: Claude 5 models reject it.

import { fetchWithRetries, type Ask, type AskResult, type HttpDeps } from './ask';

export const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2023-06-01';

export function createClaude({ apiKey, ...deps }: { apiKey: string } & HttpDeps): Ask {
  return async (req) => {
    const body = JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      ...(req.schema ? { output_config: { format: { type: 'json_schema', schema: req.schema } } } : {}),
    });
    const res = await fetchWithRetries(
      'Claude',
      MESSAGES_URL,
      {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
        body,
      },
      deps,
    );
    return toResult(await res.json());
  };
}

interface MessagesResponse {
  content?: { type?: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string | null;
}

function toResult(json: MessagesResponse): AskResult {
  const blocks = Array.isArray(json.content) ? json.content : [];
  return {
    text: blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(''),
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
    stopReason: json.stop_reason ?? null,
  };
}
