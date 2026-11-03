// The one kind of call the mood labeller makes to a model, whatever the provider: instructions,
// one user message, a JSON schema the reply must follow and a token budget. Each provider module
// (anthropic.ts, openai.ts, gemini.ts) turns it into its own API's request with plain fetch (no
// SDK, so no new dependency) and reads back the text and token counts. Used offline only; nothing
// calls a model at request time. fetch and sleep are injected so tests never touch the network.

export interface AskRequest {
  model: string;
  system: string;
  /** The one user message. */
  user: string;
  maxTokens: number;
  /** JSON schema the reply must follow; unset for free text. */
  schema?: object;
}

export interface AskResult {
  /** The reply's text; thinking is left out. */
  text: string;
  /** Tokens billed in and out (thinking counts as out). */
  inputTokens: number;
  outputTokens: number;
  /**
   * "end_turn" when the reply finished normally, "max_tokens" when it was cut short, "refusal"
   * when the model or a safety filter declined; another provider-specific reason as given.
   */
  stopReason: string | null;
}

export type Ask = (request: AskRequest) => Promise<AskResult>;

export interface HttpDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_TRIES = 3;
const MAX_WAIT_MS = 60_000;
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One HTTP request with retries. Rate limits (429) and server errors (5xx) are retried, at most 3
 * tries in all, waiting as long as the server asks (retry-after, or AcousticBrainz's
 * x-ratelimit-reset-in, up to a minute) or else 1 s, then 2 s. Anything else fails at once. The
 * error names the API, the status and the server's message, never the request's headers, so an
 * API key cannot leak into a log.
 */
export async function fetchWithRetries(
  api: string,
  url: string,
  init: RequestInit,
  { fetch: fetchFn = fetch, sleep = realSleep }: HttpDeps = {},
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetchFn(url, init);
    if (res.ok) return res;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_TRIES) {
      throw new Error(`${api} API ${res.status} after ${attempt} ${attempt === 1 ? 'try' : 'tries'}: ${errorText(await res.text())}`);
    }
    await sleep(waitMs(res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset-in'), attempt));
  }
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
    const json = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    const message = json.error?.message ?? json.message;
    if (typeof message === 'string') return message;
  } catch {
    // not JSON
  }
  return body.slice(0, 200);
}
