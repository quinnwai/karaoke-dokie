// Calls Claude's Messages API with plain fetch (no SDK, so no new dependency). Used offline by
// the mood labeller; nothing calls the model at request time. fetch and sleep are injected so
// tests never touch the network.
// Rate limits (429) and server errors (5xx) are retried, at most 3 tries in all, waiting as long
// as the API's retry-after header asks (up to a minute) or else 1 s, then 2 s. Anything else
// fails at once. No temperature is sent: Claude 5 models reject it.

export const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2023-06-01';
const MAX_TRIES = 3;
const MAX_WAIT_MS = 60_000;

export interface AskRequest {
  model: string;
  system: string;
  /** The one user message. */
  user: string;
  maxTokens: number;
  /** JSON schema the reply must follow (output_config.format); unset for free text. */
  schema?: object;
}

export interface AskResult {
  /** The reply's text blocks joined; thinking blocks are left out. */
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

export type Ask = (request: AskRequest) => Promise<AskResult>;

export function createClaude({
  apiKey,
  fetch: fetchFn = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Ask {
  return async (req) => {
    const body = JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      ...(req.schema ? { output_config: { format: { type: 'json_schema', schema: req.schema } } } : {}),
    });
    for (let attempt = 1; ; attempt++) {
      const res = await fetchFn(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
        body,
      });
      if (res.ok) return toResult(await res.json());
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_TRIES) {
        throw new Error(`Claude API ${res.status} after ${attempt} ${attempt === 1 ? 'try' : 'tries'}: ${errorText(await res.text())}`);
      }
      await sleep(waitMs(res.headers.get('retry-after'), attempt));
    }
  };
}

function waitMs(retryAfter: string | null, attempt: number): number {
  const seconds = Number(retryAfter);
  if (retryAfter !== null && retryAfter.trim() !== '' && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_WAIT_MS);
  }
  return 1000 * 2 ** (attempt - 1);
}

/** The API's own error message when the body is its JSON error, else the start of the body. */
function errorText(body: string): string {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    if (typeof message === 'string') return message;
  } catch {
    // not JSON
  }
  return body.slice(0, 200);
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
