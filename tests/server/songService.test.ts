import { describe, expect, it, vi } from 'vitest';
import type { Match, SongRange, Track, VocalRange } from '../../src/lib/contracts';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { createSongService, type SongDeps } from '../../src/lib/server/songService';

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
  it('returns the first page lazily, resolving only what it needs', async () => {
    const store = createMemoryStore();
    const { deps, resolveSongRange } = fakeDeps();
    const svc = createSongService(store, deps, { concurrency: 1 });
    const res = await svc.recommend(tracks, user, 0, 5);
    expect(res.matches.map((m) => m.track.id)).toEqual(['t2', 't4', 't8', 't10', 't14']);
    expect(res.nextOffset).toBe(5);
    // Needed 6 matches (one extra to know a next page exists): t16 is the 6th -> 16 lookups.
    expect(resolveSongRange).toHaveBeenCalledTimes(16);
    expect(Object.keys(res.sources).sort()).toEqual(['t10', 't14', 't2', 't4', 't8']);
    expect(res.sources.t2).toMatchObject({ outcome: 'note-file', trackId: 't2' });
  });

  it('caches lookups and logs every resolved song, including skipped ones', async () => {
    const store = createMemoryStore();
    const { deps, resolveSongRange } = fakeDeps();
    const svc = createSongService(store, deps, { concurrency: 1 });
    await svc.recommend(tracks, user, 0, 5);
    const log = await store.listLog(100);
    expect(log).toHaveLength(16);
    expect(log.filter((e) => e.outcome === 'skipped').map((e) => e.trackId).sort()).toEqual(
      ['t12', 't15', 't3', 't6', 't9'].sort(),
    );
    expect(await store.getSongRange('artist 3|song 3')).toMatchObject({ range: null });
    expect(await store.getSongRange('artist 2|song 2')).toMatchObject({ range: range(50, 70) });

    resolveSongRange.mockClear();
    const again = await svc.recommend(tracks, user, 0, 5);
    expect(again.matches).toHaveLength(5);
    expect(resolveSongRange).not.toHaveBeenCalled();
    expect(await store.listLog(100)).toHaveLength(16); // cache hits are not logged again
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
