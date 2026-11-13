// QWW-47: POST /api/setlist, the Setlist tuner's route, end to end on the memory store and the mock Spotify
// (the placeholder seeds: a 25 song library and 15 catalogue-only songs), plus its request check and the
// catalogue's per-range cache. The ranking itself is tested in tests/songs/setlist.test.ts.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as login from '../../app/api/auth/login/route';
import * as callback from '../../app/api/auth/callback/route';
import * as setlistRoute from '../../app/api/setlist/route';
import { ERA_IDS } from '../../src/lib/contracts';
import type { EraId, GearValues, Match, SetlistRequest, SetlistResponse, SongRange, TunerPart } from '../../src/lib/contracts';
import { catalogueTracks, createCatalogue, prepareCatalogue, SETLIST_RANGES_KEPT } from '../../src/lib/server/catalogue';
import { LIBRARY_LISTS_KEPT, LIBRARY_RETRY_MS } from '../../src/lib/server/handlers';
import { setlistFor } from '../../src/lib/server/setlistService';
import { MOCK_USER } from '../../src/lib/server/mockSpotify';
import { SESSION_COOKIE } from '../../src/lib/server/session';
import { SpotifyError } from '../../src/lib/server/spotify';
import { validateSetlistRequest } from '../../src/lib/server/validate';
import { getAppContext, productionSongDeps, resetAppContextForTests } from '../../src/lib/server/wiring';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { DEFAULTS, DEFAULT_OFF, SETLIST_PAGE } from '../../src/lib/songs/setlistConfig';
import { catalogueEntries, rng } from '../helpers/sliderFixtures';

const BASE = 'http://127.0.0.1:3000';
const savedEnv = { ...process.env };
const RANGE = { low: 45, high: 80 };

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

function req(json: unknown, jar?: Jar, cookie?: string): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (jar?.cookies.size) headers.set('cookie', jar.header());
  if (cookie) headers.set('cookie', cookie);
  return new Request(`${BASE}/api/setlist`, { method: 'POST', headers, body: typeof json === 'string' ? json : JSON.stringify(json) });
}

async function signIn(): Promise<Jar> {
  const jar = new Jar();
  const r1 = jar.take(await login.GET(new Request(`${BASE}/api/auth/login`)));
  jar.take(await callback.GET(new Request(r1.headers.get('location')!, { headers: { cookie: jar.header() } })));
  expect(jar.cookies.has(SESSION_COOKIE)).toBe(true);
  return jar;
}

/** The tuner as it loads, with some of it changed. */
function body(over: Partial<{ gears: Partial<GearValues>; off: TunerPart[]; eras: EraId[]; offset: number; limit: number; range: { low: number; high: number } }> = {}): SetlistRequest {
  return {
    range: over.range ?? RANGE,
    gears: { difficulty: DEFAULTS.difficulty, history: DEFAULTS.history, popularity: DEFAULTS.popularity, tempo: DEFAULTS.tempo, ...over.gears },
    off: over.off ?? [...DEFAULT_OFF],
    eras: over.eras ?? [...DEFAULTS.eras],
    ...(over.offset !== undefined ? { offset: over.offset } : {}),
    ...(over.limit !== undefined ? { limit: over.limit } : {}),
  };
}

async function post(json: unknown, jar?: Jar, cookie?: string) {
  const res = await setlistRoute.POST(req(json, jar, cookie));
  return { status: res.status, headers: res.headers, body: (await res.json()) as SetlistResponse & { error?: string; message?: string } };
}
const ids = (b: SetlistResponse) => b.songs.map((s) => s.match.track.id);

beforeEach(() => {
  process.env = { ...savedEnv, KARAOKE_STORE: 'memory', SPOTIFY_MOCK: '1', SESSION_SECRET: 'integration-secret-integration-secret' };
  delete process.env.DUETS_AND_MOODS;
  resetAppContextForTests();
});
afterAll(() => {
  process.env = savedEnv;
  resetAppContextForTests();
  vi.useRealTimers();
});

describe('validateSetlistRequest', () => {
  const good = body({ limit: 20, offset: 40 });

  it('accepts the sheet\'s state and keeps only what the contract has, dropping repeated ids', () => {
    const v = validateSetlistRequest({ ...good, off: ['tempo', 'tempo', 'era'], eras: ['s90', 's90'], stray: 1 });
    expect(v).toEqual({ ok: true, value: { range: RANGE, gears: good.gears, off: ['tempo', 'era'], eras: ['s90'], offset: 40, limit: 20 } });
  });

  it('leaves out offset and limit when they are not sent', () => {
    const v = validateSetlistRequest(body());
    expect(v.ok && 'offset' in v.value).toBe(false);
    expect(v.ok && 'limit' in v.value).toBe(false);
  });

  it.each<[string, unknown, string]>([
    ['a body that is not an object', 'x', 'JSON object'],
    ['no range', { ...good, range: undefined }, 'range'],
    ['a range that is backwards', { ...good, range: { low: 70, high: 60 } }, 'range'],
    ['a range that is too narrow', { ...good, range: { low: 60, high: 63 } }, 'range'],
    ['no gears', { ...good, gears: undefined }, 'gears must be an object'],
    ['a gear that is missing', { ...good, gears: { difficulty: 0, history: 0, popularity: 0 } }, 'gears.tempo'],
    ['a gear that is not a whole number', { ...good, gears: { ...good.gears, tempo: 50.5 } }, 'gears.tempo'],
    ['a gear over 100', { ...good, gears: { ...good.gears, popularity: 101 } }, 'gears.popularity'],
    ['a gear under 0', { ...good, gears: { ...good.gears, difficulty: -1 } }, 'gears.difficulty'],
    ['a gear that is a string', { ...good, gears: { ...good.gears, history: '50' } }, 'gears.history'],
    ['an unknown part in off', { ...good, off: ['tempo', 'mood'] }, 'off must be'],
    ['off that is not a list', { ...good, off: 'tempo' }, 'off must be'],
    ['an unknown era', { ...good, eras: ['s60'] }, 'eras must be'],
    ['eras that are not a list', { ...good, eras: undefined }, 'eras must be'],
    ['an offset below 0', { ...good, offset: -1 }, 'offset'],
    ['a limit of 0', { ...good, limit: 0 }, 'limit'],
    ['a limit over the most a page holds', { ...good, limit: SETLIST_PAGE.max + 1 }, 'limit'],
  ])('rejects %s', (_name, input, mentions) => {
    const v = validateSetlistRequest(input);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain(mentions);
  });
});

describe('POST /api/setlist, signed out', () => {
  it('answers 200 with the ranked page, the parts that counted and no cache, for the tuner as it loads', async () => {
    const res = await post(body());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body.applied).toEqual(['difficulty', 'popularity']);
    expect(res.body.empty).toBeUndefined();
    expect(res.body.libraryUnavailable).toBeUndefined();
    expect(res.body.songs.length).toBeGreaterThan(5);
    expect(res.body.total).toBe(res.body.songs.length); // a small catalogue: one page holds it all
    expect(res.body.nextOffset).toBeNull();
    for (const s of res.body.songs) {
      expect(s.match.track.id.startsWith('cat:')).toBe(true);
      expect(Object.keys(s.gears).sort()).toEqual(['difficulty', 'history', 'popularity', 'tempo']);
      expect(s.gears.history).toBeNull(); // nobody's library
      expect(s.match.range.pitchShare).toBeUndefined(); // stripped, as in every whole-list response
      expect(res.body.sources[s.match.track.id]?.trackId).toBe(s.match.track.id);
    }
  });

  it('lists only songs that fit the range sent, as written or an octave away', async () => {
    const narrow = { low: 50, high: 70 };
    const res = await post(body({ range: narrow }));
    expect(res.body.songs.length).toBeGreaterThan(0);
    for (const { match } of res.body.songs) {
      const shift = match.octave === 'up' ? 12 : match.octave === 'down' ? -12 : 0;
      expect(match.range.low + shift).toBeGreaterThanOrEqual(narrow.low);
      expect(match.range.high + shift).toBeLessThanOrEqual(narrow.high);
    }
    expect(res.body.songs.length).toBeLessThan((await post(body())).body.songs.length);
  });

  it('lists the songs sung as written before the ones that need an octave jump, and still lists those (QWW-58)', async () => {
    const res = await post(body({ range: { low: 40, high: 70 }, limit: SETLIST_PAGE.max })); // a low range: the mock catalogue has songs sung as written and songs an octave down
    const sure = res.body.songs.filter((s) => s.match.difficulty !== 'maybe').map((s) => s.match.octave === 'none');
    // The mock catalogue has both kinds here, or this proves nothing.
    expect(sure.includes(true) && sure.includes(false)).toBe(true);
    expect(sure.indexOf(false)).toBe(sure.lastIndexOf(true) + 1); // one block sung as written, then one that needs a jump
    expect(res.body.total).toBe(res.body.songs.length);
  });

  it('ignores the History gear, on or off: nobody is signed in', async () => {
    const on = await post(body({ off: ['tempo', 'era'], gears: { history: 0 } }));
    const off = await post(body({ off: ['history', 'tempo', 'era'] }));
    expect(on.body.applied).toEqual(['difficulty', 'popularity']);
    expect(ids(on.body)).toEqual(ids(off.body));
  });

  it('re-ranks when a gear moves: Tempo at the slow end and at the fast end list different songs', async () => {
    const only: TunerPart[] = ['history', 'era', 'difficulty', 'popularity'];
    const slow = await post(body({ off: only, gears: { tempo: 0 } }));
    const fast = await post(body({ off: only, gears: { tempo: 100 } }));
    expect(slow.body.applied).toEqual(['tempo']);
    expect(ids(slow.body)).not.toEqual(ids(fast.body));
    expect(new Set(ids(slow.body))).toEqual(new Set(ids(fast.body))); // a gear only reorders
  });

  it('filters by era: Era off shows every era, picked eras only theirs, nothing picked shows nothing', async () => {
    const every = await post(body({ off: ['history', 'tempo', 'era'], eras: ['s80'] }));
    const eighties = await post(body({ off: ['history', 'tempo'], eras: ['s80'] }));
    const nothing = await post(body({ off: ['history', 'tempo'], eras: [] }));
    expect(every.body.songs.length).toBeGreaterThan(eighties.body.songs.length);
    expect(eighties.body.songs.length).toBeGreaterThan(0);
    expect(eighties.body.songs.every((s) => s.era === 's80')).toBe(true);
    expect(eighties.body.applied).toEqual(['difficulty', 'popularity', 'era']);
    expect(nothing.body).toMatchObject({ songs: [], total: 0, nextOffset: null, empty: 'no-era-picked' });
  });

  it('pages the list: offset and limit cut it, nextOffset points at the next row, and the pages add up to the list', async () => {
    const all = await post(body({ limit: SETLIST_PAGE.max }));
    const first = await post(body({ limit: 4 }));
    expect(first.body.songs).toHaveLength(4);
    expect(first.body.nextOffset).toBe(4);
    expect(first.body.total).toBe(all.body.total);
    const pages: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: Awaited<ReturnType<typeof post>> = await post(body({ limit: 7, offset }));
      expect(page.body.total).toBe(all.body.total);
      pages.push(...ids(page.body));
      offset = page.body.nextOffset;
    }
    expect(pages).toEqual(ids(all.body));
  });

  it('is empty, not an error, past the end of the list', async () => {
    const res = await post(body({ offset: 5000 }));
    expect(res.status).toBe(200);
    expect(res.body.songs).toEqual([]);
    expect(res.body.nextOffset).toBeNull();
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.empty).toBeUndefined(); // there are songs; this is just a page past them
  });

  it('says "no-songs-in-range" when nothing fits', async () => {
    const res = await post(body({ range: { low: 28, high: 33 } }));
    expect(res.body).toMatchObject({ songs: [], total: 0, empty: 'no-songs-in-range' });
  });

  it('treats a missing, garbled or forged session as signed out, never a 401', async () => {
    for (const cookie of [undefined, `${SESSION_COOKIE}=garbage`, `${SESSION_COOKIE}=${Buffer.from('someone').toString('base64url')}.AAAA`]) {
      const res = await post(body(), undefined, cookie);
      expect(res.status).toBe(200);
      expect(res.body.songs.every((s) => s.match.track.id.startsWith('cat:'))).toBe(true);
    }
  });

  it('answers 400 for a body that is not JSON or not the contract', async () => {
    expect((await post('not json')).status).toBe(400);
    const bad = await post({ ...body(), gears: { difficulty: 0, history: 0, popularity: 0, tempo: 101 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('bad-request');
    expect(bad.body.message).toContain('gears.tempo');
  });

  it('shows no duet or mood markers while DUETS_AND_MOODS is off, and the same songs in the same order when it is on', async () => {
    const off = await post(body({ off: ['history', 'tempo', 'era'] }));
    for (const { match } of off.body.songs) {
      expect(match.moods).toBeUndefined();
      expect(match.part).toBeUndefined();
      expect(match.partSinger).toBeUndefined();
      expect(match.range.duet).toBeUndefined();
      expect(match.range.parts).toBeUndefined();
    }
    process.env.DUETS_AND_MOODS = 'on';
    process.env.MOODS_SHIPPED = 'upbeat,heartfelt';
    resetAppContextForTests();
    const on = await post(body({ off: ['history', 'tempo', 'era'] }));
    expect(ids(on.body)).toEqual(ids(off.body));
    expect(on.body.songs.some((s) => s.match.range.duet === true)).toBe(true);
  });
});

describe('POST /api/setlist, multi-select Era', () => {
  const eraOff: TunerPart[] = ['history', 'tempo', 'era'];
  const eraOn: TunerPart[] = ['history', 'tempo'];
  /** The whole page for these picks (the placeholder catalogue is small enough for one). */
  const ask = (eras: EraId[], off: TunerPart[] = eraOn, jar?: Jar) => post(body({ off, eras, limit: SETLIST_PAGE.max }), jar);

  it('lists the songs of every picked era, no more and no fewer, in the order the whole list has them', async () => {
    const whole = await ask([], eraOff); // Era off: every era
    const eighties = await ask(['s80']);
    const nineties = await ask(['s90']);
    const both = await ask(['s80', 's90']);
    expect(eighties.body.total).toBeGreaterThan(0);
    expect(nineties.body.total).toBeGreaterThan(0);
    expect(both.body.total).toBe(eighties.body.total + nineties.body.total);
    expect(both.body.songs.every((s) => s.era === 's80' || s.era === 's90')).toBe(true);
    expect(new Set(both.body.songs.map((s) => s.era))).toEqual(new Set(['s80', 's90'])); // both are really there
    expect(ids(both.body)).toEqual(whole.body.songs.filter((s) => s.era === 's80' || s.era === 's90').map((s) => s.match.track.id));
    expect(both.body.applied).toEqual(['difficulty', 'popularity', 'era']);
    expect(both.body.empty).toBeUndefined();
  });

  it('picks any number of eras, up to all seven, which is every song with a year', async () => {
    const whole = await ask([], eraOff);
    const dated = whole.body.songs.filter((s) => s.era !== null);
    expect(dated.length).toBeLessThan(whole.body.songs.length); // one placeholder song has no year, and drops out
    const three = await ask(['pre', 's00', 's20']);
    expect(three.body.songs.every((s) => ['pre', 's00', 's20'].includes(s.era!))).toBe(true);
    expect(new Set(three.body.songs.map((s) => s.era))).toEqual(new Set(['pre', 's00', 's20']));
    const all = await ask([...ERA_IDS]);
    expect(ids(all.body)).toEqual(dated.map((s) => s.match.track.id));
  });

  it('is the same list whatever order the eras are sent in, and however often', async () => {
    const a = await ask(['s70', 's10', 's90']);
    expect(ids((await ask(['s90', 's70', 's10'])).body)).toEqual(ids(a.body));
    expect(ids((await ask(['s10', 's10', 's90', 's70', 's90'])).body)).toEqual(ids(a.body));
  });

  it('follows the tuner\'s taps: the first pick is one era, each tap adds or takes away one, none left is the empty state, reset is every era', async () => {
    const total = async (eras: EraId[], off: TunerPart[] = eraOn) => (await ask(eras, off)).body.total;
    const [s80, s90, s00] = [await total(['s80']), await total(['s90']), await total(['s00'])];
    expect(await total(['s80', 's90'])).toBe(s80 + s90); // tap '80s, then '90s
    expect(await total(['s80', 's90', 's00'])).toBe(s80 + s90 + s00);
    expect(await total(['s80', 's00'])).toBe(s80 + s00); // tap '90s again: it goes
    expect(await total(['s00'])).toBe(s00);
    expect((await ask([])).body).toMatchObject({ songs: [], total: 0, empty: 'no-era-picked' }); // "Pick an era to see songs."
    expect(await total(['s80'], eraOff)).toBe((await ask([], eraOff)).body.total); // reset: Era is off, so the picks left behind count for nothing
    expect((await ask(['s80'], eraOff)).body.applied).toEqual(['difficulty', 'popularity']);
  });

  it('pages through a selection of several eras without a gap or a repeat', async () => {
    const full = await ask(['s70', 's80', 's10']);
    const pages: string[] = [];
    for (let offset: number | null = 0; offset !== null; ) {
      const page: Awaited<ReturnType<typeof post>> = await post(body({ off: eraOn, eras: ['s80', 's10', 's70'], limit: 4, offset }));
      expect(page.body.total).toBe(full.body.total);
      pages.push(...ids(page.body));
      offset = page.body.nextOffset;
    }
    expect(pages).toEqual(ids(full.body));
    expect(new Set(pages).size).toBe(pages.length);
  });

  it('applies to a signed-in singer\'s library songs too, and the History gear still counts', async () => {
    const jar = await signIn();
    const res = await ask(['s70', 's80'], ['tempo'], jar);
    expect(res.body.applied).toEqual(['difficulty', 'history', 'popularity', 'era']);
    expect(res.body.songs.length).toBeGreaterThan(0);
    expect(res.body.songs.every((s) => s.era === 's70' || s.era === 's80')).toBe(true);
    expect(res.body.songs.some((s) => !s.match.track.id.startsWith('cat:'))).toBe(true); // the singer's own songs are in it
    expect(res.body.songs.every((s) => s.match.year !== undefined && s.match.year >= 1970 && s.match.year < 1990)).toBe(true);
  });
});

describe('POST /api/setlist, signed in', () => {
  it('adds the singer\'s library songs and lets History count: their own songs come first at On repeat', async () => {
    const jar = await signIn();
    const only: TunerPart[] = ['tempo', 'era', 'difficulty', 'popularity']; // History is the one gear left
    const res = await post(body({ off: only, gears: { history: 100 } }), jar);
    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual(['history']);
    expect(res.body.libraryUnavailable).toBeUndefined();

    const sure = res.body.songs.filter((s) => s.match.difficulty !== 'maybe');
    const library = sure.filter((s) => !s.match.track.id.startsWith('cat:'));
    expect(library.length).toBeGreaterThan(5);
    expect(sure.some((s) => s.match.track.id.startsWith('cat:'))).toBe(true); // the catalogue-only songs are still there
    // A tier: every library song before any catalogue-only one, and History is known for exactly the library's.
    const firstCatalogue = sure.findIndex((s) => s.match.track.id.startsWith('cat:'));
    expect(sure.slice(0, firstCatalogue).every((s) => s.gears.history !== null)).toBe(true);
    expect(sure.slice(firstCatalogue).every((s) => s.gears.history === null)).toBe(true);
    // Most played first: History places fall along the list.
    const places = library.map((s) => s.gears.history!);
    for (let i = 1; i < places.length; i++) expect(places[i]!).toBeLessThanOrEqual(places[i - 1]!);
    // Rediscover turns the library's order around.
    const rediscover = await post(body({ off: only, gears: { history: 0 } }), jar);
    const reLibrary = rediscover.body.songs.filter((s) => s.match.difficulty !== 'maybe' && !s.match.track.id.startsWith('cat:'));
    expect(reLibrary.map((s) => s.match.track.id)).toEqual(library.map((s) => s.match.track.id).reverse());
  });

  it('lists the library\'s songs the same way: sung as written before the ones that need an octave jump (QWW-58)', async () => {
    const res = await post(body({ range: { low: 40, high: 70 }, limit: SETLIST_PAGE.max }), await signIn());
    const sure = res.body.songs.filter((s) => s.match.difficulty !== 'maybe');
    const written = sure.map((s) => s.match.octave === 'none');
    expect(written.includes(true) && written.includes(false)).toBe(true);
    expect(written.indexOf(false)).toBe(written.lastIndexOf(true) + 1);
    expect(sure.some((s) => !s.match.track.id.startsWith('cat:'))).toBe(true); // the library's songs are in the list
  });

  it('lists a song once when the library and the catalogue both have it, as the library\'s', async () => {
    const signedOut = await post(body({ limit: SETLIST_PAGE.max }));
    const signedIn = await post(body({ limit: SETLIST_PAGE.max }), await signIn());
    const titles = signedIn.body.songs.map((s) => `${s.match.track.artist}|${s.match.track.title}`.toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);
    const africa = signedIn.body.songs.find((s) => s.match.track.title === 'Africa');
    expect(africa?.match.track.id.startsWith('cat:')).toBe(false); // a Spotify track id, with the Spotify player
    expect(signedOut.body.songs.find((s) => s.match.track.title === 'Africa')?.match.track.id.startsWith('cat:')).toBe(true);
    // The library adds its estimated songs (the Maybe group) to the catalogue's, and takes none away.
    expect(signedIn.body.total).toBeGreaterThanOrEqual(signedOut.body.total);
    for (const { match } of signedIn.body.songs) expect(signedIn.body.sources[match.track.id]?.trackId).toBe(match.track.id);
  });

  it('with the default state lists the same confident songs first as someone signed out: History is off', async () => {
    const out = await post(body({ limit: 10 }));
    const inn = await post(body({ limit: 10 }), await signIn());
    expect(inn.body.applied).toEqual(['difficulty', 'popularity']);
    expect(inn.body.songs.map((s) => `${s.match.track.artist}|${s.match.track.title}`)).toEqual(out.body.songs.map((s) => `${s.match.track.artist}|${s.match.track.title}`));
  });

  it('keeps a library\'s matches for the next request on the same range, and makes them again for another', async () => {
    const jar = await signIn();
    const spy = vi.spyOn(getAppContext().songs, 'libraryMatches');
    await post(body({ gears: { difficulty: 10 } }), jar);
    await post(body({ gears: { difficulty: 90 } }), jar);
    await post(body({ off: [], gears: { tempo: 20 }, eras: ['s80'] }), jar);
    expect(spy).toHaveBeenCalledTimes(1);
    await post(body({ range: { low: 50, high: 75 } }), jar);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('answers with the catalogue\'s songs and libraryUnavailable when Spotify cannot be read, and History does not count', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const jar = await signIn();
      getAppContext().spotify.getSavedPage = async () => {
        throw new SpotifyError('Spotify API /me/tracks?limit=50&offset=0 failed (429)', 429, '', '48000');
      };
      const res = await post(body({ off: ['tempo', 'era'] }), jar);
      expect(res.status).toBe(200);
      expect(res.body.libraryUnavailable).toBe(true);
      expect(res.body.applied).toEqual(['difficulty', 'popularity']);
      expect(res.body.songs.length).toBeGreaterThan(0);
      expect(res.body.songs.every((s) => s.match.track.id.startsWith('cat:'))).toBe(true);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('[spotify] could not load the library'));
    } finally {
      error.mockRestore();
    }
  });
});

describe('the catalogue keeps the tuner\'s songs for the last few ranges', () => {
  const deps = productionSongDeps(createMemoryStore(), false);
  const entries = catalogueEntries(rng(3), 400);

  it('hands out the same prepared songs for a range again, a new set for another, and forgets the oldest', async () => {
    const catalogue = createCatalogue(async () => entries, deps);
    const range = (n: number) => ({ low: 40 + n, high: 70 + n });
    const first = await catalogue.setlist(range(0));
    expect(await catalogue.setlist(range(0))).toBe(first);
    expect(await catalogue.setlist(range(1))).not.toBe(first);
    expect(first.matches.length).toBeGreaterThan(50);
    for (let n = 2; n <= SETLIST_RANGES_KEPT; n++) await catalogue.setlist(range(n));
    // SETLIST_RANGES_KEPT + 1 ranges have been asked for: the first, least recently used, is gone.
    expect(await catalogue.setlist(range(0))).not.toBe(first);
  });

  it('keeps a range that is asked for again ahead of one that is not', async () => {
    const catalogue = createCatalogue(async () => entries, deps);
    const range = (n: number) => ({ low: 40 + n, high: 70 + n });
    const first = await catalogue.setlist(range(0));
    for (let n = 1; n < SETLIST_RANGES_KEPT; n++) await catalogue.setlist(range(n));
    await catalogue.setlist(range(0)); // used again: now the newest
    await catalogue.setlist(range(SETLIST_RANGES_KEPT)); // pushes out the oldest, which is range 1
    expect(await catalogue.setlist(range(0))).toBe(first);
  });

  it('starts again when the catalogue is read again', async () => {
    let now = 0;
    const catalogue = createCatalogue(async () => [...entries], deps, { ttlMs: 1000, now: () => now });
    const first = await catalogue.setlist({ low: 40, high: 70 });
    now = 500;
    expect(await catalogue.setlist({ low: 40, high: 70 })).toBe(first);
    now = 2000; // the hour is up: a new read, so a new list
    const again = await catalogue.setlist({ low: 40, high: 70 });
    expect(again).not.toBe(first);
    expect(again.matches.length).toBe(first.matches.length);
  });
});

describe('what the response carries', () => {
  const deps = productionSongDeps(createMemoryStore(), false);
  const tracks = catalogueTracks(catalogueEntries(rng(3), 300));
  const range = { low: 40, high: 76 };
  const request = (over: Partial<SetlistRequest> = {}): SetlistRequest => ({ ...body({ range }), ...over });

  /** A library song made from a catalogue one: its stored range has a histogram and the karaoke inputs it was scored with. */
  function libraryMatch(from: Match): Match {
    const range = {
      ...from.range,
      pitchShare: [[from.range.low, 0.5], [from.range.high, 0.5]],
      karaokeViews: 12_345,
      chartRank: 4,
      deezerRank: 9,
      parts: [{ low: from.range.low, high: from.range.high, tessitura: from.range.tessitura, fastLyrics: false, pitchShare: [[from.range.low, 1]] }],
    } as SongRange;
    return { ...from, track: { ...from.track, id: 'spotify-own-1', familiarity: 0.9, known: true }, range };
  }

  it('has no pitch histograms and none of the karaoke popularity a song was scored with, whoever the song is', () => {
    const base = prepareCatalogue(tracks, range, deps);
    expect(base.matches.some((m) => m.range.pitchShare)).toBe(true); // the engine has them: the strain needs them
    const own = libraryMatch(base.matches[0]!);
    const library = { matches: [own], keys: new Map([['spotify-own-1', 'someone|somewhere']]), logs: new Map(), complete: true };
    const res = setlistFor(base, library, request({ off: ['tempo', 'era', 'difficulty', 'popularity'], gears: { ...request().gears, history: 100 }, limit: 200 }));
    expect(res.songs[0]!.match.track.id).toBe('spotify-own-1'); // On repeat, first: it is on the page
    const sent = JSON.stringify(res);
    for (const name of ['pitchShare', 'karaokeViews', 'chartRank', 'deezerRank']) expect(sent, name).not.toContain(name);
  });

  it('takes sources for the songs on the page only, and leaves the catalogue\'s own list as it found it', () => {
    const base = prepareCatalogue(tracks, range, deps);
    const before = JSON.stringify([...base.logs]);
    const own = libraryMatch(base.matches[0]!);
    const log = { trackId: 'spotify-own-1', title: 'T', artist: 'A', outcome: 'note-file' as const, reason: 'library line', at: '2026-01-01T00:00:00.000Z' };
    const library = { matches: [own], keys: new Map([['spotify-own-1', 'someone|somewhere']]), logs: new Map([['spotify-own-1', log]]), complete: true };
    const res = setlistFor(base, library, request({ limit: 3 }));
    expect(res.songs).toHaveLength(3);
    expect(Object.keys(res.sources).sort()).toEqual(res.songs.map((s) => s.match.track.id).sort());
    expect(JSON.stringify([...base.logs])).toBe(before); // merging a library never changes what the next request reads
    // And a library song shows its own line, not the catalogue's.
    const first = setlistFor(base, library, request({ off: ['tempo', 'era', 'difficulty', 'popularity'], gears: { ...request().gears, history: 100 }, limit: 1 }));
    expect(first.sources['spotify-own-1']?.reason).toBe('library line');
  });
});

describe('POST /api/setlist, signed in: what is kept, and what is not asked twice', () => {
  const only: TunerPart[] = ['tempo', 'era', 'difficulty', 'popularity'];

  it('shows no duet or mood markers to a signed-in singer either, and the order does not depend on the switch', async () => {
    const jar = await signIn();
    const off = await post(body({ off: ['tempo', 'era'] }), jar);
    for (const { match } of off.body.songs) {
      expect(match.moods).toBeUndefined();
      expect(match.part).toBeUndefined();
      expect(match.partSinger).toBeUndefined();
      expect(match.range.duet).toBeUndefined();
      expect(match.range.parts).toBeUndefined();
    }
    process.env.DUETS_AND_MOODS = 'on';
    resetAppContextForTests();
    const on = await post(body({ off: ['tempo', 'era'] }), await signIn());
    expect(ids(on.body)).toEqual(ids(off.body));
    expect(on.body.songs.some((s) => s.match.range.duet === true)).toBe(true);
  });

  it('makes the library\'s list again for a range with another top note, not just another bottom one', async () => {
    const jar = await signIn();
    const spy = vi.spyOn(getAppContext().songs, 'libraryMatches');
    await post(body({ range: { low: 45, high: 80 } }), jar);
    await post(body({ range: { low: 45, high: 79 } }), jar);
    await post(body({ range: { low: 46, high: 80 } }), jar);
    expect(spy).toHaveBeenCalledTimes(3);
    await post(body({ range: { low: 45, high: 80 } }), jar);
    expect(spy).toHaveBeenCalledTimes(3); // the first is still kept
  });

  it('keeps at most LIBRARY_LISTS_KEPT lists, dropping the least recently used', async () => {
    const jar = await signIn();
    const spy = vi.spyOn(getAppContext().songs, 'libraryMatches');
    const at = (n: number) => body({ range: { low: 45, high: 70 + n } });
    for (let n = 0; n <= LIBRARY_LISTS_KEPT; n++) await post(at(n), jar); // one more than are kept
    expect(spy).toHaveBeenCalledTimes(LIBRARY_LISTS_KEPT + 1);
    await post(at(LIBRARY_LISTS_KEPT), jar);
    expect(spy).toHaveBeenCalledTimes(LIBRARY_LISTS_KEPT + 1); // the newest is kept
    await post(at(0), jar);
    expect(spy).toHaveBeenCalledTimes(LIBRARY_LISTS_KEPT + 2); // the oldest was dropped
  });

  it('keeps a list that is used again ahead of one that is not', async () => {
    const jar = await signIn();
    const spy = vi.spyOn(getAppContext().songs, 'libraryMatches');
    const at = (n: number) => body({ range: { low: 45, high: 70 + n } });
    for (let n = 0; n < LIBRARY_LISTS_KEPT; n++) await post(at(n), jar);
    await post(at(0), jar); // used again: now the newest, and the oldest is range 1
    await post(at(LIBRARY_LISTS_KEPT), jar); // pushes one out
    const calls = spy.mock.calls.length;
    await post(at(0), jar);
    expect(spy).toHaveBeenCalledTimes(calls); // range 0 survived
    await post(at(1), jar);
    expect(spy).toHaveBeenCalledTimes(calls + 1); // range 1 did not
  });

  it('makes the list again when the singer\'s library has been read again, since its songs may have changed', async () => {
    const jar = await signIn();
    const ctx = getAppContext();
    const spy = vi.spyOn(ctx.songs, 'libraryMatches');
    await post(body(), jar);
    await post(body(), jar);
    expect(spy).toHaveBeenCalledTimes(1);
    ctx.tracks.invalidate(MOCK_USER.id); // the track cache lets go of the library: the next request reads it again
    await post(body(), jar);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not keep a list that is not complete, says so, and carries on with the next request', async () => {
    const jar = await signIn();
    const songs = getAppContext().songs;
    const real = songs.libraryMatches.bind(songs);
    const spy = vi.spyOn(songs, 'libraryMatches').mockImplementationOnce(async (...args) => ({ ...(await real(...args)), complete: false }));
    const first = await post(body({ off: only }), jar);
    expect(first.body.libraryIncomplete).toBe(true);
    expect(first.body.applied).toEqual(['history']); // the part of the library that is there still counts
    const second = await post(body({ off: only }), jar);
    expect(spy).toHaveBeenCalledTimes(2); // not kept: it asked again
    expect(second.body.libraryIncomplete).toBeUndefined();
    await post(body({ off: only }), jar);
    expect(spy).toHaveBeenCalledTimes(2); // complete: kept
  });

  it('does not let a slow list that settles late drop a newer list for the same range', async () => {
    const jar = await signIn();
    const songs = getAppContext().songs;
    const real = songs.libraryMatches.bind(songs);
    let release!: (late: Awaited<ReturnType<typeof real>>) => void;
    const spy = vi.spyOn(songs, 'libraryMatches').mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const at = (n: number) => body({ range: { low: 45, high: 70 + n } });

    const slow = post(at(0), jar); // its list is still being made...
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    for (let n = 1; n <= LIBRARY_LISTS_KEPT; n++) await post(at(n), jar); // ...while enough others push it out
    await post(at(0), jar); // the same range again: a new list, made in full
    expect(spy).toHaveBeenCalledTimes(LIBRARY_LISTS_KEPT + 2);

    release({ ...(await real(...spy.mock.calls[0]!)), complete: false }); // the first one settles at last, not complete
    await slow;
    await post(at(0), jar);
    expect(spy).toHaveBeenCalledTimes(LIBRARY_LISTS_KEPT + 2); // the newer list is still kept
  });

  it('answers with the catalogue\'s list when matching the library fails, and does not try again for a moment', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const jar = await signIn();
      const spy = vi.spyOn(getAppContext().songs, 'libraryMatches').mockRejectedValueOnce(new Error('database is down'));
      const first = await post(body(), jar);
      expect(first.status).toBe(200);
      expect(first.body.libraryUnavailable).toBe(true);
      expect(first.body.songs.every((s) => s.match.track.id.startsWith('cat:'))).toBe(true);
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/\[setlist\] could not match the library: .*database is down/));
      expect((await post(body(), jar)).body.libraryUnavailable).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1); // left alone for LIBRARY_RETRY_MS
      vi.setSystemTime(Date.now() + LIBRARY_RETRY_MS + 1000);
      const later = await post(body(), jar);
      expect(later.body.libraryUnavailable).toBeUndefined();
      expect(later.body.songs.some((s) => !s.match.track.id.startsWith('cat:'))).toBe(true);
    } finally {
      error.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not ask Spotify again on every slider move once its library could not be read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const jar = await signIn();
      const ctx = getAppContext();
      let calls = 0;
      ctx.spotify.getSavedPage = async () => {
        calls++;
        throw new Error('network down'); // not a quota 429: nothing else keeps the next request from trying
      };
      for (let move = 0; move < 8; move++) {
        const res = await post(body({ gears: { difficulty: move * 10 } }), jar);
        expect(res.status).toBe(200);
        expect(res.body.libraryUnavailable).toBe(true);
      }
      expect(calls).toBe(1);
      vi.setSystemTime(Date.now() + LIBRARY_RETRY_MS + 1000);
      await post(body(), jar);
      expect(calls).toBe(2); // a moment later it is allowed to try once more
    } finally {
      error.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps one singer\'s library list from another\'s', async () => {
    const jar = await signIn();
    const other = await signIn(); // the mock signs in as the same user; the keys are per user id, so it shares one entry
    const spy = vi.spyOn(getAppContext().songs, 'libraryMatches');
    const a = await post(body({ off: only }), jar);
    const b = await post(body({ off: only }), other);
    expect(ids(b.body)).toEqual(ids(a.body));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('the catalogue\'s per-range list, keyed by both ends of the range', () => {
  const deps = productionSongDeps(createMemoryStore(), false);
  it('is made again for a range with another top note', async () => {
    const catalogue = createCatalogue(async () => catalogueEntries(rng(3), 300), deps);
    const a = await catalogue.setlist({ low: 40, high: 70 });
    expect(await catalogue.setlist({ low: 40, high: 70 })).toBe(a);
    expect(await catalogue.setlist({ low: 40, high: 71 })).not.toBe(a);
    expect(await catalogue.setlist({ low: 41, high: 70 })).not.toBe(a);
  });
});
