import { describe, expect, it } from 'vitest';
import { API_VERSION, createClaude, MESSAGES_URL, type AskRequest } from '../../src/lib/moods/anthropic';

const request: AskRequest = { model: 'claude-haiku-5-5', system: 'Label songs.', user: 'Label these 1 songs', maxTokens: 1000, schema: { type: 'object' } };

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fail = (status: number, message = 'nope', headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: 'error', error: { type: 'x', message } }), { status, headers });
const reply = {
  content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: '{"labels":' },
    { type: 'text', text: '[]}' },
  ],
  usage: { input_tokens: 1200, output_tokens: 340 },
  stop_reason: 'end_turn',
};

/** A fetch that answers from a list and records each call, and a sleep that records waits. */
function fakes(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const waits: number[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    return next;
  }) as unknown as typeof globalThis.fetch;
  const sleep = async (ms: number) => void waits.push(ms);
  return { calls, waits, fetch, sleep };
}

describe('createClaude', () => {
  it('posts one message with the API key and version headers, structured output and no sampling settings', async () => {
    const f = fakes([ok(reply)]);
    const result = await createClaude({ apiKey: 'test-key', fetch: f.fetch, sleep: f.sleep })(request);

    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe(MESSAGES_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    expect(API_VERSION).toBe('2023-06-01');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 1000,
      system: 'Label songs.',
      messages: [{ role: 'user', content: 'Label these 1 songs' }],
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
    });
    for (const sampling of ['temperature', 'top_p', 'top_k']) expect(body).not.toHaveProperty(sampling);

    // Text blocks joined, thinking left out.
    expect(result).toEqual({ text: '{"labels":[]}', inputTokens: 1200, outputTokens: 340, stopReason: 'end_turn' });
    expect(f.waits).toEqual([]);
  });

  it('leaves out output_config when no schema is given', async () => {
    const f = fakes([ok(reply)]);
    await createClaude({ apiKey: 'k', fetch: f.fetch, sleep: f.sleep })({ ...request, schema: undefined });
    expect(JSON.parse(String(f.calls[0]!.init.body))).not.toHaveProperty('output_config');
  });

  it('retries rate limits and server errors with backoff, then succeeds', async () => {
    const f = fakes([fail(429), fail(529, 'Overloaded'), ok(reply)]);
    const result = await createClaude({ apiKey: 'k', fetch: f.fetch, sleep: f.sleep })(request);
    expect(f.calls).toHaveLength(3);
    expect(f.waits).toEqual([1000, 2000]);
    expect(result.text).toBe('{"labels":[]}');
  });

  it('waits as long as retry-after asks, up to a minute', async () => {
    const f = fakes([fail(429, 'slow down', { 'retry-after': '7' }), fail(503, 'busy', { 'retry-after': '600' }), ok(reply)]);
    await createClaude({ apiKey: 'k', fetch: f.fetch, sleep: f.sleep })(request);
    expect(f.waits).toEqual([7000, 60_000]);
  });

  it('gives up after 3 tries with the status and the API message', async () => {
    const f = fakes([fail(500), fail(502), fail(500, 'Internal server error'), ok(reply)]);
    await expect(createClaude({ apiKey: 'k', fetch: f.fetch, sleep: f.sleep })(request)).rejects.toThrow(
      'Claude API 500 after 3 tries: Internal server error',
    );
    expect(f.calls).toHaveLength(3);
  });

  it('fails at once on other errors, without the key in the message', async () => {
    for (const status of [400, 401, 403, 404]) {
      const f = fakes([fail(status, 'invalid x-api-key')]);
      const err = await createClaude({ apiKey: 'sk-ant-secret', fetch: f.fetch, sleep: f.sleep })(request).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(`Claude API ${status} after 1 try: invalid x-api-key`);
      expect((err as Error).message).not.toContain('sk-ant-secret');
      expect(f.calls).toHaveLength(1);
      expect(f.waits).toEqual([]);
    }
  });

  it('reports the start of a body that is not the API error JSON', async () => {
    const f = fakes([new Response('<html>Bad gateway</html>', { status: 400 })]);
    await expect(createClaude({ apiKey: 'k', fetch: f.fetch, sleep: f.sleep })(request)).rejects.toThrow('Claude API 400 after 1 try: <html>Bad gateway</html>');
  });
});
