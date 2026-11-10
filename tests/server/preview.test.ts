// GET /api/preview/<deezerId> (QWW-48): one Deezer /track call, then a redirect to the track's 30 s preview.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as previewRoute from '../../app/api/preview/[id]/route';
import {
  BROWSER_MAX_AGE_S,
  createPreviewResolver,
  isDeezerPreviewLink,
  LINK_MARGIN_S,
  linkExpiry,
  MISS_TTL_MS,
  previewResponse,
  UNKNOWN_EXPIRY_KEEP_S,
} from '../../src/lib/server/preview';

const T0 = Date.UTC(2026, 10, 10, 14, 0, 0);
/** A preview link as Deezer sends it, expiring `ttlS` seconds after T0. */
const link = (id: string, ttlS = 900) =>
  `https://cdnt-preview.dzcdn.net/api/1/1/6/a/2/0/${id}.mp3?hdnea=exp=${T0 / 1000 + ttlS}~acl=/api/1/1/6/a/2/0/${id}.mp3*~data=user_id=0,application_id=42~hmac=ab12`;

type Answer = { status?: number; body?: unknown } | Error;

/** A fake fetch for api.deezer.com/track/<id>: each id answers from `answers`, else with a preview link. */
function deezer(answers: Record<string, Answer | Answer[]> = {}) {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    const id = url.split('/').pop()!;
    calls.push(id);
    let a: Answer | Answer[] | undefined = answers[id];
    if (Array.isArray(a)) a = a.shift();
    if (a instanceof Error) throw a;
    const { status = 200, body = { id: Number(id), title: 'Song', preview: link(id) } } = a ?? {};
    return { ok: status >= 200 && status < 300, status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) };
  });
  return { fetch, calls };
}

function setup(answers: Record<string, Answer | Answer[]> = {}, maxCached?: number) {
  let now = T0;
  const d = deezer(answers);
  const resolver = createPreviewResolver({ fetch: d.fetch, now: () => now, ...(maxCached ? { maxCached } : {}) });
  return {
    ...d,
    resolver,
    get: (id: string) => previewResponse(id, resolver, () => now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('preview links', () => {
  it('reads when a link expires from its token, and keeps one that does not say for a minute at most', async () => {
    expect(linkExpiry(link('1', 900), 0)).toBe(T0 + 900_000);
    expect(linkExpiry('https://cdnt-preview.dzcdn.net/a.mp3', T0)).toBe(T0 + (LINK_MARGIN_S + UNKNOWN_EXPIRY_KEEP_S) * 1000);
    const s = setup({ '3': { body: { id: 3, preview: 'https://cdnt-preview.dzcdn.net/a.mp3' } } });
    const res = await s.get('3');
    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe(`public, max-age=${UNKNOWN_EXPIRY_KEEP_S}`);
    expect(res.headers.get('vercel-cdn-cache-control')).toBe(`max-age=${UNKNOWN_EXPIRY_KEEP_S}`);
    s.advance(UNKNOWN_EXPIRY_KEEP_S * 1000);
    await s.get('3');
    expect(s.calls).toEqual(['3', '3']);
  });

  it("redirects only to https links on Deezer's CDN", () => {
    expect(isDeezerPreviewLink(link('1'))).toBe(true);
    expect(isDeezerPreviewLink('https://cdns-preview-d.dzcdn.net/stream/c-1.mp3')).toBe(true);
    expect(isDeezerPreviewLink('http://cdnt-preview.dzcdn.net/a.mp3')).toBe(false);
    expect(isDeezerPreviewLink('https://evil.example/dzcdn.net/a.mp3')).toBe(false);
    expect(isDeezerPreviewLink('https://dzcdn.net.evil.example/a.mp3')).toBe(false);
    expect(isDeezerPreviewLink('')).toBe(false);
    expect(isDeezerPreviewLink('not a url')).toBe(false);
  });
});

describe('GET /api/preview/<id>', () => {
  it('redirects to the preview with one Deezer call, cached by the CDN until 5 minutes before the link expires', async () => {
    const s = setup();
    const res = await s.get('3135556');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(link('3135556'));
    expect(s.calls).toEqual(['3135556']);
    expect(s.fetch.mock.calls[0]![0]).toBe('https://api.deezer.com/track/3135556');
    expect(res.headers.get('cache-control')).toBe(`public, max-age=${BROWSER_MAX_AGE_S}`);
    expect(res.headers.get('vercel-cdn-cache-control')).toBe(`max-age=${900 - LINK_MARGIN_S}`);
  });

  it('serves the same link again from its cache, for less time as it ages, then asks Deezer for a fresh one', async () => {
    const s = setup();
    await s.get('42');
    s.advance(8 * 60_000);
    const later = await s.get('42');
    expect(s.calls).toEqual(['42']);
    expect(later.headers.get('location')).toBe(link('42'));
    expect(later.headers.get('vercel-cdn-cache-control')).toBe('max-age=120'); // 15 min - 8 min - 5 min margin
    expect(later.headers.get('cache-control')).toBe('public, max-age=60');
    s.advance(119_000);
    expect((await s.get('42')).headers.get('cache-control')).toBe('public, max-age=1');
    s.advance(1_000); // 5 minutes left: never handed out from the cache
    await s.get('42');
    expect(s.calls).toEqual(['42', '42']);
  });

  it('shares one Deezer call between requests that arrive while it runs', async () => {
    const s = setup();
    const [a, b, c] = await Promise.all([s.get('7'), s.get('7'), s.get('8')]);
    expect([a.status, b.status, c.status]).toEqual([302, 302, 302]);
    expect(s.calls.sort()).toEqual(['7', '8']);
  });

  it("is 404 when Deezer has no such track or no preview for it, and remembers that for 10 minutes", async () => {
    const s = setup({
      '1': { body: { error: { type: 'DataException', message: 'no data', code: 800 } } },
      '2': { body: { id: 2, title: 'No preview', preview: '' } },
    });
    for (const id of ['1', '2']) {
      const res = await s.get(id);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'no-preview' });
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    await s.get('1');
    expect(s.calls).toEqual(['1', '2']);
    s.advance(MISS_TTL_MS);
    await s.get('1');
    expect(s.calls).toEqual(['1', '2', '1']);
  });

  it("is 404 for a preview link that is not on Deezer's CDN, rather than redirect anywhere", async () => {
    const s = setup({ '5': { body: { id: 5, preview: 'https://evil.example/a.mp3' } } });
    expect((await s.get('5')).status).toBe(404);
  });

  it('is 502 when Deezer cannot be asked, and asks again next time (a failure is never cached)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = setup({
      '1': [new Error('fetch failed'), {}],
      '2': { status: 503 },
      '3': { body: { error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } } },
      '4': { body: '<html>' },
    });
    for (const id of ['1', '2', '3', '4']) {
      const res = await s.get(id);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'deezer-unavailable' });
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls[0]![0]).toContain('Deezer track 1: fetch failed');
    expect((await s.get('1')).status).toBe(302);
    expect(s.calls).toEqual(['1', '2', '3', '4', '1']);
  });

  it('is 400, with no Deezer call, for anything that is not a Deezer track id', async () => {
    const s = setup();
    for (const id of ['', 'abc', '0', '012', '-5', '1.5', '12a', '1'.repeat(17), '../track/1', '1%2F2']) {
      expect((await s.get(id)).status, id).toBe(400);
    }
    expect(s.calls).toEqual([]);
  });

  it('sends a link with less than 5 minutes left uncached', async () => {
    const s = setup({ '9': { body: { id: 9, preview: link('9', 200) } } });
    const res = await s.get('9');
    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('vercel-cdn-cache-control')).toBeNull();
    await s.get('9');
    expect(s.calls).toEqual(['9', '9']);
  });

  it('keeps at most maxCached links, dropping the oldest', async () => {
    const s = setup({}, 2);
    await s.get('1');
    await s.get('2');
    await s.get('3');
    await s.get('3');
    await s.get('1');
    expect(s.calls).toEqual(['1', '2', '3', '1']);
  });

  it('is wired to the route with the id from the path', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 11, preview: link('11', 3600) }) }));
    vi.stubGlobal('fetch', fetch);
    const res = await previewRoute.GET(new Request('http://127.0.0.1:3000/api/preview/11'), { params: Promise.resolve({ id: '11' }) });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(link('11', 3600));
    expect(fetch).toHaveBeenCalledWith('https://api.deezer.com/track/11', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});
