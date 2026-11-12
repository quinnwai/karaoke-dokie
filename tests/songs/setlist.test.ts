// QWW-47: the ranking engine behind the Setlist tuner (src/lib/songs/setlist.ts), rule by rule.
//
// Two kinds of list. Hand-built songs, where each rule is shown on a few songs whose places are known,
// and a synthetic catalogue (tests/helpers/sliderFixtures.ts, 4,000 songs, matched by the production code)
// for the things that only show on a real-sized list: the lists the success criteria are about.

import { describe, expect, it } from 'vitest';
import type { EraId, GearId, Match, SetlistInput, SetlistState, SongRange, Track, TunerPart, VocalRange } from '../../src/lib/contracts';
import { ERA_IDS, GEAR_IDS } from '../../src/lib/contracts';
import { feelOfTempo } from '../../src/lib/tempo/feel';
import { catalogueMatches, catalogueTracks, prepareCatalogue, rankCatalogue, type CatalogueTrack } from '../../src/lib/server/catalogue';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { productionSongDeps } from '../../src/lib/server/wiring';
import { matchSong, toMatch } from '../../src/lib/songs/match';
import {
  BOTTOM_DISCOUNT,
  EASE_POINT,
  GEAR_WEIGHTS,
  MIN_PLAUSIBLE_SPAN,
  TEMPO_END_REACH,
  effectiveTempo,
  libraryCandidate,
  noteCost,
  prepareSetlist,
  rankPrepared,
  rankSetlist,
  songStrain,
  type PreparedSetlist,
  type SetlistCandidate,
} from '../../src/lib/songs/setlist';
import { DEFAULTS, DEFAULT_OFF, ERA_LABEL, eraOf } from '../../src/lib/songs/setlistConfig';
import { catalogueEntries, rng } from '../helpers/sliderFixtures';

const deps = productionSongDeps(createMemoryStore(), false);

/** Pass/fail ranges of the release harness (QWW-52): low and high, male and female, and a narrow beginner. */
const TEST_RANGES: [string, Pick<VocalRange, 'low' | 'high'>][] = [
  ['low male, E2 to E4', { low: 40, high: 64 }],
  ['high male, C3 to C5', { low: 48, high: 72 }],
  ['low female, F3 to F5', { low: 53, high: 77 }],
  ['high female, A3 to A5', { low: 57, high: 81 }],
  ['narrow beginner, D3 to D4', { low: 50, high: 62 }],
];

/** One range per voice type, named by it (QWW-58; MIDI, C4 = 60): the ranges the as-written rule is checked on. */
const VOICE_RANGES: [string, Pick<VocalRange, 'low' | 'high'>][] = [
  ['bass, E2 to E4', { low: 40, high: 64 }],
  ["Quinn-Wai's test, F2 to F4", { low: 41, high: 65 }],
  ['baritone, A2 to A4', { low: 45, high: 69 }],
  ['tenor, C3 to C5', { low: 48, high: 72 }],
  ['alto, F3 to F5', { low: 53, high: 77 }],
  ['mezzo, A3 to A5', { low: 57, high: 81 }],
  ['soprano, C4 to C6', { low: 60, high: 84 }],
  ['low male, F2 to C5', { low: 41, high: 72 }],
];

/** The tuner as it loads (setlistConfig.ts), logged out, with some of it changed. */
function state(over: { gears?: Partial<Record<GearId, number>>; off?: TunerPart[]; eras?: EraId[]; loggedIn?: boolean } = {}): SetlistState & { loggedIn: boolean } {
  return {
    gears: { difficulty: DEFAULTS.difficulty, history: DEFAULTS.history, popularity: DEFAULTS.popularity, tempo: DEFAULTS.tempo, ...over.gears },
    off: over.off ?? [...DEFAULT_OFF],
    eras: over.eras ?? [...DEFAULTS.eras],
    loggedIn: over.loggedIn ?? false,
  };
}
const input = (range: Pick<VocalRange, 'low' | 'high'>, over: Parameters<typeof state>[0] = {}): SetlistInput => ({ range, ...state(over) });
const ids = (list: { songs: { match: Match }[] }, n = Infinity) => list.songs.slice(0, n).map((s) => s.match.track.id);

/** A seeded Fisher-Yates shuffle: a different order for every seed, the same one every run. */
function shuffled<T>(xs: T[], seed: number): T[] {
  const rand = rng(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ---------- the synthetic catalogue ----------

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const ERA_SHARE: [EraId, number][] = [['pre', 0.08], ['s70', 0.1], ['s80', 0.16], ['s90', 0.2], ['s00', 0.2], ['s10', 0.19], ['s20', 0.07]];
const YEAR_OF: Record<EraId, number> = { pre: 1962, s70: 1976, s80: 1985, s90: 1995, s00: 2005, s10: 2015, s20: 2022 };

/**
 * The sliderFixtures catalogue with a year (95% of songs) and a tempo (96%), so the Era and Tempo gears have something to work on.
 * With `hits`, the songs whose typical note is in that range and that span at least `minSpan` semitones are the catalogue's
 * biggest hits (3.5 to 5.5 million karaoke views). The real catalogue's are, mostly: wide-ranging tenor and female pop around B3
 * to G4 as written, and that is why the low voices' lists were full of songs sung an octave down (QWW-58). Without it,
 * popularity does not depend on pitch.
 */
function catalogue(seed = 7, hits?: { from: number; to: number; minSpan: number }): CatalogueTrack[] {
  const entries = catalogueEntries(rng(seed), 4000);
  const facts = rng(seed + 1000);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - facts())) * Math.cos(2 * Math.PI * facts());
  for (const e of entries) {
    let r = facts();
    const era = ERA_SHARE.find(([, share]) => (r -= share) < 0)?.[0] ?? 's10';
    if (facts() < 0.95) {
      const year = YEAR_OF[era] + Math.floor(facts() * 4);
      if (e.usdb) e.usdb = { ...e.usdb, year };
      else e.popularity = { ...(e.popularity ?? { key: e.key, source: 'billboard' }), chartYear: year };
    }
    if (facts() < 0.96) e.tempo = Math.round(clamp(118 + 25 * gauss(), 70, 179));
  }
  if (hits) {
    const views = rng(seed + 2000);
    for (const e of entries) {
      if (e.range.tessitura < hits.from || e.range.tessitura > hits.to || e.range.high - e.range.low < hits.minSpan) continue;
      e.popularity = { ...(e.popularity ?? { key: e.key, source: 'karafun+billboard' }), karaokeViews: Math.round(3_500_000 + 2_000_000 * views()) };
    }
  }
  return catalogueTracks(entries);
}
const CATALOGUE = catalogue();
/** Hits typically sung from B3 (59) to G4 (67), an octave wide or more: the tenor's and the alto's register, above a bass's. */
const HIT_CATALOGUE = catalogue(7, { from: 59, to: 67, minSpan: 12 });

// ---------- hand-built songs ----------

const track = (id: string, playRank = 0): Track => ({ id, title: id, artist: 'A', artistId: 'a', spotifyUrl: '', playRank });
const USER: VocalRange = { low: 40, high: 70, source: 'test' }; // 30 semitones: the middle half is 47.5 to 62.5

/** A song as the server would match it for USER, with the popularity and facts a test gives it. */
function song(
  id: string,
  spec: { low: number; high: number; tessitura?: number; shares?: [number, number][]; popularity?: number | null; tempo?: number; year?: number; confidence?: 'high' | 'low'; playRank?: number },
): Match {
  const range: SongRange = {
    low: spec.low,
    high: spec.high,
    tessitura: spec.tessitura ?? Math.round((spec.low + spec.high) / 2),
    source: 'note-file',
    confidence: spec.confidence ?? 'high',
    fastLyrics: false,
    ...(spec.shares ? { pitchShare: spec.shares } : {}),
  };
  const fit = matchSong(USER, range);
  if (!fit) throw new Error(`${id} does not fit ${USER.low} to ${USER.high}`);
  const pop = spec.popularity === undefined ? 0.5 : spec.popularity;
  return {
    ...toMatch(track(id, spec.playRank ?? 0), range, fit),
    parts: { comfort: 0.5, familiarity: 1, popularity: pop ?? 0.4, popularityKnown: pop !== null, penalty: 0 },
    ...(spec.tempo !== undefined ? { tempo: spec.tempo } : {}),
    ...(spec.year !== undefined ? { year: spec.year } : {}),
  };
}
const cands = (...ms: Match[]): SetlistCandidate[] => ms.map((match) => ({ match }));

/** Sung time spread evenly over [low, high]. */
const flat = (low: number, high: number): [number, number][] => {
  const n = high - low + 1;
  return Array.from({ length: n }, (_, i): [number, number] => [low + i, 1 / n]);
};

/** A prepared song with chosen places, to test the sum and the sort on exact numbers. */
function placed(id: string, gears: Partial<Record<GearId, number | null>>, extra: { maybe?: boolean; era?: EraId | null; popularity?: number } = {}): PreparedSetlist['songs'][number] {
  return {
    candidate: { match: song(id, { low: 50, high: 60 }) },
    era: extra.era === undefined ? 's90' : extra.era,
    maybe: extra.maybe ?? false,
    gears: { difficulty: 50, history: null, popularity: 50, tempo: 50, ...gears },
    popularity: extra.popularity ?? 0.5,
  };
}
const preparedOf = (...songs: PreparedSetlist['songs']): PreparedSetlist => ({ range: USER, songs });

// ================================================================

describe('the defaults (spec §11)', () => {
  it('are Popularity on at 100 and Difficulty on at the Light work end; History, Tempo and Era off', () => {
    expect(DEFAULTS).toMatchObject({ difficulty: 0, history: 100, popularity: 100, tempo: 50 });
    expect([...DEFAULT_OFF].sort()).toEqual(['era', 'history', 'tempo']);
    expect(DEFAULTS.eras).toEqual([]);
  });

  it('are in range for the sliders, and every era has a label with the right apostrophe', () => {
    for (const g of GEAR_IDS) expect(Number.isInteger(DEFAULTS[g]) && DEFAULTS[g] >= 0 && DEFAULTS[g] <= 100).toBe(true);
    for (const e of ERA_IDS) expect(ERA_LABEL[e]).toBeTruthy();
    expect(ERA_LABEL.s90).toBe('’90s');
  });

  it('put the eras by release year, 1970 and 2020 starting a new one, and no year in none', () => {
    expect([1961, 1969, 1970, 1979, 1980, 1999, 2000, 2009, 2010, 2019, 2020, 2026].map(eraOf)).toEqual([
      'pre', 'pre', 's70', 's70', 's80', 's90', 's00', 's00', 's10', 's10', 's20', 's20',
    ]);
    expect(eraOf(undefined)).toBeNull();
    expect(eraOf(Number.NaN)).toBeNull();
  });
});

describe('easy leans low (rule 2): the curve', () => {
  it('costs nothing at the ease point, climbs to 1 at the top and only to the discount at the bottom', () => {
    expect(noteCost(EASE_POINT)).toBe(0);
    expect(noteCost(1)).toBe(1);
    expect(noteCost(0)).toBeCloseTo(BOTTOM_DISCOUNT, 12);
    for (const t of [-0.5, 1.5]) expect(noteCost(t)).toBe(noteCost(Math.min(1, Math.max(0, t))));
  });

  it('rises the farther a note is from the ease point, on both sides', () => {
    for (let t = EASE_POINT; t < 1 - 1e-9; t += 0.01) expect(noteCost(t + 0.01)).toBeGreaterThan(noteCost(t));
    for (let t = EASE_POINT; t > 0.01; t -= 0.01) expect(noteCost(t - 0.01)).toBeGreaterThan(noteCost(t));
  });

  it('charges a note near the top more than a note the same distance from the bottom, at every distance', () => {
    for (let d = 0; d < 0.5 - 1e-9; d += 0.005) {
      expect(noteCost(1 - d), `${d} from the edges`).toBeGreaterThan(noteCost(d));
    }
  });

  it('is the curve that docs/backend.md and the comment in setlist.ts tabulate', () => {
    const table: [number, number][] = [[0, 0.6], [0.1, 0.31], [0.2, 0.11], [0.35, 0], [0.5, 0.05], [0.65, 0.21], [0.8, 0.48], [0.9, 0.72], [1, 1]];
    for (const [t, cost] of table) expect(noteCost(t), `t = ${t}`).toBeCloseTo(cost, 2);
    expect([EASE_POINT, BOTTOM_DISCOUNT]).toEqual([0.35, 0.6]);
  });

  it('makes a song in the lower-middle easier than the same song higher up, both inside the middle half', () => {
    const low = song('low', { low: 48, high: 54, shares: flat(48, 54) }); // t from 0.27 to 0.47
    const high = song('high', { low: 56, high: 62, shares: flat(56, 62) }); // t from 0.53 to 0.73, the mirror of it
    expect([low.difficulty, high.difficulty]).toEqual(['easy', 'easy']);
    expect(songStrain(USER, low)!).toBeLessThan(songStrain(USER, high)!);

    const list = prepareSetlist(cands(high, low), USER);
    const place = (id: string) => list.songs.find((s) => s.candidate.match.track.id === id)!.gears.difficulty!;
    expect(place('low')).toBeLessThan(place('high'));
    // So with equal popularity, Light work puts the lower song first; Locked in puts the higher one first.
    expect(ids(rankPrepared(list, state({ off: ['history', 'tempo', 'era', 'popularity'] })))).toEqual(['low', 'high']);
    expect(ids(rankPrepared(list, state({ gears: { difficulty: 100 }, off: ['history', 'tempo', 'era', 'popularity'] })))).toEqual(['high', 'low']);
  });

  it('sees the octave a song is sung in: the same song an octave down sits lower in the range', () => {
    const asWritten = song('as-written', { low: 58, high: 64, shares: flat(58, 64) });
    const down: Match = { ...asWritten, octave: 'down' };
    // 46 to 52 is t 0.20 to 0.40, around the ease point; 58 to 64 is t 0.60 to 0.80.
    expect(songStrain(USER, down)!).toBeLessThan(songStrain(USER, asWritten)! / 2);
  });

  it('sees the octave the other way too: a song written low and sung up sits higher in the range', () => {
    const asWritten = song('as-written', { low: 34, high: 40, shares: flat(34, 40) });
    expect(asWritten.octave).toBe('up'); // 46 to 52 as sung, t 0.20 to 0.40
    // Had the shift been ignored, 34 to 40 would sit below the range, at its bottom edge.
    const ignoringShift: Match = { ...asWritten, octave: 'none' };
    expect(songStrain(USER, asWritten)!).toBeLessThan(0.1);
    expect(songStrain(USER, ignoringShift)!).toBeCloseTo(0.6, 2);
  });

  it('is 0 for a song that sits on the ease point and 1 for one on the top note', () => {
    const atEase = EASE_POINT * 30 + 40; // 50.5
    expect(songStrain(USER, song('ease', { low: 46, high: 55, tessitura: 50, shares: [[50.5, 1]] }))!).toBeLessThan(1e-9);
    expect(songStrain(USER, { ...song('top', { low: 60, high: 70 }), range: { ...song('top', { low: 60, high: 70 }).range, pitchShare: [[70, 1]] } })!).toBeCloseTo(1, 12);
    expect(atEase).toBe(50.5);
  });
});

describe('difficulty places follow the labels', () => {
  const list = prepareCatalogue(CATALOGUE, TEST_RANGES[1]![1], deps);
  const places = (label: string) => list.prepared.songs.filter((s) => s.candidate.match.difficulty === label).map((s) => s.gears.difficulty);

  it('give Easy songs the first third of the track, Medium the second and Hard the last, so a lane colour and a label agree', () => {
    for (const p of places('easy')) expect(p!).toBeGreaterThan(0), expect(p!).toBeLessThan(100 / 3);
    for (const p of places('medium')) expect(p!).toBeGreaterThan(100 / 3), expect(p!).toBeLessThan(200 / 3);
    for (const p of places('hard')) expect(p!).toBeGreaterThan(200 / 3), expect(p!).toBeLessThan(100);
  });

  it('spread the songs of a label evenly over its third, whatever the share of songs in it', () => {
    for (const [label, from] of [['easy', 0], ['medium', 100 / 3], ['hard', 200 / 3]] as const) {
      const ps = places(label) as number[];
      expect(ps.length).toBeGreaterThan(30);
      // Each fifth of the third holds about a fifth of the label's songs.
      for (let k = 0; k < 5; k++) {
        const inFifth = ps.filter((p) => p >= from + (k * 100) / 15 && p < from + ((k + 1) * 100) / 15).length;
        expect(inFifth / ps.length, `${label}, fifth ${k}`).toBeGreaterThan(0.15);
        expect(inFifth / ps.length, `${label}, fifth ${k}`).toBeLessThan(0.25);
      }
    }
  });
});

describe('places on the other gears are by rank (QWW-33)', () => {
  const { prepared } = prepareCatalogue(CATALOGUE, TEST_RANGES[0]![1], deps);

  for (const g of ['popularity', 'tempo'] as const) {
    it(`spread the ${g} places over the whole track: each tenth holds about a tenth of the songs that have one`, () => {
      const ps = prepared.songs.map((s) => s.gears[g]).filter((p): p is number => p !== null);
      expect(ps.length).toBeGreaterThan(1000);
      // Songs tied at an end share their average place (a tenth of the catalogue can score the same top popularity),
      // so the ends are near 0 and 100 rather than on them.
      expect(Math.min(...ps)).toBeLessThan(10);
      expect(Math.max(...ps)).toBeGreaterThan(90);
      for (let k = 0; k < 10; k++) {
        const share = ps.filter((p) => p >= k * 10 && (p < (k + 1) * 10 || k === 9)).length / ps.length;
        expect(share, `${g}, tenth ${k}`).toBeGreaterThan(0.07);
        expect(share, `${g}, tenth ${k}`).toBeLessThan(0.13);
      }
    });
  }

  it('put a more popular song further along Popularity, and a faster one further along Tempo', () => {
    const list = prepareSetlist(cands(song('a', { low: 50, high: 60, popularity: 0.3, tempo: 80 }), song('b', { low: 50, high: 60, popularity: 0.6, tempo: 100 }), song('c', { low: 50, high: 60, popularity: 0.9, tempo: 140 })), USER);
    expect(list.songs.map((s) => s.gears.popularity)).toEqual([0, 50, 100]);
    expect(list.songs.map((s) => s.gears.tempo)).toEqual([0, 50, 100]);
  });

  it('give songs with the same score the same place', () => {
    const list = prepareSetlist(cands(song('a', { low: 50, high: 60, tempo: 100 }), song('b', { low: 50, high: 60, tempo: 100 }), song('c', { low: 50, high: 60, tempo: 150 })), USER);
    expect(list.songs.map((s) => s.gears.tempo)).toEqual([25, 25, 100]);
  });

  it('leave a song with no popularity or tempo without a place, rather than inventing one', () => {
    const list = prepareSetlist(cands(song('a', { low: 50, high: 60, popularity: null }), song('b', { low: 50, high: 60, popularity: 0.7, tempo: 100 })), USER);
    expect(list.songs[0]!.gears).toMatchObject({ popularity: null, tempo: null });
    expect(list.songs[1]!.gears.popularity).toBe(50);
  });

  it('read the tempo through one accessor (QWW-54 switches it)', () => {
    expect(effectiveTempo(song('a', { low: 50, high: 60, tempo: 93 }))).toBe(93);
    expect(effectiveTempo(song('b', { low: 50, high: 60 }))).toBeUndefined();
  });
});

describe('the distance (spec §5, model A)', () => {
  it('is the sum over the active gears of weight × |place - value|, and Popularity counts double', () => {
    expect(GEAR_WEIGHTS).toEqual({ difficulty: 1, history: 1, popularity: 2, tempo: 1 });
    // A: popularity 90, difficulty 10 -> 2 × 10 + 10 = 30. B: popularity 100, difficulty 40 -> 0 + 40 = 40.
    const a = placed('a', { popularity: 90, difficulty: 10 });
    const b = placed('b', { popularity: 100, difficulty: 40 });
    expect(ids(rankPrepared(preparedOf(b, a), state()))).toEqual(['a', 'b']);
    // A ten place gap in popularity needs a twenty place easier song to make up for it: 2 × 10 = 20.
    const c = placed('c', { popularity: 90, difficulty: 20 }, { popularity: 0.8 });
    const d = placed('d', { popularity: 100, difficulty: 40 }, { popularity: 0.9 });
    expect(ids(rankPrepared(preparedOf(c, d), state()))).toEqual(['d', 'c']); // a tie: the more popular song first
    const e = placed('e', { popularity: 90, difficulty: 19 }, { popularity: 0.8 });
    expect(ids(rankPrepared(preparedOf(d, e), state()))).toEqual(['e', 'd']);
  });

  it('counts the distance from a value that is not 0 or 100 on both sides of it', () => {
    const songs = [placed('under', { tempo: 35 }), placed('over', { tempo: 70 }), placed('near', { tempo: 52 })];
    const r = rankPrepared(preparedOf(...songs), state({ off: ['history', 'era', 'difficulty', 'popularity'], gears: { tempo: 50 } }));
    expect(ids(r)).toEqual(['near', 'under', 'over']); // 2, 15 and 20 away
  });

  it('adds nothing for a gear that is off, whatever its value (spec §4a)', () => {
    const songs = [placed('a', { tempo: 10, popularity: 80 }), placed('b', { tempo: 90, popularity: 60 }), placed('c', { tempo: 50, popularity: 70 })];
    const base = ids(rankPrepared(preparedOf(...songs), state({ off: ['history', 'tempo', 'era', 'difficulty'] })));
    for (const tempo of [0, 17, 50, 100]) {
      expect(ids(rankPrepared(preparedOf(...songs), state({ gears: { tempo }, off: ['history', 'tempo', 'era', 'difficulty'] })))).toEqual(base);
    }
    // And on, it does something.
    expect(ids(rankPrepared(preparedOf(...songs), state({ gears: { tempo: 100 }, off: ['history', 'era', 'difficulty'] })))).not.toEqual(base);
    expect(rankPrepared(preparedOf(...songs), state({ off: ['history', 'tempo', 'era', 'difficulty'] })).applied).toEqual(['popularity']);
  });

  it('lists the catalogue in popularity order when every gear is off (spec test 18), inside each group, whatever order the songs came in', () => {
    const range = TEST_RANGES[0]![1];
    const { matches } = prepareCatalogue(CATALOGUE, range, deps);
    const allOff = state({ off: [...GEAR_IDS, 'era'] });
    const first = rankSetlist(cands(...matches), { range, ...allOff });
    expect(first.songs).toHaveLength(matches.length);
    expect(first.applied).toEqual([]);
    const pop = first.songs.map((s) => (s.match.parts?.popularityKnown ? s.match.parts.popularity : -1));
    // The groups, in their order: sure songs sung as written, sure songs that need a jump, then the same two of the Maybe songs (QWW-58).
    const group = (s: (typeof first.songs)[number]) => (s.match.difficulty === 'maybe' ? 2 : 0) + (s.match.octave === 'none' ? 0 : 1);
    expect(new Set(first.songs.map(group)).size, 'groups in this list').toBeGreaterThanOrEqual(2); // songs sung as written and songs that need a jump
    for (let i = 1; i < pop.length; i++) {
      const [a, b] = [group(first.songs[i - 1]!), group(first.songs[i]!)];
      expect(b, `song ${i}`).toBeGreaterThanOrEqual(a);
      if (a === b) expect(pop[i]!).toBeLessThanOrEqual(pop[i - 1]!);
    }
    for (const seed of [1, 2, 3]) {
      expect(ids(rankSetlist(cands(...shuffled(matches, seed)), { range, ...allOff })), `shuffle ${seed}`).toEqual(ids(first));
    }
  });

  it('breaks ties in order: the more popular song, then the easier, then artist and title, then id', () => {
    // Nothing is active, so every song is tied on distance and only the tie-breaks speak. (The octave is not one of them:
    // songs sung as written come before songs that need a jump whatever the gears say, QWW-58, tested below.)
    const allOff = state({ off: [...GEAR_IDS, 'era'] });
    const popularFirst = [placed('t1', {}, { popularity: 0.5 }), placed('t2', {}, { popularity: 0.9 }), placed('t3', { difficulty: 20 }, { popularity: 0.5 })];
    expect(ids(rankPrepared(preparedOf(...popularFirst), allOff))).toEqual(['t2', 't3', 't1']); // t3 is as popular as t1 but easier

    const named = (id: string, artist: string, title: string): PreparedSetlist['songs'][number] => {
      const p = placed(id, {}, { popularity: 0.5 });
      return { ...p, candidate: { match: { ...p.candidate.match, track: { ...p.candidate.match.track, artist, title } } } };
    };
    // By name before id, so the same song as a library track and as a catalogue track keeps its place whatever the ids say.
    const byName = rankPrepared(preparedOf(named('zzz', 'Abba', 'Chiquitita'), named('aaa', 'Abba', 'Waterloo'), named('mmm', 'Zedd', 'Clarity')), allOff);
    expect(ids(byName)).toEqual(['zzz', 'aaa', 'mmm']);
    expect(ids(rankPrepared(preparedOf(named('b', 'Abba', 'Waterloo'), named('a', 'ABBA', 'waterloo')), allOff))).toEqual(['a', 'b']);
  });

  it('never adds or removes a song: whatever the gears say, the same songs come back (rule 1)', () => {
    const { matches, prepared } = prepareCatalogue(CATALOGUE, TEST_RANGES[0]![1], deps);
    const everyone = new Set(matches.map((m) => m.track.id));
    const settings = [state(), state({ gears: { difficulty: 100, tempo: 100, popularity: 0 }, off: ['history', 'era'] }), state({ off: [...GEAR_IDS, 'era'] })];
    for (const s of settings) {
      const r = rankPrepared(prepared, s);
      expect(r.songs).toHaveLength(matches.length);
      expect(new Set(ids(r))).toEqual(everyone);
    }
  });
});

describe('a song we do not know on an active gear is a tier of its own', () => {
  const others = ['history', 'era', 'difficulty', 'popularity'] as TunerPart[];

  it('sorts after every song that has the gear, however popular and however close on the other gears', () => {
    // The unknown song is the most popular and the easiest; the known ones are obscure and hard. A sum would put it first.
    const songs = [
      placed('unknown', { tempo: null, popularity: 100, difficulty: 0 }, { popularity: 0.99 }),
      placed('known-a', { tempo: 100, popularity: 5, difficulty: 90 }, { popularity: 0.1 }),
      placed('known-b', { tempo: 0, popularity: 10, difficulty: 80 }, { popularity: 0.2 }),
    ];
    for (const tempo of [0, 50, 100]) {
      const r = rankPrepared(preparedOf(...songs), state({ off: ['history', 'era'], gears: { tempo } }));
      expect(ids(r).at(-1), `tempo ${tempo}`).toBe('unknown');
    }
  });

  it('sorts a song that misses two active gears after one that misses one', () => {
    const songs = [
      placed('misses-two', { tempo: null, popularity: null }, { popularity: 0.99 }),
      placed('misses-one', { tempo: null, popularity: 5 }, { popularity: 0.1 }),
      placed('misses-none', { tempo: 5, popularity: 5 }, { popularity: 0.1 }),
    ];
    expect(ids(rankPrepared(preparedOf(...songs), state({ off: ['history', 'era', 'difficulty'], gears: { tempo: 100 } })))).toEqual(['misses-none', 'misses-one', 'misses-two']);
  });

  it('costs nothing while the gear is off', () => {
    const songs = [placed('unknown', { tempo: null }, { popularity: 0.9 }), placed('known', { tempo: 50 }, { popularity: 0.1 })];
    expect(ids(rankPrepared(preparedOf(...songs), state({ off: [...others, 'tempo'] })))).toEqual(['unknown', 'known']);
  });

  it('puts the gear the singer chose first when songs miss different ones: no tempo sorts after every song that has one', () => {
    // 'no-tempo' is popular and easy and has everything but a tempo; 'no-popularity' has a tempo but no popularity.
    // Tempo is the more specific control, so the song that has a tempo comes first, whatever else it is missing.
    const songs = [
      placed('no-tempo', { tempo: null, popularity: 100, difficulty: 0 }, { popularity: 0.99 }),
      placed('no-popularity', { tempo: 100, popularity: null, difficulty: 90 }, { popularity: 0.1 }),
      placed('complete', { tempo: 20, popularity: 5, difficulty: 95 }, { popularity: 0.05 }),
    ];
    for (const tempo of [0, 50, 100]) {
      const r = rankPrepared(preparedOf(...songs), state({ off: ['history', 'era'], gears: { tempo } }));
      expect(ids(r), `tempo ${tempo}`).toEqual(['complete', 'no-popularity', 'no-tempo']);
    }
    // And History above Tempo, away from the Tempo ends: a song outside the library sorts after one inside it, even one with no tempo.
    // (At an end the songs in its band come first, ahead of History: see "Tempo at an end" below.) Real songs with real tempos.
    const own = { match: song('own-no-tempo', { low: 50, high: 60, popularity: 0.1 }), listening: 0.8 };
    const other = { match: song('other-has-tempo', { low: 50, high: 60, popularity: 0.99, tempo: 100 }) };
    const r = rankPrepared(prepareSetlist([other, own], USER), state({ off: ['era', 'difficulty', 'popularity'], loggedIn: true, gears: { tempo: 50 } }));
    expect(ids(r)).toEqual(['own-no-tempo', 'other-has-tempo']);
  });

  it('ranks the songs that miss the same gears among themselves by the gears they have', () => {
    const songs = [placed('far', { tempo: null, popularity: 40 }), placed('near', { tempo: null, popularity: 90 })];
    expect(ids(rankPrepared(preparedOf(...songs), state({ off: ['history', 'era', 'difficulty'] })))).toEqual(['near', 'far']);
  });

  it('puts a song with no tempo after the songs that have one when Tempo is on, on a real list, in each group (QWW-58)', () => {
    // Tempo is at its slow end here, so the songs in the slow band come first (QWW-54, tested with the rule); a song with no tempo is not in it.
    const r = rankCatalogue(CATALOGUE, input(TEST_RANGES[0]![1], { gears: { tempo: 0 }, off: [...others, 'difficulty', 'popularity'].filter((p, i, all) => all.indexOf(p) === i) as TunerPart[] }), deps);
    // The songs sung as written come first, then the jumps, in the band and out of it; a song with no tempo goes after the others of its own group.
    for (const written of [true, false]) {
      const group = r.songs.filter((s) => s.match.difficulty !== 'maybe' && (s.match.octave === 'none') === written);
      const firstUnknown = group.findIndex((s) => s.gears.tempo === null);
      expect(firstUnknown, written ? 'sung as written' : 'jumps').toBeGreaterThan(500);
      expect(group.slice(firstUnknown).every((s) => s.gears.tempo === null)).toBe(true);
    }
  });
});

describe('an implausible song range cannot win on being easy', () => {
  const one = song('one-note', { low: 60, high: 60, popularity: 0.95 }); // "Jump": C4 to C4
  const narrow = song('four-semitones', { low: 58, high: 62, popularity: 0.9 });
  const real = (n: number) => song(`real-${n}`, { low: 48 + (n % 4), high: 60 + (n % 4), shares: flat(48 + (n % 4), 60 + (n % 4)), popularity: 0.3 + (n % 5) / 10 });

  it('has no difficulty when it spans fewer than MIN_PLAUSIBLE_SPAN semitones', () => {
    expect(MIN_PLAUSIBLE_SPAN).toBe(5);
    expect(songStrain(USER, one)).toBeNull();
    expect(songStrain(USER, narrow)).toBeNull();
    expect(songStrain(USER, song('five', { low: 58, high: 63, shares: flat(58, 63) }))).not.toBeNull();
  });

  it('sorts after every song with a difficulty while Difficulty is on, however popular and however easy it looks', () => {
    const songs = [one, narrow, ...Array.from({ length: 30 }, (_, n) => real(n))];
    const list = prepareSetlist(cands(...songs), USER);
    expect(list.songs.find((s) => s.candidate.match.track.id === 'one-note')!.gears.difficulty).toBeNull();
    for (const difficulty of [0, 50, 100]) {
      const r = rankPrepared(list, state({ gears: { difficulty } }));
      expect(ids(r).slice(-2).sort(), `difficulty ${difficulty}`).toEqual(['four-semitones', 'one-note']);
    }
  });

  it('ranks on popularity like any song once Difficulty is off', () => {
    const songs = [one, ...Array.from({ length: 30 }, (_, n) => real(n))];
    const r = rankPrepared(prepareSetlist(cands(...songs), USER), state({ off: ['history', 'tempo', 'era', 'difficulty'] }));
    expect(ids(r)[0]).toBe('one-note');
  });
});

describe('the Era filter (rule 5)', () => {
  const songs = [
    song('s60', { low: 50, high: 60, year: 1965 }),
    song('s80a', { low: 50, high: 60, year: 1984 }),
    song('s80b', { low: 50, high: 60, year: 1989 }),
    song('s00', { low: 50, high: 60, year: 2003 }),
    song('none', { low: 50, high: 60 }),
  ];
  const list = prepareSetlist(cands(...songs), USER);
  const off = (...extra: TunerPart[]): TunerPart[] => ['history', 'tempo', ...extra];

  it('Era off means every era, the picks being ignored, and songs with no year too', () => {
    const r = rankPrepared(list, state({ off: off('era'), eras: ['s80'] }));
    expect(r.songs).toHaveLength(5);
    expect(r.applied).toEqual(['difficulty', 'popularity']);
  });

  it('is a multi-select OR: a song passes when its era is any of the picked ones', () => {
    const r = rankPrepared(list, state({ off: off(), eras: ['s80', 'pre'] }));
    expect(ids(r).sort()).toEqual(['s60', 's80a', 's80b']);
    expect(r.applied).toEqual(['difficulty', 'popularity', 'era']);
    expect(rankPrepared(list, state({ off: off(), eras: ['s80'] })).songs.map((s) => s.era)).toEqual(['s80', 's80']);
  });

  it('leaves out a song with no year while Era is on', () => {
    expect(ids(rankPrepared(list, state({ off: off(), eras: [...ERA_IDS] }))).sort()).toEqual(['s00', 's60', 's80a', 's80b']);
  });

  it('is empty with "no-era-picked" when Era is on and nothing is picked, not when Era is off (spec §4a)', () => {
    const r = rankPrepared(list, state({ off: off(), eras: [] }));
    expect(r.songs).toEqual([]);
    expect(r.empty).toBe('no-era-picked');
    expect(rankPrepared(list, state({ off: off('era'), eras: [] })).songs).toHaveLength(5);
  });

  it('says "no-songs-in-era" when the picked eras have no song that fits, and "no-songs-in-range" when nothing fits at all', () => {
    expect(rankPrepared(list, state({ off: off(), eras: ['s20'] })).empty).toBe('no-songs-in-era');
    expect(rankSetlist([], input(USER)).empty).toBe('no-songs-in-range');
    // Nothing fitting at all beats the Era message: there is nothing to pick an era from.
    expect(rankSetlist([], input(USER, { off: ['history', 'tempo'], eras: [] })).empty).toBe('no-songs-in-range');
    expect(rankPrepared(list, state({ off: off('era') })).empty).toBeUndefined();
  });

  it('keeps a song at the same place on every gear whatever is picked, so toggling an era only fades rows in and out', () => {
    const all = rankPrepared(list, state({ off: off('era') }));
    const some = rankPrepared(list, state({ off: off(), eras: ['s80'] }));
    for (const s of some.songs) expect(all.songs.find((x) => x.match.track.id === s.match.track.id)!.gears).toEqual(s.gears);
  });
});

describe('multi-select Era (rule 5): every combination of eras', () => {
  // The 127 non-empty subsets of the seven eras, each as the list of eras in it.
  const COMBINATIONS: EraId[][] = Array.from({ length: 127 }, (_, i) => ERA_IDS.filter((_, k) => ((i + 1) >> k) & 1));
  const eraOff: TunerPart[] = ['history', 'tempo', 'era'];
  const eraOn: TunerPart[] = ['history', 'tempo'];

  it('has all 127 combinations, from one era to all seven', () => {
    expect(new Set(COMBINATIONS.map((c) => c.join())).size).toBe(127);
    expect(Math.min(...COMBINATIONS.map((c) => c.length))).toBe(1);
    expect(Math.max(...COMBINATIONS.map((c) => c.length))).toBe(7);
  });

  it.each(TEST_RANGES)('%s: any combination of eras lists exactly the songs of those eras, in the order the whole list has them', (_name, range) => {
    const { prepared } = prepareCatalogue(CATALOGUE, range, deps);
    const whole = rankPrepared(prepared, state({ off: eraOff })).songs; // Era off: every era, whatever is picked
    const byEra = new Map<EraId | null, number>();
    for (const s of whole) byEra.set(s.era, (byEra.get(s.era) ?? 0) + 1);
    // The catalogue has songs in every era and some with no year, so each combination below is a real selection.
    for (const era of ERA_IDS) expect(byEra.get(era) ?? 0, era).toBeGreaterThan(10);
    expect(byEra.get(null) ?? 0).toBeGreaterThan(0);

    for (const picked of COMBINATIONS) {
      const r = rankPrepared(prepared, state({ off: eraOn, eras: picked }));
      const inOrder = whole.filter((s) => s.era !== null && picked.includes(s.era)).map((s) => s.match.track.id);
      expect(ids(r), picked.join()).toEqual(inOrder); // OR, and the same relative order as with every era
      expect(r.songs.every((s) => s.era !== null && picked.includes(s.era))).toBe(true);
      expect(r.songs.length, picked.join()).toBe(picked.reduce((n, era) => n + (byEra.get(era) ?? 0), 0)); // the eras are disjoint
      expect(r.empty).toBeUndefined();
      expect(r.applied).toEqual(['difficulty', 'popularity', 'era']);
    }
  });

  it('does not care in which order, or how often, the eras were picked', () => {
    const { prepared } = prepareCatalogue(CATALOGUE, TEST_RANGES[1]![1], deps);
    const a = ids(rankPrepared(prepared, state({ off: eraOn, eras: ['s80', 's00', 'pre'] })));
    expect(ids(rankPrepared(prepared, state({ off: eraOn, eras: ['pre', 's80', 's00'] })))).toEqual(a);
    expect(ids(rankPrepared(prepared, state({ off: eraOn, eras: ['s00', 'pre', 's80', 's80', 'pre'] })))).toEqual(a);
  });

  it('follows the tuner\'s taps: the first pick is that era alone, each tap adds or takes away one, none left is the empty state, reset is every era', () => {
    const { prepared } = prepareCatalogue(CATALOGUE, TEST_RANGES[0]![1], deps);
    const total = (eras: EraId[], off: TunerPart[] = eraOn) => rankPrepared(prepared, state({ off, eras })).songs.length;
    const s80 = total(['s80']);
    const s90 = total(['s90']);
    const s00 = total(['s00']);
    expect(total(['s80', 's90'])).toBe(s80 + s90); // tap '80s, then '90s: both
    expect(total(['s80', 's90', 's00'])).toBe(s80 + s90 + s00);
    expect(total(['s80', 's00'])).toBe(s80 + s00); // tap '90s again: it goes
    expect(total(['s00'])).toBe(s00);
    const none = rankPrepared(prepared, state({ off: eraOn, eras: [] }));
    expect(none).toMatchObject({ songs: [], empty: 'no-era-picked' }); // "Pick an era to see songs."
    expect(total([], eraOff)).toBe(total([...ERA_IDS]) + prepared.songs.filter((s) => s.era === null).length); // reset: every era, undated songs too
  });

  it('applies to the Maybe songs as well, which still come last', () => {
    const sure = [song('s80', { low: 50, high: 60, year: 1984 }), song('s90', { low: 50, high: 60, year: 1994 }), song('s00', { low: 50, high: 60, year: 2004 })];
    const maybe = [song('m80', { low: 42, high: 68, confidence: 'low', year: 1983 }), song('m10', { low: 42, high: 68, confidence: 'low', year: 2012 })];
    const list = prepareSetlist(cands(...sure, ...maybe), USER);
    const r = rankPrepared(list, state({ off: eraOn, eras: ['s80', 's90'] }));
    expect(ids(r).sort()).toEqual(['m80', 's80', 's90']);
    expect(ids(r).at(-1)).toBe('m80');
  });
});

describe('the Maybe songs come last (as everywhere else)', () => {
  it('sort after every other song, whatever the gears say, and are laid out on their own', () => {
    const maybe = song('maybe', { low: 40, high: 70, confidence: 'low', popularity: 0.99 });
    expect(maybe.difficulty).toBe('maybe');
    const sure = Array.from({ length: 10 }, (_, n) => song(`sure-${n}`, { low: 50, high: 60, shares: flat(50, 60), popularity: 0.1 + n / 20 }));
    const list = prepareSetlist(cands(maybe, ...sure), USER);
    for (const gears of [{ popularity: 100 }, { popularity: 0, difficulty: 100 }]) {
      expect(ids(rankPrepared(list, state({ gears }))).at(-1)).toBe('maybe');
    }
    // Alone in its group it sits in the middle of every track rather than at an end.
    expect(list.songs.find((s) => s.maybe)!.gears.popularity).toBe(50);
  });

  it('still get a place on Difficulty, as if their range were sure', () => {
    const maybe = song('maybe', { low: 42, high: 68, confidence: 'low' });
    const list = prepareSetlist(cands(maybe), USER);
    expect(list.songs[0]!.gears.difficulty).not.toBeNull();
  });
});

describe('songs sung as written come before songs that need an octave jump (QWW-58, decision A)', () => {
  // The same notes as the singer sings them, 46 to 62 (t 0.2 to 0.73 of USER's range), got three ways: written there, written an
  // octave above (58 to 74, too high as written) or an octave below (34 to 50, too low as written). On every gear the three are equal.
  const AS_SUNG = { none: [46, 62], down: [58, 74], up: [34, 50] } as const;
  const sung = (id: string, how: keyof typeof AS_SUNG, popularity = 0.5) => {
    const [low, high] = AS_SUNG[how];
    return song(id, { low, high, shares: flat(low, high), popularity });
  };
  /** Written at 56 to 70, the top of USER's range: a Hard song, and one a song of the same popularity sung lower beats on Difficulty. */
  const hardAsWritten = (id: string, popularity = 0.5) => song(id, { low: 56, high: 70, shares: flat(56, 70), popularity });
  const order = (ms: Match[], over: Parameters<typeof state>[0] = {}) => ids(rankPrepared(prepareSetlist(cands(...ms), USER), state(over)));

  it('puts a song sung as written first even when the octave-jump song is more popular and easier, an octave down or up', () => {
    const written = hardAsWritten('written', 0.4);
    const down = sung('down', 'down', 0.9);
    const up = sung('up', 'up', 0.9);
    expect([written.octave, down.octave, up.octave]).toEqual(['none', 'down', 'up']);
    expect([written.difficulty, down.difficulty, up.difficulty]).toEqual(['hard', 'easy', 'easy']);
    expect(order([down, up, written])).toEqual(['written', 'down', 'up']);
    expect(order([up, down, written])).toEqual(['written', 'down', 'up']);
  });

  it('puts a song sung as written first when it is only as popular, and the jump makes the other song easier (the cause measured on 11 Nov)', () => {
    // A song too high for you lands in the lower half of your range an octave down, where Easy is kindest: it reads Easy, the same
    // song sung as written reads Hard. With equal popularity the old order took the easy one.
    for (const how of ['down', 'up'] as const) {
      expect(order([sung('jump', how, 0.6), hardAsWritten('written', 0.6)]), how).toEqual(['written', 'jump']);
    }
  });

  it('puts it first for every setting of the gears, all off included', () => {
    const written = hardAsWritten('written', 0.2);
    const jumps = [sung('down', 'down', 0.95), sung('up', 'up', 0.95)];
    const settings = [state(), state({ gears: { difficulty: 0, popularity: 100 } }), state({ gears: { difficulty: 100, popularity: 0 } }), state({ off: [...GEAR_IDS, 'era'] })];
    for (const s of settings) {
      expect(ids(rankPrepared(prepareSetlist(cands(...jumps, written), USER), s))[0]).toBe('written');
    }
  });

  it('still orders the songs inside each group by popularity, whichever way they jump', () => {
    const songs = [sung('w1', 'none', 0.9), sung('w2', 'none', 0.6), sung('w3', 'none', 0.3), sung('d1', 'down', 0.95), sung('u1', 'up', 0.7), sung('d2', 'down', 0.4)];
    const expected = ['w1', 'w2', 'w3', 'd1', 'u1', 'd2'];
    expect(order(songs)).toEqual(expected);
    for (const seed of [1, 2, 3]) expect(order(shuffled(songs, seed)), `shuffle ${seed}`).toEqual(expected);
  });

  it('does not prefer an octave up to an octave down, or the other way round: a jump is a jump', () => {
    expect(order([sung('down', 'down', 0.6), sung('up', 'up', 0.8)])).toEqual(['up', 'down']);
    expect(order([sung('down', 'down', 0.8), sung('up', 'up', 0.6)])).toEqual(['down', 'up']);
  });

  it('still orders the songs inside each group by Difficulty, the groups staying in their order', () => {
    const easyWritten = sung('easy-written', 'none');
    const hardWritten = hardAsWritten('hard-written');
    const easyJump = sung('easy-jump', 'down');
    const hardJump = song('hard-jump', { low: 68, high: 82, shares: flat(68, 82), popularity: 0.5 }); // 56 to 70 once sung an octave down
    expect([hardJump.octave, hardJump.difficulty]).toEqual(['down', 'hard']);
    const all = [hardJump, easyJump, hardWritten, easyWritten];
    const only: TunerPart[] = ['history', 'tempo', 'era', 'popularity']; // Difficulty is the only gear left
    expect(order(all, { off: only })).toEqual(['easy-written', 'hard-written', 'easy-jump', 'hard-jump']); // Light work
    expect(order(all, { gears: { difficulty: 100 }, off: only })).toEqual(['hard-written', 'easy-written', 'hard-jump', 'easy-jump']); // Locked in
  });

  it('still lists the songs that need a jump, after the others, so a range whose popular songs all need one is never empty', () => {
    const jumps = Array.from({ length: 12 }, (_, n) => sung(`jump-${n}`, n % 2 ? 'down' : 'up', 0.95 - n / 100));
    const quiet = [sung('quiet-a', 'none', 0.2), sung('quiet-b', 'none', 0.1)];
    const list = prepareSetlist(cands(...jumps, ...quiet), USER);
    for (const s of [state(), state({ gears: { difficulty: 100, popularity: 0 } }), state({ off: [...GEAR_IDS, 'era'] })]) {
      const r = rankPrepared(list, s);
      expect(r.songs).toHaveLength(14);
      expect(r.empty).toBeUndefined();
      expect(ids(r, 2).sort()).toEqual(['quiet-a', 'quiet-b']); // which of the two is first depends on the gears
    }
    // With nothing sung as written at all, the jumps are the list, in popularity order as before.
    const onlyJumps = rankPrepared(prepareSetlist(cands(...jumps), USER), state());
    expect(onlyJumps.songs).toHaveLength(12);
    expect(ids(onlyJumps, 3)).toEqual(['jump-0', 'jump-1', 'jump-2']);
  });

  it('keeps the Maybe songs after all the others, and sorts them the same way among themselves', () => {
    const sure = sung('sure-jump', 'down', 0.1); // the least popular song, but a sure one
    const maybeWritten = song('maybe-written', { low: 40, high: 70, confidence: 'low', popularity: 0.5 });
    const maybeJump = song('maybe-jump', { low: 58, high: 74, confidence: 'low', popularity: 0.99 });
    expect([maybeWritten.octave, maybeJump.octave]).toEqual(['none', 'down']);
    expect(order([maybeJump, maybeWritten, sure])).toEqual(['sure-jump', 'maybe-written', 'maybe-jump']);
  });

  it('comes before "not known on an active gear" too, so the rule has no exception while Tempo (short of its ends) or History is on', () => {
    // Decision A says every song sung as written comes before any that needs a jump. A song with no tempo still sorts after the
    // songs that have one, but only among songs that are sung the same way. (Tempo at an end is the one exception, QWW-54, below.)
    const noTempo = sung('written-no-tempo', 'none', 0.2);
    const jumpWithTempo = song('jump-with-tempo', { low: 58, high: 74, shares: flat(58, 74), popularity: 0.9, tempo: 100 });
    expect(effectiveTempo(noTempo)).toBeUndefined();
    const tempoOnly: TunerPart[] = ['history', 'era', 'difficulty', 'popularity'];
    expect(order([jumpWithTempo, noTempo], { off: tempoOnly, gears: { tempo: 89 } })).toEqual(['written-no-tempo', 'jump-with-tempo']);
    // The same for the singer's own songs: a song of theirs that needs a jump follows the catalogue's songs sung as written.
    const own = { match: sung('own-jump', 'down', 0.3), listening: 0.9 };
    const catalogueWritten = { match: sung('catalogue-written', 'none', 0.3) };
    const historyOnly: TunerPart[] = ['tempo', 'era', 'difficulty', 'popularity'];
    const r = rankPrepared(prepareSetlist([own, catalogueWritten], USER), state({ off: historyOnly, loggedIn: true }));
    expect(r.applied).toEqual(['history']);
    expect(ids(r)).toEqual(['catalogue-written', 'own-jump']);
  });
});

describe('Tempo at an end: the songs at that end come before how a song is sung (QWW-54)', () => {
  // The same notes as the singer sings them (as in QWW-58 above), written as they are sung, an octave above or an octave below,
  // each with the tempo a test gives it: under 90 is the slow band, 125 and over the upbeat band (feelOfTempo), between is mid.
  // Five songs with a tempo get the places 0, 25, 50, 75 and 100 on Tempo, slowest to fastest.
  const AS_SUNG = { none: [46, 62], down: [58, 74], up: [34, 50] } as const;
  const timed = (id: string, how: keyof typeof AS_SUNG, tempo: number | undefined, popularity = 0.5) => {
    const [low, high] = AS_SUNG[how];
    return song(id, { low, high, shares: flat(low, high), popularity, ...(tempo === undefined ? {} : { tempo }) });
  };
  const slowJump = timed('slow-jump', 'down', 60);
  const FIVE = [slowJump, timed('slow-written', 'none', 70), timed('mid-written', 'none', 110), timed('fast-written', 'none', 150), timed('fast-jump', 'up', 170)];
  const tempoOnly: TunerPart[] = ['history', 'era', 'difficulty', 'popularity']; // Tempo is the only gear on
  const at = (tempo: number, ms: Match[] = FIVE, over: Parameters<typeof state>[0] = {}) =>
    ids(rankPrepared(prepareSetlist(cands(...ms), USER), state({ off: tempoOnly, ...over, gears: { tempo, ...over.gears } })));

  it('puts the slow band first at the slow end and the upbeat band first at the upbeat end, the songs sung as written first inside each', () => {
    expect([slowJump.octave, FIVE[4]!.octave]).toEqual(['down', 'up']);
    // A slow song that needs a jump comes before the mid and fast songs sung as written, and after the slow one sung as written.
    expect(at(0)).toEqual(['slow-written', 'slow-jump', 'mid-written', 'fast-written', 'fast-jump']);
    expect(at(100)).toEqual(['fast-written', 'fast-jump', 'mid-written', 'slow-written', 'slow-jump']);
  });

  it('reaches 10 places in from either end: Tempo 10 and 90 are at the end, 11 and 89 are not', () => {
    expect(TEMPO_END_REACH).toBe(10);
    expect(at(10)).toEqual(['slow-written', 'slow-jump', 'mid-written', 'fast-written', 'fast-jump']);
    expect(at(90)).toEqual(['fast-written', 'fast-jump', 'mid-written', 'slow-written', 'slow-jump']);
    // One place further in, every song sung as written comes first again and the jumps follow, each group nearest first.
    expect(at(11)).toEqual(['slow-written', 'mid-written', 'fast-written', 'slow-jump', 'fast-jump']);
    expect(at(89)).toEqual(['fast-written', 'mid-written', 'slow-written', 'fast-jump', 'slow-jump']);
  });

  // Eleven songs, places 0, 10, ... 100 on Tempo. 'weak-slow' rests at the top of the slow band and 'weak-fast' at the bottom of the upbeat
  // band, as the weak labels of #49 do (89.5 to 89.9, 125 to 125.4), so a thumb at 10 or at 90 sits exactly on one of them.
  const eleven = [
    timed('clear-slow', 'none', 50), timed('weak-slow', 'none', 89.6), timed('mid-1', 'none', 95), timed('mid-2', 'none', 100), timed('mid-3', 'none', 105),
    timed('mid-4', 'none', 110), timed('mid-5', 'none', 115), timed('mid-6', 'none', 120), timed('mid-7', 'none', 124), timed('weak-fast', 'none', 125.2), timed('clear-fast', 'none', 190),
  ];

  it('counts a thumb at 6 to 10 (or 90 to 94) as the end itself: the songs in the band go slowest first, not nearest the thumb', () => {
    expect(at(0, eleven).slice(0, 2)).toEqual(['clear-slow', 'weak-slow']);
    expect(at(100, eleven).slice(0, 2)).toEqual(['clear-fast', 'weak-fast']);
    // Measured to the thumb, a thumb at 10 would put the weak song first; at the end it is the same list as at 0.
    for (const tempo of [6, 8, 10]) expect(at(tempo, eleven), `tempo ${tempo}`).toEqual(at(0, eleven));
    for (const tempo of [90, 92, 94]) expect(at(tempo, eleven), `tempo ${tempo}`).toEqual(at(100, eleven));
  });

  it('has no jump when the thumb leaves a stop: the target runs from 0 at the thumb\'s 10 to 100 at its 90', () => {
    // From the stop's edge straight to the thumb, a thumb at 11 would put the weak song (place 10) first, though at 10 it was second.
    expect(at(11, eleven).slice(0, 2)).toEqual(['clear-slow', 'weak-slow']);
    expect(at(89, eleven).slice(0, 2)).toEqual(['clear-fast', 'weak-fast']);
    // The target moves 1.25 places for each step of the thumb: it reaches the weak song's place, 10, at a thumb of 18 (90 at a thumb of 82).
    expect(at(18, eleven)[0]).toBe('weak-slow');
    expect(at(82, eleven)[0]).toBe('weak-fast');
    // The middle of the track stays the middle.
    expect(at(50, eleven)[0]).toBe('mid-4');
  });

  it('keeps the songs sung as written first everywhere else on the track', () => {
    for (const tempo of [12, 25, 50, 75, 88]) {
      const r = at(tempo);
      expect(r.slice(0, 3).sort(), `tempo ${tempo}`).toEqual(['fast-written', 'mid-written', 'slow-written']);
      expect(r.slice(3).sort(), `tempo ${tempo}`).toEqual(['fast-jump', 'slow-jump']);
    }
  });

  it('counts for nothing while Tempo is off, whatever its value', () => {
    const r = at(0, FIVE, { off: [...tempoOnly, 'tempo'] });
    expect(r.slice(0, 3).sort()).toEqual(['fast-written', 'mid-written', 'slow-written']);
    expect(r.slice(3).sort()).toEqual(['fast-jump', 'slow-jump']);
  });

  it('puts the songs at the end first whatever the other gears say, and still orders inside them by those gears', () => {
    // Tempo 70, 80 and 110 are places 0, 50 and 100; Popularity 0.1, 0.5 and 0.95 are places 0, 50 and 100 (counted double). With Tempo
    // at 0 and Popularity at 100 the sums are 200 (slow-obscure), 150 (slow-hit) and 100 (mid-hit): by the sum alone the mid hit is first.
    const three = [timed('slow-obscure', 'none', 70, 0.1), timed('slow-hit', 'none', 80, 0.5), timed('mid-hit', 'none', 110, 0.95)];
    const popularityToo: Parameters<typeof state>[0] = { off: ['history', 'era', 'difficulty'], gears: { popularity: 100 } };
    expect(at(0, three, popularityToo)).toEqual(['slow-hit', 'slow-obscure', 'mid-hit']);
    // Short of the end nothing is first but the sum.
    expect(at(50, three, popularityToo)).toEqual(['mid-hit', 'slow-hit', 'slow-obscure']);
  });

  it('draws the line between the slow and the mid band at 90 and the one between the mid and the upbeat band at 125', () => {
    // Tempo 89.9 is slow and 90 is mid; 124.9 is mid and 125 is upbeat (feelOfTempo). The two songs next to each line differ in
    // popularity so that the sum alone would put the popular one of each pair first.
    const edge = [timed('t-89.9', 'none', 89.9, 0.1), timed('t-90', 'none', 90, 0.99), timed('t-124.9', 'none', 124.9, 0.1), timed('t-125', 'none', 125, 0.99)];
    const popularityToo: Parameters<typeof state>[0] = { off: ['history', 'era', 'difficulty'], gears: { popularity: 100 } };
    expect(at(0, edge, popularityToo)).toEqual(['t-89.9', 't-90', 't-125', 't-124.9']);
    expect(at(100, edge, popularityToo)).toEqual(['t-125', 't-90', 't-124.9', 't-89.9']);
  });

  it('keeps a big hit sung an octave down behind the songs at the end that are sung as written (QWW-58 inside the band)', () => {
    // The hit is the most popular song and an octave jump; with Popularity on it would lead whatever the Tempo end said, if the octave
    // groups were dropped. Both slow songs sung as written are ahead of it, and so is the slow jump song: it is in the band.
    const songs = [timed('jump-hit', 'down', 75, 0.99), timed('slow-written-a', 'none', 70, 0.2), timed('slow-written-b', 'none', 80, 0.1), timed('mid-written', 'none', 110, 0.5)];
    const popularityToo: Parameters<typeof state>[0] = { off: ['history', 'era', 'difficulty'], gears: { popularity: 100 } };
    const r = at(0, songs, popularityToo);
    expect(r.indexOf('jump-hit')).toBeGreaterThan(r.indexOf('slow-written-a'));
    expect(r.indexOf('jump-hit')).toBeGreaterThan(r.indexOf('slow-written-b'));
    expect(r.indexOf('jump-hit')).toBeLessThan(r.indexOf('mid-written'));
  });

  it('puts the band before the singer\'s own songs too (R31), and sung as written before History: own written, other written, own jump, other jump in the band, then the same four out of it', () => {
    // Signed in with History on at 100, the way the tuner opens signed in, and Tempo at an end. The singer's own songs are the ones with a
    // listening share. Sung as written comes ahead of History (QWW-58), so the singer's own jump song is behind a catalogue song sung as
    // written, and both are ahead of every song out of the band. Fast songs (150 to 180) are in the upbeat band, mid songs (105 to 120) are not.
    const own = (id: string, how: keyof typeof AS_SUNG, tempo: number) => ({ match: timed(id, how, tempo), listening: 0.9 });
    const other = (id: string, how: keyof typeof AS_SUNG, tempo: number) => ({ match: timed(id, how, tempo) });
    const list = prepareSetlist(
      [
        other('mid-jump-other', 'up', 120), own('mid-jump-own', 'down', 115), other('mid-written-other', 'none', 105), own('mid-written-own', 'none', 110),
        other('fast-jump-other', 'up', 180), own('fast-jump-own', 'down', 170), other('fast-written-other', 'none', 160), own('fast-written-own', 'none', 150),
      ],
      USER,
    );
    const signedIn: Parameters<typeof state>[0] = { off: ['era', 'difficulty', 'popularity'], loggedIn: true };
    const atEnd = ['fast-written-own', 'fast-written-other', 'fast-jump-own', 'fast-jump-other', 'mid-written-own', 'mid-written-other', 'mid-jump-own', 'mid-jump-other'];
    for (const tempo of [100, 94]) expect(ids(rankPrepared(list, state({ ...signedIn, gears: { tempo } }))), `tempo ${tempo}`).toEqual(atEnd);
    // No song is in the slow band, so at the slow end and short of the ends the order is the usual one: sung as written first, the singer's
    // own songs first inside each, then the jumps the same way.
    for (const tempo of [0, 50]) {
      const r = ids(rankPrepared(list, state({ ...signedIn, gears: { tempo } })));
      expect(r.slice(0, 2).sort(), `tempo ${tempo}`).toEqual(['fast-written-own', 'mid-written-own']);
      expect(r.slice(2, 4).sort(), `tempo ${tempo}`).toEqual(['fast-written-other', 'mid-written-other']);
      expect(r.slice(4, 6).sort(), `tempo ${tempo}`).toEqual(['fast-jump-own', 'mid-jump-own']);
      expect(r.slice(6).sort(), `tempo ${tempo}`).toEqual(['fast-jump-other', 'mid-jump-other']);
    }
  });

  it('puts a song with no tempo after the songs that have one inside its group, and the Maybe songs last', () => {
    const noTempo = timed('written-no-tempo', 'none', undefined, 0.9);
    expect(effectiveTempo(noTempo)).toBeUndefined();
    // It is out of the band, so it is in the rest: after the songs sung as written that have a tempo, before the rest's jump songs.
    expect(at(100, [...FIVE, noTempo])).toEqual(['fast-written', 'fast-jump', 'mid-written', 'slow-written', 'written-no-tempo', 'slow-jump']);
    const maybe = song('maybe-slow', { low: 40, high: 70, confidence: 'low', popularity: 0.99, tempo: 40 });
    expect(maybe.difficulty).toBe('maybe');
    expect(at(0, [maybe, ...FIVE]).at(-1)).toBe('maybe-slow');
    expect(at(100, [maybe, ...FIVE]).at(-1)).toBe('maybe-slow');
  });

  it('is the same list however the songs arrive', () => {
    for (const tempo of [0, 100]) {
      for (const seed of [1, 2, 3]) expect(at(tempo, shuffled(FIVE, seed)), `tempo ${tempo}, shuffle ${seed}`).toEqual(at(tempo));
    }
  });
});

describe('History (rule 3): the singer\'s own songs, only when logged in', () => {
  const a = { match: song('a', { low: 50, high: 60, popularity: 0.5 }), listening: 0.9 };
  const b = { match: song('b', { low: 50, high: 60, popularity: 0.5 }), listening: 0.15 };
  const c = { match: song('c', { low: 50, high: 60, popularity: 0.5 }), listening: 0.4 };
  const outside = { match: song('outside', { low: 50, high: 60, popularity: 0.5 }) };
  const only: TunerPart[] = ['tempo', 'era', 'difficulty', 'popularity']; // History is the only gear left to count

  it('counts only when the singer is logged in: logged out it is ignored even when it is on', () => {
    const list = prepareSetlist([a, b, c, outside], USER);
    const out = rankPrepared(list, state({ off: only, loggedIn: false }));
    expect(out.applied).toEqual([]);
    // Nothing is active, so the order is the all-off order, not a History order.
    expect(ids(out)).toEqual(ids(rankPrepared(list, state({ off: [...GEAR_IDS, 'era'], loggedIn: false }))));
    expect(ids(out)).not.toEqual(ids(rankPrepared(list, state({ off: only, loggedIn: true, gears: { history: 100 } }))));
    const inn = rankPrepared(list, state({ off: only, loggedIn: true }));
    expect(inn.applied).toEqual(['history']);
  });

  it('puts On repeat songs first at 100 and Rediscover songs first at 0, the songs outside the library after both', () => {
    const list = prepareSetlist([a, b, c, outside], USER);
    expect(ids(rankPrepared(list, state({ off: only, loggedIn: true, gears: { history: 100 } })))).toEqual(['a', 'c', 'b', 'outside']);
    expect(ids(rankPrepared(list, state({ off: only, loggedIn: true, gears: { history: 0 } })))).toEqual(['b', 'c', 'a', 'outside']);
  });

  it('gives a song outside the library no place on History', () => {
    const list = prepareSetlist([a, outside], USER);
    expect(list.songs.map((s) => s.gears.history)).toEqual([50, null]);
  });

  it('tells songs that are played the same apart by Spotify\'s order, so a big tied group spreads out', () => {
    const tied = [0, 1, 2, 3].map((i) => ({ match: song(`t${i}`, { low: 50, high: 60, playRank: i }), listening: 0.15 }));
    const list = prepareSetlist(tied, USER);
    const place = (id: string) => list.songs.find((s) => s.candidate.match.track.id === id)!.gears.history!;
    // The song played more (lower play rank) sits further toward On repeat.
    expect([place('t3'), place('t2'), place('t1'), place('t0')]).toEqual([0, 100 / 3, 200 / 3, 100]);
  });
});

describe('determinism', () => {
  it('gives the same list however the songs arrive, and the same list twice', () => {
    const range = TEST_RANGES[2]![1];
    const { matches } = catalogueMatches(CATALOGUE, { ...range, source: 'test' }, deps);
    const state1 = input(range, { off: ['history', 'era'], gears: { tempo: 20, difficulty: 35 } });
    const a = rankSetlist(cands(...matches), state1);
    for (const seed of [1, 2, 3, 4]) {
      const b = rankSetlist(cands(...shuffled(matches, seed)), state1);
      expect(ids(b), `shuffle ${seed}`).toEqual(ids(a));
      expect(b.songs.map((s) => s.gears)).toEqual(a.songs.map((s) => s.gears));
    }
    expect(ids(rankSetlist(cands(...matches), state1))).toEqual(ids(a));
  });

  it('never changes the songs it was given', () => {
    const m = song('a', { low: 50, high: 60 });
    const before = JSON.stringify(m);
    rankSetlist(cands(m, song('b', { low: 52, high: 61 })), input(USER));
    expect(JSON.stringify(m)).toBe(before);
  });
});

// ================================================================
// The success criteria (QWW-42) on a list the size of the real one.

describe.each(TEST_RANGES)('%s', (_name, range) => {
  const list = prepareCatalogue(CATALOGUE, range, deps);
  const hard = list.matches.filter((m) => m.difficulty === 'hard');

  it('has songs to rank, and Hard ones to find', () => {
    expect(list.matches.length).toBeGreaterThan(100);
    expect(hard.length).toBeGreaterThanOrEqual(10);
  });

  it('only lists songs that fit the singer\'s range, for any setting of the gears (rule 1)', () => {
    // The filter is matchSong's (match.ts), applied when the list is built; the engine neither adds nor removes a song.
    const settings = [state(), state({ gears: { difficulty: 100 } }), state({ off: [...GEAR_IDS, 'era'] }), state({ gears: { popularity: 0, tempo: 100 }, off: ['history', 'era'] })];
    for (const s of settings) {
      const r = rankPrepared(list.prepared, s);
      expect(r.songs).toHaveLength(list.matches.length);
      for (const { match } of r.songs) {
        const { low, high } = match.range;
        const shift = match.octave === 'up' ? 12 : match.octave === 'down' ? -12 : 0;
        expect(low + shift, match.track.id).toBeGreaterThanOrEqual(range.low);
        expect(high + shift, match.track.id).toBeLessThanOrEqual(range.high);
      }
    }
  });

  // Quinn-Wai's check of 10 Nov: logged out, max difficulty, Hard songs at the top. Popularity is on from the start and
  // counts double, so the top is the most popular Hard songs: this holds when there are Hard songs of every popularity,
  // as in this catalogue (hundreds of them). It is not a law: a range with a handful of Hard songs, all obscure, puts
  // popular Medium and Easy ones among them. The next test is the exact version, with Popularity off.
  it('puts Hard songs at the top at max difficulty, logged out, with Popularity at its default, on this catalogue (Quinn-Wai, 10 Nov)', () => {
    const r = rankPrepared(list.prepared, state({ gears: { difficulty: 100 } }));
    expect(r.songs.length).toBeGreaterThanOrEqual(10);
    expect(r.songs.slice(0, 10).map((s) => s.match.difficulty)).toEqual(Array(10).fill('hard'));
    expect(r.songs[0]!.gears.difficulty!).toBeGreaterThan(90);
  });

  it('puts only Hard songs first at max difficulty with Popularity off, hardest first, inside each group (QWW-58)', () => {
    const r = rankPrepared(list.prepared, state({ gears: { difficulty: 100 }, off: ['history', 'tempo', 'era', 'popularity'] }));
    // The songs sung as written come before the jumps, so the Hard songs are first inside each of the two groups.
    let hardChecked = 0;
    for (const written of [true, false]) {
      const group = r.songs.filter((s) => s.match.difficulty !== 'maybe' && (s.match.octave === 'none') === written);
      const hardHere = group.filter((s) => s.match.difficulty === 'hard').length;
      const top = group.slice(0, hardHere);
      expect(top.every((s) => s.match.difficulty === 'hard' || s.gears.difficulty === null)).toBe(true);
      const ds = top.map((s) => s.gears.difficulty!);
      for (let i = 1; i < ds.length; i++) expect(ds[i]!).toBeLessThanOrEqual(ds[i - 1]!);
      hardChecked += hardHere;
    }
    expect(hardChecked).toBe(hard.length); // every Hard song was in one of the two groups
  });

  it('is never empty at max difficulty: at least 10 songs (criterion 3)', () => {
    for (const off of [DEFAULT_OFF, ['history'], ['history', 'tempo', 'era', 'popularity']] as TunerPart[][]) {
      const r = rankPrepared(list.prepared, state({ gears: { difficulty: 100, tempo: 100, popularity: 0 }, off: [...off], eras: [...ERA_IDS] }));
      expect(r.songs.length).toBeGreaterThanOrEqual(10);
    }
    // The one way to an empty list: Era on and no era picked (spec §4a).
    expect(rankPrepared(list.prepared, state({ gears: { difficulty: 100 }, off: ['history'], eras: [] })).empty).toBe('no-era-picked');
  });

  it('returns songs for every single era, with any gear at either end (criterion 3)', () => {
    for (const era of ERA_IDS) {
      for (const g of ['difficulty', 'popularity', 'tempo'] as const) {
        for (const v of [0, 100]) {
          const r = rankPrepared(list.prepared, state({ off: ['history'], eras: [era], gears: { [g]: v } }));
          expect(r.songs.length, `${era}, ${g} ${v}`).toBeGreaterThan(0);
          expect(r.empty).toBeUndefined();
        }
      }
    }
  });

  it('with the default state is sorted by the documented sum, popularity counting double (rule 3), inside each group (QWW-58)', () => {
    const r = rankPrepared(list.prepared, state());
    const distance = (s: (typeof r.songs)[number]) => 2 * Math.abs(s.gears.popularity! - 100) + Math.abs(s.gears.difficulty! - 0);
    // The songs sung as written come before the jumps; inside each group the order is the documented sum.
    for (const written of [true, false]) {
      const group = r.songs.filter((s) => s.match.difficulty !== 'maybe' && (s.match.octave === 'none') === written);
      // Sorted by the documented sum, among the songs that have both gears.
      const complete = group.filter((s) => s.gears.popularity !== null && s.gears.difficulty !== null);
      expect(complete.length, written ? 'sung as written' : 'jumps').toBeGreaterThan(50);
      for (let i = 1; i < complete.length; i++) expect(distance(complete[i]!)).toBeGreaterThanOrEqual(distance(complete[i - 1]!) - 1e-6);
      // And the songs missing one of them come after all of those.
      const firstIncomplete = group.findIndex((s) => s.gears.popularity === null || s.gears.difficulty === null);
      if (firstIncomplete >= 0) expect(group.slice(0, firstIncomplete).every((s) => s.gears.popularity !== null && s.gears.difficulty !== null)).toBe(true);
    }
  });

  it('moves the list along the whole length of every gear (QWW-33): the top 10 differ between neighbouring tenths', () => {
    for (const g of ['difficulty', 'popularity', 'tempo'] as const) {
      const top = (v: number) => ids(rankPrepared(list.prepared, state({ off: ['history', 'era'], gears: { [g]: v, ...(g === 'popularity' ? {} : { popularity: 100 }) } })), 10);
      // Tempo's first and last tenth are one stop: the thumb counts as the end there (QWW-54), so 0 to 10 and 90 to 100 are flat by design.
      const flat = g === 'tempo' ? new Set([10, 100]) : new Set<number>();
      let moved = 0;
      let steps = 0;
      for (let v = 10; v <= 100; v += 10) {
        if (flat.has(v)) continue;
        steps++;
        if (top(v).some((id, i) => id !== top(v - 10)[i])) moved++;
      }
      expect(moved, g).toBeGreaterThanOrEqual(Math.ceil(0.9 * steps));
    }
  });
});

// Criterion 9 (QWW-58): logged out with the default gears, at least 15 of the top 20 are sung as written. One range for every
// voice type, on a catalogue whose hits sit in the tenor's register, which is what put octave jumps at the top of a bass's list.
describe.each(VOICE_RANGES)('%s: songs sung as written first (criterion 9)', (_name, range) => {
  const { prepared, matches } = prepareCatalogue(HIT_CATALOGUE, range, deps);
  const written = matches.filter((m) => m.octave === 'none');
  const sungAsWritten = (s: { match: Match }) => s.match.octave === 'none';

  it('has songs sung as written to fill a top 20, and songs that need a jump behind them (or this proves nothing)', () => {
    expect(written.length).toBeGreaterThanOrEqual(20);
    expect(matches.length - written.length).toBeGreaterThanOrEqual(20);
  });

  it('puts at least 15 of the top 20 sung as written, logged out with the default gears', () => {
    const top = rankPrepared(prepared, state()).songs.slice(0, 20);
    expect(top).toHaveLength(20);
    expect(top.filter(sungAsWritten).length).toBeGreaterThanOrEqual(15);
  });

  it('lists every song sung as written before any song that needs a jump, whatever the gears and eras say (Tempo at an end apart, QWW-54)', () => {
    const settings = [
      state(),
      state({ gears: { difficulty: 100 } }),
      state({ gears: { difficulty: 20 }, off: ['history', 'tempo'], eras: ['s80'] }), // Quinn-Wai's list of 11 Nov: F2 to F4, '80s, Difficulty about 20
      state({ gears: { popularity: 0, tempo: 89 }, off: ['history', 'era'] }), // Tempo on, one place short of the end
      state({ gears: { popularity: 0, tempo: 11 }, off: ['history', 'era'] }),
      state({ gears: { popularity: 0, tempo: 0 }, off: ['history', 'tempo', 'era'] }), // Tempo at an end but off: it counts for nothing
      state({ off: [...GEAR_IDS, 'era'] }),
      ...ERA_IDS.map((era) => state({ off: ['history', 'tempo'], eras: [era] })),
    ];
    for (const [i, s] of settings.entries()) {
      const { songs } = rankPrepared(prepared, s);
      // The Maybe songs come after all the others (tested above); the rule holds inside each of the two blocks.
      for (const maybe of [false, true]) {
        const block = songs.filter((x) => (x.match.difficulty === 'maybe') === maybe).map(sungAsWritten);
        const firstJump = block.indexOf(false);
        expect(firstJump < 0 || !block.slice(firstJump).includes(true), `setting ${i}, ${maybe ? 'Maybe' : 'sure'} songs: a song sung as written after a jump`).toBe(true);
      }
    }
  });

  it('with Tempo at an end, lists the songs at that end first, and inside each part as written before a jump (QWW-54)', () => {
    for (const [tempo, band] of [[0, 'slow'], [10, 'slow'], [90, 'upbeat'], [100, 'upbeat']] as const) {
      const { songs } = rankPrepared(prepared, state({ off: ['history', 'era', 'difficulty', 'popularity'], gears: { tempo } }));
      const sure = songs.filter((x) => x.match.difficulty !== 'maybe');
      expect(songs.slice(sure.length).every((x) => x.match.difficulty === 'maybe'), `tempo ${tempo}: the Maybe songs are last`).toBe(true);
      const inBand = (x: { match: Match }) => x.match.tempo !== undefined && feelOfTempo(x.match.tempo) === band;
      const flags = sure.map(inBand);
      expect(flags.filter(Boolean).length, `tempo ${tempo}: songs in the ${band} band`).toBeGreaterThan(100);
      // Songs in the band that need a jump exist, so the check below is about them: they come before every song out of the band.
      expect(sure.filter((x) => inBand(x) && !sungAsWritten(x)).length, `tempo ${tempo}: jump songs in the band`).toBeGreaterThan(0);
      expect(flags.indexOf(false) < 0 || !flags.slice(flags.indexOf(false)).includes(true), `tempo ${tempo}: a song in the band after one that is not`).toBe(true);
      for (const part of [true, false]) {
        const inPart = sure.filter((x) => inBand(x) === part);
        const written = inPart.map(sungAsWritten);
        expect(written.indexOf(false) < 0 || !written.slice(written.indexOf(false)).includes(true), `tempo ${tempo}, ${part ? 'in' : 'out of'} the band: a song sung as written after a jump`).toBe(true);
        // Nearest the end first inside each group of songs sung the same way (the thumb counts as the end, so Tempo 10 is Tempo 0).
        const end = band === 'slow' ? 0 : 100;
        for (const way of [true, false]) {
          const group = inPart.filter((x) => sungAsWritten(x) === way && x.gears.tempo !== null);
          for (let i = 1; i < group.length; i++) expect(Math.abs(group[i]!.gears.tempo! - end), `tempo ${tempo}, song ${i}`).toBeGreaterThanOrEqual(Math.abs(group[i - 1]!.gears.tempo! - end) - 1e-6);
        }
      }
    }
  });

  it('still lists every song that fits, and is never empty (criterion 3): the jumps follow, they are not dropped', () => {
    for (const s of [state(), state({ gears: { difficulty: 100 } }), state({ off: [...GEAR_IDS, 'era'] })]) {
      expect(rankPrepared(prepared, s).songs).toHaveLength(matches.length);
    }
    expect(matches.length).toBeGreaterThanOrEqual(10);
    for (const era of ERA_IDS) expect(rankPrepared(prepared, state({ off: ['history', 'tempo'], eras: [era] })).songs.length, era).toBeGreaterThan(0);
  });
});

describe('the top of the default list, on twelve invented catalogues (rule 3)', () => {
  // Measured across seeds 1 to 12 and the five ranges: the top 20 never has a song under place 72 on Popularity and
  // averages 89 or more. The bounds leave room under that. They say "leans on popularity" without pinning one catalogue.
  const seeds = Array.from({ length: 12 }, (_, i) => i + 1);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  it.each(seeds)('seed %i: the top 20 are popular songs, and easier than the list as a whole', (seed) => {
    const tracks = catalogue(seed);
    for (const [name, range] of TEST_RANGES) {
      const { prepared } = prepareCatalogue(tracks, range, deps);
      const r = rankPrepared(prepared, state());
      const top = r.songs.slice(0, 20);
      expect(Math.min(...top.map((s) => s.gears.popularity!)), `${name}, lowest place`).toBeGreaterThan(65);
      expect(mean(top.map((s) => s.gears.popularity!)), `${name}, mean place`).toBeGreaterThan(85);
      expect(mean(top.map((s) => s.gears.difficulty!)), name).toBeLessThan(mean(r.songs.map((s) => s.gears.difficulty ?? 50)));
    }
  });

  it.each(seeds)('seed %i: at max difficulty the top 10 are Hard songs, in every range', (seed) => {
    const tracks = catalogue(seed);
    for (const [name, range] of TEST_RANGES) {
      const { prepared } = prepareCatalogue(tracks, range, deps);
      const r = rankPrepared(prepared, state({ gears: { difficulty: 100 } }));
      expect(r.songs.slice(0, 10).map((s) => s.match.difficulty), name).toEqual(Array(10).fill('hard'));
    }
  });
});

describe('a duet and a library song', () => {
  it('ranks a duet on the part the singer sings: its match carries that part\'s range, which the engine reads', () => {
    const range: SongRange = {
      low: 30,
      high: 80,
      tessitura: 55,
      source: 'note-file',
      confidence: 'high',
      fastLyrics: false,
      duet: true,
      parts: [
        { low: 30, high: 36, tessitura: 33, fastLyrics: false, pitchShare: flat(30, 36) }, // P1 only fits up an octave
        { low: 48, high: 54, tessitura: 51, fastLyrics: false, pitchShare: flat(48, 54) },
      ],
    };
    const fit = matchSong(USER, range)!;
    expect(fit.part).toBe(2); // fits as written, which beats an octave shift (match.ts)
    const m = { ...toMatch(track('duet'), range, fit), parts: { comfort: 0.5, familiarity: 1, popularity: 0.5, popularityKnown: true, penalty: 0 } };
    expect(m.range.low).toBe(48);
    const solo = song('solo', { low: 48, high: 54, shares: flat(48, 54) });
    const list = prepareSetlist(cands(m, solo), USER);
    // The same notes, so the same place on Difficulty.
    expect(list.songs[0]!.gears.difficulty).toBe(list.songs[1]!.gears.difficulty);
  });

  it('turns a library match into a candidate with how much the singer plays it', () => {
    const played = { ...song('played', { low: 50, high: 60 }), track: { ...track('played'), familiarity: 0.8 } };
    const byRank = { ...song('by-rank', { low: 50, high: 60 }), track: track('by-rank', 20) }; // no familiarity: 1 / (1 + 20 / 20)
    expect(libraryCandidate(played)).toEqual({ match: played, listening: 0.8 });
    expect(libraryCandidate(byRank).listening).toBeCloseTo(0.5, 12);
  });
});

describe('the lists the harness (QWW-52) checks, as one call', () => {
  it('rankCatalogue ranks a catalogue for the tuner\'s state and is what the server serves', () => {
    const range = TEST_RANGES[0]![1];
    const r = rankCatalogue(CATALOGUE, input(range), deps);
    const viaList = rankPrepared(prepareCatalogue(CATALOGUE, range, deps).prepared, state());
    expect(ids(r)).toEqual(ids(viaList));
    expect(r.songs.length).toBeGreaterThan(1000);
    expect(r.applied).toEqual(['difficulty', 'popularity']);
  });
});
