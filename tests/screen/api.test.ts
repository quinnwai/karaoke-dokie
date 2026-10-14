// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ApiError, createApi } from '../../src/lib/client/api';
import { me, recommendationsPage } from '../fixtures/screen';

function fakeFetch(respond: (url: string, init: RequestInit) => { status?: number; body?: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const { status = 200, body = { ok: true } } = respond(url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}

describe('api client', () => {
  it('GET /api/me returns the user, or null on 401', async () => {
    const ok = fakeFetch(() => ({ body: me() }));
    expect(await createApi(ok.impl).me()).toEqual(me());
    expect(ok.calls[0]!.url).toBe('/api/me');

    const out = fakeFetch(() => ({ status: 401, body: { error: 'signed out' } }));
    expect(await createApi(out.impl).me()).toBeNull();
  });

  it('other /api/me errors throw', async () => {
    const f = fakeFetch(() => ({ status: 500 }));
    await expect(createApi(f.impl).me()).rejects.toBeInstanceOf(ApiError);
  });

  it('PUT /api/me/range sends the range as JSON', async () => {
    const f = fakeFetch(() => ({}));
    await createApi(f.impl).saveRange({ low: 45, high: 72, source: 'test' });
    const { url, init } = f.calls[0]!;
    expect(url).toBe('/api/me/range');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ low: 45, high: 72, source: 'test' });
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.credentials).toBe('same-origin');
  });

  it('GET /api/recommendations pages with offset and limit 5', async () => {
    const f = fakeFetch((url) => ({ body: recommendationsPage(Number(new URL(url, 'http://x').searchParams.get('offset'))) }));
    const page = await createApi(f.impl).recommendations(5);
    expect(f.calls[0]!.url).toBe('/api/recommendations?offset=5&limit=5');
    expect(page.matches).toHaveLength(5);
    expect(page.nextOffset).toBeNull();
  });

  it('GET /api/songs/known and POST /api/feedback', async () => {
    const f = fakeFetch((url) => ({ body: url.includes('known') ? { songs: [] } : { ok: true } }));
    const api = createApi(f.impl);
    expect(await api.knownSongs()).toEqual({ songs: [] });
    await api.feedback({ trackId: 't1', thumbs: 'down', difficulty: 'hard', octave: 'up' });
    expect(f.calls.map((c) => [c.url, c.init.method ?? 'GET'])).toEqual([
      ['/api/songs/known', 'GET'],
      ['/api/feedback', 'POST'],
    ]);
    expect(JSON.parse(String(f.calls[1]!.init.body))).toEqual({ trackId: 't1', thumbs: 'down', difficulty: 'hard', octave: 'up' });
  });

  it('failed writes reject with the status', async () => {
    const f = fakeFetch(() => ({ status: 400 }));
    await expect(createApi(f.impl).saveRange({ low: 1, high: 2, source: 'test' })).rejects.toMatchObject({ status: 400, path: '/api/me/range' });
  });
});
