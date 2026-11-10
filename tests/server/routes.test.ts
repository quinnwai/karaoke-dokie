// Integration tests: call the app/api route handlers directly with the memory store and mock Spotify.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as login from '../../app/api/auth/login/route';
import * as callback from '../../app/api/auth/callback/route';
import * as disconnect from '../../app/api/auth/disconnect/route';
import * as logout from '../../app/api/auth/logout/route';
import * as me from '../../app/api/me/route';
import * as meRange from '../../app/api/me/range/route';
import * as recs from '../../app/api/recommendations/route';
import * as known from '../../app/api/songs/known/route';
import * as feedback from '../../app/api/feedback/route';
import * as adminLog from '../../app/api/admin/log/route';
import * as events from '../../app/api/events/route';
import * as adminEvents from '../../app/api/admin/events/route';
import * as catalogueRecs from '../../app/api/catalogue/recommendations/route';
import * as catalogueFeedback from '../../app/api/catalogue/feedback/route';
import { SLIDER_IDS } from '../../src/lib/contracts';
import type {
  AdminEventsResponse,
  DataSourceLogEntry,
  KnownSongsResponse,
  Match,
  MeResponse,
  RecommendationsResponse,
  ResultsView,
} from '../../src/lib/contracts';
import { withoutDuetRange, withoutDuetsAndMoods } from '../../src/lib/server/features';
import { getStore } from '../../src/lib/server/getStore';
import { MOCK_USER } from '../../src/lib/server/mockSpotify';
import { LIBRARY_DEADLINE_MS } from '../../src/lib/server/handlers';
import { createSpotifyClient, SpotifyError } from '../../src/lib/server/spotify';
import { availableFacets, DEFAULT_VIEW, orderMatches } from '../../src/lib/songs/browse';
import { songKey } from '../../src/lib/songs/resolve';
import { isMeasured } from '../../src/lib/songs/sourceRank';
import { CHART_FLOOR } from '../../src/lib/songs/score';
import { SESSION_COOKIE, STATE_COOKIE } from '../../src/lib/server/session';
import { getAppContext, resetAppContextForTests, SEED_SONGS } from '../../src/lib/server/wiring';
import { fakeSpotify, type FakeSpotify } from '../helpers/fakeSpotify';

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

  // The browser only gets ?authError=spotify, so the server log line is the only record of why it failed.
  it.each([
    ['token exchange', '{"error":"invalid_client"}', () => void (getAppContext().spotify.exchangeCode = async () => { throw new SpotifyError('Spotify token request failed (400)', 400, '{"error":"invalid_client"}'); })],
    ['profile (/me)', 'retry-after 48000 s', () => void (getAppContext().spotify.getMe = async () => { throw new SpotifyError('Spotify API /me failed (429)', 429, '{"error":{"status":429}}', '48000'); })],
    ['saving the user', 'read-only transaction', () => void vi.spyOn(getAppContext().store, 'upsertUser').mockRejectedValue(new Error('cannot execute INSERT in a read-only transaction'))],
  ])('callback logs the %s step when it fails, and still sends the browser to authError=spotify', async (step, said, breakIt) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const jar = new Jar();
      const r1 = jar.take(await login.GET(req('/api/auth/login')));
      breakIt();
      const r2 = await callback.GET(new Request(r1.headers.get('location')!, { headers: { cookie: jar.header() } }));
      expect(r2.headers.get('location')).toBe(`${BASE}/?authError=spotify`);
      expect(r2.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0]![0]);
      expect(line).toContain(`failed at the ${step} step`);
      expect(line).toContain(said);
      // Never the code or a token.
      expect(line).not.toContain('mock-code');
      expect(line).not.toContain('mock-access');
    } finally {
      spy.mockRestore();
    }
  });

  // Was a 502 and an empty "Couldn't load songs" screen (10 Nov 2026); now the catalogue's songs and a flag (QWW-55).
  it('logs why the library could not be read, and answers with catalogue songs and a flag, not a 502', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const jar = await signIn();
      await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE }));
      getAppContext().spotify.getSavedPage = async () => {
        throw new SpotifyError('Spotify API /me/tracks?limit=50&offset=0 failed (429)', 429, '', '48000');
      };
      const res = await recs.GET(req('/api/recommendations?all=1', jar));
      expect(res.status).toBe(200);
      const body = (await res.json()) as RecommendationsResponse;
      expect(body.libraryUnavailable).toBe(true);
      expect(body.matches.length).toBeGreaterThan(0);
      expect(body.matches.every((m) => m.track.id.startsWith('cat:'))).toBe(true);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('[spotify] could not load the library: Spotify API /me/tracks'));
      expect(String(spy.mock.calls[0]![0])).toContain('retry-after 48000 s');
      // Spotify's wait is kept for every later request.
      expect(await getStore().getSpotifyBlock()).toBeGreaterThan(Date.now() + 47_000_000);
    } finally {
      spy.mockRestore();
    }
  });

  it('logout clears the session', async () => {
    const jar = await signIn();
    jar.take(await logout.POST(req('/api/auth/logout', jar, { method: 'POST' })));
    expect(jar.cookies.has(SESSION_COOKIE)).toBe(false);
    expect((await me.GET(req('/api/me', jar))).status).toBe(401);
  });

  it('disconnect deletes the stored library and signs the user out (Spotify terms, QWW-55 PR 2)', async () => {
    const jar = await signIn();
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE }));
    expect((await recs.GET(req('/api/recommendations?all=1', jar))).status).toBe(200);
    const store = getStore();
    const userId = (await store.listUserIds())[0]!;
    expect((await store.listSavedTracks(userId)).length).toBeGreaterThan(0);
    expect(await store.getLibraryState(userId)).not.toBeNull();

    expect((await disconnect.POST(req('/api/auth/disconnect', undefined, { method: 'POST' }))).status).toBe(401); // not signed in: nothing to do
    jar.take(await disconnect.POST(req('/api/auth/disconnect', jar, { method: 'POST' })));
    expect(jar.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(await store.listSavedTracks(userId)).toEqual([]);
    expect(await store.getLibraryState(userId)).toBeNull();
    expect(await store.getRange(userId)).not.toBeNull(); // the vocal range is not Spotify data
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
    // Every seeded song in the mock library fits a wide range; catalogue-only seeds are not in the library.
    expect(ids.size).toBe(SEED_SONGS.filter((x) => !x.catalogueOnly).length);

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
    const library = SEED_SONGS.filter((x) => !x.catalogueOnly);
    const estimates = library.filter((x) => x.range.confidence === 'low').length;
    expect(wide.map((m) => m.difficulty === 'maybe')).toEqual([
      ...Array<boolean>(library.length - estimates).fill(false),
      ...Array<boolean>(estimates).fill(true),
    ]);
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
    const sure = page.matches.filter((m) => m.difficulty !== 'maybe');
    expect(page.matches.slice(0, sure.length)).toEqual(sure);
    expect(sure.length).toBeGreaterThanOrEqual(5);
    for (const m of sure) {
      const shift = m.octave === 'down' ? -12 : m.octave === 'up' ? 12 : 0;
      expect(m.range.low + shift).toBeGreaterThanOrEqual(45);
      expect(m.range.high + shift).toBeLessThanOrEqual(72);
    }
  });

  it('returns every match at once with all=1, with year, genre and USDB popularity, whatever offset and limit say', async () => {
    const jar = await signIn();
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE }));
    const africa = { low: 52, high: 69, tessitura: 60, source: 'audio-full' as const, confidence: 'high' as const, fastLyrics: false, pitchShare: [[55, 0.5], [64, 0.5]] as [number, number][] };
    const log = { trackId: '', title: 'Africa', artist: 'Toto', outcome: 'audio-full' as const, reason: 'Measured.', at: '2026-10-18T00:00:00.000Z' };
    await getStore().putSongRange(songKey('Toto', 'Africa'), { range: africa, log });
    await getStore().putUsdbSongs([{ id: 7, key: songKey('Adele', 'Someone Like You'), artist: 'Adele', title: 'Someone Like You', views: 40_000, rating: 4.5, year: 2011, genre: 'Pop' }]);

    const res = await recs.GET(req('/api/recommendations?all=1&offset=-1&limit=0', jar));
    expect(res.status).toBe(200);
    const body = (await res.json()) as RecommendationsResponse;
    expect(body).toMatchObject({ complete: true, nextOffset: null });
    // Every seeded library song fits WIDE (Africa is one of them; the put above replaced its range).
    expect(body.matches).toHaveLength(SEED_SONGS.filter((x) => !x.catalogueOnly).length);

    const paged = new Map<string, RecommendationsResponse['matches'][number]>();
    for (let offset: number | null = 0, i = 0; offset !== null && i < 10; i++) {
      const p = (await (await recs.GET(req(`/api/recommendations?offset=${offset}&limit=5`, jar))).json()) as RecommendationsResponse;
      expect(p).not.toHaveProperty('complete');
      for (const m of p.matches) paged.set(m.track.id, m);
      offset = p.nextOffset;
    }
    expect(new Set(body.matches.map((m) => m.track.id))).toEqual(new Set(paged.keys()));
    expect(paged.get('mock-16-africa')!.range.pitchShare).toEqual(africa.pitchShare); // pages keep the histogram

    for (const m of body.matches) {
      expect(body.sources[m.track.id]).toMatchObject({ trackId: m.track.id });
      expect(m.range).not.toHaveProperty('pitchShare');
    }
    const byTitle = Object.fromEntries(body.matches.map((m) => [m.track.title, m]));
    expect(byTitle['Someone Like You']).toMatchObject({ year: 2011, yearSource: 'usdb', genre: 'Pop', parts: { popularityKnown: true } });
    expect(byTitle['Baby']).toMatchObject({ year: 2010, yearSource: 'spotify', parts: { popularityKnown: false } });
    expect(byTitle['Baby']).not.toHaveProperty('genre');
  });

  it('says which list shows you know each library song', async () => {
    const jar = await signIn();
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE }));
    const body = (await (await recs.GET(req('/api/recommendations?all=1', jar))).json()) as RecommendationsResponse;
    const reasons = Object.fromEntries(body.matches.map((m) => [m.track.title, m.reasons]));
    // The mock library: Baby is in all three top lists, Bohemian Rhapsody only in the 6-month one,
    // Can't Help Falling in Love in the 1-year one and the last plays, Africa in a playlist.
    expect(reasons['Baby']).toEqual(['In your sweet spot', 'Top songs this month']);
    expect(reasons['Bohemian Rhapsody']).toEqual(['Top songs, past 6 months', 'Crowd favourite']);
    expect(reasons["Can't Help Falling in Love"]).toEqual(['Lots of low notes', 'Played recently']);
    expect(reasons['Africa']).toEqual(['In your sweet spot', 'In your playlists']);
    // Every library track says where it was heard, so none falls back to the older wording.
    expect(body.matches.flatMap((m) => m.reasons ?? []).filter((r) => /^You (play|know)/.test(r))).toEqual([]);
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
    expect(body.songs.length).toBe(SEED_SONGS.filter((x) => !x.catalogueOnly).length);
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

  it('stores the results view the tap came from, and no view when the client sends none', async () => {
    const jar = await signIn();
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE }));
    const tap = { trackId: 'mock-1-bohemian-rhapsody', thumbs: 'up', difficulty: 'maybe', octave: 'none' };
    const view = { difficulty: 0.25, familiarity: null, popularity: 1, tempo: null, decade: '70s', mood: 'heartfelt', duetsOnly: false };
    const post = async (json: unknown) => (await feedback.POST(req('/api/feedback', jar, { method: 'POST', json }))).status;
    expect(await post({ ...tap, view: { ...view, chips: ['a'] } })).toBe(200); // fields it does not know are dropped
    const duetsOnly = { difficulty: null, familiarity: null, popularity: null, tempo: null, decade: null, mood: null, duetsOnly: true };
    expect(await post({ ...tap, view: duetsOnly })).toBe(200);
    expect(await post(tap)).toBe(200);
    const [older, plain, filtered] = await getStore().listFeedback({ userId: MOCK_USER.id });
    expect(filtered!.view).toStrictEqual(view);
    expect(plain!.view).toStrictEqual(duetsOnly);
    expect(older).not.toHaveProperty('view');
  });

  const goodView = { difficulty: null, familiarity: null, popularity: null, tempo: null, decade: null, mood: null, duetsOnly: false };
  const without = (key: keyof typeof goodView) => Object.fromEntries(Object.entries(goodView).filter(([k]) => k !== key));
  it.each([
    ['null', null],
    ['a string', 'top'],
    ['an array', []],
    ['an old sort view', { sort: 'top', decade: null, mood: null, duetsOnly: false }],
    ['a slider above 1', { ...goodView, difficulty: 1.5 }],
    ['a slider below 0', { ...goodView, familiarity: -0.1 }],
    ['a slider as a string', { ...goodView, popularity: '0.5' }],
    ['no difficulty', without('difficulty')],
    ['no popularity', without('popularity')],
    ['unknown decade', { ...goodView, decade: '50s' }],
    ['a year for a decade', { ...goodView, decade: 1980 }],
    ['no decade', without('decade')],
    ['unknown mood', { ...goodView, mood: 'sad' }],
    ['no mood', without('mood')],
    ['duetsOnly as a string', { ...goodView, duetsOnly: 'false' }],
    ['no duetsOnly', without('duetsOnly')],
  ])('returns 400 on a bad view (%s)', async (_name, view) => {
    const jar = await signIn();
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE }));
    const body = { trackId: 't', thumbs: 'up', difficulty: 'easy', octave: 'none', view };
    expect((await feedback.POST(req('/api/feedback', jar, { method: 'POST', json: body }))).status).toBe(400);
    expect(await getStore().listFeedback()).toEqual([]);
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

describe('catalogue (no Spotify)', () => {
  const catalogueGet = async (query: string) => {
    const res = await catalogueRecs.GET(req(`/api/catalogue/recommendations?${query}`));
    expect(res.status).toBe(200);
    return (await res.json()) as RecommendationsResponse;
  };
  const ids = (body: RecommendationsResponse) => body.matches.map((m) => m.track.id);
  const measuredSeeds = SEED_SONGS.filter((s) => isMeasured(s.range));

  it('holds the measured seed songs and their USDB rows in mock mode, and none of the estimates', async () => {
    const songs = await getAppContext().catalogue.get();
    expect(songs.length).toBeGreaterThan(0);
    expect(songs.map((s) => s.key).sort()).toEqual(measuredSeeds.map((s) => songKey(s.artist, s.title)).sort());
    for (const seed of measuredSeeds.filter((s) => s.usdb)) {
      expect(songs.find((s) => s.key === songKey(seed.artist, seed.title))!.usdb).toMatchObject(seed.usdb!);
    }
  });

  it('is not seeded outside mock mode', async () => {
    delete process.env.SPOTIFY_MOCK;
    process.env.SPOTIFY_LIVE = '1'; // real Spotify allowed (outside a deployment it is the mock, QWW-55 PR 2)
    resetAppContextForTests();
    expect(await getAppContext().catalogue.get()).toEqual([]);
    expect(await getStore().listLog()).toEqual([]);
  });

  it('recommends catalogue songs with no cookie, and keeps no account or cookie', async () => {
    const res = await catalogueRecs.GET(req('/api/catalogue/recommendations?low=45&high=80'));
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    const body = (await res.json()) as RecommendationsResponse;
    expect(body.matches.length).toBeGreaterThan(0);
    expect(body.matches.length).toBeLessThanOrEqual(5);
    for (const m of body.matches) {
      expect(m.track).toMatchObject({ id: `cat:${songKey(m.track.artist, m.track.title)}`, known: false, familiarity: 1 });
      expect(m.track.spotifyUrl).toMatch(/^https:\/\/open\.spotify\.com\/search\//);
      expect(isMeasured(m.range)).toBe(true);
      // Nobody's library, so only range and crowd reasons.
      for (const r of m.reasons ?? []) expect(r).toMatch(/^(In your sweet spot|Mostly comfortable|Some (high|low) notes|Lots of (high|low) notes|Crowd favourite)$/);
      expect(body.sources[m.track.id]).toMatchObject({ trackId: m.track.id, outcome: m.range.source });
    }
    expect(await getStore().listUserIds()).toEqual([]);
  });

  it.each([
    ['no range', ''],
    ['no high note', 'low=48'],
    ['not a number', 'low=abc&high=72'],
    ['non-integer', 'low=48.5&high=72'],
    ['negative', 'low=-48&high=72'],
    ['low >= high', 'low=72&high=72'],
    ['span too small', 'low=60&high=64'],
    ['span too large', 'low=30&high=79'],
    ['below MIDI 28', 'low=27&high=50'],
    ['above MIDI 96', 'low=80&high=97'],
    ['bad offset', 'low=48&high=72&offset=-1'],
    ['bad limit', 'low=48&high=72&limit=51'],
  ])('rejects a bad request (%s) with 400', async (_name, query) => {
    const res = await catalogueRecs.GET(req(`/api/catalogue/recommendations?${query}`));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad-request' });
  });

  it('accepts the range limits', async () => {
    await catalogueGet('low=28&high=76');
    await catalogueGet('low=91&high=96&all=1');
  });

  it('all=1 returns every match, complete, with year and genre from the USDB row', async () => {
    const all = await catalogueGet('low=45&high=80&all=1');
    expect(all.complete).toBe(true);
    expect(all.nextOffset).toBeNull();
    expect(all.matches.length).toBeGreaterThan(0);
    expect(Object.keys(all.sources).sort()).toEqual(ids(all).sort());
    const firstPage = await catalogueGet('low=45&high=80');
    expect(firstPage.complete).toBeUndefined();
    expect(ids(firstPage)).toEqual(ids(all).slice(0, 5));
    let withYear = 0;
    for (const seed of SEED_SONGS) {
      const m = all.matches.find((x) => x.track.id === `cat:${songKey(seed.artist, seed.title)}`);
      if (!m || !seed.usdb?.year) continue;
      expect(m).toMatchObject({ year: seed.usdb.year, yearSource: 'usdb', genre: seed.usdb.genre });
      withYear++;
    }
    expect(withYear).toBeGreaterThan(0);
  });

  it('pages never repeat or skip a song', async () => {
    const all = ids(await catalogueGet('low=45&high=80&all=1'));
    const paged: string[] = [];
    let offset: number | null = 0;
    for (let i = 0; offset !== null && i < 100; i++) {
      const page = await catalogueGet(`low=45&high=80&offset=${offset}&limit=2`);
      expect(Object.keys(page.sources).sort()).toEqual(ids(page).sort());
      paged.push(...ids(page));
      offset = page.nextOffset;
    }
    expect(offset).toBeNull();
    expect(paged).toEqual(all);
    expect(new Set(paged).size).toBe(paged.length);
  });

  describe('feedback', () => {
    const queen = SEED_SONGS.find((s) => s.title === 'Dancing Queen')!;
    const tap = {
      anonId: '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b',
      range: { low: 45, high: 80 },
      trackId: `cat:${songKey(queen.artist, queen.title)}`,
      thumbs: 'up',
      difficulty: 'easy',
      octave: 'none',
    };
    const post = (json: unknown) => catalogueFeedback.POST(req('/api/catalogue/feedback', undefined, { method: 'POST', json }));

    it('stores the tap under the device id, with the range it came with and the song range at the tap', async () => {
      const res = await post(tap);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(res.headers.getSetCookie()).toEqual([]);
      const stored = await getStore().listFeedback({ userId: `anon:${tap.anonId}` });
      expect(stored).toEqual([
        {
          userId: `anon:${tap.anonId}`,
          trackId: tap.trackId,
          thumbs: 'up',
          difficulty: 'easy',
          octave: 'none',
          userRange: { low: 45, high: 80, source: 'test' },
          songRange: { source: queen.range.source, low: queen.range.low, high: queen.range.high },
          at: expect.any(String),
        },
      ]);
      expect(await getStore().listUserIds()).toEqual([]);
    });

    it('stores a tap on a song with no stored range without a snapshot', async () => {
      expect((await post({ ...tap, trackId: 'cat:nobody|unknown' })).status).toBe(200);
      const [stored] = await getStore().listFeedback({ userId: `anon:${tap.anonId}` });
      expect(stored!.songRange).toBeUndefined();
    });

    it('accepts device ids of 8 and 64 characters', async () => {
      expect((await post({ ...tap, anonId: 'abcd-123' })).status).toBe(200);
      expect((await post({ ...tap, anonId: 'A1-'.repeat(21) + 'z' })).status).toBe(200);
    });

    it.each([
      ['no device id', { anonId: undefined }],
      ['a short device id', { anonId: 'abc-123' }],
      ['a long device id', { anonId: 'a'.repeat(65) }],
      ['other characters in the device id', { anonId: 'device id!' }],
      ['a numeric device id', { anonId: 12345678 }],
      ['a track id not from the catalogue', { trackId: 'mock-1-bohemian-rhapsody' }],
      ['a bare cat: prefix', { trackId: 'cat:' }],
      ['no range', { range: undefined }],
      ['a range that is not an object', { range: '45-80' }],
      ['a range too narrow', { range: { low: 60, high: 64 } }],
      ['a non-integer range', { range: { low: 45.5, high: 80 } }],
      ['bad thumbs', { thumbs: 'sideways' }],
      ['a bad difficulty', { difficulty: 'trivial' }],
      ['a bad octave', { octave: 'two' }],
    ])('rejects %s with 400 and stores nothing', async (_name, change) => {
      const res = await post({ ...tap, ...change });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'bad-request' });
      expect(await getStore().listFeedback()).toEqual([]);
    });

    it('rejects a body that is not JSON', async () => {
      const res = await catalogueFeedback.POST(req('/api/catalogue/feedback', undefined, { method: 'POST', body: '{oops' }));
      expect(res.status).toBe(400);
      expect(await getStore().listFeedback()).toEqual([]);
    });
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

describe('beta event log', () => {
  const ANON = 'device-0001';
  const secondsAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  const event = (name: string, props?: Record<string, unknown>, at = secondsAgo(1)) => ({ name, at, ...(props ? { props } : {}) });
  const post = (body: unknown, jar?: Jar) => events.POST(req('/api/events', jar, { method: 'POST', json: body }));
  const collect = () => {
    process.env.EVENTS = 'on';
    resetAppContextForTests();
  };

  it('returns 204 and stores nothing while collection is off (the default outside production)', async () => {
    delete process.env.EVENTS;
    resetAppContextForTests();
    const body = { anonId: ANON, events: [event('landing_viewed')] };
    const res = await post(body);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(await getStore().listEvents()).toEqual([]);

    process.env.EVENTS = 'off';
    resetAppContextForTests();
    expect((await post(body)).status).toBe(204);
    expect(await getStore().listEvents()).toEqual([]);
  });

  it('stores events with forbidden props stripped, keyed by the device id even when signed in', async () => {
    collect();
    const jar = await signIn();
    const viewed = event('results_viewed', undefined, secondsAgo(2));
    const opened = event('song_opened', {
      difficulty: 0.5,
      position: 3,
      trackId: 'mock-1-bohemian-rhapsody',
      SpotifyId: 'spotify:track:x',
      display_name: 'Test Singer',
      EMAIL: 'singer@example.com',
      userId: MOCK_USER.id,
    });
    const res = await post({ anonId: ANON, events: [viewed, opened] }, jar);
    expect(res.status).toBe(204);
    const stored = await getStore().listEvents();
    expect(stored).toEqual([
      { anonId: ANON, ...viewed },
      { anonId: ANON, name: 'song_opened', at: opened.at, props: { difficulty: 0.5, position: 3 } },
    ]);
    expect(JSON.stringify(stored)).not.toMatch(/mock-|spotify:|Test Singer|example\.com/);
  });

  it.each([
    ['a bad anonId', { anonId: 'short', events: [event('tap')] }],
    ['too many events', { anonId: ANON, events: Array.from({ length: 51 }, () => event('tap')) }],
    ['a bad name', { anonId: ANON, events: [event('Song Opened')] }],
    ['a bad prop value', { anonId: ANON, events: [event('song_opened', { view: { difficulty: 0.5 } })] }],
    ['a far-future at', { anonId: ANON, events: [event('tap', undefined, secondsAgo(-8 * 86_400))] }],
  ])('returns 400 and stores nothing for %s', async (_name, body) => {
    collect();
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad-request' });
    expect(await getStore().listEvents()).toEqual([]);
  });

  it('returns 400 for a body that is not JSON', async () => {
    collect();
    expect((await events.POST(req('/api/events', undefined, { method: 'POST', body: '{oops' }))).status).toBe(400);
  });

  it('accepts a text/plain body, as navigator.sendBeacon sends it', async () => {
    collect();
    const body = JSON.stringify({ anonId: ANON, events: [event('landing_viewed')] });
    const res = await events.POST(
      new Request(`${BASE}/api/events`, { method: 'POST', body, headers: { 'content-type': 'text/plain;charset=UTF-8' } }),
    );
    expect(res.status).toBe(204);
    expect((await getStore().listEvents()).map((e) => [e.anonId, e.name])).toEqual([[ANON, 'landing_viewed']]);
  });
});

describe('admin events', () => {
  const asAdmin = (path = '/api/admin/events') => adminEvents.GET(req(path, undefined, { headers: { 'x-admin-token': 'admin-token-123' } }));
  const send = (anonId: string, list: { name: string; at: string; props?: Record<string, unknown> }[]) =>
    events.POST(req('/api/events', undefined, { method: 'POST', json: { anonId, events: list } }));
  const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();

  beforeEach(() => {
    process.env.EVENTS = 'on';
    resetAppContextForTests();
  });

  it('is forbidden without the right token, and when ADMIN_TOKEN is unset', async () => {
    expect((await adminEvents.GET(req('/api/admin/events'))).status).toBe(403);
    expect((await adminEvents.GET(req('/api/admin/events', undefined, { headers: { 'x-admin-token': 'wrong' } }))).status).toBe(403);
    delete process.env.ADMIN_TOKEN;
    resetAppContextForTests();
    expect((await adminEvents.GET(req('/api/admin/events', undefined, { headers: { 'x-admin-token': '' } }))).status).toBe(403);
  });

  it('returns the funnel, per-control numbers and sessions', async () => {
    await send('device-aaaa', [
      { name: 'title_view', at: at(60) },
      { name: 'start_pressed', at: at(59) },
      { name: 'low_note_done', at: at(50), props: { midi: 45 } },
      { name: 'high_note_done', at: at(40), props: { midi: 72 } },
      { name: 'range_shown', at: at(39) },
    ]);
    const view = { difficulty: null, familiarity: null, popularity: null, tempo: null, decade: '80s', mood: null, duetsOnly: false };
    const opened = { name: 'song_open', at: at(15), props: { ...view, position: 2 } };
    await send('device-bbbb', [
      { name: 'title_view', at: at(30) },
      { name: 'list_view', at: at(20) },
      opened,
      { name: 'spotify_link_pressed', at: at(14), props: view },
      { name: 'feedback_tapped', at: at(10), props: { ...view, thumbs: 'up' } },
    ]);
    const res = await asAdmin();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as AdminEventsResponse;
    expect(body.funnel).toEqual([
      { name: 'title_view', devices: 2 },
      { name: 'start_pressed', devices: 1 },
      { name: 'low_note_done', devices: 1 },
      { name: 'high_note_done', devices: 1 },
      { name: 'range_shown', devices: 1 },
      { name: 'list_view', devices: 1 },
      { name: 'song_open', devices: 1 },
      { name: 'spotify_link_pressed', devices: 1 },
      { name: 'spotify_connect', devices: 0 },
    ]);
    expect(body.byControl).toEqual({ decade: { opened: 1, spotify: 1, up: 1, down: 0, medianPosition: 2 } });
    expect(body.sessions.map((s) => s.anonId)).toEqual(['device-bbbb', 'device-aaaa']);
    const names = (i: number) => body.sessions[i]!.events.map((e) => e.name);
    expect(names(0)).toEqual(['title_view', 'list_view', 'song_open', 'spotify_link_pressed', 'feedback_tapped']);
    expect(names(1)).toEqual(['title_view', 'start_pressed', 'low_note_done', 'high_note_done', 'range_shown']);
    expect(body.sessions[0]!.events[2]).toEqual(opened);
  });

  it('reads only the newest `limit` events, and rejects a bad limit', async () => {
    await send('device-aaaa', [
      { name: 'title_view', at: at(30) },
      { name: 'start_pressed', at: at(20) },
      { name: 'range_shown', at: at(10) },
    ]);
    const body = (await (await asAdmin('/api/admin/events?limit=2')).json()) as AdminEventsResponse;
    expect(body.funnel.slice(0, 2)).toEqual([
      { name: 'title_view', devices: 0 },
      { name: 'start_pressed', devices: 1 },
    ]);
    expect(body.sessions[0]!.events.map((e) => e.name)).toEqual(['start_pressed', 'range_shown']);
    for (const q of ['limit=0', 'limit=20001', 'limit=abc']) {
      expect((await asAdmin(`/api/admin/events?${q}`)).status).toBe(400);
    }
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

describe('shipped mood labels (QWW-11)', () => {
  // Moods need the DUETS_AND_MOODS switch (QWW-43) and then a mood listed in MOODS_SHIPPED.
  beforeEach(() => {
    process.env.DUETS_AND_MOODS = 'on';
    resetAppContextForTests();
  });

  const catalogueAll = async () =>
    ((await (await catalogueRecs.GET(req('/api/catalogue/recommendations?low=40&high=84&all=1'))).json()) as RecommendationsResponse).matches;

  it('no mood reaches the screen until MOODS_SHIPPED lists it', async () => {
    const matches = await catalogueAll();
    expect(matches.length).toBeGreaterThan(5);
    expect(matches.some((m) => m.moods)).toBe(false);
  });

  it('shows only the listed moods, from the seeded labels', async () => {
    process.env.MOODS_SHIPPED = 'heartfelt';
    resetAppContextForTests();
    const matches = await catalogueAll();
    const labelled = matches.filter((m) => m.moods);
    expect(labelled.length).toBeGreaterThan(0);
    for (const m of labelled) expect(m.moods).toEqual(['heartfelt']);
    const seed = SEED_SONGS.find((x) => x.title === 'Stand By Me')!;
    expect(matches.find((m) => m.track.title === seed.title)?.moods).toEqual(['heartfelt']);
  });

  it('library results carry shipped moods too', async () => {
    process.env.MOODS_SHIPPED = 'upbeat,heartfelt';
    resetAppContextForTests();
    const jar = await signIn();
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE }));
    const page = (await (await recs.GET(req('/api/recommendations?offset=0&limit=50', jar))).json()) as RecommendationsResponse;
    expect(page.matches.find((m) => m.track.title === 'Dancing Queen')?.moods).toEqual(['upbeat']);
  });
});

// QWW-43: duets and moods are hidden for the first tester release behind one switch, off by default.
// The promise that matters is that flipping it never changes the ranking for anyone, so these tests
// run every route that returns songs, over the kinds of range the release is judged on.
describe('duets and moods switch (QWW-43)', () => {
  const RANGES: [string, number, number][] = [
    ['everyone', 40, 84],
    ['A2 to C5', 45, 72],
    ['a low voice', 40, 62],
    ['a high voice', 55, 82],
    ['a narrow beginner', 50, 68],
  ];

  /** Every route that returns matches, for one range, with the switch on or off and every mood listed. */
  async function everyRoute(on: boolean, low: number, high: number) {
    process.env.DUETS_AND_MOODS = on ? 'on' : '';
    process.env.MOODS_SHIPPED = 'upbeat,heartfelt';
    resetAppContextForTests();
    const get = async (handler: { GET(r: Request): Promise<Response> }, path: string, jar?: Jar) =>
      (await (await handler.GET(req(path, jar))).json()) as RecommendationsResponse;
    const jar = await signIn();
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: { low, high, source: 'test' } }));
    const q = `low=${low}&high=${high}`;
    return {
      catalogueAll: await get(catalogueRecs, `/api/catalogue/recommendations?${q}&all=1`),
      cataloguePage: await get(catalogueRecs, `/api/catalogue/recommendations?${q}&offset=0&limit=50`),
      libraryAll: await get(recs, '/api/recommendations?all=1', jar),
      libraryPage: await get(recs, '/api/recommendations?offset=0&limit=50', jar),
    };
  }
  type Routes = Awaited<ReturnType<typeof everyRoute>>;
  const routeNames = ['catalogueAll', 'cataloguePage', 'libraryAll', 'libraryPage'] as const;

  const duetOrMoodFields = (m: Match) => [m.moods, m.part, m.partSinger, m.range.duet, m.range.parts].filter((v) => v !== undefined);
  const ids = (ms: Match[]) => ms.map((m) => m.track.id);
  /** The data-source lines with the time each seeded song was stored, which differs between two seedings. */
  const sansTimes = (sources: RecommendationsResponse['sources']) =>
    Object.fromEntries(Object.entries(sources).map(([id, line]) => [id, { ...line, at: '' }]));

  it('is off by default: no mood label and no duet marker on any route, even with every mood listed', async () => {
    const off = await everyRoute(false, 40, 84);
    for (const name of routeNames) {
      expect(off[name].matches.length, name).toBeGreaterThan(5);
      for (const m of off[name].matches) expect(duetOrMoodFields(m), `${name}: ${m.track.title}`).toEqual([]);
    }
  });

  it('only "on" turns it on: a typo or "1" leaves it off', async () => {
    for (const value of ['1', 'true', 'yes', 'onn', 'off']) {
      process.env.DUETS_AND_MOODS = value;
      process.env.MOODS_SHIPPED = 'upbeat,heartfelt';
      resetAppContextForTests();
      const body = (await (await catalogueRecs.GET(req('/api/catalogue/recommendations?low=40&high=84&all=1'))).json()) as RecommendationsResponse;
      expect(body.matches.filter((m) => duetOrMoodFields(m).length), value).toEqual([]);
    }
  });

  it('hides, it does not delete: switched on, the duet parts and the listed moods are all there', async () => {
    const on = await everyRoute(true, 40, 84);
    const catalogue = on.catalogueAll.matches;
    expect(catalogue.some((m) => m.range.duet === true && m.part !== undefined && m.partSinger !== undefined)).toBe(true);
    expect(catalogue.some((m) => m.range.parts?.length)).toBe(true);
    expect(catalogue.some((m) => m.moods?.includes('upbeat'))).toBe(true);
    expect(catalogue.some((m) => m.moods?.includes('heartfelt'))).toBe(true);
    expect(on.libraryAll.matches.some((m) => m.moods?.length)).toBe(true);
  });

  it.each(RANGES)('turning it off does not change the ranking for %s', async (_who, low, high) => {
    const on = await everyRoute(true, low, high);
    const off = await everyRoute(false, low, high);
    for (const name of routeNames) {
      expect(on[name].matches.length, name).toBeGreaterThan(0);
      // The same songs in the same order, and off is on with the words about duets and moods taken out
      // and nothing else: scores, labels, reasons and the paging fields all match.
      expect(ids(off[name].matches), name).toEqual(ids(on[name].matches));
      const { sources: offSources, ...offRest } = off[name];
      const { sources: onSources, ...onRest } = on[name];
      expect(offRest, name).toEqual({ ...onRest, matches: on[name].matches.map(withoutDuetsAndMoods) });
      expect(sansTimes(offSources), name).toEqual(sansTimes(onSources));
    }
  });

  it('leaves the order the phone works out from the list unchanged, and drops the chips', async () => {
    const on = await everyRoute(true, 40, 84);
    const off = await everyRoute(false, 40, 84);
    const user = { low: 40, high: 84, source: 'test' as const };
    const views: ResultsView[] = [
      DEFAULT_VIEW,
      ...SLIDER_IDS.flatMap((id) => [0, 0.5, 1].map((v) => ({ ...DEFAULT_VIEW, [id]: v }))),
      { ...DEFAULT_VIEW, difficulty: 0.2, popularity: 0.9, tempo: 0.6 },
      { ...DEFAULT_VIEW, decade: '80s' },
    ];
    const modes = [['catalogue', 'catalogueAll'], ['library', 'libraryAll']] as const;
    for (const [mode, name] of modes) {
      for (const view of views) {
        const fromOn = orderMatches(on[name].matches, view, user, mode);
        const fromOff = orderMatches(off[name].matches, view, user, mode);
        expect(ids(fromOff), `${mode} ${JSON.stringify(view)}`).toEqual(ids(fromOn));
      }
    }
    // The Pick row is built from the same fields: decades stay, the duet and mood chips go.
    expect(availableFacets(on.catalogueAll.matches)).toMatchObject({ decades: true, duets: true, moods: ['upbeat', 'heartfelt'] });
    expect(availableFacets(off.catalogueAll.matches)).toEqual({ decades: true, duets: false, moods: [] });
  });

  it('the pick-songs list says nothing about duets either, and lists the same songs in the same order', async () => {
    const pickList = async (on: boolean) => {
      process.env.DUETS_AND_MOODS = on ? 'on' : '';
      resetAppContextForTests();
      const jar = await signIn();
      return ((await (await known.GET(req('/api/songs/known', jar))).json()) as KnownSongsResponse).songs;
    };
    const on = await pickList(true);
    const off = await pickList(false);
    // The control: the mock library has a duet (Shallow), and with the switch on its parts are sent.
    expect(on.some((s) => s.range.duet === true && s.range.parts?.length)).toBe(true);
    expect(off.map((s) => s.track.id)).toEqual(on.map((s) => s.track.id));
    for (const s of off) expect([s.range.duet, s.range.parts].filter((v) => v !== undefined), s.track.title).toEqual([]);
    expect(off).toEqual(on.map((s) => ({ ...s, range: withoutDuetRange(s.range) })));
  });
});


describe('karaoke popularity (QWW-6)', () => {
  it('scores the library whole list with it, and keeps a Spotify year over the chart year', async () => {
    // Baby has no USDB row in the seeds, so nothing else gives it a popularity. Made-up chart numbers.
    await getStore().putSongPopularity([{ key: songKey('Justin Bieber', 'Baby'), chartRank: 9, chartYear: 2011, source: 'billboard' }]);
    const jar = await signIn();
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE }));
    const all = (await (await recs.GET(req('/api/recommendations?all=1', jar))).json()) as RecommendationsResponse;
    const baby = all.matches.find((m) => m.track.title === 'Baby')!;
    expect(baby).toMatchObject({ year: 2010, yearSource: 'spotify', parts: { popularity: CHART_FLOOR.top20, popularityKnown: true } });
    expect(baby.range).not.toHaveProperty('chartRank');
    const page = (await (await recs.GET(req('/api/recommendations?offset=0&limit=50', jar))).json()) as RecommendationsResponse;
    expect(page.matches.find((m) => m.track.title === 'Baby')!.parts).toMatchObject({ popularityKnown: false });
  });

  it('scores the catalogue with it and dates a song by its chart year when nothing else does', async () => {
    const key = songKey('Chart Artist', 'Chart Only Song');
    const range = { low: 55, high: 65, tessitura: 60, source: 'audio-full' as const, confidence: 'high' as const, fastLyrics: false };
    const log = { trackId: '', title: 'Chart Only Song', artist: 'Chart Artist', outcome: 'audio-full' as const, reason: 'Measured.', at: '2026-10-18T00:00:00.000Z' };
    await getStore().putSongRange(key, { range, log });
    await getStore().putSongPopularity([{ key, chartRank: 3, chartYear: 1999, source: 'billboard' }]);
    const body = (await (await catalogueRecs.GET(req('/api/catalogue/recommendations?low=45&high=80&all=1'))).json()) as RecommendationsResponse;
    const song = body.matches.find((m) => m.track.id === `cat:${key}`)!;
    expect(song).toMatchObject({ year: 1999, yearSource: 'chart', parts: { popularity: CHART_FLOOR.top20, popularityKnown: true } });
    expect(song.reasons).toContain('Crowd favourite');
    expect(song.range).toEqual(range);
  });
});

// QWW-55. On 10 Nov 2026 Spotify answered 429 (QUOTA_EXCEEDED, retry-after 12098 s) to the whole app, and a signed-in
// tester saw "Couldn't load songs" (a 502 from /api/recommendations). These go through the real Spotify client on a
// fake Web API that counts its requests, from sign-in to the song list.
describe('Spotify trouble is never a server error', () => {
  const CFG = { clientId: 'x', clientSecret: 'y', redirectUri: `${BASE}/api/auth/callback` };
  beforeEach(() => void vi.spyOn(console, 'info').mockImplementation(() => {}));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Signs in through the real client on the fake Web API: login sets the state, and Spotify would send the browser back with a code. */
  async function signInThrough(spotify: FakeSpotify, jar = new Jar()) {
    getAppContext().spotify = createSpotifyClient(CFG, spotify.fetch, async () => {});
    jar.take(await login.GET(req('/api/auth/login', jar)));
    const back = `${BASE}/api/auth/callback?code=spotify-code&state=${jar.cookies.get(STATE_COOKIE)}`;
    const r2 = jar.take(await callback.GET(new Request(back, { headers: { cookie: jar.header() } })));
    return { jar, location: r2.headers.get('location'), status: r2.status };
  }

  const list = async (jar: Jar, path = '/api/recommendations?all=1') => {
    const res = await recs.GET(req(path, jar));
    return { status: res.status, body: (await res.json()) as RecommendationsResponse };
  };

  it('with Spotify answering 429 QUOTA_EXCEEDED, the song list still loads, no request is a 5xx, and Spotify is left alone until the wait is over', async () => {
    const spotify = fakeSpotify({ liked: 120 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { jar } = await signInThrough(spotify);
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE }));
    spotify.quota.on = true; // 429 QUOTA_EXCEEDED, retry-after 12098 s, from here on

    const statuses: number[] = [];
    const first = await recs.GET(req('/api/recommendations?all=1', jar));
    statuses.push(first.status);
    const body = (await first.json()) as RecommendationsResponse;
    expect(body.libraryUnavailable).toBe(true);
    expect(body.complete).toBe(true);
    expect(body.matches.length).toBeGreaterThan(0);
    expect(body.matches.every((m) => m.track.id.startsWith('cat:'))).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/\[spotify\] could not load the library: Spotify API .* failed \(429\).*retry-after 12098 s/));
    const spent = spotify.requests.length;
    expect(await getStore().getSpotifyBlock()).toBeGreaterThan(Date.now() + 12_000_000);

    // Every route that wants the library, again and again: 200, the flag, and not one more request to Spotify.
    for (let i = 0; i < 10; i++) {
      const all = await recs.GET(req('/api/recommendations?all=1', jar));
      const paged = await recs.GET(req('/api/recommendations?offset=0&limit=5', jar));
      const knownRes = await known.GET(req('/api/songs/known', jar));
      statuses.push(all.status, paged.status, knownRes.status);
      expect(((await all.json()) as RecommendationsResponse).libraryUnavailable).toBe(true);
      const page = (await paged.json()) as RecommendationsResponse;
      expect(page).toMatchObject({ libraryUnavailable: true });
      expect(page.matches).toHaveLength(5);
      expect(await knownRes.json()).toEqual({ songs: [], libraryUnavailable: true });
    }
    expect((await me.GET(req('/api/me', jar))).status).toBe(200);
    expect(statuses.every((st) => st === 200)).toBe(true);
    expect(spotify.requests).toHaveLength(spent);
    // Signing in again, from another browser, asks Spotify for nothing either.
    expect((await signInThrough(spotify)).location).toBe(`${BASE}/?authError=spotify`);
    expect(spotify.requests).toHaveLength(spent);

    // The wait is over, and Spotify answers again: the library is read, and the flag is gone.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 12_099_000);
    spotify.quota.on = false;
    const later = await list(jar);
    expect(later.status).toBe(200);
    expect(later.body.libraryUnavailable).toBeUndefined();
    expect(later.body.matches.some((m) => m.track.id.startsWith('mock-'))).toBe(true);
    expect(spotify.requests.length).toBeGreaterThan(spent);
  });

  it('a quota 429 that sends no Retry-After blocks for an hour; a plain rate limit of a few seconds blocks nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const spotify = fakeSpotify({ liked: 120 });
    const { jar } = await signInThrough(spotify);
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE }));

    // Rate limited for 2 s, again after every wait: the retries run out, the screen gets catalogue songs, and Spotify is not blocked.
    spotify.shortLimit = { match: '/me/tracks', times: 99, retryAfter: 2 };
    const limited = await list(jar);
    expect(limited.status).toBe(200);
    expect(limited.body.libraryUnavailable).toBe(true);
    expect(await getStore().getSpotifyBlock()).toBeNull();
    spotify.shortLimit = null;
    const again = await list(jar);
    expect(again.body.libraryUnavailable).toBeUndefined(); // the next request asked Spotify again, and got the library

    // A quota 429 with no Retry-After at all.
    getAppContext().tracks.invalidate('real-singer');
    await getStore().deleteUserLibrary('real-singer'); // a user with a stored library is served it during a wait; this one has none
    spotify.quota.on = true;
    spotify.quota.retryAfter = null;
    const before = Date.now();
    expect((await list(jar)).body.libraryUnavailable).toBe(true);
    const until = (await getStore().getSpotifyBlock())!;
    expect(until - before).toBeGreaterThanOrEqual(3_600_000 - 5000);
    expect(until - before).toBeLessThan(3_600_000 + 5000);
  });

  it('a stalled Spotify gets catalogue songs at the read deadline, not the host\'s own 5xx', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const spotify = fakeSpotify({ liked: 120 });
    const { jar } = await signInThrough(spotify);
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE }));
    const asked: string[] = [];
    getAppContext().spotify = createSpotifyClient(CFG, (input) => {
      asked.push(input);
      return new Promise<Response>(() => {}); // never answers
    }, async () => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = list(jar);
    await vi.advanceTimersByTimeAsync(LIBRARY_DEADLINE_MS - 1);
    expect(asked.length).toBeGreaterThan(0);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body.libraryUnavailable).toBe(true);
    expect(res.body.matches.length).toBeGreaterThan(0);
  });

  it('a 429 at the profile step sends the browser back with authError=spotify, keeps the wait, and the next sign-in asks Spotify for nothing', async () => {
    const spotify = fakeSpotify();
    spotify.quota.on = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = await signInThrough(spotify);
    expect(first.status).toBe(302);
    expect(first.location).toBe(`${BASE}/?authError=spotify`);
    expect(first.jar.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(spotify.requests).toEqual(['POST accounts.spotify.com/api/token', 'GET /v1/me']);
    expect(await getStore().getSpotifyBlock()).toBeGreaterThan(Date.now() + 12_000_000);
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('failed at the profile (/me) step'));

    const second = await signInThrough(spotify);
    expect(second.status).toBe(302);
    expect(second.location).toBe(`${BASE}/?authError=spotify`);
    expect(spotify.requests).toHaveLength(2);
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('failed at the rate limit check step: SpotifyBlockedError'));
  });

  it('any other Spotify failure gives catalogue songs too, without keeping a wait', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const jar = await signIn();
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE }));
    getAppContext().spotify.getSavedPage = async () => {
      throw new TypeError('fetch failed');
    };
    const res = await list(jar);
    expect(res.status).toBe(200);
    expect(res.body.libraryUnavailable).toBe(true);
    expect(res.body.matches.length).toBeGreaterThan(0);
    expect(error).toHaveBeenCalledWith('[spotify] could not load the library: TypeError: fetch failed');
    expect(await getStore().getSpotifyBlock()).toBeNull();
  });

  it('a block that cannot be read does not hide a healthy Spotify', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spotify = fakeSpotify({ liked: 120 });
    vi.spyOn(getStore(), 'getSpotifyBlock').mockRejectedValue(new Error('relation "spotify_block" does not exist'));
    const { jar, location } = await signInThrough(spotify);
    expect(location).toBe(`${BASE}/?signedIn=1`);
    await meRange.PUT(req('/api/me/range', jar, { method: 'PUT', json: WIDE }));
    const res = await list(jar);
    expect(res.status).toBe(200);
    expect(res.body.libraryUnavailable).toBeUndefined();
    expect(res.body.matches.some((m) => m.track.id.startsWith('mock-'))).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[spotify] could not read the rate limit: Error: relation "spotify_block" does not exist'));
  });
});
