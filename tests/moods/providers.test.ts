import { describe, expect, it } from 'vitest';
import { fetchWithRetries, type AskRequest } from '../../src/lib/moods/ask';
import { createGemini, generateUrl } from '../../src/lib/moods/gemini';
import { CHAT_URL, createOpenAI } from '../../src/lib/moods/openai';
import { isProvider, PROVIDERS } from '../../src/lib/moods/providers';

const request: AskRequest = { model: 'test-model', system: 'Label songs.', user: 'Label these 1 songs', maxTokens: 1000, schema: { type: 'object' } };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

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

const SAMPLING = ['temperature', 'top_p', 'top_k', 'topP', 'topK'];

describe('createOpenAI', () => {
  const reply = {
    choices: [{ message: { content: '{"labels":[]}', refusal: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1200, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 600 } },
  };

  it('posts a chat completion with the key, the schema in strict mode and no sampling settings', async () => {
    const f = fakes([json(reply)]);
    const result = await createOpenAI({ apiKey: 'test-key', fetch: f.fetch, sleep: f.sleep })(request);
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe(CHAT_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ authorization: 'Bearer test-key', 'content-type': 'application/json' });
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      model: 'test-model',
      max_completion_tokens: 1000,
      messages: [
        { role: 'system', content: 'Label songs.' },
        { role: 'user', content: 'Label these 1 songs' },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'reply', strict: true, schema: { type: 'object' } } },
    });
    for (const s of SAMPLING) expect(body).not.toHaveProperty(s);
    // Reasoning tokens are part of completion_tokens, so they are counted once.
    expect(result).toEqual({ text: '{"labels":[]}', inputTokens: 1200, outputTokens: 900, stopReason: 'end_turn' });
  });

  it('leaves out response_format without a schema', async () => {
    const f = fakes([json(reply)]);
    await createOpenAI({ apiKey: 'k', fetch: f.fetch, sleep: f.sleep })({ ...request, schema: undefined });
    expect(JSON.parse(String(f.calls[0]!.init.body))).not.toHaveProperty('response_format');
  });

  it('reports a cut-short reply, a refusal and a filtered reply in the labeller terms', async () => {
    const cases: [object, string | null][] = [
      [{ choices: [{ message: { content: '{"lab' }, finish_reason: 'length' }] }, 'max_tokens'],
      [{ choices: [{ message: { content: null, refusal: 'I cannot help with that.' }, finish_reason: 'stop' }] }, 'refusal'],
      [{ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }, 'refusal'],
      [{ choices: [] }, null],
    ];
    for (const [body, stopReason] of cases) {
      const f = fakes([json(body)]);
      const result = await createOpenAI({ apiKey: 'k', fetch: f.fetch, sleep: f.sleep })(request);
      expect(result.stopReason).toBe(stopReason);
      if (stopReason !== 'max_tokens') expect(result.text).toBe('');
    }
  });

  it('fails at once on a bad key, with the API message and without the key', async () => {
    const f = fakes([json({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }, 401)]);
    const err = await createOpenAI({ apiKey: 'sk-secret', fetch: f.fetch, sleep: f.sleep })(request).catch((e: Error) => e);
    expect((err as Error).message).toBe('OpenAI API 401 after 1 try: Incorrect API key provided');
    expect((err as Error).message).not.toContain('sk-secret');
    expect(f.waits).toEqual([]);
  });
});

describe('createGemini', () => {
  const reply = {
    candidates: [{ content: { parts: [{ text: 'thinking out loud', thought: true }, { text: '{"labels":', thoughtSignature: 'x' }, { text: '[]}' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1100, candidatesTokenCount: 300, thoughtsTokenCount: 200 },
  };

  it('posts generateContent with the key in a header, the JSON schema and no sampling settings', async () => {
    const f = fakes([json(reply)]);
    const result = await createGemini({ apiKey: 'test-key', fetch: f.fetch, sleep: f.sleep })(request);
    const { url, init } = f.calls[0]!;
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
    expect(url).not.toContain('test-key');
    expect(init.headers).toEqual({ 'x-goog-api-key': 'test-key', 'content-type': 'application/json' });
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: 'Label songs.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Label these 1 songs' }] }],
      generationConfig: { maxOutputTokens: 1000, responseMimeType: 'application/json', responseJsonSchema: { type: 'object' } },
    });
    for (const s of SAMPLING) expect(body.generationConfig).not.toHaveProperty(s);
    // Thought parts left out; thinking billed as output.
    expect(result).toEqual({ text: '{"labels":[]}', inputTokens: 1100, outputTokens: 500, stopReason: 'end_turn' });
  });

  it('escapes the model name in the URL', () => {
    expect(generateUrl('models/../x')).toBe('https://generativelanguage.googleapis.com/v1beta/models/models%2F..%2Fx:generateContent');
  });

  it('reports a cut-short reply, a safety stop and a blocked prompt in the labeller terms', async () => {
    const cases: [object, string | null][] = [
      [{ candidates: [{ content: { parts: [{ text: '{"la' }] }, finishReason: 'MAX_TOKENS' }] }, 'max_tokens'],
      [{ candidates: [{ finishReason: 'SAFETY' }] }, 'refusal'],
      [{ promptFeedback: { blockReason: 'OTHER' } }, 'refusal'],
      [{ candidates: [{ content: { parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }] }, 'MALFORMED_FUNCTION_CALL'],
    ];
    for (const [body, stopReason] of cases) {
      const f = fakes([json(body)]);
      expect((await createGemini({ apiKey: 'k', fetch: f.fetch, sleep: f.sleep })(request)).stopReason).toBe(stopReason);
    }
  });

  it('retries a rate limit, then gives up with the API message', async () => {
    const err = { error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } };
    const f = fakes([json(err, 429), json(err, 429), json(err, 429)]);
    await expect(createGemini({ apiKey: 'k', fetch: f.fetch, sleep: f.sleep })(request)).rejects.toThrow(
      'Gemini API 429 after 3 tries: Resource has been exhausted',
    );
    expect(f.waits).toEqual([1000, 2000]);
  });
});

describe('fetchWithRetries', () => {
  it("waits as long as AcousticBrainz's x-ratelimit-reset-in asks", async () => {
    const f = fakes([json({ message: 'slow down' }, 429, { 'x-ratelimit-reset-in': '4' }), json({ ok: true })]);
    const res = await fetchWithRetries('AcousticBrainz', 'https://example.test/x', {}, { fetch: f.fetch, sleep: f.sleep });
    expect(await res.json()).toEqual({ ok: true });
    expect(f.waits).toEqual([4000]);
  });

  it("reads a top-level message, as AcousticBrainz's errors have", async () => {
    const f = fakes([json({ message: 'More than 25 recordings not allowed per request' }, 400)]);
    await expect(fetchWithRetries('AcousticBrainz', 'https://example.test/x', {}, { fetch: f.fetch, sleep: f.sleep })).rejects.toThrow(
      'AcousticBrainz API 400 after 1 try: More than 25 recordings not allowed per request',
    );
  });
});

describe('PROVIDERS', () => {
  it('names each key variable, a default model and the source its rows are stored under', () => {
    expect(Object.fromEntries(Object.entries(PROVIDERS).map(([p, info]) => [p, [info.keyEnv, info.source]]))).toEqual({
      anthropic: ['ANTHROPIC_API_KEY', 'claude'],
      openai: ['OPENAI_API_KEY', 'openai'],
      gemini: ['GEMINI_API_KEY', 'gemini'],
    });
    expect(PROVIDERS.anthropic.defaultModel).toBe('claude-haiku-5-5');
    expect(PROVIDERS.openai.defaultModel).toBe('gpt-6-luna');
    expect(isProvider('openai')).toBe(true);
    expect(isProvider('mistral')).toBe(false);
  });
});
