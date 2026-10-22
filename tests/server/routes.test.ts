// Integration tests: call the app/api route handlers directly with the memory store and mock Spotify.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as login from '../../app/api/auth/login/route';
import * as callback from '../../app/api/auth/callback/route';
import * as logout from '../../app/api/auth/logout/route';
import * as me from '../../app/api/me/route';
import * as meRange from '../../app/api/me/range/route';
import * as recs from '../../app/api/recommendations/route';
import * as known from '../../app/api/songs/known/route';
import * as feedback from '../../app/api/feedback/route';
import * as adminLog from '../../app/api/admin/log/route';
import type {
  DataSourceLogEntry,
  KnownSongsResponse,
  MeResponse,
  RecommendationsResponse,
} from '../../src/lib/contracts';
import { getStore } from '../../src/lib/server/getStore';
import { MOCK_USER } from '../../src/lib/server/mockSpotify';
import { songKey } from '../../src/lib/songs/resolve';
import { SESSION_COOKIE, STATE_COOKIE } from '../../src/lib/server/session';
import { getAppContext, resetAppContextForTests } from '../../src/lib/server/wiring';

const BASE = 'http://127.0.0.1:3000';
const savedEnv = { ...process.env };

/** Minimal cookie jar: applies Set-Cookie headers and renders a Cookie header. */
class Jar {
  cookies = new Map<string, string>();
  take(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';').map((s) => s.trim());
      const [name, value] = pair!.split('=') as [string, string];
      if (attrs.some((a) => a.toLowerCase() === 'max-age=0')) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

function req(path: string, jar?: Jar, init: RequestInit & { json?: unknown } = {}): Request {
  const headers = new Headers(init.headers);
  if (jar?.cookies.size) headers.set('cookie', jar.header());
  let body = init.body;
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    headers.set('content-type', 'application/json');
  }
  return new Request(`${BASE}${path}`, { ...init, headers, body });
}

async function signIn(): Promise<Jar> {
  const jar = new Jar();
  const r1 = jar.take(await login.GET(req('/api/auth/login', jar)));
  expect(r1.status).toBe(302);
  const r2 = jar.take(await callback.GET(new Request(r1.headers.get('location')!, { headers: { cookie: jar.header() } })));
  expect(r2.status).toBe(302);
  expect(r2.headers.get('location')).toBe(`${BASE}/?signedIn=1`);
  return jar;
}

const WIDE = { low: 45, high: 80, source: 'test' as const };

beforeEach(() => {
  process.env = {
    ...savedEnv,
    KARAOKE_STORE: 'memory',
    SPOTIFY_MOCK: '1',
    SESSION_SECRET: 'integration-secret-integration-secret',
    ADMIN_TOKEN: 'admin-token-123',
  };
  resetAppContextForTests();
});
afterAll(() => {
  process.env = savedEnv;
  resetAppContextForTests();
});

describe('sign-in flow', () => {
  it('login sets a state cookie and the mock redirects straight to the callback', async () => {
    const jar = new Jar();
    const res = jar.take(await login.GET(req('/api/auth/login')));
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/api/auth/callback');
    expect(loc.searchParams.get('state')).toBe(jar.cookies.get(STATE_COOKIE));
  });

  it('callback sets an httpOnly session cookie and stores the user', async () => {
    const jar = new Jar();
    const r1 = jar.take(await login.GET(req('/api/auth/login')));
    const r2 = await callback.GET(new Request(r1.headers.get('location')!, { headers: { cookie: jar.header() } }));
    const session = r2.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(session).toMatch(/HttpOnly/);
    expect(session).not.toMatch(/Secure/); // plain http in tests
    expect(await getStore().getUser(MOCK_USER.id)).toMatchObject({ displayName: 'Test Singer' });
  });

  it('callback rejects a missing or wrong state', async () => {
    const r1 = await login.GET(req('/api/auth/login'));
    const noCookie = await callback.GET(new Request(r1.headers.get('location')!));
    expect(noCookie.headers.get('location')).toBe(`${BASE}/?authError=state`);
    expect(noCookie.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    const wrong = await callback.GET(
      new Request(`${BASE}/api/auth/callback?code=mock-code&state=abc`, { headers: { cookie: `${STATE_COOKIE}=xyz` } }),
    );
    expect(wrong.headers.get('location')).toBe(`${BASE}/?authError=state`);
    const denied = await callback.GET(
      new Request(`${BASE}/api/auth/callback?error=access_denied&state=s`, { headers: { cookie: `${STATE_COOKIE}=s` } }),
    );
    expect(denied.headers.get('location')).toBe(`${BASE}/?authError=access_denied`);
  });

  it('logout clears the session', async () => {
    const jar = await signIn();
    jar.take(await logout.POST(req('/api/auth/logout', jar, { method: 'POST' })));
    expect(jar.cookies.has(SESSION_COOKIE)).toBe(false);
    expect((await me.GET(req('/api/me', jar))).status).toBe(401);
  });

  it('login returns 500 JSON when the session secret is missing', async () => {
    delete process.env.SESSION_SECRET;
    resetAppContextForTests();
    const res = await login.GET(req('/api/auth/login'));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'server-misconfigured' });
  });
});

describe('signed-out access', () => {
  it('returns 401 JSON from every user route', async () => {
    const forged = new Jar();
    forged.cookies.set(SESSION_COOKIE, 'bW9jaw.forged');
    for (const jar of [undefined, forged]) {
      const responses = await Promise.all([
        me.GET(req('/api/me', jar)),
        meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE })),
        recs.GET(req('/api/recommendations', jar)),
        known.GET(req('/api/songs/known', jar)),
        feedback.POST(req('/api/feedback', jar, { method: 'POST', json: {} })),
      ]);
      for (const r of responses) {
        expect(r.status).toBe(401);
        expect(r.headers.get('content-type')).toBe('application/json');
        expect(await r.json()).toEqual({ error: 'signed-out' });
      }
    }
  });
});

describe('me and range', () => {
  it('returns the profile, then the saved range', async () => {
    const jar = await signIn();
    const r1 = await me.GET(req('/api/me', jar));
    expect(await r1.json()).toEqual({ userId: MOCK_USER.id, displayName: 'Test Singer', range: null } satisfies MeResponse);
    const put = await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: { low: 48, high: 72, source: 'test' } }));
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });
    const r2 = (await (await me.GET(req('/api/me', jar))).json()) as MeResponse;
    expect(r2.range).toEqual({ low: 48, high: 72, source: 'test' });
  });

  it.each([
    ['not JSON', 'nope'],
    ['non-integer', { low: 48.5, high: 72, source: 'test' }],
    ['low >= high', { low: 72, high: 72, source: 'test' }],
    ['span too small', { low: 60, high: 64, source: 'test' }],
    ['span too large', { low: 30, high: 79, source: 'test' }],
    ['below MIDI 28', { low: 27, high: 50, source: 'test' }],
    ['above MIDI 96', { low: 80, high: 97, source: 'test' }],
    ['bad source', { low: 48, high: 72, source: 'guess' }],
    ['strings', { low: '48', high: '72', source: 'test' }],
  ])('rejects a bad range (%s) with 400', async (_name, body) => {
    const jar = await signIn();
    const init = typeof body === 'string' ? { method: 'PUT', body } : { method: 'PUT', json: body };
    const res = await meRange.PUT(req('/api/me/range', jar, init));
    expect(res.status).toBe(400);
    expect(await getStore().getRange(MOCK_USER.id)).toBeNull();
  });

  it('accepts the range limits', async () => {
    const jar = await signIn();
    for (const body of [
      { low: 28, high: 76, source: 'songs' },
      { low: 91, high: 96, source: 'test' },
    ]) {
      expect((await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: body }))).status).toBe(200);
    }
  });
});

describe('recommendations', () => {
  it('requires a saved range', async () => {
    const jar = await signIn();
    const res = await recs.GET(req('/api/recommendations', jar));
    expect(res.status).toBe(409);
  });

  it('returns 5 matches with sources and a nextOffset, then the following pages', async () => {
    const jar = await signIn();
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE }));
    const res = await recs.GET(req('/api/recommendations?offset=0&limit=5', jar));
    expect(res.status).toBe(200);
    const page1 = (await res.json()) as RecommendationsResponse;
    expect(page1.matches).toHaveLength(5);
    expect(page1.nextOffset).toBe(5);
    for (const m of page1.matches) {
      expect(page1.sources[m.track.id]).toMatchObject({ trackId: m.track.id, outcome: m.range.source });
      expect(['easy', 'medium', 'hard']).toContain(m.difficulty);
    }

    const ids = new Set(page1.matches.map((m) => m.track.id));
    let offset: number | null = page1.nextOffset;
    for (let i = 0; offset !== null && i < 10; i++) {
      const p = (await (await recs.GET(req(`/api/recommendations?offset=${offset}&limit=5`, jar))).json()) as RecommendationsResponse;
      for (const m of p.matches) {
        expect(ids.has(m.track.id)).toBe(false);
        ids.add(m.track.id);
      }
      offset = p.nextOffset;
    }
    expect(offset).toBeNull();
    expect(ids.size).toBe(10); // the 10 seeded songs in the mock library all fit a wide range

    // Skipped songs were logged but never matched.
    const log = await getStore().listLog(500);
    expect(log.filter((e) => e.outcome === 'skipped').length).toBeGreaterThan(0);
    const skippedIds = new Set(log.filter((e) => e.outcome === 'skipped').map((e) => e.trackId));
    for (const id of ids) expect(skippedIds.has(id)).toBe(false);
  });

  it('lists low-confidence ranges after every labeled song, as Maybe', async () => {
    const jar = await signIn();
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE }));
    const wide = ((await (await recs.GET(req('/api/recommendations?offset=0&limit=50', jar))).json()) as RecommendationsResponse).matches;
    expect(wide.map((m) => m.difficulty === 'maybe')).toEqual([false, false, false, false, false, true, true, true, true, true]);
    for (const m of wide) expect(m.difficulty === 'maybe').toBe(m.range.confidence === 'low');

    // A2 to C5: estimates within 2 semitones of it are Maybe (Whitney Houston only an octave down); the rest stay hidden.
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: { low: 45, high: 72, source: 'test' } }));
    const page = (await (await recs.GET(req('/api/recommendations?offset=0&limit=50', jar))).json()) as RecommendationsResponse;
    const maybe = page.matches.filter((m) => m.difficulty === 'maybe');
    expect(maybe.map((m) => `${m.track.title} ${m.octave}`).sort()).toEqual([
      'Bohemian Rhapsody none',
      "Don't Stop Believin' none",
      'I Will Always Love You down',
    ]);
    expect(page.matches.slice(0, 5).every((m) => m.difficulty !== 'maybe')).toBe(true);
    expect(page.matches).toHaveLength(8);
  });

  it('rejects bad paging params', async () => {
    const jar = await signIn();
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE }));
    for (const q of ['offset=-1', 'limit=0', 'limit=51', 'offset=abc']) {
      expect((await recs.GET(req(`/api/recommendations?${q}`, jar))).status).toBe(400);
    }
  });
});

describe('known songs', () => {
  it('lists saved songs with a known range', async () => {
    const jar = await signIn();
    const res = await known.GET(req('/api/songs/known', jar));
    expect(res.status).toBe(200);
    const body = (await res.json()) as KnownSongsResponse;
    expect(body.songs.length).toBe(10);
    expect(body.songs.map((s) => s.track.title)).toContain('Bohemian Rhapsody');
  });
});

describe('feedback', () => {
  it('stores the tap with the user range, difficulty and octave', async () => {
    const jar = await signIn();
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE }));
    const body = { trackId: 'mock-1-bohemian-rhapsody', thumbs: 'up', difficulty: 'medium', octave: 'down' };
    const res = await feedback.POST(req('/api/feedback', jar, { method: 'POST', json: body }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const stored = await getStore().listFeedback({ userId: MOCK_USER.id });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ ...body, userId: MOCK_USER.id, userRange: WIDE });
    expect(Date.parse(stored[0]!.at)).not.toBeNaN();
    // The library was never loaded, and the tap does not load it from Spotify.
    expect(stored[0]!.songRange).toBeUndefined();
  });

  it('stores where the song’s range came from, read from the cached library and range', async () => {
    const jar = await signIn();
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE }));
    const africa = { low: 52, high: 69, tessitura: 60, source: 'audio-full' as const, confidence: 'high' as const, fastLyrics: false, method: 'pyin-v1/app-range-v1' };
    const log = { trackId: '', title: 'Africa', artist: 'Toto', outcome: 'audio-full' as const, reason: 'Measured.', at: '2026-10-18T00:00:00.000Z' };
    await getStore().putSongRange(songKey('Toto', 'Africa'), { range: africa, log });
    await recs.GET(req('/api/recommendations', jar)); // loads and caches the library
    const post = async (json: unknown) => (await feedback.POST(req('/api/feedback', jar, { method: 'POST', json }))).status;
    expect(await post({ trackId: 'mock-16-africa', thumbs: 'up', difficulty: 'easy', octave: 'none' })).toBe(200);
    expect(await post({ trackId: 'mock-1-bohemian-rhapsody', thumbs: 'down', difficulty: 'maybe', octave: 'none' })).toBe(200);
    expect(await post({ trackId: 'not-in-the-library', thumbs: 'up', difficulty: 'easy', octave: 'none' })).toBe(200);
    const [unknown, estimate, measured] = await getStore().listFeedback({ userId: MOCK_USER.id });
    expect(measured!.songRange).toEqual({ source: 'audio-full', method: 'pyin-v1/app-range-v1', low: 52, high: 69 });
    expect(estimate).toMatchObject({ difficulty: 'maybe', songRange: { source: 'artist-external', low: 46, high: 70 } });
    expect(estimate!.songRange).not.toHaveProperty('method');
    expect(unknown!.songRange).toBeUndefined();
  });

  it.each([
    ['empty', {}],
    ['bad thumbs', { trackId: 't', thumbs: 'sideways', difficulty: 'easy', octave: 'none' }],
    ['bad difficulty', { trackId: 't', thumbs: 'up', difficulty: 'trivial', octave: 'none' }],
    ['bad octave', { trackId: 't', thumbs: 'up', difficulty: 'easy', octave: 'two' }],
    ['empty trackId', { trackId: '', thumbs: 'up', difficulty: 'easy', octave: 'none' }],
    ['array', []],
  ])('returns 400 on bad input (%s)', async (_name, body) => {
    const jar = await signIn();
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE }));
    expect((await feedback.POST(req('/api/feedback', jar, { method: 'POST', json: body }))).status).toBe(400);
    expect((await feedback.POST(req('/api/feedback', jar, { method: 'POST', body: '{oops' }))).status).toBe(400);
    expect(await getStore().listFeedback()).toEqual([]);
  });
});

describe('admin log', () => {
  it('is forbidden without the right token', async () => {
    expect((await adminLog.GET(req('/api/admin/log'))).status).toBe(403);
    expect((await adminLog.GET(req('/api/admin/log', undefined, { headers: { 'x-admin-token': 'wrong' } }))).status).toBe(403);
  });

  it('is forbidden when ADMIN_TOKEN is unset, even with an empty header', async () => {
    delete process.env.ADMIN_TOKEN;
    resetAppContextForTests();
    expect((await adminLog.GET(req('/api/admin/log', undefined, { headers: { 'x-admin-token': '' } }))).status).toBe(403);
  });

  it('returns log entries newest first', async () => {
    const jar = await signIn();
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE }));
    await recs.GET(req('/api/recommendations', jar));
    const res = await adminLog.GET(req('/api/admin/log', undefined, { headers: { 'x-admin-token': 'admin-token-123' } }));
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as { entries: DataSourceLogEntry[] };
    expect(entries.length).toBeGreaterThanOrEqual(6);
    const times = entries.map((e) => e.at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(entries.some((e) => e.title === 'Bohemian Rhapsody')).toBe(true);
  });
});

describe('process-wide singletons', () => {
  it('keeps one store and app context per process', () => {
    expect(getStore()).toBe(getStore());
    expect(getAppContext()).toBe(getAppContext());
    expect(getAppContext().store).toBe(getStore());
  });
});

describe('request origin', () => {
  it('uses the Host and forwarded headers over req.url', async () => {
    const { requestOrigin } = await import('../../src/lib/server/handlers');
    expect(requestOrigin(new Request('http://localhost:3000/x'))).toBe('http://localhost:3000');
    expect(requestOrigin(new Request('http://localhost:3000/x', { headers: { host: '127.0.0.1:3000' } }))).toBe(
      'http://127.0.0.1:3000',
    );
    expect(
      requestOrigin(
        new Request('http://localhost:3000/x', {
          headers: { host: 'internal', 'x-forwarded-host': 'karaoke.example, proxy', 'x-forwarded-proto': 'https' },
        }),
      ),
    ).toBe('https://karaoke.example');
  });

  it('marks cookies Secure behind an https proxy', async () => {
    const res = await login.GET(new Request(`${BASE}/api/auth/login`, { headers: { 'x-forwarded-proto': 'https' } }));
    expect(res.headers.getSetCookie()[0]).toMatch(/Secure/);
  });
});
