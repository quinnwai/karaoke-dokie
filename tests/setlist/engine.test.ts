// The interim ranking engine (src/lib/setlist/engine.ts) against the model in its header and in spec §5, as QWW-47 decided
// it (option A) and the screen's defaults reproduce:
//
//   place    = a song's rank among the songs that fit, 0 to 100, per gear (Difficulty gives Easy, Medium and Hard a third each)
//   distance = sum over the gears that count of weight x |place - target|
//   order    = songs in the picked eras (every era when Era is off), nearest first, ties in the order given
//
// Popularity weighs x2. A song with no place on a gear that counts sorts after the rest on it. History counts only when the
// singer's library was read. Maybe songs come after the sure ones, each group placed on its own. Each scenario is a few songs
// (tests/helpers/setlist.ts `song`); the places and distances are worked out in the comments so a reader can check them.
// A place is a rank, so what a song's place is depends on the other songs in its group: read each list as a whole.

import { describe, expect, it } from 'vitest';
import type { DataSourceLogEntry, Label, Match } from '../../src/lib/contracts';
import { EASY, HARD, laneColor, MID } from '../../src/lib/setlist/art';
import { DEFAULTS } from '../../src/lib/setlist/defaults';
import { createLocalEngine, GEAR_WEIGHT, MIN_PLAUSIBLE_SPAN, rankSetlist, UNKNOWN_DISTANCE } from '../../src/lib/setlist/engine';
import { initialTuner, toRequest, tunerReducer } from '../../src/lib/setlist/tuner';
import { ERA_IDS, GEAR_IDS, TUNER_PARTS, type EraId, type GearId, type SetlistInput, type SetlistRequest, type SetlistSong, type TunerPart } from '../../src/lib/setlist/types';
import { RANGE, song, type SongOptions } from '../helpers/setlist';

const ids = (songs: SetlistSong[]) => songs.map((s) => s.match.track.id);
const singer = { low: RANGE.low, high: RANGE.high };

interface Spec {
  /** The gears that count; every other gear is off. */
  on?: GearId[];
  /** Targets by gear, 0 to 100; a gear not named sits at its default. */
  at?: Partial<Record<GearId, number>>;
  /** The picked eras, with Era on. Left out, Era is off and every era counts. */
  eras?: EraId[];
  /** Whether the singer's library was read, so History can count. Default true. */
  loggedIn?: boolean;
}

/** An input for the singer's range in which only the gears named are on (and Era only when `eras` is given). */
function input({ on = [], at = {}, eras, loggedIn = true }: Spec = {}): SetlistInput {
  const counting: readonly TunerPart[] = on;
  return {
    range: { ...singer },
    gears: { difficulty: DEFAULTS.difficulty, history: DEFAULTS.history, popularity: DEFAULTS.popularity, tempo: DEFAULTS.tempo, ...at },
    off: TUNER_PARTS.filter((part) => (part === 'era' ? eras === undefined : !counting.includes(part))),
    eras: eras ?? [...DEFAULTS.eras],
    loggedIn,
  };
}

/** The same, as the tuner sends it: no sign-in state, the engine knows that. */
function request(spec: Spec = {}): SetlistRequest {
  const { range, gears, off, eras } = input(spec);
  return { range, gears, off, eras };
}

const rank = (candidates: Match[], spec?: Spec) => rankSetlist(candidates, input(spec));
const order = (candidates: Match[], spec?: Spec) => ids(rank(candidates, spec).songs);
/** Each song's place on one gear, by track id. Places do not depend on what is on, so no gear has to be switched on. */
const placesOn = (candidates: Match[], gear: GearId, spec?: Spec): Record<string, number | null> =>
  Object.fromEntries(rank(candidates, spec).songs.map((s) => [s.match.track.id, s.gears[gear]]));
/** A match as the server sends it when no strain was measured: it is worked out from the song's range. */
const withoutStrain = (m: Match): Match => ({ ...m, strain: undefined });

// ---------------------------------------------------------------------------------------------------------------------
// Places

describe('places on Difficulty: each label has a third of the track', () => {
  it('puts a lone song of each label in the middle of its third: (band + 0.5) / 3 of the track', () => {
    const list = [song('e', { difficulty: 'easy' }), song('m', { difficulty: 'medium' }), song('h', { difficulty: 'hard' })];
    // Easy 0.5 / 3 = 16.7, Medium 1.5 / 3 = 50, Hard 2.5 / 3 = 83.3.
    expect(placesOn(list, 'difficulty')).toEqual({ e: 16.7, m: 50, h: 83.3 });
  });

  it('puts a lone song in the middle of its third whatever its strain', () => {
    for (const strain of [0, 1.5, 3]) expect(placesOn([song('e', { strain })], 'difficulty')).toEqual({ e: 16.7 });
  });

  it('splits a label\'s third evenly among its songs, the lower strain lower: (band + (k + 0.5) / n) / 3', () => {
    // Two songs in a band, k = 0 and 1 of n = 2: (band + 0.25) / 3 and (band + 0.75) / 3.
    const list = [
      song('e2', { difficulty: 'easy', strain: 2 }),
      song('h1', { difficulty: 'hard', strain: 0.5 }),
      song('m2', { difficulty: 'medium', strain: 2 }),
      song('e1', { difficulty: 'easy', strain: 0.5 }),
      song('h2', { difficulty: 'hard', strain: 2 }),
      song('m1', { difficulty: 'medium', strain: 0.5 }),
    ];
    // Easy 0.25 / 3 = 8.3 and 0.75 / 3 = 25; Medium 1.25 / 3 = 41.7 and 1.75 / 3 = 58.3; Hard 2.25 / 3 = 75 and 2.75 / 3 = 91.7.
    expect(placesOn(list, 'difficulty')).toEqual({ e1: 8.3, e2: 25, m1: 41.7, m2: 58.3, h1: 75, h2: 91.7 });
  });

  it('works out several songs per label by strain, whatever order they came in', () => {
    const list = [
      song('m29', { difficulty: 'medium', strain: 2.9 }),
      song('e12', { difficulty: 'easy', strain: 1.2 }),
      song('h22', { difficulty: 'hard', strain: 2.2 }),
      song('e28', { difficulty: 'easy', strain: 2.8 }),
      song('m01', { difficulty: 'medium', strain: 0.1 }),
      song('e04', { difficulty: 'easy', strain: 0.4 }),
      song('h07', { difficulty: 'hard', strain: 0.7 }),
      song('e20', { difficulty: 'easy', strain: 2.0 }),
      song('m15', { difficulty: 'medium', strain: 1.5 }),
    ];
    // Easy, n = 4: (0.5 / 4) / 3 = 4.2, (1.5 / 4) / 3 = 12.5, (2.5 / 4) / 3 = 20.8, (3.5 / 4) / 3 = 29.2.
    // Medium, n = 3: (1 + 0.5 / 3) / 3 = 38.9, (1 + 1.5 / 3) / 3 = 50, (1 + 2.5 / 3) / 3 = 61.1.
    // Hard, n = 2: (2 + 0.25) / 3 = 75 and (2 + 0.75) / 3 = 91.7.
    expect(placesOn(list, 'difficulty')).toEqual({ e04: 4.2, e12: 12.5, e20: 20.8, e28: 29.2, m01: 38.9, m15: 50, m29: 61.1, h07: 75, h22: 91.7 });
  });

  it('keeps Easy songs in 0 to 33, Medium in 33 to 67 and Hard in 67 to 100, each ordered by strain inside its third', () => {
    const labels: Label[] = ['easy', 'medium', 'hard'];
    const strains = Array.from({ length: 12 }, (_, i) => i * 0.25); // 0 to 2.75
    const list = labels.flatMap((difficulty) => strains.map((strain) => song(`${difficulty}-${strain}`, { difficulty, strain })));
    // Mixed up: every other song first, then the rest backwards.
    const mixed = [...list.filter((_, i) => i % 2 === 0), ...list.filter((_, i) => i % 2 === 1).reverse()];
    const places = placesOn(mixed, 'difficulty');
    const thirds = { easy: [0, 33], medium: [33, 67], hard: [67, 100] } as const;
    for (const label of ['easy', 'medium', 'hard'] as const) {
      const inLabel = strains.map((strain) => places[`${label}-${strain}`]!);
      for (const place of inLabel) {
        expect(place).toBeGreaterThanOrEqual(thirds[label][0]);
        expect(place).toBeLessThanOrEqual(thirds[label][1]);
      }
      // A higher strain is a higher place, and no two songs share one.
      expect(inLabel).toEqual([...inLabel].sort((a, b) => a - b));
      expect(new Set(inLabel).size).toBe(inLabel.length);
    }
  });

  it('gives a label with few songs only its own third: nothing is stretched across the track', () => {
    // Three Easy songs and nothing else: 5.6, 16.7 and 27.8, all inside 0 to 33, not 0, 50 and 100.
    const list = [song('a', { strain: 2.5 }), song('b', { strain: 0.5 }), song('c', { strain: 1 })];
    expect(placesOn(list, 'difficulty')).toEqual({ b: 5.6, c: 16.7, a: 27.8 });
  });

  it('tells songs of the same strain apart by play rank, then by position: the more played, then the earlier, sits higher', () => {
    // Three Easy songs, all strain 0: a tie. Sorted from the bottom of the third, the higher play rank number (played less)
    // goes first, then the later position. So the order is b, a, c: 5.6, 16.7 and 27.8.
    const list = [song('a', { playRank: 1 }), song('b', { playRank: 1 }), song('c', { playRank: 0 })];
    expect(placesOn(list, 'difficulty')).toEqual({ b: 5.6, a: 16.7, c: 27.8 });
  });

  it('works the strain out from the song\'s range when the match carries none', () => {
    // Two Easy songs for a singer 45 to 72 (middle 58.5, half-width 13.5), neither with a strain:
    //   50 to 64: the low end (15% of the time) is outside the middle half and nothing is at an edge: strain 0.15
    //   46 to 60: the low end is in an edge eighth (|46 - 58.5| / 13.5 = 0.93): 2 x 0.15 + 0.15 = 0.45
    // So the first is the lower of the two: 8.3, then 25.
    const mild = withoutStrain(song('mild', { range: { low: 50, high: 64 } }));
    const harder = withoutStrain(song('harder', { range: { low: 46, high: 60 } }));
    expect(placesOn([harder, mild], 'difficulty')).toEqual({ mild: 8.3, harder: 25 });
  });
});

describe('places on Popularity, History and Tempo: by rank among the songs that have a score', () => {
  const eleven = [0.01, 0.02, 0.03, 0.5, 0.51, 0.52, 0.9, 0.91, 0.95, 0.97, 0.99];

  it('spreads the songs evenly over the track by rank, not by value: eleven bunched values give 0, 10, ..., 100', () => {
    const list = eleven.map((popularity, i) => song(`p${i}`, { popularity }));
    const mixed = [4, 9, 1, 7, 0, 10, 3, 8, 2, 6, 5].map((i) => list[i]!);
    expect(placesOn(mixed, 'popularity')).toEqual(Object.fromEntries(eleven.map((_, i) => [`p${i}`, i * 10])));
  });

  it('rounds a place to one decimal', () => {
    // Seven songs: rank / 6 of the track.
    const list = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7].map((popularity, i) => song(`s${i}`, { popularity }));
    expect(Object.values(placesOn(list, 'popularity'))).toEqual([0, 16.7, 33.3, 50, 66.7, 83.3, 100]);
  });

  it('puts a lone known song in the middle, however popular it is', () => {
    expect(placesOn([song('only', { popularity: 0.99 })], 'popularity')).toEqual({ only: 50 });
    expect(placesOn([song('x', { popularity: null }), song('only', { popularity: 0.01 }), song('y', { popularity: null })], 'popularity')).toEqual({
      x: null,
      only: 50,
      y: null,
    });
  });

  const UNKNOWN: Record<'history' | 'popularity' | 'tempo', Record<'low' | 'mid' | 'high' | 'none', SongOptions>> = {
    history: { low: { history: 0.2 }, mid: { history: 0.5 }, high: { history: 0.8 }, none: { history: null } },
    popularity: { low: { popularity: 0.2 }, mid: { popularity: 0.5 }, high: { popularity: 0.8 }, none: { popularity: null } },
    tempo: { low: { tempo: 80 }, mid: { tempo: 120 }, high: { tempo: 160 }, none: { tempo: null } },
  };

  it.each(['history', 'popularity', 'tempo'] as const)('%s: a song with nothing known has no place, and is not counted when the others are placed', (gear) => {
    const { low, mid, high, none } = UNKNOWN[gear];
    const list = [song('none', none), song('high', high), song('low', low), song('mid', mid)];
    // Three known songs: 0, 50 and 100. Had the unknown one counted, they would be 0, 33.3, 66.7 and 100.
    expect(placesOn(list, gear)).toEqual({ none: null, high: 100, low: 0, mid: 50 });
  });

  it('places Tempo by the rank of the beats per minute, not on a 70 to 180 scale', () => {
    const list = [180, 70, 120, 95].map((tempo) => song(`t${tempo}`, { tempo }));
    // Ranks 0 to 3 of the track: 0, 33.3, 66.7 and 100. A straight line from 70 to 180 would put 95 at 22.7 and 120 at 45.5.
    expect(placesOn(list, 'tempo')).toEqual({ t70: 0, t95: 33.3, t120: 66.7, t180: 100 });
    // A tempo outside that range is just another rank.
    const wide = [200, 40, 125].map((tempo) => song(`w${tempo}`, { tempo }));
    expect(placesOn(wide, 'tempo')).toEqual({ w40: 0, w125: 50, w200: 100 });
  });

  it('tells songs with the same score apart by play rank, then by position: the more played, then the earlier, sits higher', () => {
    // Three songs at one popularity. Sorted from the bottom of the track, the higher play rank number (played less) goes
    // first, then the later position: b, a, c, which is 0, 50 and 100. c is the most played, and a is earlier than b.
    const list = [song('a', { popularity: 0.5, playRank: 1 }), song('b', { popularity: 0.5, playRank: 1 }), song('c', { popularity: 0.5, playRank: 0 })];
    expect(placesOn(list, 'popularity')).toEqual({ c: 100, a: 50, b: 0 });
  });
});

describe('places on History: the singer\'s own library', () => {
  const list = [
    song('rare', { history: 0.1, popularity: 0.2 }),
    song('top', { history: 0.9, popularity: 0.8 }),
    song('mid', { history: 0.5, popularity: 0.5 }),
  ];

  it('are given once the singer\'s library was read', () => {
    expect(placesOn(list, 'history', { loggedIn: true })).toEqual({ rare: 0, top: 100, mid: 50 });
  });

  it('are not given to anyone else, whatever the songs carry: every song has none, and the other gears are placed all the same', () => {
    expect(placesOn(list, 'history', { loggedIn: false })).toEqual({ rare: null, top: null, mid: null });
    expect(placesOn(list, 'popularity', { loggedIn: false })).toEqual({ rare: 0, top: 100, mid: 50 });
  });

  it('has no place for a song with no listening data, and does not count it', () => {
    const some = [song('none', { history: null }), song('a', { history: 0.2 }), song('b', { history: 0.8 })];
    expect(placesOn(some, 'history')).toEqual({ none: null, a: 0, b: 100 });
  });
});

describe('the Maybe songs are placed on their own', () => {
  const sure = () => [song('s1', { popularity: 0.2 }), song('s2', { popularity: 0.5 }), song('s3', { popularity: 0.9 })];
  const maybes = () => [song('m1', { difficulty: 'maybe', popularity: 0.99 }), song('m2', { difficulty: 'maybe', popularity: 0.01 })];

  it('does not move the places of the sure songs: they are the same with and without Maybe songs', () => {
    expect(placesOn(sure(), 'popularity')).toEqual({ s1: 0, s2: 50, s3: 100 });
    const [m1, m2] = maybes();
    const mixed = [m1!, ...sure(), m2!];
    // The sure songs keep 0, 50 and 100; the Maybe songs are ranked only among themselves: m2 (0.01) 0 and m1 (0.99) 100.
    // Placed together all five would be m2 0, s1 25, s2 50, s3 75 and m1 100.
    expect(placesOn(mixed, 'popularity')).toEqual({ s1: 0, s2: 50, s3: 100, m1: 100, m2: 0 });
  });

  it('puts a lone Maybe song in the middle of a known gear, however popular it is', () => {
    expect(placesOn([...sure(), song('m', { difficulty: 'maybe', popularity: 0.99 })], 'popularity').m).toBe(50);
  });

  it('bands a Maybe song on Difficulty from its range, as if it were sure, and places it among the Maybe songs only', () => {
    // For a singer 45 to 72, 48 to 64 has 15% of its time in an edge eighth: Hard. Alone among the Maybe songs it is a lone
    // Hard song, 2.5 / 3 = 83.3, whatever sure Hard songs there are. (Placed with the lone sure Hard song they would be 75 and 91.7.)
    const list = [
      song('e', { difficulty: 'easy' }),
      song('m', { difficulty: 'medium' }),
      song('h', { difficulty: 'hard' }),
      song('maybe', { difficulty: 'maybe', range: { low: 48, high: 64 } }),
    ];
    expect(placesOn(list, 'difficulty')).toEqual({ e: 16.7, m: 50, h: 83.3, maybe: 83.3 });
  });
});

describe('a range too narrow to be a melody (QWW-43 "Jump")', () => {
  const at = (span: number) => song('narrow', { range: { low: 60, high: 60 + span } });

  it('is judged on the span from the lowest to the highest note: 5 semitones', () => {
    expect(MIN_PLAUSIBLE_SPAN).toBe(5);
  });

  it.each([0, 1, 2, 3, 4])('a span of %i semitones has no place on Difficulty (0 is a one-note range)', (span) => {
    expect(placesOn([at(span)], 'difficulty')).toEqual({ narrow: null });
  });

  it('places a span of 5 semitones, a lone Easy song in the middle of its third', () => {
    expect(placesOn([at(5)], 'difficulty')).toEqual({ narrow: 16.7 });
    expect(placesOn([at(12)], 'difficulty')).toEqual({ narrow: 16.7 });
  });

  it('takes no part in placing the others: their places are the same with it and without it', () => {
    const real = () => [song('a', { strain: 0.5 }), song('b', { strain: 2 })];
    // Two Easy songs: 8.3 and 25. Had the narrow one (also Easy) counted, three would be 5.6, 16.7 and 27.8.
    expect(placesOn(real(), 'difficulty')).toEqual({ a: 8.3, b: 25 });
    const [a, b] = real();
    expect(placesOn([a!, song('narrow', { strain: 1, range: { low: 60, high: 63 } }), b!], 'difficulty')).toEqual({ a: 8.3, b: 25, narrow: null });
  });

  it('is placed on every other gear as any song is', () => {
    const list = [song('low', { popularity: 0.2 }), song('narrow', { popularity: 0.5, range: { low: 60, high: 62 } }), song('high', { popularity: 0.9 })];
    expect(placesOn(list, 'popularity')).toEqual({ low: 0, narrow: 50, high: 100 });
  });
});

describe('what comes back with each song', () => {
  const list = [song('pre', { year: 1969 }), song('s90', { year: 1995 }), song('none', { year: null })];

  it('is the very match it was given, the era of its release year, and a place on every gear', () => {
    const { songs } = rank(list);
    // Nothing is on, so the order is the order given.
    expect(songs).toHaveLength(3);
    songs.forEach((s, i) => expect(s.match).toBe(list[i]));
    expect(songs.map((s) => s.era)).toEqual(['pre', 's90', null]);
    for (const s of songs) expect(Object.keys(s.gears).sort()).toEqual([...GEAR_IDS].sort());
  });

  it('puts the places before the request: they are the same whichever gears are on and whichever eras are picked', () => {
    const everything = (spec?: Spec) => Object.fromEntries(rank(list, spec).songs.map((s) => [s.match.track.id, s.gears]));
    const base = everything();
    expect(everything({ on: ['popularity'], at: { popularity: 0 } })).toEqual(base);
    expect(everything({ on: [...GEAR_IDS], at: { tempo: 10 } })).toEqual(base);
    // An Era that keeps only one song leaves that song's places as they were among all three.
    const onlyNineties = rank(list, { eras: ['s90'] }).songs;
    expect(ids(onlyNineties)).toEqual(['s90']);
    expect(onlyNineties[0]!.gears).toEqual(base.s90);
  });
});

describe('places and the lane colours', () => {
  // laneColor cuts at the exact thirds (100 / 3 and 200 / 3), the thirds the engine places Easy, Medium and Hard songs in, so
  // a row's lane is the colour of its label however long the list is. (At the spec's 34 and 67 the first songs of a long
  // Medium or Hard band, placed at 33.4 to 33.9 and 66.7 to 66.9, were drawn a tier too low.)
  it.each([60, 200, 500])('draws every song in the colour of its label, the first and the last of each band included, with %i songs a band', (n) => {
    const strains = Array.from({ length: n }, (_, i) => (i * 3) / (n - 1));
    const labels = ['easy', 'medium', 'hard'] as const;
    const list = labels.flatMap((difficulty) => strains.map((strain, i) => song(`${difficulty}-${i}`, { difficulty, strain })));
    const places = placesOn(list, 'difficulty');
    const colour: Record<(typeof labels)[number], string> = { easy: EASY, medium: MID, hard: HARD };
    for (const label of labels) {
      const wrong = strains.map((_, i) => `${label}-${i}`).filter((id) => laneColor(places[id]!) !== colour[label]);
      expect(wrong, `${label} songs whose lane colour is another tier's`).toEqual([]);
    }
    // The songs nearest the cuts are the ones that used to go wrong: the lowest of Medium and Hard, the highest of Easy and Medium.
    expect(places['medium-0']).toBeGreaterThanOrEqual(100 / 3);
    expect(places['hard-0']).toBeGreaterThanOrEqual(200 / 3);
    expect(places[`easy-${n - 1}`]).toBeLessThan(100 / 3);
    expect(places[`medium-${n - 1}`]).toBeLessThan(200 / 3);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Ranking

describe('the defaults, as a singer first sees them (QWW-47 option A)', () => {
  const defaults = toRequest(initialTuner(), singer);
  const signedOut: SetlistInput = { ...defaults, loggedIn: false };
  const signedIn: SetlistInput = { ...defaults, loggedIn: true };

  it('count Difficulty at 0 and Popularity at 100, for everyone: History, Tempo and Era start off', () => {
    expect(defaults.gears).toMatchObject({ difficulty: DEFAULTS.difficulty, popularity: DEFAULTS.popularity });
    expect(defaults.off).toEqual(['history', 'tempo', 'era']);
    expect(rankSetlist([song('a')], signedOut).applied).toEqual(['difficulty', 'popularity']);
    expect(rankSetlist([song('a')], signedIn).applied).toEqual(['difficulty', 'popularity']);
  });

  it('put the popular songs first, and the easier of two popular songs ahead of the harder', () => {
    const a = song('a', { difficulty: 'easy', strain: 1, popularity: 0.3 });
    const b = song('b', { difficulty: 'hard', strain: 1, popularity: 0.95 });
    const c = song('c', { difficulty: 'easy', strain: 2, popularity: 0.9 });
    const d = song('d', { difficulty: 'medium', strain: 1.5, popularity: 0.6 });
    const e = song('e', { difficulty: 'easy', strain: 0.5, popularity: 0.1 });
    const f = song('f', { difficulty: 'hard', strain: 2, popularity: 0.5 });
    const list = [a, b, c, d, e, f];
    // Popularity, by rank of 6 (0.1 < 0.3 < 0.5 < 0.6 < 0.9 < 0.95): e 0, a 20, f 40, d 60, c 80, b 100.
    expect(placesOn(list, 'popularity')).toEqual({ e: 0, a: 20, f: 40, d: 60, c: 80, b: 100 });
    // Difficulty: the Easy songs by strain, e 0.5, a 1, c 2, of n = 3: 5.6, 16.7, 27.8. d is the lone Medium: 50.
    // The Hard songs, b 1 then f 2, of n = 2: 75 and 91.7.
    expect(placesOn(list, 'difficulty')).toEqual({ e: 5.6, a: 16.7, c: 27.8, d: 50, b: 75, f: 91.7 });
    // distance = |difficulty - 0| + 2 x |popularity - 100|
    //   c 27.8 + 2 x 20 = 67.8    b 75 + 2 x 0 = 75    d 50 + 2 x 40 = 130
    //   a 16.7 + 2 x 80 = 176.7   e 5.6 + 2 x 100 = 205.6   f 91.7 + 2 x 60 = 211.7
    // The two most popular songs lead, and the easier of them, c, is first. f is more popular than a and e but Hard: last.
    expect(ids(rankSetlist(list, signedOut).songs)).toEqual(['c', 'b', 'd', 'a', 'e', 'f']);
    // Signed in changes nothing: History is off by default for everyone.
    expect(ids(rankSetlist(list, signedIn).songs)).toEqual(['c', 'b', 'd', 'a', 'e', 'f']);
  });
});

describe('weights', () => {
  it('Popularity weighs double and every other gear once', () => {
    expect(GEAR_WEIGHT).toEqual({ difficulty: 1, history: 1, popularity: 2, tempo: 1 });
  });

  it('a gap on Popularity costs twice what the same gap on Difficulty does', () => {
    // Difficulty target 0, Popularity target 100. Three songs of three labels, so Difficulty puts them at 83.3, 16.7 and 50,
    // and their popularity ranks put them at 100, 50 and 0.
    const x = song('x', { difficulty: 'hard', popularity: 0.9 }); // 83.3 and 100: 83.3 + 2 x 0 = 83.3
    const y = song('y', { difficulty: 'easy', popularity: 0.5 }); // 16.7 and 50: 16.7 + 2 x 50 = 116.7
    const z = song('z', { difficulty: 'medium', popularity: 0.1 }); // 50 and 0: 50 + 2 x 100 = 250
    const spec: Spec = { on: ['difficulty', 'popularity'], at: { difficulty: 0, popularity: 100 } };
    expect(placesOn([y, z, x], 'difficulty')).toEqual({ x: 83.3, y: 16.7, z: 50 });
    expect(placesOn([y, z, x], 'popularity')).toEqual({ x: 100, y: 50, z: 0 });
    // With each gap counted once, y (16.7 + 50 = 66.7) would lead x (83.3). Doubled, x leads y.
    expect(order([y, z, x], spec)).toEqual(['x', 'y', 'z']);
  });
});

describe('Era (spec §4a, §5)', () => {
  const eighties = song('1985', { year: 1985 });
  const nineties = song('1995', { year: 1995 });
  const noughties = song('2005', { year: 2005 });
  const tens = song('2015', { year: 2015 });
  const undated = song('undated', { year: null });
  // No gear is on, so what comes back is the songs that pass the Era rule, in the order given.
  const list = [eighties, nineties, noughties, tens, undated];

  it('on, keeps only the songs of the picked eras', () => {
    expect(order(list, { eras: ['s90', 's10'] })).toEqual(['1995', '2015']);
  });

  it('on, drops a song with no year, since it is in no era, even with every era picked', () => {
    expect(order(list, { eras: [...ERA_IDS] })).toEqual(['1985', '1995', '2005', '2015']);
  });

  it('off, keeps every song, a song with no year too, whatever eras the gear holds', () => {
    expect(ids(rankSetlist(list, { ...input(), eras: ['s20'] }).songs)).toEqual(['1985', '1995', '2005', '2015', 'undated']);
    expect(order(list)).toEqual(['1985', '1995', '2005', '2015', 'undated']);
  });

  it('on with nothing picked gives no songs and says "no-era-picked", which is not the same as Era off', () => {
    const none = rank(list, { eras: [] });
    expect(none.songs).toEqual([]);
    expect(none.empty).toBe('no-era-picked');
    const off = rank(list);
    expect(off.songs).toHaveLength(list.length);
    expect(off).not.toHaveProperty('empty');
  });

  it('on with eras that no song is in gives no songs and says "no-songs-in-era"', () => {
    const result = rank(list, { eras: ['s20', 's70'] });
    expect(result.songs).toEqual([]);
    expect(result.empty).toBe('no-songs-in-era');
  });

  it('with no songs at all says "no-songs-in-range", whether Era is off or on with picks', () => {
    expect(rank([]).empty).toBe('no-songs-in-range');
    expect(rank([], { eras: ['s90'] }).empty).toBe('no-songs-in-range');
    expect(rank([]).songs).toEqual([]);
  });

  it('"no-era-picked" wins when Era is on with nothing picked, even if there are no songs at all', () => {
    expect(rank([], { eras: [] }).empty).toBe('no-era-picked');
  });

  it('has no reason when there are songs, however few the picked eras leave', () => {
    const result = rank(list, { eras: ['s80'] });
    expect(ids(result.songs)).toEqual(['1985']);
    expect(result).not.toHaveProperty('empty');
  });

  it('filters before it ranks: a song of a dropped era never appears, however near the target', () => {
    // Popularity 100 counts. hit80 is the most popular song but its era is not picked.
    const hit80 = song('hit80', { year: 1985, popularity: 1 });
    const mid90 = song('mid90', { year: 1995, popularity: 0.5 });
    const low90 = song('low90', { year: 1995, popularity: 0.1 });
    expect(order([low90, hit80, mid90], { on: ['popularity'], at: { popularity: 100 }, eras: ['s90'] })).toEqual(['mid90', 'low90']);
  });

  it('leaves the songs of a dropped era in the places of the rest: they are ranked among every song that fits, not only the picked eras', () => {
    const hit80 = song('hit80', { year: 1985, popularity: 1 });
    const mid90 = song('mid90', { year: 1995, popularity: 0.5 });
    const low90 = song('low90', { year: 1995, popularity: 0.1 });
    // Among the three: low90 0, mid90 50, hit80 100. Among the two 90s alone they would be 0 and 100.
    const kept = rank([low90, hit80, mid90], { eras: ['s90'] }).songs;
    expect(kept.map((s) => [s.match.track.id, s.gears.popularity])).toEqual([
      ['low90', 0],
      ['mid90', 50],
    ]);
  });
});

describe('a gear that is off adds nothing (spec §5)', () => {
  // Per gear: one song on the target and one far from it, given far first. With only that gear on the near song leads;
  // with it off the songs stay in the order given, whatever they say about the gear.
  const FIXTURES: Record<GearId, { at: Partial<Record<GearId, number>>; near: SongOptions; far: SongOptions }> = {
    difficulty: { at: { difficulty: 0 }, near: { difficulty: 'easy' }, far: { difficulty: 'hard' } }, // 16.7 against 83.3
    history: { at: { history: 100 }, near: { history: 0.9 }, far: { history: 0.1 } }, // 100 against 0
    popularity: { at: { popularity: 100 }, near: { popularity: 1 }, far: { popularity: 0.2 } }, // 100 against 0
    tempo: { at: { tempo: 100 }, near: { tempo: 180 }, far: { tempo: 70 } }, // 100 against 0
  };

  it.each(GEAR_IDS)('%s: on, the nearer song leads; off, the order given stays', (gear) => {
    const { at, near, far } = FIXTURES[gear];
    const nearSong = song('near', near);
    const farSong = song('far', far);
    expect(order([farSong, nearSong], { on: [gear], at })).toEqual(['near', 'far']);
    expect(order([farSong, nearSong], { at })).toEqual(['far', 'near']);
  });

  it('does not read a song\'s data on an off gear: the order is the same with the data, other data or none', () => {
    // Difficulty (target 0) is the only gear on. r is Hard, q Medium and p Easy, one of each, so they are at 83.3, 50 and
    // 16.7: distances 83.3, 50 and 16.7.
    type Data = { popularity: number | null; tempo: number | null };
    const make = (r: Data, q: Data, p: Data) => [
      song('r', { difficulty: 'hard', ...r }),
      song('q', { difficulty: 'medium', ...q }),
      song('p', { difficulty: 'easy', ...p }),
    ];
    const first = make({ popularity: 0.5, tempo: 125 }, { popularity: 0.9, tempo: 180 }, { popularity: 0.1, tempo: 70 });
    const other = make({ popularity: 1, tempo: 70 }, { popularity: 0.1, tempo: 125 }, { popularity: 0.9, tempo: 180 });
    const none = make({ popularity: null, tempo: null }, { popularity: null, tempo: null }, { popularity: null, tempo: null });

    const difficultyOnly: Spec = { on: ['difficulty'], at: { difficulty: 0, popularity: 100, tempo: 50 } };
    expect(order(first, difficultyOnly)).toEqual(['p', 'q', 'r']);
    expect(order(other, difficultyOnly)).toEqual(['p', 'q', 'r']);
    expect(order(none, difficultyOnly)).toEqual(['p', 'q', 'r']);

    // The control: switch Popularity on (x2, target 100) and the same songs do read it, and the sets disagree.
    //   first: popularity ranks put p 0, r 50, q 100:  r 83.3 + 2 x 50 = 183.3, q 50 + 2 x 0 = 50, p 16.7 + 2 x 100 = 216.7  =>  q, r, p
    //   other: they put q 0, p 50, r 100:              r 83.3 + 2 x 0 = 83.3, q 50 + 2 x 100 = 250, p 16.7 + 2 x 50 = 116.7  =>  r, p, q
    //   none:  no place at all, so each is 2 x 150 further, and Difficulty alone orders them                                  =>  p, q, r
    const withPopularity: Spec = { on: ['difficulty', 'popularity'], at: { difficulty: 0, popularity: 100 } };
    expect(order(first, withPopularity)).toEqual(['q', 'r', 'p']);
    expect(order(other, withPopularity)).toEqual(['r', 'p', 'q']);
    expect(order(none, withPopularity)).toEqual(['p', 'q', 'r']);
  });
});

describe('History counts only when the singer\'s library was read', () => {
  const played = song('played', { history: 0.9 });
  const rarely = song('rarely', { history: 0.1 });
  // History at 100 (On repeat) and History is not off: the engine, not the request, decides whether it counts.
  const spec = (loggedIn: boolean): Spec => ({ on: ['history'], at: { history: 100 }, loggedIn });

  it('counts for a singer whose library was read: the song nearer the target leads, and applied says so', () => {
    const result = rank([rarely, played], spec(true));
    expect(ids(result.songs)).toEqual(['played', 'rarely']);
    expect(result.applied).toEqual(['history']);
    expect(result.songs.map((s) => s.gears.history)).toEqual([100, 0]);
  });

  it('does not count for anyone else, though it is not off: the order given stays, and applied leaves it out', () => {
    const result = rank([rarely, played], spec(false));
    expect(ids(result.songs)).toEqual(['rarely', 'played']);
    expect(result.applied).toEqual([]);
    expect(result.songs.map((s) => s.gears.history)).toEqual([null, null]);
  });

  it('leaves the other gears to count without it', () => {
    const result = rank([song('far', { popularity: 0.1 }), song('near', { popularity: 0.9 })], { on: ['history', 'popularity'], loggedIn: false });
    expect(result.applied).toEqual(['popularity']);
    expect(ids(result.songs)).toEqual(['near', 'far']);
  });
});

describe('with every gear off and Era off (spec test 18)', () => {
  const list = [
    song('a', { difficulty: 'hard', strain: 3, popularity: 0.1, tempo: 70, year: 2015 }),
    song('b', { difficulty: 'easy', strain: 0, popularity: 1, tempo: 180, year: 1965 }),
    song('c', { difficulty: 'medium', strain: 1.5, popularity: 0.5, tempo: 125, year: null }),
    song('d', { difficulty: 'easy', strain: 3, popularity: null, tempo: null, year: 1985 }),
  ];

  it('keeps the order the songs came in, whatever they say about the gears and the eras', () => {
    expect(order(list)).toEqual(['a', 'b', 'c', 'd']);
    expect(rank(list).applied).toEqual([]);
  });

  it('keeps a reversed order too', () => {
    expect(order([...list].reverse())).toEqual(['d', 'c', 'b', 'a']);
  });

  it('is what the tuner asks for after every part is reset', () => {
    const reset = TUNER_PARTS.reduce((s, gear) => tunerReducer(s, { type: 'reset', gear }), initialTuner());
    const asked = toRequest(reset, singer);
    expect([...asked.off].sort()).toEqual([...TUNER_PARTS].sort());
    const result = rankSetlist(list, { ...asked, loggedIn: true });
    expect(ids(result.songs)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.applied).toEqual([]);
  });

  it('still puts Maybe songs last', () => {
    const maybe = song('maybe', { difficulty: 'maybe' });
    expect(order([maybe, ...list.slice(0, 2)])).toEqual(['a', 'b', 'maybe']);
  });
});

describe('a song with no place on a gear that counts', () => {
  // UNKNOWN_DISTANCE is farther than the 100 a placed song can be from a target, so such songs always come after the
  // placed ones, in the order given among themselves.
  const UNKNOWN: Record<'history' | 'popularity' | 'tempo', { at: Partial<Record<GearId, number>>; none: SongOptions; worst: SongOptions; best: SongOptions }> = {
    // The worst placed song is the lowest, 0, which is 100 from a target of 100 (200 doubled); an unknown one is 150 away (300).
    history: { at: { history: 100 }, none: { history: null }, worst: { history: 0.1 }, best: { history: 0.9 } },
    popularity: { at: { popularity: 100 }, none: { popularity: null }, worst: { popularity: 0.1 }, best: { popularity: 0.9 } },
    tempo: { at: { tempo: 100 }, none: { tempo: null }, worst: { tempo: 70 }, best: { tempo: 180 } },
  };
  const gears = ['history', 'popularity', 'tempo'] as const;

  it('counts as farther than any placed song', () => {
    expect(UNKNOWN_DISTANCE).toBeGreaterThan(100);
  });

  it.each(gears)('%s: comes after every placed song, even the worst, and keeps its place among its own', (gear) => {
    const { at, none, worst, best } = UNKNOWN[gear];
    const list = [song('none1', none), song('worst', worst), song('none2', none), song('best', best)];
    expect(order(list, { on: [gear], at })).toEqual(['best', 'worst', 'none1', 'none2']);
  });

  it.each(gears)('%s: is not pushed back while the gear is off', (gear) => {
    const { at, none, worst, best } = UNKNOWN[gear];
    const list = [song('none1', none), song('worst', worst), song('none2', none), song('best', best)];
    expect(order(list, { at })).toEqual(['none1', 'worst', 'none2', 'best']);
  });
});

describe('Maybe songs (an estimated range)', () => {
  it('come after the sure songs even when they are nearer', () => {
    // Difficulty target 0, Popularity target 100: distance = Difficulty + 2 x |Popularity - 100|. Each group is placed alone.
    const maybe = song('maybe', { difficulty: 'maybe', popularity: 1 }); // lone Maybe: 16.7 (its range is Easy) and 50: 16.7 + 2 x 50 = 116.7
    const sureA = song('sureA', { difficulty: 'easy', strain: 3, popularity: 0.9 }); // 16.7 and 100: 16.7 + 0 = 16.7
    const sureB = song('sureB', { difficulty: 'medium', strain: 0, popularity: 0.5 }); // 50 and 0: 50 + 2 x 100 = 250
    const spec: Spec = { on: ['difficulty', 'popularity'], at: { difficulty: 0, popularity: 100 } };
    const result = rank([maybe, sureB, sureA], spec);
    expect(result.songs.map((s) => [s.match.track.id, s.gears.difficulty, s.gears.popularity])).toEqual([
      ['sureA', 16.7, 100],
      ['sureB', 50, 0],
      ['maybe', 16.7, 50],
    ]);
  });

  it('are ranked among themselves like any other songs', () => {
    const sure = song('sure', { popularity: 0.1 });
    const near = song('near', { difficulty: 'maybe', popularity: 0.9 });
    const nearer = song('nearer', { difficulty: 'maybe', popularity: 1 });
    // The Maybe group alone: near 0, nearer 100. The lone sure song is 50.
    expect(order([near, nearer, sure], { on: ['popularity'], at: { popularity: 100 } })).toEqual(['sure', 'nearer', 'near']);
  });

  it('come after the sure songs with every gear off, too', () => {
    const maybe = song('maybe', { difficulty: 'maybe' });
    expect(order([maybe, song('sureA'), song('sureB')])).toEqual(['sureA', 'sureB', 'maybe']);
  });
});

describe('a song whose range is too narrow never wins on Difficulty', () => {
  const real = () => [
    song('easy', { difficulty: 'easy', strain: 1 }), // lone Easy once the narrow song is out of it: 16.7
    song('mid', { difficulty: 'medium', strain: 1.5 }), // 50
    song('hard', { difficulty: 'hard', strain: 3 }), // 83.3
  ];
  const narrow = (span: number) => song('one', { difficulty: 'easy', strain: 0, range: { low: 60, high: 60 + span } });

  it.each([0, 1, 2, 3, 4])('with Difficulty at 0, a song of span %i that its label would put first comes last', (span) => {
    // The easiest song there is by its label (Easy, strain 0), and it still comes last: it has no place, so it is 150 away.
    expect(order([narrow(span), ...real()], { on: ['difficulty'], at: { difficulty: 0 } })).toEqual(['easy', 'mid', 'hard', 'one']);
  });

  it('comes last at the other end of the track too, and at the middle', () => {
    expect(order([narrow(2), ...real()], { on: ['difficulty'], at: { difficulty: 100 } })).toEqual(['hard', 'mid', 'easy', 'one']);
    const middle = order([narrow(2), ...real()], { on: ['difficulty'], at: { difficulty: 50 } });
    expect(middle[0]).toBe('mid');
    expect(middle.at(-1)).toBe('one');
  });

  it('is the same song that leads once its range has 5 semitones: the control', () => {
    // Placed (Easy, strain 0 against the other Easy song's strain 1) it is 8.3 and easy is 25: it leads at target 0.
    expect(order([narrow(5), ...real()], { on: ['difficulty'], at: { difficulty: 0 } })).toEqual(['one', 'easy', 'mid', 'hard']);
  });

  it('counts for nothing when Difficulty is off: it keeps its place in the order given', () => {
    expect(order([narrow(2), ...real()])).toEqual(['one', 'easy', 'mid', 'hard']);
  });
});

describe('applied: the parts that counted, in the order of the sheet', () => {
  const all: GearId[] = [...GEAR_IDS];
  it.each<[string, Spec, TunerPart[]]>([
    ['the defaults', { on: ['difficulty', 'popularity'] }, ['difficulty', 'popularity']],
    ['every gear and Era, with the library read', { on: all, eras: ['s90'] }, ['difficulty', 'history', 'popularity', 'tempo', 'era']],
    ['the same without it: History cannot count', { on: all, eras: ['s90'], loggedIn: false }, ['difficulty', 'popularity', 'tempo', 'era']],
    ['nothing on', {}, []],
    ['only Era', { eras: ['s90'] }, ['era']],
    ['only Tempo', { on: ['tempo'] }, ['tempo']],
    ['only History, without the library', { on: ['history'], loggedIn: false }, []],
    ['Era on with nothing picked, which still counts as on', { eras: [] }, ['era']],
  ])('%s', (_what, spec, expected) => {
    expect(rank([song('a', { year: 1995 })], spec).applied).toEqual(expected);
  });

  it('does not depend on the order `off` is listed in', () => {
    const forward = input({ on: ['popularity'] });
    const backward = { ...forward, off: [...forward.off].reverse() };
    expect(rankSetlist([song('a')], backward).applied).toEqual(['popularity']);
    expect(rankSetlist([song('a')], forward).applied).toEqual(['popularity']);
  });

  it('is there when no song is, since it says what counted', () => {
    expect(rank([], { on: ['difficulty', 'popularity'] }).applied).toEqual(['difficulty', 'popularity']);
  });
});

describe('ordering and bookkeeping', () => {
  it('keeps the order given for songs that are equally near, and puts a nearer song ahead of them', () => {
    // Popularity target 50 over three songs, places 0, 50 and 100: the middle one is on target, and the two ends are each
    // 2 x 50 = 100 away, a tie. Whichever end came first stays first.
    const lo = song('lo', { popularity: 0.1 });
    const mid = song('mid', { popularity: 0.5 });
    const hi = song('hi', { popularity: 0.9 });
    const spec: Spec = { on: ['popularity'], at: { popularity: 50 } };
    expect(order([hi, mid, lo], spec)).toEqual(['mid', 'hi', 'lo']);
    expect(order([lo, mid, hi], spec)).toEqual(['mid', 'lo', 'hi']);
  });

  it('keeps the order given for songs with no place, as they are all equally far', () => {
    const list = [song('u1', { popularity: null }), song('known', { popularity: 0.4 }), song('u2', { popularity: null }), song('u3', { popularity: null })];
    expect(order(list, { on: ['popularity'] })).toEqual(['known', 'u1', 'u2', 'u3']);
  });

  it('does not change what it is given, and hands back the very songs, not copies', () => {
    const low = song('low', { popularity: 0.2 });
    const high = song('high', { popularity: 1 });
    const candidates = Object.freeze([low, high]) as Match[];
    const given = input({ on: ['popularity'] });
    for (const part of [given.off, given.eras, given.gears, given.range]) Object.freeze(part);
    const before = JSON.stringify([candidates, given]);
    const result = rankSetlist(candidates, Object.freeze(given));
    expect(JSON.stringify([candidates, given])).toBe(before);
    expect(candidates[0]).toBe(low);
    expect(result.songs[0]!.match).toBe(high);
    expect(result.songs[1]!.match).toBe(low);
    expect(result.songs).not.toBe(candidates);
  });

  it('gives no songs for no songs', () => {
    const result = rank([], { on: ['popularity'] });
    expect(result.songs).toEqual([]);
    expect(result.empty).toBe('no-songs-in-range');
  });
});

describe('createLocalEngine', () => {
  const a = song('a', { popularity: 0.2 });
  const b = song('b', { popularity: 1 });
  const c = song('c', { popularity: 0.6 });
  const candidates = [a, b, c];
  const byPopularity = request({ on: ['popularity'], at: { popularity: 100 } });
  const entry: DataSourceLogEntry = {
    trackId: 'b',
    title: 'Song b',
    artist: 'Artist b',
    outcome: 'note-file',
    reason: 'Matched a note file by title and artist.',
    at: '2026-10-14T00:00:00.000Z',
  };

  it('answers a request with a whole response: the ranked songs, how many, no next page, what counted', async () => {
    const answer = createLocalEngine(candidates, { loggedIn: true }).rank(byPopularity);
    expect(answer).toBeInstanceOf(Promise);
    const response = await answer;
    expect(response).toEqual({
      songs: rankSetlist(candidates, { ...byPopularity, loggedIn: true }).songs,
      total: 3,
      nextOffset: null,
      sources: {},
      applied: ['popularity'],
    });
    expect(ids(response.songs)).toEqual(['b', 'c', 'a']);
    expect(response.songs[0]!.match).toBe(b);
    // Nothing optional is there unless there is something to say.
    expect(Object.keys(response).sort()).toEqual(['applied', 'nextOffset', 'songs', 'sources', 'total']);
  });

  it('hands on the data-source lines it was given, and has none by default', async () => {
    const withSources = await createLocalEngine(candidates, { loggedIn: true, sources: { b: entry } }).rank(byPopularity);
    expect(withSources.sources).toEqual({ b: entry });
    expect((await createLocalEngine(candidates, { loggedIn: true }).rank(byPopularity)).sources).toEqual({});
  });

  it('says so only when the library could not be read', async () => {
    const down = await createLocalEngine(candidates, { loggedIn: false, libraryUnavailable: true }).rank(byPopularity);
    expect(down.libraryUnavailable).toBe(true);
    const fine = await createLocalEngine(candidates, { loggedIn: true, libraryUnavailable: false }).rank(byPopularity);
    expect(fine).not.toHaveProperty('libraryUnavailable');
  });

  it('carries the reason there are no songs, with the total', async () => {
    const none = await createLocalEngine(candidates, { loggedIn: true }).rank(request({ eras: [] }));
    expect(none).toMatchObject({ songs: [], total: 0, nextOffset: null, empty: 'no-era-picked' });
    const empty = await createLocalEngine([], { loggedIn: false }).rank(byPopularity);
    expect(empty).toMatchObject({ songs: [], total: 0, nextOffset: null, empty: 'no-songs-in-range' });
  });

  it('does not page: it answers every song whatever offset and limit were asked', async () => {
    const response = await createLocalEngine(candidates, { loggedIn: true }).rank({ ...byPopularity, offset: 1, limit: 1 });
    expect(ids(response.songs)).toEqual(['b', 'c', 'a']);
    expect(response.total).toBe(3);
    expect(response.nextOffset).toBeNull();
  });

  it('lets the engine, not the request, decide whether History counts', async () => {
    const played = song('played', { history: 0.9 });
    const rarely = song('rarely', { history: 0.1 });
    const wantsHistory = request({ on: ['history'], at: { history: 100 } });
    const read = await createLocalEngine([rarely, played], { loggedIn: true }).rank(wantsHistory);
    expect(ids(read.songs)).toEqual(['played', 'rarely']);
    expect(read.applied).toEqual(['history']);
    const notRead = await createLocalEngine([rarely, played], { loggedIn: false }).rank(wantsHistory);
    expect(ids(notRead.songs)).toEqual(['rarely', 'played']);
    expect(notRead.applied).toEqual([]);
  });

  it('answers each request on its own, and asking again gives the same answer', async () => {
    const engine = createLocalEngine(candidates, { loggedIn: true });
    const first = await engine.rank(byPopularity);
    const nothingOn = await engine.rank(request());
    expect(ids(first.songs)).toEqual(['b', 'c', 'a']);
    expect(ids(nothingOn.songs)).toEqual(['a', 'b', 'c']);
    expect(first).not.toBe(nothingOn);
    expect(ids((await engine.rank(byPopularity)).songs)).toEqual(['b', 'c', 'a']);
    // The songs it holds are not reordered by being asked.
    expect(candidates.map((m) => m.track.id)).toEqual(['a', 'b', 'c']);
  });
});
