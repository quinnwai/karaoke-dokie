import { describe, expect, it, vi } from 'vitest';
import type { SongRange, VocalRange } from '../../src/lib/contracts';
import {
  CATALOGUE_SIZE,
  CATALOGUE_TTL_MS,
  DEGRADED_TTL_MS,
  catalogueKey,
  catalogueTracks,
  createCatalogue,
  loadCatalogue,
  recommendCatalogue,
} from '../../src/lib/server/catalogue';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import type { CatalogueSong, SongCanonical, SongPopularityRecord, UsdbIndexEntry } from '../../src/lib/server/store';
import { MAX_ALL_MATCHES } from '../../src/lib/server/songService';
import { productionSongDeps } from '../../src/lib/server/wiring';
import { DEFAULT_VIEW, orderMatches } from '../../src/lib/songs/browse';
import { CHART_FLOOR, UNKNOWN_POPULARITY } from '../../src/lib/songs/score';

const user: VocalRange = { low: 48, high: 72, source: 'test' }; // C3-C5, centre C4
/** The real matching, scoring and ranking, as the app injects them. */
const deps = productionSongDeps(createMemoryStore(), false);

const range = (low: number, high: number, extra: Partial<SongRange> = {}): SongRange => ({
  low,
  high,
  tessitura: (low + high) / 2,
  source: 'note-file',
  confidence: 'high',
  fastLyrics: false,
  ...extra,
});
const song = (artist: string, title: string, r: SongRange, usdb?: Partial<UsdbIndexEntry>): CatalogueSong => {
  const key = `${artist}|${title}`.toLowerCase();
  const s: CatalogueSong = {
    key,
    artist,
    title,
    range: r,
    log: { trackId: 'spotify-track-of-a-tester', title, artist, outcome: r.source, reason: 'Measured.', at: '2026-10-18T00:00:00.000Z' },
  };
  if (usdb) s.usdb = { id: 1, key, artist, title, ...usdb };
  return s;
};
const ids = (matches: { track: { id: string } }[]) => matches.map((m) => m.track.id);

describe('catalogue tracks', () => {
  it('shows each song as a track nobody has played, with a Spotify search link', () => {
    const tracks = catalogueTracks([song('ABBA', 'Dancing Queen', range(57, 69)), song('Toto', 'Africa', range(55, 67))]);
    expect(tracks[0]!.track).toEqual({
      id: 'cat:abba|dancing queen',
      title: 'Dancing Queen',
      artist: 'ABBA',
      artistId: '',
      spotifyUrl: 'https://open.spotify.com/search/ABBA%20Dancing%20Queen',
      playRank: 0,
      familiarity: 1,
      known: false,
    });
    expect(tracks[1]!.track.playRank).toBe(1);
  });

  it('replaces the stored track id in the log line, which can be a tester’s Spotify track', () => {
    const [t] = catalogueTracks([song('ABBA', 'Dancing Queen', range(57, 69))]);
    expect(t!.log).toMatchObject({ trackId: 'cat:abba|dancing queen', title: 'Dancing Queen', outcome: 'note-file' });
  });

  it('reads the song key back from a catalogue id only', () => {
    expect(catalogueKey('cat:abba|dancing queen')).toBe('abba|dancing queen');
    expect(catalogueKey('cat:')).toBeNull();
    expect(catalogueKey('mock-1-bohemian-rhapsody')).toBeNull();
  });
});

describe('catalogue recommendations', () => {
  it('scores with the USDB row’s views and stars when the range has none, and returns the stored range', () => {
    const plain = range(57, 63);
    const tracks = catalogueTracks([song('A', 'Unknown', plain), song('B', 'Popular', plain, { views: 99_999, rating: 5 })]);
    const { matches } = recommendCatalogue(tracks, user, deps, { all: true });
    expect(matches.map((m) => m.track.title)).toEqual(['Popular', 'Unknown']);
    const [popular, unknown] = matches;
    expect(popular!.parts!.popularity).toBeCloseTo(1);
    expect(unknown!.parts!.popularity).toBe(UNKNOWN_POPULARITY);
    expect(popular!.range).toEqual(plain);
    expect(tracks[1]!.range).toEqual(plain);
  });

  it('keeps the range’s own USDB views and stars over the row’s', () => {
    const own = range(57, 63, { usdbViews: 10, usdbRating: 1 });
    const tracks = catalogueTracks([song('A', 'With row', own, { views: 99_999, rating: 5 }), song('B', 'No row', own)]);
    const [a, b] = recommendCatalogue(tracks, user, deps, { all: true }).matches;
    expect(a!.parts!.popularity).toBeCloseTo(b!.parts!.popularity);
    expect(a!.parts!.popularity).toBeLessThan(0.3);
  });

  it('adds the year and genre from the USDB row', () => {
    const tracks = catalogueTracks([
      song('ABBA', 'Dancing Queen', range(57, 63), { year: 1976, genre: 'Pop' }),
      song('Toto', 'Africa', range(57, 63)),
    ]);
    const { matches } = recommendCatalogue(tracks, user, deps, { all: true });
    expect(matches.find((m) => m.track.title === 'Dancing Queen')).toMatchObject({ year: 1976, yearSource: 'usdb', genre: 'Pop' });
    const africa = matches.find((m) => m.track.title === 'Africa')!;
    for (const field of ['year', 'yearSource', 'genre']) expect(africa).not.toHaveProperty(field);
  });

  it('never says you play or know a song, and labels it like any other', () => {
    const tracks = catalogueTracks([
      song('A', 'Easy', range(57, 63), { views: 99_999, rating: 5 }),
      song('B', 'Hard', range(49, 71, { pitchShare: [[49, 0.3], [60, 0.4], [71, 0.3]] })),
      song('C', 'Estimate', range(50, 70, { source: 'audio-full', confidence: 'low' })),
    ]);
    const { matches } = recommendCatalogue(tracks, user, deps, { all: true });
    expect(matches.map((m) => [m.track.title, m.difficulty])).toEqual([
      ['Easy', 'easy'],
      ['Hard', 'hard'],
      ['Estimate', 'maybe'],
    ]);
    expect(matches[0]!.reasons).toEqual(['In your sweet spot', 'Crowd favourite']);
    // Only range and crowd reasons: no listening reason, in any wording.
    for (const m of matches) {
      for (const r of m.reasons ?? []) expect(r).toMatch(/^(In your sweet spot|Mostly comfortable|Some (high|low) notes|Lots of (high|low) notes|Crowd favourite)$/);
    }
  });

  it('leaves out dub and karaoke versions and songs that do not fit', () => {
    const tracks = catalogueTracks([
      song('Soul II Soul', 'Back to Life - Satta Dub', range(57, 63)),
      song('Someone', 'Song (Karaoke Version)', range(57, 63)),
      song('Low', 'Too Low', range(30, 40)),
      song('Fits', 'Fine', range(57, 63)),
    ]);
    expect(ids(recommendCatalogue(tracks, user, deps, { all: true }).matches)).toEqual(['cat:fits|fine']);
  });

  it('all: every match, complete, sources for each, and no pitch histograms (the cache keeps them)', () => {
    const share: [number, number][] = [[57, 0.5], [63, 0.5]];
    const duet = range(57, 63, {
      pitchShare: share,
      duet: true,
      parts: [{ low: 57, high: 63, tessitura: 60, pitchShare: share, fastLyrics: false }],
    });
    const tracks = catalogueTracks([song('A', 'Duet', duet), song('B', 'Solo', range(55, 65, { pitchShare: share }))]);
    const res = recommendCatalogue(tracks, user, deps, { all: true });
    expect(res.complete).toBe(true);
    expect(res.nextOffset).toBeNull();
    expect(res.matches).toHaveLength(2);
    for (const m of res.matches) {
      expect(m.range).not.toHaveProperty('pitchShare');
      expect(res.sources[m.track.id]).toMatchObject({ trackId: m.track.id, outcome: 'note-file', reason: 'Measured.' });
    }
    const returnedDuet = res.matches.find((m) => m.track.title === 'Duet')!.range;
    expect(returnedDuet.parts![0]).toEqual({ low: 57, high: 63, tessitura: 60, fastLyrics: false });
    expect(Object.keys(res.sources).sort()).toEqual(ids(res.matches).sort());
    expect(tracks[0]!.range.pitchShare).toEqual(share);
    expect(tracks[0]!.range.parts![0]!.pitchShare).toEqual(share);
  });

  it('sends a duet with the range of the part it matched, so the bar is the notes you sing (QWW-33, Rasputin)', () => {
    // D#2 to D#4. Part 1 sings F#4 to D6, out of reach even an octave down; part 2 sings B3 to B4, which fits an octave down.
    const part1: [number, number][] = [[66, 0.7], [86, 0.3]];
    const rasputin = range(66, 86, {
      duet: true,
      usdbId: 12261,
      pitchShare: part1,
      parts: [
        { low: 66, high: 86, tessitura: 71, pitchShare: part1, fastLyrics: false },
        { low: 59, high: 71, tessitura: 65, pitchShare: [[59, 0.5], [64, 0.4], [71, 0.1]], fastLyrics: false },
      ],
    });
    const mine: VocalRange = { low: 39, high: 63, source: 'test' };
    const tracks = catalogueTracks([song('Boney M.', 'Rasputin', rasputin, { views: 99_999, rating: 5 })]);
    const { matches } = recommendCatalogue(tracks, mine, deps, { all: true });
    expect(matches).toHaveLength(1);
    const [m] = matches;
    expect(m).toMatchObject({ part: 2, octave: 'down' });
    // Part 2's own range, not the whole song's (which is part 1's): sung an octave down it stays inside D#2 to D#4.
    expect(m!.range).toMatchObject({ low: 59, high: 71, tessitura: 65, duet: true });
    expect(m!.range.low - 12).toBeGreaterThanOrEqual(mine.low);
    expect(m!.range.high - 12).toBeLessThanOrEqual(mine.high);
    // Still the stored range: both parts kept, no histograms, none of the popularity it was scored with.
    expect(m!.range.parts).toHaveLength(2);
    expect(m!.range).not.toHaveProperty('pitchShare');
    expect(m!.range).not.toHaveProperty('usdbViews');
    expect(m!.range.usdbId).toBe(12261);
  });

  it('pages never repeat or skip a song, and carry only their own sources', () => {
    const tracks = catalogueTracks(
      Array.from({ length: 8 }, (_, i) => song('Artist', `Song ${i}`, range(54 + (i % 4), 62 + (i % 3)), i % 2 ? { views: 100 * i } : undefined)),
    );
    const all = ids(recommendCatalogue(tracks, user, deps, { all: true }).matches);
    expect(all).toHaveLength(8);
    const paged: string[] = [];
    let offset: number | null = 0;
    for (let i = 0; offset !== null && i < 10; i++) {
      const p = recommendCatalogue(tracks, user, deps, { offset, limit: 3 });
      expect(p.complete).toBeUndefined();
      expect(Object.keys(p.sources).sort()).toEqual(ids(p.matches).sort());
      paged.push(...ids(p.matches));
      offset = p.nextOffset;
    }
    expect(offset).toBeNull();
    expect(paged).toEqual(all);
  });
});

describe('karaoke popularity (QWW-6)', () => {
  const popularity = (s: CatalogueSong, extra: Omit<SongPopularityRecord, 'key' | 'source'>): SongPopularityRecord => ({ key: s.key, source: 'test', ...extra });

  it('is read with the catalogue, once for all of its songs, and kept on the songs that have a row', async () => {
    const store = createMemoryStore();
    const a = song('A', 'Charted', range(57, 63));
    const b = song('B', 'Plain', range(57, 63));
    await store.putSongRange(a.key, { range: a.range, log: a.log });
    await store.putSongRange(b.key, { range: b.range, log: b.log });
    const row = popularity(a, { chartRank: 4, chartYear: 2001 });
    await store.putSongPopularity([row, { key: 'nobody|else', karaokeViews: 1, source: 'test' }]);
    const listCatalogue = vi.spyOn(store, 'listCatalogue');
    const getSongPopularity = vi.spyOn(store, 'getSongPopularity');
    const loaded = await loadCatalogue(store);
    expect(listCatalogue).toHaveBeenCalledWith(CATALOGUE_SIZE);
    expect(getSongPopularity).toHaveBeenCalledTimes(1);
    expect([...getSongPopularity.mock.calls[0]![0]].sort()).toEqual([a.key, b.key]);
    expect(loaded.find((s) => s.key === a.key)!.popularity).toEqual(row);
    expect(loaded.find((s) => s.key === b.key)).not.toHaveProperty('popularity');
  });

  it('reads each song\'s tempo with the catalogue and puts it on the match (QWW-40)', async () => {
    const store = createMemoryStore();
    const a = song('A', 'Fast', range(57, 63));
    const b = song('B', 'NoTempo', range(57, 63));
    await store.putSongRange(a.key, { range: a.range, log: a.log });
    await store.putSongRange(b.key, { range: b.range, log: b.log });
    // Deezer 60 folds to 120, which with no label to vouch for it is squeezed into the mid band (QWW-54: 105.68);
    // a key with no song row never reaches the catalogue
    await store.putSongTempo([{ key: a.key, deezerBpm: 60 }, { key: 'nobody|else', trackerBpm: 99 }]);
    const getSongTempos = vi.spyOn(store, 'getSongTempos');
    const loaded = await loadCatalogue(store);
    expect(getSongTempos).toHaveBeenCalledTimes(1);
    expect(loaded.find((s) => s.key === a.key)!.tempo).toBeCloseTo(105.68, 2);
    expect(loaded.find((s) => s.key === b.key)).not.toHaveProperty('tempo');
    const all = recommendCatalogue(catalogueTracks(loaded), user, deps, { all: true });
    expect(all.matches.find((m) => m.track.title === 'Fast')!.tempo).toBeCloseTo(105.68, 2);
    expect(all.matches.find((m) => m.track.title === 'NoTempo')).not.toHaveProperty('tempo');
  });

  it("puts each song's Deezer track id on its match, for the row's play button (QWW-48)", async () => {
    const store = createMemoryStore();
    const a = song('A', 'Found', range(57, 63));
    const b = song('B', 'Missed', range(57, 63));
    const c = song('C', 'Never looked up', range(57, 63));
    for (const s of [a, b, c]) await store.putSongRange(s.key, { range: s.range, log: s.log });
    await store.putSongDeezer([
      { key: a.key, rank: 500_000, deezerId: 3_135_556, checkedAt: '2026-11-06T00:00:00.000Z' },
      { key: b.key, checkedAt: '2026-11-06T00:00:00.000Z' }, // Deezer had no matching track
    ]);
    const tracks = catalogueTracks(await loadCatalogue(store));
    for (const page of [{ all: true } as const, { offset: 0, limit: 5 }]) {
      const byTitle = Object.fromEntries(recommendCatalogue(tracks, user, deps, page).matches.map((m) => [m.track.title, m]));
      expect(byTitle.Found!.deezerId).toBe(3_135_556);
      expect(byTitle.Missed).not.toHaveProperty('deezerId');
      expect(byTitle['Never looked up']).not.toHaveProperty('deezerId');
    }
  });

  describe('feel labels (QWW-54)', () => {
    /** Three songs: a really fast one, a ballad Deezer reads at double time, and one nobody labelled. */
    async function withLabels(labels: 'none' | 'both') {
      const store = createMemoryStore();
      const fast = song('Fast', 'Really Fast', range(57, 63));
      const ballad = song('Slow', 'Double Time Ballad', range(57, 63));
      const plain = song('Plain', 'Unlabelled', range(57, 63));
      for (const s of [fast, ballad, plain]) await store.putSongRange(s.key, { range: s.range, log: s.log });
      await store.putSongTempo([
        { key: fast.key, deezerBpm: 172 },
        { key: ballad.key, deezerBpm: 170 },
        { key: plain.key, deezerBpm: 100 },
      ]);
      if (labels === 'both') {
        await store.putSongFeel([
          { key: fast.key, feel: 'upbeat', source: 'test/v1' },
          { key: ballad.key, feel: 'slow', source: 'test/v1' },
        ]);
      }
      return { store, fast, ballad, plain };
    }
    const titles = (ms: { track: { title: string } }[]) => ms.map((m) => m.track.title);
    const endOf = (loaded: Awaited<ReturnType<typeof loadCatalogue>>, tempo: 0 | 1) =>
      titles(orderMatches(recommendCatalogue(catalogueTracks(loaded), user, deps, { all: true }).matches, { ...DEFAULT_VIEW, tempo }, user, 'catalogue'));

    it('moves a labelled song into its label\'s band, says where its tempo came from, and leaves the others as measured', async () => {
      const { store, fast, ballad, plain } = await withLabels('both');
      const getSongFeels = vi.spyOn(store, 'getSongFeels');
      const loaded = await loadCatalogue(store);
      const by = (key: string) => loaded.find((s) => s.key === key)!;
      expect(getSongFeels).toHaveBeenCalledTimes(1); // once for the whole catalogue
      expect(by(fast.key)).toMatchObject({ tempo: 172, tempoSource: 'deezer' });
      expect(by(ballad.key)).toMatchObject({ tempo: 85, tempoSource: 'deezer' }); // 170 halved
      expect(by(plain.key)).toMatchObject({ tempoSource: 'deezer' });
      expect(by(plain.key).tempo).toBeCloseTo(99.41, 2); // no label: 100 bpm squeezed into the mid band
    });

    it('keeps a double-time ballad off the upbeat end of the Tempo gear, and puts it first at the slow end', async () => {
      const before = await loadCatalogue((await withLabels('none')).store);
      // Without the labels the ballad is the second most upbeat song, above the song measured at 100.
      expect(endOf(before, 1)).toEqual(['Really Fast', 'Double Time Ballad', 'Unlabelled']);
      const after = await loadCatalogue((await withLabels('both')).store);
      expect(endOf(after, 1)).toEqual(['Really Fast', 'Unlabelled', 'Double Time Ballad']);
      expect(endOf(after, 0)).toEqual(['Double Time Ballad', 'Unlabelled', 'Really Fast']);
    });

    it('does no tempo work for a request: the tempos and labels are read once when the cache fills, and never again', async () => {
      const { store } = await withLabels('both');
      const getSongTempos = vi.spyOn(store, 'getSongTempos');
      const getSongFeels = vi.spyOn(store, 'getSongFeels');
      const catalogue = createCatalogue(() => loadCatalogue(store), deps);
      for (const page of [{ all: true as const }, { all: true as const }, { offset: 0, limit: 2 }]) await catalogue.recommend(user, page);
      expect(getSongTempos).toHaveBeenCalledTimes(1);
      expect(getSongFeels).toHaveBeenCalledTimes(1);
    });

    it('carries the one tempo to the match and nothing else about it', async () => {
      const loaded = await loadCatalogue((await withLabels('both')).store);
      const m = recommendCatalogue(catalogueTracks(loaded), user, deps, { all: true }).matches.find((x) => x.track.title === 'Double Time Ballad')!;
      expect(m.tempo).toBe(85);
      expect(m).not.toHaveProperty('tempoSource');
    });

    it('works before the labels reach a database: a store with no feel methods, or no song_feel table, ranks on the measured tempo', async () => {
      const { store, ballad } = await withLabels('both');
      const { getSongFeels: _, ...withoutFeels } = store;
      const measured = (await loadCatalogue(withoutFeels)).find((s) => s.key === ballad.key)!;
      expect(measured.tempo).toBeCloseTo(121.36, 2); // 170 bpm, measured and unlabelled: squeezed into the mid band
      expect(measured.tempo).toBeGreaterThanOrEqual(90); // never the 85 the label would give

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Postgres' own words for it, with the code Neon sends, and pg-mem's wording without one
      for (const err of [Object.assign(new Error('relation "song_feel" does not exist\nat somewhere'), { code: '42P01' }), new Error('relation "song_feel" does not exist')]) {
        vi.spyOn(store, 'getSongFeels').mockRejectedValueOnce(err);
        const loaded = await loadCatalogue(store);
        expect(loaded.find((s) => s.key === ballad.key)).toMatchObject({ tempoSource: 'deezer' });
        expect(loaded.find((s) => s.key === ballad.key)!.tempo).toBeCloseTo(121.36, 2);
      }
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]![0]).toContain('relation "song_feel" does not exist');
      expect(warn.mock.calls[0]![0]).not.toContain('somewhere');
      warn.mockRestore();
    });

    it('does not keep the measured tempos for a cache lifetime after a failed labels read: it fails like the other reads, and the next fill asks again', async () => {
      const { store, ballad } = await withLabels('both');
      vi.spyOn(store, 'getSongFeels').mockRejectedValueOnce(new Error('fetch failed (timeout)'));
      let now = 0;
      const catalogue = createCatalogue(() => loadCatalogue(store), deps, { now: () => now });
      await expect(catalogue.get()).rejects.toThrow('fetch failed');
      now += 1; // the failed fill was dropped, so this asks again and gets the labelled tempo
      expect((await catalogue.get()).find((t) => t.key === ballad.key)!.tempo).toBe(85);
    });
  });

  it('scores with it on every request, all=1 or a page, and returns the stored range', () => {
    const plain = range(57, 63);
    const charted = song('A', 'Charted', plain);
    const viewed = song('B', 'Viewed', plain, { views: 10, rating: 1 });
    const unknown = song('C', 'Unknown', plain);
    const tracks = catalogueTracks([
      { ...unknown },
      { ...viewed, popularity: popularity(viewed, { karaokeViews: 1_000_000 }) },
      { ...charted, popularity: popularity(charted, { chartRank: 15, chartYear: 1997 }) },
    ]);
    const all = recommendCatalogue(tracks, user, deps, { all: true });
    expect(all.matches.map((m) => m.track.title)).toEqual(['Charted', 'Viewed', 'Unknown']);
    const [first, second, third] = all.matches;
    expect(first!.parts).toMatchObject({ popularity: CHART_FLOOR.top20, popularityKnown: true });
    expect(first!.reasons).toEqual(['In your sweet spot', 'Crowd favourite']);
    expect(second!.parts!.popularity).toBeGreaterThan(UNKNOWN_POPULARITY); // its own low USDB numbers, averaged with many karaoke views
    expect(third!.parts).toMatchObject({ popularity: UNKNOWN_POPULARITY, popularityKnown: false });
    for (const m of all.matches) expect(m.range).toEqual(plain);
    expect(tracks[2]!.range).toStrictEqual(plain);
    expect(recommendCatalogue(tracks, user, deps, { offset: 0, limit: 3 }).matches.map((m) => m.track.id)).toEqual(all.matches.map((m) => m.track.id));
  });

  it('takes the chart year only for a song whose USDB row has no year', () => {
    const withYear = song('A', 'Dated', range(57, 63), { year: 1975 });
    const noYear = song('B', 'Undated', range(57, 63), { views: 100 });
    const noRow = song('C', 'No row', range(57, 63));
    const tracks = catalogueTracks([
      { ...withYear, popularity: popularity(withYear, { chartRank: 50, chartYear: 1976 }) },
      { ...noYear, popularity: popularity(noYear, { chartRank: 50, chartYear: 1988 }) },
      { ...noRow, popularity: popularity(noRow, { chartRank: 50, chartYear: 2003 }) },
    ]);
    const byTitle = Object.fromEntries(recommendCatalogue(tracks, user, deps, { all: true }).matches.map((m) => [m.track.title, [m.year, m.yearSource]]));
    expect(byTitle).toEqual({ Dated: [1975, 'usdb'], Undated: [1988, 'chart'], 'No row': [2003, 'chart'] });
  });
});

describe('catalogue cache', () => {
  const songs = [song('ABBA', 'Dancing Queen', range(57, 63))];

  it('reads the store once per TTL (an hour by default)', async () => {
    let t = 0;
    let loads = 0;
    const catalogue = createCatalogue(
      async () => {
        loads++;
        return songs;
      },
      deps,
      { now: () => t },
    );
    const first = await catalogue.get();
    expect(first.map((s) => s.track.id)).toEqual(['cat:abba|dancing queen']);
    t = CATALOGUE_TTL_MS - 1;
    expect(await catalogue.get()).toBe(first);
    expect((await catalogue.recommend(user, { all: true })).matches).toHaveLength(1);
    expect(loads).toBe(1);
    t = CATALOGUE_TTL_MS;
    expect(await catalogue.get()).not.toBe(first);
    expect(loads).toBe(2);
    expect(CATALOGUE_TTL_MS).toBe(60 * 60_000);
  });

  it('shares one read between requests that arrive while it runs', async () => {
    let loads = 0;
    const catalogue = createCatalogue(
      async () => {
        loads++;
        return songs;
      },
      deps,
      { ttlMs: 1000, now: () => 0 },
    );
    const [a, b] = await Promise.all([catalogue.get(), catalogue.get()]);
    expect(a).toBe(b);
    expect(loads).toBe(1);
  });

  it('reads again after a failed read', async () => {
    let fail = true;
    const catalogue = createCatalogue(
      async () => {
        if (fail) throw new Error('database down');
        return songs;
      },
      deps,
      { now: () => 0 },
    );
    await expect(catalogue.get()).rejects.toThrow('database down');
    fail = false;
    expect(await catalogue.get()).toHaveLength(1);
  });
});

describe('all=1 size', () => {
  it('sends at most MAX_ALL_MATCHES songs, the best by Top picks', () => {
    const many = Array.from({ length: MAX_ALL_MATCHES + 50 }, (_, i) =>
      song(`Artist ${i}`, `Song ${i}`, range(55, 65), { views: MAX_ALL_MATCHES + 50 - i }),
    );
    const tracks = catalogueTracks(many);
    const all = recommendCatalogue(tracks, user, deps, { all: true });
    const paged = recommendCatalogue(tracks, user, deps, { offset: 0, limit: 5 });
    expect(all.matches).toHaveLength(MAX_ALL_MATCHES);
    // Trimmed, and nothing to ask again for: the client must not loop.
    expect(all).toMatchObject({ complete: false, nextOffset: null });
    expect(all.matches.slice(0, 5).map((m) => m.track.id)).toEqual(paged.matches.map((m) => m.track.id));
    expect(Object.keys(all.sources)).toHaveLength(MAX_ALL_MATCHES);
  });
});


describe('one song, one row (QWW-49)', () => {
  /** A store with a few measured songs: one song under two spellings, one with a tag on its title, one plain. */
  const rawNames = new Map<string, { title: string; artist: string }>();
  async function stocked() {
    const store = createMemoryStore();
    const raw = [
      song('Aaliyah', "I Don't Wanna", range(55, 67)),
      song('Aaliyah', 'I Don’t Wanna', range(55, 67)),
      song('10cc', 'Dreadlock Holiday (Album Version)', range(55, 67)),
      song('Toto', 'Africa', range(55, 67)),
    ];
    for (const s of raw) await store.putSongRange(s.key, { range: s.range, log: s.log });
    for (const s of raw) rawNames.set(s.key, { title: s.title, artist: s.artist });
    await store.putSongPopularity([
      { key: raw[0]!.key, karaokeViews: 1_000, source: 'test' },
      { key: raw[1]!.key, karaokeViews: 40_000_000, source: 'test' },
    ]);
    return { store, raw };
  }
  /** A record as the build writes it: the clean title to show, and the title the row had then (from `raw`, else its key's). */
  const canonical = (key: string, canonicalKey: string, title: string, artist: string): SongCanonical => ({
    key, canonicalKey, title, artist, method: 'titles-v1', reason: key === canonicalKey ? 'same' : 'folded',
    sourceTitle: rawNames.get(key)?.title ?? '', sourceArtist: rawNames.get(key)?.artist ?? '',
  });

  it('shows the stored titles when the build has not run, exactly as before', async () => {
    const { store } = await stocked();
    const loaded = await loadCatalogue(store);
    expect(loaded.map((s) => s.title).sort()).toEqual(['Africa', 'Dreadlock Holiday (Album Version)', "I Don't Wanna", 'I Don’t Wanna']);
  });

  it('loads one row per song with its clean title, and the list shows it once', async () => {
    const { store, raw } = await stocked();
    await store.putSongCanonical([
      canonical(raw[0]!.key, raw[1]!.key, 'I Don’t Wanna', 'Aaliyah'),
      canonical(raw[1]!.key, raw[1]!.key, 'I Don’t Wanna', 'Aaliyah'),
      canonical(raw[2]!.key, raw[2]!.key, 'Dreadlock Holiday', '10cc'),
    ]);
    const getSongCanonical = vi.spyOn(store, 'getSongCanonical');
    const loaded = await loadCatalogue(store, undefined, { canonical: true });
    expect(getSongCanonical).toHaveBeenCalledTimes(1);
    expect(getSongCanonical.mock.calls[0]![0]).toHaveLength(4); // all the songs the catalogue read, once
    // Toto has no row yet: shown as stored.
    expect(loaded.map((s) => `${s.artist} - ${s.title}`).sort()).toEqual(['10cc - Dreadlock Holiday', 'Aaliyah - I Don’t Wanna', 'Toto - Africa']);

    const tracks = catalogueTracks(loaded);
    const dreadlock = tracks.find((t) => t.key === raw[2]!.key)!.track;
    expect(dreadlock).toMatchObject({ id: `cat:${raw[2]!.key}`, title: 'Dreadlock Holiday', spotifyUrl: 'https://open.spotify.com/search/10cc%20Dreadlock%20Holiday' });
    const res = recommendCatalogue(tracks, user, deps, { all: true });
    expect(res.matches.map((m) => m.track.title).sort()).toEqual(['Africa', 'Dreadlock Holiday', 'I Don’t Wanna']);
    expect(ids(res.matches)).not.toContain(`cat:${raw[0]!.key}`); // the folded spelling is not a row of its own
  });

  it('keeps the song when the row it folds into ranked too low to load', async () => {
    const { store, raw } = await stocked();
    await store.putSongCanonical([canonical(raw[0]!.key, raw[1]!.key, 'I Don’t Wanna', 'Aaliyah'), canonical(raw[1]!.key, raw[1]!.key, 'I Don’t Wanna', 'Aaliyah')]);
    // a cut of 1 loads only the most popular song: the other spelling of Aaliyah's song is not in it
    const loaded = await loadCatalogue(store, 1, { canonical: true });
    expect(loaded.map((s) => s.key)).toEqual([raw[1]!.key]);
    // and the less popular spelling alone still shows, under the clean title, when it is the one loaded
    const only = await loadCatalogue({ ...store, listCatalogue: async () => (await store.listCatalogue(10)).filter((s) => s.key === raw[0]!.key) }, undefined, { canonical: true });
    expect(only.map((s) => `${s.key} ${s.title}`)).toEqual([`${raw[0]!.key} I Don’t Wanna`]);
  });

  it('shows the stored titles when the mapping cannot be read, and says so, instead of failing', async () => {
    const { store } = await stocked();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const broken = { ...store, getSongCanonical: async () => { throw new Error('relation "song_canonical" does not exist'); } };
      const loaded = await loadCatalogue(broken, undefined, { canonical: true });
      expect(loaded).toHaveLength(4);
      expect(loaded.degraded).toBe(true);
      expect(loaded.map((s) => s.title)).toContain('Dreadlock Holiday (Album Version)');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('song_canonical'));
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves the mapping alone unless it is asked for, so reports that look songs up by key see the catalogue as stored', async () => {
    const { store, raw } = await stocked();
    await store.putSongCanonical([canonical(raw[0]!.key, raw[1]!.key, 'I Don’t Wanna', 'Aaliyah'), canonical(raw[1]!.key, raw[1]!.key, 'I Don’t Wanna', 'Aaliyah')]);
    const getSongCanonical = vi.spyOn(store, 'getSongCanonical');
    const loaded = await loadCatalogue(store);
    expect(getSongCanonical).not.toHaveBeenCalled();
    expect(loaded).toHaveLength(4);
    expect(loaded.map((s) => s.key)).toContain(raw[0]!.key);
    expect(loaded.degraded).toBeUndefined();
  });

  it('applies a record only to the row it was made from: a row renamed since keeps its live title', async () => {
    const { store, raw } = await stocked();
    await store.putSongCanonical([canonical(raw[2]!.key, raw[2]!.key, 'Dreadlock Holiday', '10cc')]);
    // a sync renames the row after the build ran
    const renamed = raw[2]!;
    await store.putSongRange(renamed.key, { range: renamed.range, log: { ...renamed.log, title: 'Dreadlock Holiday (Instrumental)' } });
    const loaded = await loadCatalogue(store, undefined, { canonical: true });
    // the stale record is not used: the row keeps the title it has now, so the list still hides it on that tag
    expect(loaded.find((s) => s.key === renamed.key)!.title).toBe('Dreadlock Holiday (Instrumental)');
    const titles = recommendCatalogue(catalogueTracks(loaded), user, deps, { all: true }).matches.map((m) => m.track.title);
    expect(titles).not.toContain('Dreadlock Holiday');
    expect(titles).not.toContain('Dreadlock Holiday (Instrumental)');
  });

  it('retries a failed mapping read once before giving up, and then applies it with no warning', async () => {
    const { store, raw } = await stocked();
    await store.putSongCanonical([canonical(raw[2]!.key, raw[2]!.key, 'Dreadlock Holiday', '10cc')]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let calls = 0;
      const flaky = { ...store, getSongCanonical: async (keys: string[]) => { if (++calls === 1) throw new Error('connection reset'); return store.getSongCanonical(keys); } };
      const loaded = await loadCatalogue(flaky, undefined, { canonical: true });
      expect(calls).toBe(2);
      expect(loaded.degraded).toBeUndefined();
      expect(loaded.map((s) => s.title)).toContain('Dreadlock Holiday');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps a degraded load for a minute, not an hour, so a failed read does not leave raw titles up all hour', async () => {
    const { store, raw } = await stocked();
    await store.putSongCanonical([canonical(raw[2]!.key, raw[2]!.key, 'Dreadlock Holiday', '10cc')]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let broken = true;
      const reads = vi.fn(async () => loadCatalogue({ ...store, getSongCanonical: async (keys: string[]) => { if (broken) throw new Error('down'); return store.getSongCanonical(keys); } }, undefined, { canonical: true }));
      let at = 0;
      const catalogue = createCatalogue(reads, deps, { now: () => at });
      expect((await catalogue.get()).map((t) => t.track.title)).toContain('Dreadlock Holiday (Album Version)');
      broken = false;
      at = DEGRADED_TTL_MS - 1;
      await catalogue.get();
      expect(reads).toHaveBeenCalledTimes(1); // still the cached, degraded one
      at = DEGRADED_TTL_MS;
      expect((await catalogue.get()).map((t) => t.track.title)).toContain('Dreadlock Holiday'); // read again after a minute
      expect(reads).toHaveBeenCalledTimes(2);
      at = DEGRADED_TTL_MS + CATALOGUE_TTL_MS - 1;
      await catalogue.get();
      expect(reads).toHaveBeenCalledTimes(2); // a good load lasts the hour
    } finally {
      warn.mockRestore();
    }
  });

  it('works with a store that has no mapping method at all', async () => {
    const { store } = await stocked();
    const { listCatalogue, getSongPopularity, getSongTempos } = store;
    expect(await loadCatalogue({ listCatalogue, getSongPopularity, getSongTempos }, undefined, { canonical: true })).toHaveLength(4);
  });
});
