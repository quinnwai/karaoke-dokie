import { describe, expect, it, vi } from 'vitest';
import type { DataSourceLogEntry, Match, SongRange, Track, VocalRange } from '../../src/lib/contracts';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { createSongService, MAX_ALL_MATCHES, type SongDeps } from '../../src/lib/server/songService';
import { matchSong as fitSong } from '../../src/lib/songs/match';
import { scoreMatch, UNKNOWN_POPULARITY } from '../../src/lib/songs/score';

const track = (n: number): Track => ({
  id: `t${n}`,
  title: `Song ${n}`,
  artist: `Artist ${n}`,
  artistId: `a${n}`,
  spotifyUrl: `https://open.spotify.com/track/t${n}`,
  playRank: n,
});
const range = (low: number, high: number): SongRange => ({
  low,
  high,
  tessitura: Math.round((low + high) / 2),
  source: 'note-file',
  confidence: 'high',
  fastLyrics: false,
});
const user: VocalRange = { low: 48, high: 72, source: 'test' };

/** Fakes: even-numbered songs fit, multiples of 3 are skipped (no data). */
function fakeDeps(overrides: Partial<SongDeps> = {}) {
  const resolveSongRange = vi.fn(async (t: Track) => {
    const n = Number(t.id.slice(1));
    const skipped = n % 3 === 0;
    return {
      range: skipped ? null : n % 2 === 0 ? range(50, 70) : range(30, 90),
      log: {
        trackId: t.id,
        title: t.title,
        artist: t.artist,
        outcome: skipped ? ('skipped' as const) : ('note-file' as const),
        reason: skipped ? 'no note file' : 'USDB note file',
        at: '2026-01-01T00:00:00.000Z',
      },
    };
  });
  const deps: SongDeps = {
    songKey: (a, t) => `${a}|${t}`.toLowerCase(),
    resolveSongRange,
    matchSong: (t, r, u): Match | null =>
      r.low >= u.low && r.high <= u.high ? { track: t, range: r, difficulty: 'easy', octave: 'none' } : null,
    rankMatches: (m) => [...m].sort((a, b) => a.track.playRank - b.track.playRank),
    paginate: (items, offset, limit) => ({
      items: items.slice(offset, offset + limit),
      nextOffset: offset + limit < items.length ? offset + limit : null,
    }),
    ...overrides,
  };
  return { deps, resolveSongRange };
}

// Fits: even and not multiple of 3 -> 2, 4, 8, 10, 14, 16, 20, 22, 26, 28, ...
const tracks = Array.from({ length: 30 }, (_, i) => track(i + 1));

describe('song service recommendations', () => {
  it('looks up the whole library so it can rank all of it, then returns the first page', async () => {
    const store = createMemoryStore();
    const { deps, resolveSongRange } = fakeDeps();
    const svc = createSongService(store, deps, { concurrency: 1 });
    const res = await svc.recommend(tracks, user, 0, 5);
    expect(res.matches.map((m) => m.track.id)).toEqual(['t2', 't4', 't8', 't10', 't14']);
    expect(res.nextOffset).toBe(5);
    expect(resolveSongRange).toHaveBeenCalledTimes(30);
    expect(Object.keys(res.sources).sort()).toEqual(['t10', 't14', 't2', 't4', 't8']);
    expect(res.sources.t2).toMatchObject({ outcome: 'note-file', trackId: 't2' });
  });

  it('caches lookups and logs every resolved song, including skipped ones', async () => {
    const store = createMemoryStore();
    const { deps, resolveSongRange } = fakeDeps();
    const svc = createSongService(store, deps, { concurrency: 1 });
    await svc.recommend(tracks, user, 0, 5);
    const log = await store.listLog(100);
    expect(log).toHaveLength(30);
    expect(log.filter((e) => e.outcome === 'skipped').map((e) => e.trackId).sort()).toEqual(
      ['t12', 't15', 't18', 't21', 't24', 't27', 't3', 't30', 't6', 't9'].sort(),
    );
    expect(await store.getSongRange('artist 3|song 3')).toMatchObject({ range: null });
    expect(await store.getSongRange('artist 2|song 2')).toMatchObject({ range: range(50, 70) });

    resolveSongRange.mockClear();
    const again = await svc.recommend(tracks, user, 0, 5);
    expect(again.matches).toHaveLength(5);
    expect(resolveSongRange).not.toHaveBeenCalled();
    expect(await store.listLog(100)).toHaveLength(30); // cache hits are not logged again
  });

  it('pages through to the end and returns nextOffset null', async () => {
    const svc = createSongService(createMemoryStore(), fakeDeps().deps);
    const seen: string[] = [];
    let offset: number | null = 0;
    let guard = 0;
    while (offset !== null && guard++ < 20) {
      const res = await svc.recommend(tracks, user, offset, 5);
      seen.push(...res.matches.map((m) => m.track.id));
      offset = res.nextOffset;
    }
    expect(offset).toBeNull();
    expect(seen).toEqual(['t2', 't4', 't8', 't10', 't14', 't16', 't20', 't22', 't26', 't28']);
  });

  it('leaves out dub and instrumental versions, which share the original song key', async () => {
    // Like the real songKey, both versions share the original's key, so they share its range.
    const svc = createSongService(createMemoryStore(), fakeDeps({ songKey: (a, t) => `${a}|${t.replace(/ - .*$/, '')}`.toLowerCase() }).deps);
    const dub = { ...track(2), id: 't2dub', title: 'Song 2 - Satta Dub' };
    const remix = { ...track(2), id: 't2remix', title: 'Song 2 - Remix' };
    const res = await svc.recommend([track(2), dub, remix], user, 0, 50);
    expect(res.matches.map((m) => m.track.id)).toEqual(['t2', 't2remix']);
  });

  it('never matches skipped songs', async () => {
    const svc = createSongService(createMemoryStore(), fakeDeps().deps);
    const res = await svc.recommend(tracks, { low: 20, high: 100, source: 'test' }, 0, 50);
    const ids = res.matches.map((m) => Number(m.track.id.slice(1)));
    expect(ids.length).toBe(20);
    expect(ids.every((n) => n % 3 !== 0)).toBe(true);
    expect(res.nextOffset).toBeNull();
  });

  it('caps lookups per request and lets the client continue', async () => {
    const store = createMemoryStore();
    const { deps, resolveSongRange } = fakeDeps();
    const svc = createSongService(store, deps, { maxResolvesPerRequest: 3, concurrency: 2 });
    const first = await svc.recommend(tracks, user, 0, 5);
    expect(resolveSongRange).toHaveBeenCalledTimes(3);
    expect(first.matches.map((m) => m.track.id)).toEqual(['t2']);
    expect(first.nextOffset).toBe(1);
    const second = await svc.recommend(tracks, user, 1, 5);
    expect(second.matches.map((m) => m.track.id)).toEqual(['t4']);
  });

  it('logs failed lookups without caching them', async () => {
    const store = createMemoryStore();
    const { deps } = fakeDeps({
      resolveSongRange: async () => {
        throw new Error('USDB down');
      },
    });
    const res = await createSongService(store, deps).recommend(tracks.slice(0, 2), user, 0, 5);
    expect(res).toEqual({ matches: [], nextOffset: null, sources: {} });
    expect((await store.listLog())[0]).toMatchObject({ outcome: 'skipped', reason: 'Lookup failed: USDB down' });
    expect(await store.getSongRange('artist 1|song 1')).toBeNull();
  });

  it('shares cached ranges between tracks with the same song key', async () => {
    const store = createMemoryStore();
    const { deps, resolveSongRange } = fakeDeps();
    const dup = { ...track(2), id: 'other-id', playRank: 3 };
    const res = await createSongService(store, deps).recommend([track(2), dup], user, 0, 5);
    expect(resolveSongRange).toHaveBeenCalledTimes(1);
    expect(res.matches.map((m) => m.track.id)).toEqual(['t2', 'other-id']);
    expect(res.sources['other-id']?.trackId).toBe('other-id');
  });
});

describe('song service known songs', () => {
  it('lists library songs with a known range in play order', async () => {
    const svc = createSongService(createMemoryStore(), fakeDeps().deps, { maxKnownSongs: 4 });
    const res = await svc.knownSongs(tracks);
    expect(res.songs.map((s) => s.track.id)).toEqual(['t1', 't2', 't4', 't5']);
    expect(res.songs[1]!.range).toEqual(range(50, 70));
  });
});

describe('song service ranking', () => {
  it('ranks the whole library before paging, so pages never overlap', async () => {
    const { deps } = fakeDeps({ rankMatches: (m) => [...m].reverse() });
    const svc = createSongService(createMemoryStore(), deps);
    const p1 = await svc.recommend(tracks, user, 0, 5);
    const p2 = await svc.recommend(tracks, user, 5, 5);
    expect(p1.matches.map((m) => m.track.id)).toEqual(['t28', 't26', 't22', 't20', 't16']);
    expect(p2.matches.map((m) => m.track.id)).toEqual(['t14', 't10', 't8', 't4', 't2']);
    expect(p2.nextOffset).toBeNull();
  });
});

describe('song service whole list (all)', () => {
  const ids = (ms: Match[]) => ms.map((m) => m.track.id);
  const logFor = (t: Track): DataSourceLogEntry => ({
    trackId: t.id, title: t.title, artist: t.artist, outcome: 'note-file', reason: 'USDB note file', at: '2026-01-01T00:00:00.000Z',
  });
  /** A resolver that gives every song this range. */
  const everyone = (r: SongRange) => async (t: Track) => ({ range: r, log: logFor(t) });
  const key = (n: number) => `artist ${n}|song ${n}`;
  const indexRow = (n: number, extra: { views?: number; rating?: number; year?: number; genre?: string } = {}) => ({
    id: n, key: key(n), artist: `Artist ${n}`, title: `Song ${n}`, ...extra,
  });
  /** The real matcher and scorer, as the app wires them. */
  const scoring: SongDeps['matchSong'] = (t, r, u) => {
    const fit = fitSong(u, r);
    return fit ? scoreMatch(u, { track: t, range: r, ...fit }) : null;
  };

  it('returns every match at once, the same songs as paging to the end, with complete true', async () => {
    const all = await createSongService(createMemoryStore(), fakeDeps().deps).recommend(tracks, user, 7, 2, { all: true });
    const pager = createSongService(createMemoryStore(), fakeDeps().deps);
    const paged: string[] = [];
    for (let offset: number | null = 0, guard = 0; offset !== null && guard < 20; guard++) {
      const res = await pager.recommend(tracks, user, offset, 5);
      paged.push(...ids(res.matches));
      offset = res.nextOffset;
    }
    expect(paged).toHaveLength(10);
    expect([...ids(all.matches)].sort()).toEqual([...paged].sort());
    expect(all.complete).toBe(true);
    expect(all.nextOffset).toBeNull();
    expect(Object.keys(all.sources).sort()).toEqual([...paged].sort());
  });

  it('says it is not complete when the lookup budget runs out, and where to carry on; asking again finishes', async () => {
    const svc = createSongService(createMemoryStore(), fakeDeps().deps, { maxResolvesPerRequest: 10, concurrency: 2 });
    const first = await svc.recommend(tracks, user, 0, 0, { all: true });
    expect(ids(first.matches)).toEqual(['t2', 't4', 't8', 't10']); // songs 1 to 10 looked up
    expect(first.complete).toBe(false);
    expect(first.nextOffset).toBe(4);
    let res = first;
    for (let guard = 0; !res.complete && guard < 5; guard++) res = await svc.recommend(tracks, user, 0, 0, { all: true });
    expect(res.complete).toBe(true);
    expect(res.nextOffset).toBeNull();
    expect(res.matches).toHaveLength(10);
  });

  it(`stops at ${MAX_ALL_MATCHES} songs and lets the client page the rest`, async () => {
    const many = Array.from({ length: MAX_ALL_MATCHES + 3 }, (_, i) => track(i + 1));
    const { deps } = fakeDeps({ resolveSongRange: everyone(range(50, 70)) });
    const svc = createSongService(createMemoryStore(), deps, { maxResolvesPerRequest: 5000, concurrency: 100 });
    const res = await svc.recommend(many, user, 0, 0, { all: true });
    expect(res.matches).toHaveLength(MAX_ALL_MATCHES);
    expect(Object.keys(res.sources)).toHaveLength(MAX_ALL_MATCHES);
    expect(res.complete).toBe(false);
    expect(res.nextOffset).toBe(MAX_ALL_MATCHES);
    const rest = await svc.recommend(many, user, MAX_ALL_MATCHES, 50);
    expect(ids(rest.matches)).toEqual(['t1001', 't1002', 't1003']);
    expect(rest.nextOffset).toBeNull();
  });

  it('leaves pages exactly as they were: no index read, no song facts, histograms kept', async () => {
    const store = createMemoryStore();
    await store.putUsdbSongs([indexRow(2, { views: 5000, rating: 4, year: 1975, genre: 'Rock' })]);
    const findUsdbSongs = vi.spyOn(store, 'findUsdbSongs');
    const withShare: SongRange = { ...range(50, 70), pitchShare: [[55, 0.5], [65, 0.5]] };
    const matchSong = vi.fn(fakeDeps().deps.matchSong);
    const { deps } = fakeDeps({ matchSong, resolveSongRange: everyone(withShare) });
    const lib = [{ ...track(2), releaseYear: 1990 }, track(4)];
    const res = await createSongService(store, deps).recommend(lib, user, 0, 5);
    expect(res).toStrictEqual({
      matches: [
        { track: lib[0], range: withShare, difficulty: 'easy', octave: 'none' },
        { track: lib[1], range: withShare, difficulty: 'easy', octave: 'none' },
      ],
      nextOffset: null,
      sources: { t2: logFor(lib[0]!), t4: logFor(lib[1]!) },
    });
    expect(findUsdbSongs).not.toHaveBeenCalled();
    expect(matchSong.mock.calls.map(([, r]) => r)).toStrictEqual([withShare, withShare]);
  });

  it('reads the USDB index once for the whole list, for the songs that have a range', async () => {
    const store = createMemoryStore();
    const findUsdbSongs = vi.spyOn(store, 'findUsdbSongs');
    await createSongService(store, fakeDeps().deps).recommend(tracks, user, 0, 0, { all: true });
    expect(findUsdbSongs).toHaveBeenCalledTimes(1);
    const withRange = tracks.map((t) => Number(t.id.slice(1))).filter((n) => n % 3 !== 0);
    expect([...findUsdbSongs.mock.calls[0]![0]].sort()).toEqual(withRange.map(key).sort());
  });

  it('gives each song the earlier of the USDB and Spotify years, and says which one it is', async () => {
    const store = createMemoryStore();
    await store.putUsdbSongs([indexRow(2, { year: 1975 }), indexRow(4, { year: 1999 }), indexRow(8, { year: 1981 }), indexRow(14, { year: 1969 }), indexRow(16)]);
    const lib = [
      { ...track(2), releaseYear: 2011 }, // a remaster: USDB's 1975 is the song's year
      { ...track(4), releaseYear: 1990 }, // Spotify's is earlier
      { ...track(8), releaseYear: 1981 }, // a tie counts as USDB's
      { ...track(10), releaseYear: 2003 }, // not in the index
      track(14), // no Spotify year
      track(16), // neither has a year
    ];
    const res = await createSongService(store, fakeDeps().deps).recommend(lib, user, 0, 0, { all: true });
    const years = Object.fromEntries(res.matches.map((m) => [m.track.id, [m.year, m.yearSource]]));
    expect(years).toEqual({
      t2: [1975, 'usdb'],
      t4: [1990, 'spotify'],
      t8: [1981, 'usdb'],
      t10: [2003, 'spotify'],
      t14: [1969, 'usdb'],
      t16: [undefined, undefined],
    });
    const t16 = res.matches.find((m) => m.track.id === 't16')!;
    expect(t16).not.toHaveProperty('year');
    expect(t16).not.toHaveProperty('yearSource');
  });

  it('takes the genre from the index row', async () => {
    const store = createMemoryStore();
    await store.putUsdbSongs([indexRow(2, { genre: 'Rock' }), indexRow(4)]);
    const res = await createSongService(store, fakeDeps().deps).recommend([track(2), track(4), track(8)], user, 0, 0, { all: true });
    expect(res.matches.map((m) => m.genre)).toEqual(['Rock', undefined, undefined]);
    expect(res.matches[1]).not.toHaveProperty('genre');
  });

  it('scores with the index row\'s views and stars only when the range has none, and never stores them', async () => {
    const store = createMemoryStore();
    await store.putUsdbSongs([indexRow(2, { views: 5000, rating: 4 }), indexRow(4, { views: 9000, rating: 5 })]);
    const own = { ...range(50, 70), usdbViews: 10 };
    const matchSong = vi.fn(fakeDeps().deps.matchSong);
    const { deps } = fakeDeps({
      matchSong,
      resolveSongRange: async (t) => ({ range: t.id === 't4' ? own : range(50, 70), log: logFor(t) }),
    });
    const res = await createSongService(store, deps).recommend([track(2), track(4), track(8)], user, 0, 0, { all: true });
    const scored = Object.fromEntries(matchSong.mock.calls.map(([t, r]) => [t.id, r]));
    expect(scored.t2).toStrictEqual({ ...range(50, 70), usdbViews: 5000, usdbRating: 4 });
    expect(scored.t4).toStrictEqual(own); // its own views stand, and the index adds no stars to them
    expect(scored.t8).toStrictEqual(range(50, 70)); // not in the index
    expect(res.matches[0]!.range).toMatchObject({ usdbViews: 5000, usdbRating: 4 });
    expect((await store.getSongRange(key(2)))!.range).toStrictEqual(range(50, 70));
  });

  it('marks popularity as known when the index has views or stars for a song that lacked them', async () => {
    const store = createMemoryStore();
    await store.putUsdbSongs([indexRow(2, { views: 5000, rating: 4 })]);
    const { deps } = fakeDeps({ matchSong: scoring, resolveSongRange: everyone(range(56, 64)) });
    const lib = [track(2), track(4), { ...track(8), popularity: 60 }];
    const res = await createSongService(store, deps).recommend(lib, user, 0, 0, { all: true });
    const parts = Object.fromEntries(res.matches.map((m) => [m.track.id, m.parts!]));
    expect(parts.t2).toMatchObject({ popularityKnown: true });
    expect(parts.t2!.popularity).not.toBe(UNKNOWN_POPULARITY);
    expect(parts.t4).toMatchObject({ popularityKnown: false, popularity: UNKNOWN_POPULARITY });
    expect(parts.t8).toMatchObject({ popularityKnown: true, popularity: 0.6 });
    // Pages score as before, without the index.
    const page = await createSongService(store, deps).recommend(lib, user, 0, 5);
    expect(page.matches.find((m) => m.track.id === 't2')!.parts).toMatchObject({ popularityKnown: false, popularity: UNKNOWN_POPULARITY });
  });

  it('leaves pitch histograms out of the whole list, duet parts included, without touching the stored range', async () => {
    const store = createMemoryStore();
    const duet: SongRange = {
      ...range(50, 70),
      pitchShare: [[55, 0.5], [65, 0.5]],
      duet: true,
      parts: [
        { singer: 'Freddie', low: 50, high: 70, tessitura: 60, pitchShare: [[55, 1]], fastLyrics: false },
        { singer: 'David', low: 52, high: 68, tessitura: 60, fastLyrics: false },
      ],
    };
    const { deps } = fakeDeps({ resolveSongRange: everyone(duet) });
    const res = await createSongService(store, deps).recommend([track(2)], user, 0, 0, { all: true });
    const sent = res.matches[0]!.range;
    expect(sent).not.toHaveProperty('pitchShare');
    expect(sent.parts).toStrictEqual([
      { singer: 'Freddie', low: 50, high: 70, tessitura: 60, fastLyrics: false },
      { singer: 'David', low: 52, high: 68, tessitura: 60, fastLyrics: false },
    ]);
    expect(sent).toMatchObject({ low: 50, high: 70, duet: true });
    expect((await store.getSongRange(key(2)))!.range).toStrictEqual(duet);
  });
});
