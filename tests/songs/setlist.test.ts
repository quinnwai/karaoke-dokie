// QWW-47: the ranking engine behind the Setlist tuner (src/lib/songs/setlist.ts), rule by rule.
//
// Two kinds of list. Hand-built songs, where each rule is shown on a few songs whose places are known,
// and a synthetic catalogue (tests/helpers/sliderFixtures.ts, 4,000 songs, matched by the production code)
// for the things that only show on a real-sized list: the lists the success criteria are about.

import { describe, expect, it } from 'vitest';
import type { EraId, GearId, Match, SetlistInput, SetlistState, SongRange, Track, TunerPart, VocalRange } from '../../src/lib/contracts';
import { ERA_IDS, GEAR_IDS } from '../../src/lib/contracts';
import { catalogueMatches, catalogueTracks, prepareCatalogue, rankCatalogue, type CatalogueTrack } from '../../src/lib/server/catalogue';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { productionSongDeps } from '../../src/lib/server/wiring';
import { matchSong, toMatch } from '../../src/lib/songs/match';
import {
  BOTTOM_DISCOUNT,
  EASE_POINT,
  GEAR_WEIGHTS,
  MIN_PLAUSIBLE_SPAN,
  effectiveTempo,
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

// ---------- the synthetic catalogue ----------

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const ERA_SHARE: [EraId, number][] = [['pre', 0.08], ['s70', 0.1], ['s80', 0.16], ['s90', 0.2], ['s00', 0.2], ['s10', 0.19], ['s20', 0.07]];
const YEAR_OF: Record<EraId, number> = { pre: 1962, s70: 1976, s80: 1985, s90: 1995, s00: 2005, s10: 2015, s20: 2022 };

/** The sliderFixtures catalogue with a year (95% of songs) and a tempo (96%), so the Era and Tempo gears have something to work on. */
function catalogue(seed = 7): CatalogueTrack[] {
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
  return catalogueTracks(entries);
}
const CATALOGUE = catalogue();

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
    expect(noteCost(0.5)).toBe(noteCost(1 - 0.5));
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

  it('lists the catalogue in popularity order when every gear is off (spec test 18), whatever order the songs came in', () => {
    const list = prepareCatalogue(CATALOGUE, TEST_RANGES[0]![1], deps);
    const all = rankPrepared(list.prepared, state({ off: [...GEAR_IDS, 'era'] }));
    expect(all.songs).toHaveLength(list.matches.length);
    expect(all.applied).toEqual([]);
    const pop = all.songs.map((s) => (s.match.parts?.popularityKnown ? s.match.parts.popularity : -1));
    for (let i = 1; i < pop.length; i++) expect(pop[i]!).toBeLessThanOrEqual(pop[i - 1]!);
  });

  it('clamps a gear value outside 0 to 100 instead of ranking on it', () => {
    const songs = [placed('a', { tempo: 0 }), placed('b', { tempo: 100 })];
    const off: TunerPart[] = ['history', 'era', 'difficulty', 'popularity'];
    expect(ids(rankPrepared(preparedOf(...songs), state({ off, gears: { tempo: 9999 } })))).toEqual(['b', 'a']);
    expect(ids(rankPrepared(preparedOf(...songs), state({ off, gears: { tempo: -50 } })))).toEqual(['a', 'b']);
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

  it('ranks the songs that miss the same gears among themselves by the gears they have', () => {
    const songs = [placed('far', { tempo: null, popularity: 40 }), placed('near', { tempo: null, popularity: 90 })];
    expect(ids(rankPrepared(preparedOf(...songs), state({ off: ['history', 'era', 'difficulty'] })))).toEqual(['near', 'far']);
  });

  it('puts a song with no tempo after the songs that have one when Tempo is on, on a real list', () => {
    const r = rankCatalogue(CATALOGUE, input(TEST_RANGES[0]![1], { gears: { tempo: 0 }, off: [...others, 'difficulty', 'popularity'].filter((p, i, all) => all.indexOf(p) === i) as TunerPart[] }), deps);
    const firstUnknown = r.songs.findIndex((s) => s.gears.tempo === null);
    expect(firstUnknown).toBeGreaterThan(1000);
    expect(r.songs.slice(firstUnknown).every((s) => s.gears.tempo === null)).toBe(true);
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
    expect(rankPrepared(list, state({ off: off('era') })).empty).toBeUndefined();
  });

  it('keeps a song at the same place on every gear whatever is picked, so toggling an era only fades rows in and out', () => {
    const all = rankPrepared(list, state({ off: off('era') }));
    const some = rankPrepared(list, state({ off: off(), eras: ['s80'] }));
    for (const s of some.songs) expect(all.songs.find((x) => x.match.track.id === s.match.track.id)!.gears).toEqual(s.gears);
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
    expect(out.songs.map((s) => s.gears.history)).not.toContain(0.9);
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
    const shuffled = [...matches].sort(() => rng(5)() - 0.5).reverse();
    const state1 = input(range, { off: ['history', 'era'], gears: { tempo: 20, difficulty: 35 } });
    const a = rankSetlist(cands(...matches), state1);
    const b = rankSetlist(cands(...shuffled), state1);
    expect(ids(b)).toEqual(ids(a));
    expect(ids(rankSetlist(cands(...matches), state1))).toEqual(ids(a));
    expect(b.songs.map((s) => s.gears)).toEqual(a.songs.map((s) => s.gears));
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
    const settings = [state(), state({ gears: { difficulty: 100 } }), state({ off: [...GEAR_IDS, 'era'] }), state({ gears: { popularity: 0, tempo: 100 }, off: ['history', 'era'] })];
    for (const s of settings) {
      for (const { match } of rankPrepared(list.prepared, s).songs) {
        const { low, high, pitchShare } = match.range;
        const shift = match.octave === 'up' ? 12 : match.octave === 'down' ? -12 : 0;
        expect(pitchShare === undefined || pitchShare.length > 0).toBe(true);
        expect(low + shift, match.track.id).toBeGreaterThanOrEqual(range.low);
        expect(high + shift, match.track.id).toBeLessThanOrEqual(range.high);
      }
    }
  });

  it('puts Hard songs at the top at max difficulty, logged out, with Popularity at its default (Quinn-Wai, 10 Nov)', () => {
    const r = rankPrepared(list.prepared, state({ gears: { difficulty: 100 } }));
    expect(r.songs.length).toBeGreaterThanOrEqual(10);
    expect(r.songs.slice(0, 10).map((s) => s.match.difficulty)).toEqual(Array(10).fill('hard'));
    // And the hardest first, among songs of near-equal popularity.
    expect(r.songs[0]!.gears.difficulty!).toBeGreaterThan(90);
  });

  it('puts only Hard songs first at max difficulty with Popularity off, hardest first', () => {
    const r = rankPrepared(list.prepared, state({ gears: { difficulty: 100 }, off: ['history', 'tempo', 'era', 'popularity'] }));
    const top = r.songs.slice(0, hard.length);
    expect(top.every((s) => s.match.difficulty === 'hard' || s.gears.difficulty === null)).toBe(true);
    const ds = top.map((s) => s.gears.difficulty!);
    for (let i = 1; i < ds.length; i++) expect(ds[i]!).toBeLessThanOrEqual(ds[i - 1]!);
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

  it('with the default state lists the most popular songs first, then the easiest (rule 3)', () => {
    const r = rankPrepared(list.prepared, state());
    const top = r.songs.slice(0, 20);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(top.map((s) => s.gears.popularity!))).toBeGreaterThan(90);
    expect(Math.min(...top.map((s) => s.gears.popularity!))).toBeGreaterThan(75);
    // Among songs that are about as popular, the easier one comes first.
    expect(mean(top.map((s) => s.gears.difficulty!))).toBeLessThan(mean(r.songs.map((s) => s.gears.difficulty ?? 50)));
    // Sorted by the documented sum, among the songs that have both gears.
    const complete = r.songs.filter((s) => s.match.difficulty !== 'maybe' && s.gears.popularity !== null && s.gears.difficulty !== null);
    const distance = (s: (typeof r.songs)[number]) => 2 * Math.abs(s.gears.popularity! - 100) + Math.abs(s.gears.difficulty! - 0);
    expect(complete.length).toBeGreaterThan(100);
    for (let i = 1; i < complete.length; i++) expect(distance(complete[i]!)).toBeGreaterThanOrEqual(distance(complete[i - 1]!) - 1e-6);
    // And the songs missing one of them come after all of those.
    const firstIncomplete = r.songs.findIndex((s) => s.gears.popularity === null || s.gears.difficulty === null);
    if (firstIncomplete >= 0) expect(r.songs.slice(0, firstIncomplete).every((s) => s.gears.popularity !== null && s.gears.difficulty !== null)).toBe(true);
  });

  it('moves the list along the whole length of every gear (QWW-33): the top 10 differ between neighbouring tenths', () => {
    for (const g of ['difficulty', 'popularity', 'tempo'] as const) {
      const top = (v: number) => ids(rankPrepared(list.prepared, state({ off: ['history', 'era'], gears: { [g]: v, ...(g === 'popularity' ? {} : { popularity: 100 }) } })), 10);
      let moved = 0;
      for (let v = 10; v <= 100; v += 10) if (top(v).some((id, i) => id !== top(v - 10)[i])) moved++;
      expect(moved, g).toBeGreaterThanOrEqual(9);
    }
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
