import { describe, expect, it } from 'vitest';
import type { Decade, Label, Match, Mood, ResultsView, SliderId, VocalRange } from '../../src/lib/contracts';
import {
  DECADES,
  DEFAULT_VIEW,
  SLIDERS,
  availableFacets,
  availableSliders,
  chipCounts,
  decadeOf,
  filterMatches,
  fitViewTo,
  hasFilters,
  orderMatches,
  pickDecade,
  pickMood,
  savedDividerIndex,
  difficultyBand,
  sliderPlaces,
  sliderValue,
  sortedByLine,
  toggleDuets,
  viewMatches,
} from '../../src/lib/songs/browse';

const user: VocalRange = { low: 45, high: 69, source: 'test' };

interface Opts {
  id: string;
  difficulty?: Label;
  year?: number;
  known?: boolean;
  familiarity?: number;
  playRank?: number;
  comfort?: number;
  popularity?: number;
  popularityKnown?: boolean;
  tempo?: number;
  low?: number;
  high?: number;
  fastLyrics?: boolean;
  duet?: boolean;
  moods?: Mood[];
  strain?: number;
}

function match(o: Opts): Match {
  const m: Match = {
    track: { id: o.id, title: o.id, artist: 'A', artistId: 'a', spotifyUrl: '', playRank: o.playRank ?? 0, known: o.known ?? true },
    range: {
      low: o.low ?? 50,
      high: o.high ?? 62,
      tessitura: 56,
      source: 'note-file',
      confidence: o.difficulty === 'maybe' ? 'low' : 'high',
      fastLyrics: o.fastLyrics ?? false,
      ...(o.duet ? { duet: true } : {}),
    },
    difficulty: o.difficulty ?? 'easy',
    octave: 'none',
    parts: {
      comfort: o.comfort ?? 0.5,
      familiarity: o.familiarity ?? 0.5,
      popularity: o.popularity ?? 0.4,
      popularityKnown: o.popularityKnown ?? false,
      penalty: 0,
    },
  };
  if (o.year !== undefined) m.year = o.year;
  if (o.tempo !== undefined) m.tempo = o.tempo;
  if (o.strain !== undefined) m.strain = o.strain;
  if (o.moods) m.moods = o.moods;
  return m;
}

const ids = (list: Match[]) => list.map((m) => m.track.id);

describe('decadeOf', () => {
  it('buckets years, with everything before 1970 in the first bucket', () => {
    expect(decadeOf(1958)).toBe('60s');
    expect(decadeOf(1969)).toBe('60s');
    expect(decadeOf(1970)).toBe('70s');
    expect(decadeOf(1999)).toBe('90s');
    expect(decadeOf(2000)).toBe('00s');
    expect(decadeOf(2019)).toBe('10s');
    expect(decadeOf(2026)).toBe('20s');
    expect(decadeOf(undefined)).toBeNull();
    expect(decadeOf(Number.NaN)).toBeNull();
  });
});

describe('sliders', () => {
  // Difficulty: label band, then strain inside it. Easy: top2 0.05, saved 0.1, top1 0.2; Hard: top3 1.2.
  const list = [
    match({ id: 'top1', familiarity: 0.2, comfort: 0.6, popularity: 0.9, strain: 0.2 }),
    match({ id: 'top2', familiarity: 0.9, comfort: 0.95, popularity: 0.2, strain: 0.05 }),
    match({ id: 'top3', familiarity: 0.5, comfort: 0.3, popularity: 0.6, difficulty: 'hard', strain: 1.2 }),
    match({ id: 'saved', known: false, familiarity: 0.15, comfort: 1, popularity: 1, strain: 0.1 }),
    match({ id: 'maybe', difficulty: 'maybe', familiarity: 1, comfort: 1, popularity: 1 }),
  ];
  const order = (view: Partial<ResultsView>, mode: 'library' | 'catalogue' = 'library') =>
    ids(orderMatches(list, { ...DEFAULT_VIEW, ...view }, user, mode));

  it('untouched sliders keep the server order', () => {
    expect(order({})).toEqual(['top1', 'top2', 'top3', 'saved', 'maybe']);
  });

  it('the difficulty slider runs from Easy songs to Hard ones, by the same label the song shows (QWW-33)', () => {
    expect(order({ difficulty: 0 })).toEqual(['top2', 'saved', 'top1', 'top3', 'maybe']);
    expect(order({ difficulty: 1 })).toEqual(['top3', 'top1', 'saved', 'top2', 'maybe']);
    expect(sliderValue(list[2]!, 'difficulty', user)).toBeGreaterThanOrEqual(2);
    expect(sliderValue(list[1]!, 'difficulty', user)).toBeLessThan(1);
  });

  it('a song with no strain (an older cached match) is banded from its range and label', () => {
    // 50 to 62 sung as three lumps (70% at 56, 15% at each end) is Easy in A2 to A4: nothing in an edge eighth.
    expect(difficultyBand(match({ id: 'x' }), user)).toEqual({ band: 0, strain: expect.any(Number) });
    expect(difficultyBand(match({ id: 'y', difficulty: 'hard' }), user).band).toBe(2);
  });

  it('the on-repeat slider orders by how much you play a song, and replaces the known-first rule', () => {
    expect(order({ familiarity: 1 })).toEqual(['top2', 'top3', 'top1', 'saved', 'maybe']);
    // Rediscover: the saved song you have not played in a while comes first.
    expect(order({ familiarity: 0 })).toEqual(['saved', 'top1', 'top3', 'top2', 'maybe']);
  });

  it('the popularity slider orders by known popularity, and songs we know nothing about go after', () => {
    const songs = [
      match({ id: 'unknown', popularity: 0.4 }),
      match({ id: 'p9', popularity: 0.9, popularityKnown: true }),
      match({ id: 'p2', popularity: 0.2, popularityKnown: true }),
      match({ id: 'p6', popularity: 0.6, popularityKnown: true }),
    ];
    const by = (popularity: number) => ids(orderMatches(songs, { ...DEFAULT_VIEW, popularity }, user, 'catalogue'));
    expect(by(1)).toEqual(['p9', 'p6', 'p2', 'unknown']);
    expect(by(0)).toEqual(['p2', 'p6', 'p9', 'unknown']);
    expect(sliderValue(songs[0]!, 'popularity', user)).toBeNull();
  });

  it('the tempo slider places songs by rank of beats per minute, and songs with no tempo go last (QWW-40)', () => {
    const songs = [
      match({ id: 'none' }),
      match({ id: 'fast', tempo: 172 }),
      match({ id: 'slow', tempo: 72 }),
      match({ id: 'mid', tempo: 110 }),
    ];
    const by = (tempo: number) => ids(orderMatches(songs, { ...DEFAULT_VIEW, tempo }, user, 'catalogue'));
    expect(by(1)).toEqual(['fast', 'mid', 'slow', 'none']);
    expect(by(0)).toEqual(['slow', 'mid', 'fast', 'none']);
    expect(sliderValue(songs[0]!, 'tempo', user)).toBeNull();
    expect(sliderValue(songs[1]!, 'tempo', user)).toBe(172);
    // Placed by rank, not by bpm: three songs at 118 to 121 still fill the track
    const bunched = [match({ id: 'a', tempo: 118 }), match({ id: 'b', tempo: 120 }), match({ id: 'c', tempo: 121 })];
    expect(sliderPlaces(bunched, 'tempo', user)).toEqual([0, 0.5, 1]);
  });

  it('several sliders together put the song closest to every target first', () => {
    // Places among the four songs shown first, difficulty then on repeat: top2 (1/18, 1), top1 (5/18, 1/3),
    // saved (3/18, 0), top3 (15/18, 2/3). Targets 0 and 1: top2 0.06, top1 0.94, saved 1.17, top3 1.17 (a tie: server order).
    expect(order({ difficulty: 0, familiarity: 1 })).toEqual(['top2', 'top1', 'top3', 'saved', 'maybe']);
  });

  it('keeps Maybe songs last and drops nothing, for any setting', () => {
    for (const difficulty of [null, 0, 0.5, 1]) {
      for (const popularity of [null, 0, 1]) {
        const out = order({ difficulty, popularity });
        expect(out).toHaveLength(list.length);
        expect(out[4]).toBe('maybe');
      }
    }
  });

  it('known songs come before saved-only ones only in the unsorted list and under the on-repeat slider (QWW-33)', () => {
    // Unsorted: the server's order, known first, with the divider.
    expect(order({}).indexOf('saved')).toBe(3);
    expect(savedDividerIndex(list, 'library')).toBe(3);
    // With only the difficulty slider set, the saved-only song sits where its difficulty puts it, and
    // there is no divider to explain a split.
    expect(order({ difficulty: 0 }).indexOf('saved')).toBe(1);
    expect(savedDividerIndex(list, 'library', { ...DEFAULT_VIEW, difficulty: 0 })).toBe(-1);
    expect(savedDividerIndex(list, 'library', { ...DEFAULT_VIEW, familiarity: 1 })).toBe(-1);
  });

  it('the middle of the difficulty track lists Medium songs first, and Easy and Hard fall away from it (QWW-33)', () => {
    const songs = [
      ...['e0', 'e1', 'e2', 'e3'].map((id, i) => match({ id, difficulty: 'easy', strain: i * 0.05 })),
      ...['m0', 'm1', 'm2'].map((id, i) => match({ id, difficulty: 'medium', strain: 0.4 + i * 0.1 })),
      ...['h0', 'h1'].map((id, i) => match({ id, difficulty: 'hard', strain: 1 + i * 0.3 })),
    ];
    const at = (difficulty: number) => ids(orderMatches(songs, { ...DEFAULT_VIEW, difficulty }, user, 'catalogue'));
    // Each label has a third of the track: a Medium song sits at 1/3, 1/2 or 2/3 whatever the share of Medium songs.
    const places = [0.5 / 4, 1.5 / 4, 2.5 / 4, 3.5 / 4, 1 + 0.5 / 3, 1 + 1.5 / 3, 1 + 2.5 / 3, 2 + 0.25, 2 + 0.75].map((x) => x / 3);
    sliderPlaces(songs, 'difficulty', user).forEach((p, i) => expect(p).toBeCloseTo(places[i]!));
    // In the middle every Medium song is within 1/6 of the thumb, the nearest Easy and Hard ones just as far.
    expect(at(0.5)[0]).toBe('m1');
    expect(at(0.5).slice(0, 5)).toEqual(expect.arrayContaining(['m0', 'm1', 'm2']));
    expect(at(0)[0]).toBe('e0');
    expect(at(1)[0]).toBe('h1');
    expect(at(0.9)[0]).toBe('h1');
  });

  it('says what the order is', () => {
    expect(sortedByLine(DEFAULT_VIEW, 'library')).toMatch(/^Top picks: songs you know/);
    expect(sortedByLine(DEFAULT_VIEW, 'catalogue')).toMatch(/^Top picks: the best fit/);
    expect(sortedByLine({ ...DEFAULT_VIEW, difficulty: 1, popularity: 0.1 }, 'library')).toBe('Sorted by: Locked in, Deep cuts');
    expect(sortedByLine({ ...DEFAULT_VIEW, difficulty: 0.5 }, 'library')).toBe('Sorted by: Medium');
    expect(sortedByLine({ ...DEFAULT_VIEW, tempo: 0.5 }, 'library')).toBe('Sorted by: Slow jams to Upbeat tracks, in between');
  });

  it('songs at the same distance from a target keep the server order', () => {
    // 'a' and 'c' sit at places 0 and 1 (below), 'b' at 0.5: a target of 0.5 is 0.5 from a and c.
    const songs = [
      match({ id: 'a', familiarity: 0.2 }),
      match({ id: 'b', familiarity: 0.5 }),
      match({ id: 'c', familiarity: 0.8 }),
    ];
    expect(ids(orderMatches([songs[2]!, songs[0]!, songs[1]!], { ...DEFAULT_VIEW, familiarity: 0.5 }, user, 'library'))).toEqual(['b', 'c', 'a']);
  });

  it('in catalogue mode no song is treated as saved-only', () => {
    expect(order({ difficulty: 0 }, 'catalogue')).toEqual(['top2', 'saved', 'top1', 'top3', 'maybe']);
    expect(savedDividerIndex(list, 'catalogue')).toBe(-1);
  });
});

describe('where songs sit on a slider (QWW-33)', () => {
  // The on-repeat slider's score is the song's familiarity, which keeps these lists easy to read.
  const fam = (id: string, familiarity: number, extra: Partial<Opts> = {}) => match({ id, familiarity, ...extra });
  const library = (list: Match[], view: Partial<ResultsView>) => ids(orderMatches(list, { ...DEFAULT_VIEW, ...view }, user, 'library'));

  // 101 songs whose scores all fall between 0.15 and 0.25: placed by score, 90% of the track is empty.
  const bunched = Array.from({ length: 101 }, (_, i) => fam(`s${i}`, 0.15 + (i / 100) ** 3 * 0.1));

  it('a song sits at its rank in the list, not at its score', () => {
    expect(sliderPlaces(bunched, 'familiarity', user)).toEqual(bunched.map((_, i) => i / 100));
  });

  it('each tenth of the track holds a tenth of the songs, and the ends are still the lowest and highest score', () => {
    const firsts = Array.from({ length: 11 }, (_, k) => library(bunched, { familiarity: k / 10 })[0]);
    expect(firsts).toEqual(Array.from({ length: 11 }, (_, k) => `s${k * 10}`));
  });

  it('songs with the same score are told apart by Spotify’s order, then by the server order', () => {
    // Saved-only songs all score 0.15. The lower the play rank, the more the song was played, and the
    // further right it sits.
    const saved = ['a', 'b', 'c', 'd'].map((id, rank) => fam(id, 0.15, { playRank: rank }));
    expect(sliderPlaces(saved, 'familiarity', user)).toEqual([1, 2 / 3, 1 / 3, 0]);
    expect(library(saved, { familiarity: 1 })).toEqual(['a', 'b', 'c', 'd']);
    expect(library(saved, { familiarity: 0 })).toEqual(['d', 'c', 'b', 'a']);
    // Same play rank too: the one earlier in the list (the better Top pick) sits further right.
    const tied = ['a', 'b', 'c'].map((id) => fam(id, 0.15));
    expect(sliderPlaces(tied, 'familiarity', user)).toEqual([1, 0.5, 0]);
  });

  it('a big tied group spreads over its share of the track', () => {
    // 80 saved-only songs, then 20 played ones: the saved ones take the first 80% of the track.
    const saved = Array.from({ length: 80 }, (_, i) => fam(`s${i}`, 0.15, { playRank: 100 - i }));
    const played = Array.from({ length: 20 }, (_, i) => fam(`p${i}`, 0.5 + i * 0.02, { playRank: 19 - i }));
    const list = [...played, ...saved];
    const firsts = [0, 0.2, 0.4, 0.6, 0.8].map((t) => library(list, { familiarity: t })[0]);
    expect(new Set(firsts).size).toBe(5);
    expect(firsts.every((id) => id!.startsWith('s'))).toBe(true);
    expect(library(list, { familiarity: 1 })[0]).toBe('p19');
  });

  it('songs we know nothing about get no place and take none', () => {
    const songs = [
      match({ id: 'p9', popularity: 0.9, popularityKnown: true }),
      match({ id: 'unknown' }),
      match({ id: 'p2', popularity: 0.2, popularityKnown: true }),
    ];
    expect(sliderPlaces(songs, 'popularity', user)).toEqual([1, null, 0]);
    expect(sliderPlaces([songs[0]!], 'popularity', user)).toEqual([0.5]);
    expect(sliderPlaces([], 'popularity', user)).toEqual([]);
  });

  it('known and saved-only songs share the track, and Maybe songs fill it on their own, after them (QWW-33)', () => {
    // Known songs are far more popular than the saved-only ones, and the Maybe ones sit in between.
    const pop = (id: string, popularity: number, extra: Partial<Opts> = {}) => match({ id, popularity, popularityKnown: true, ...extra });
    const block = (prefix: string, base: number, extra: Partial<Opts> = {}) =>
      Array.from({ length: 11 }, (_, i) => pop(`${prefix}${i}`, base + i * 0.01, extra));
    const list = [...block('m', 0.5, { difficulty: 'maybe' }), ...block('s', 0.1, { known: false }), ...block('k', 0.85)];
    const at = (t: number) => library(list, { popularity: t });
    // Popularity alone orders them: at Deep cuts the saved-only (least popular) songs come first, at Pop hits the known ones.
    expect(at(0)[0]).toBe('s0');
    expect(at(1)[0]).toBe('k10');
    for (const t of [0, 0.5, 1]) {
      const out = at(t);
      expect(out.map((id) => id[0]).join('')).toMatch(/^[ks]{22}m{11}$/);
      expect(out.find((id) => id.startsWith('m'))).toBe(`m${t * 10}`);
    }
  });

  it('a song’s place is among the songs the chips let through, so the slider spreads over what is left', () => {
    // s20 to s40 are the 90s songs. Placed among all 41 songs they would sit in the right half of the
    // track; placed among themselves, the middle one (s30) is the middle of the track.
    const songs = Array.from({ length: 41 }, (_, i) => fam(`s${i}`, 0.15 + i * 0.001, { year: i < 20 ? 1985 : 1995 }));
    const view = { ...DEFAULT_VIEW, decade: '90s' as const };
    const first = (familiarity: number) => ids(viewMatches(songs, { ...view, familiarity }, user, 'library'))[0];
    expect([first(0), first(0.5), first(1)]).toEqual(['s20', 's30', 's40']);
  });

  it('Maybe songs take no place from the others', () => {
    const sure = [0.2, 0.3, 0.4, 0.5, 0.6].map((f, i) => fam(`a${i}`, f));
    // Five Maybe songs scoring between a3 and a4: counted among the others, they would squeeze a0 to a3
    // into the left third of the track and push a4 to the far end.
    const maybe = [0.52, 0.54, 0.56, 0.58, 0.59].map((f, i) => fam(`m${i}`, f, { difficulty: 'maybe' }));
    const view = { familiarity: 0.5 };
    expect(library(sure, view)[0]).toBe('a2');
    expect(library([...maybe, ...sure], view).slice(0, 5)).toEqual(library(sure, view));
  });
});

describe('slider labels', () => {
  it('every slider has words for both ends, and no word is used twice', () => {
    expect(SLIDERS.map((s) => [s.left, s.right])).toEqual([
      ['Light work', 'Locked in'],
      ['Rediscover', 'On repeat'],
      ['Deep cuts', 'Pop hits'],
      ['Slow jams', 'Upbeat tracks'],
    ]);
    const words = SLIDERS.flatMap((s) => [s.left, s.right]);
    expect(new Set(words).size).toBe(words.length);
  });
});

describe('available sliders and rows', () => {
  it('on repeat needs a library; popularity and tempo always show, even when no song has them', () => {
    const unknownPop = [match({ id: 'a' }), match({ id: 'b' })];
    expect(availableSliders('library', unknownPop)).toEqual(['difficulty', 'familiarity', 'popularity', 'tempo']);
    expect(availableSliders('catalogue', unknownPop)).toEqual(['difficulty', 'popularity', 'tempo']);
    expect(availableSliders('library', [])).toEqual(['difficulty', 'familiarity', 'popularity', 'tempo']);
  });

  it('a filter row shows only when some song has data for it', () => {
    expect(availableFacets([match({ id: 'a' })])).toEqual({ decades: false, moods: [], duets: false });
    expect(availableFacets([match({ id: 'a', year: 1985, moods: ['heartfelt'], duet: true })])).toEqual({
      decades: true,
      moods: ['heartfelt'],
      duets: true,
    });
  });

  it('a slider the list cannot offer is unset, and everything else is kept', () => {
    const view: ResultsView = { difficulty: 0.3, familiarity: 0.8, popularity: 0.5, tempo: 0.4, decade: '80s', mood: 'upbeat', duetsOnly: true };
    expect(fitViewTo(view, ['difficulty'])).toEqual({ ...view, familiarity: null, popularity: null, tempo: null });
    expect(fitViewTo(view, ['difficulty', 'familiarity', 'popularity', 'tempo'])).toEqual(view);
  });
});

describe('chips', () => {
  const list = [
    match({ id: '85', year: 1985, moods: ['upbeat'] }),
    match({ id: '87duet', year: 1987, duet: true, moods: ['heartfelt'] }),
    match({ id: '95', year: 1995, moods: ['upbeat', 'heartfelt'] }),
    match({ id: '99duet', year: 1999, duet: true }),
    match({ id: 'noyear' }),
  ];

  it('one pick per row: picking another chip in the row replaces it, picking it again clears it', () => {
    let view = pickDecade(DEFAULT_VIEW, '80s');
    expect(view.decade).toBe('80s');
    view = pickDecade(view, '90s');
    expect(view.decade).toBe('90s');
    view = pickDecade(view, '90s');
    expect(view.decade).toBeNull();
    expect(pickMood(pickMood(DEFAULT_VIEW, 'upbeat'), 'upbeat').mood).toBeNull();
    expect(toggleDuets(toggleDuets(DEFAULT_VIEW)).duetsOnly).toBe(false);
    expect(hasFilters(DEFAULT_VIEW)).toBe(false);
    expect(hasFilters(toggleDuets(DEFAULT_VIEW))).toBe(true);
  });

  it('filters by the picked chips, and songs without a year show only when no decade is picked', () => {
    expect(ids(filterMatches(list, DEFAULT_VIEW))).toHaveLength(5);
    expect(ids(filterMatches(list, { ...DEFAULT_VIEW, decade: '80s' }))).toEqual(['85', '87duet']);
    expect(ids(filterMatches(list, { ...DEFAULT_VIEW, decade: '80s', duetsOnly: true }))).toEqual(['87duet']);
    expect(ids(filterMatches(list, { ...DEFAULT_VIEW, mood: 'heartfelt' }))).toEqual(['87duet', '95']);
  });

  it('a chip counts the songs matching it, given the picks in the other rows', () => {
    const none = chipCounts(list, DEFAULT_VIEW);
    expect(none.decades['80s']).toBe(2);
    expect(none.decades['90s']).toBe(2);
    expect(none.decades['70s']).toBe(0);
    expect(none.moods).toEqual({ upbeat: 2, heartfelt: 2 });
    expect(none.duets).toBe(2);

    const duets = chipCounts(list, { ...DEFAULT_VIEW, duetsOnly: true });
    expect(duets.decades['80s']).toBe(1);
    expect(duets.moods).toEqual({ upbeat: 0, heartfelt: 1 });
    // The duets chip itself ignores its own pick.
    expect(duets.duets).toBe(2);

    // A decade's count ignores the decade row's own pick, so switching decades is predictable.
    const eighties = chipCounts(list, { ...DEFAULT_VIEW, decade: '80s' });
    expect(eighties.decades['90s']).toBe(2);
    expect(eighties.duets).toBe(1);
  });

  it('every count equals what the list shows after tapping that chip', () => {
    const view: ResultsView = { ...DEFAULT_VIEW, mood: 'upbeat' };
    const counts = chipCounts(list, view);
    for (const d of DECADES) {
      expect(filterMatches(list, pickDecade({ ...view, decade: null }, d.id))).toHaveLength(counts.decades[d.id]);
    }
    expect(filterMatches(list, { ...view, duetsOnly: true })).toHaveLength(counts.duets);
  });
});

describe('divider', () => {
  it('sits before the first saved-only song when known songs come first', () => {
    const list = [match({ id: 'k1' }), match({ id: 'k2' }), match({ id: 's1', known: false }), match({ id: 'm', difficulty: 'maybe', known: false })];
    expect(savedDividerIndex(list, 'library')).toBe(2);
    expect(savedDividerIndex([match({ id: 's', known: false })], 'library')).toBe(-1);
    expect(savedDividerIndex([match({ id: 'k' })], 'library')).toBe(-1);
  });

  it('is not shown once the on-repeat slider is set, since the known-first rule is off', () => {
    const list = [match({ id: 'k1' }), match({ id: 's1', known: false })];
    expect(savedDividerIndex(list, 'library', { ...DEFAULT_VIEW, familiarity: 0.5 })).toBe(-1);
  });
});

// ---- the never-empty property ----

/** Small seeded PRNG (mulberry32) so failures reproduce. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomLibrary(rand: () => number, size: number): Match[] {
  const years = [undefined, 1962, 1975, 1983, 1991, 1999, 2004, 2013, 2022];
  const moodSets: (Mood[] | undefined)[] = [undefined, ['upbeat'], ['heartfelt'], ['upbeat', 'heartfelt']];
  return Array.from({ length: size }, (_, i) =>
    match({
      id: `s${i}`,
      year: years[Math.floor(rand() * years.length)],
      duet: rand() < 0.2,
      moods: moodSets[Math.floor(rand() * moodSets.length)],
      difficulty: (['easy', 'medium', 'hard', 'maybe'] as Label[])[Math.floor(rand() * 4)],
      known: rand() < 0.7,
    }),
  );
}

type Tap =
  | { kind: 'decade'; d: Decade }
  | { kind: 'mood'; m: Mood }
  | { kind: 'duets' }
  | { kind: 'clear' }
  | { kind: 'slider'; id: SliderId; value: number | null };

/** The taps the screen allows: chips with a count above 0, plus un-picking anything picked. */
function enabledTaps(list: Match[], view: ResultsView): Tap[] {
  const c = chipCounts(list, view);
  const facets = availableFacets(list);
  const taps: Tap[] = [];
  if (facets.decades) for (const d of DECADES) if (c.decades[d.id] > 0 || view.decade === d.id) taps.push({ kind: 'decade', d: d.id });
  for (const m of facets.moods) if (c.moods[m] > 0 || view.mood === m) taps.push({ kind: 'mood', m });
  if (facets.duets && (c.duets > 0 || view.duetsOnly)) taps.push({ kind: 'duets' });
  if (hasFilters(view)) taps.push({ kind: 'clear' });
  for (const id of availableSliders('library', list)) for (const value of [0, 0.4, 1, null]) taps.push({ kind: 'slider', id, value });
  return taps;
}

function apply(view: ResultsView, tap: Tap): ResultsView {
  if (tap.kind === 'decade') return pickDecade(view, tap.d);
  if (tap.kind === 'mood') return pickMood(view, tap.m);
  if (tap.kind === 'duets') return toggleDuets(view);
  if (tap.kind === 'slider') return { ...view, [tap.id]: tap.value };
  return { ...view, decade: null, mood: null, duetsOnly: false };
}

describe('no tap lands on an empty list', () => {
  it('holds for random libraries and random chip and slider sequences (seeded)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed);
      const list = randomLibrary(rand, 1 + Math.floor(rand() * 25));
      let view: ResultsView = DEFAULT_VIEW;
      for (let step = 0; step < 30; step++) {
        const taps = enabledTaps(list, view);
        if (!taps.length) break;
        view = apply(view, taps[Math.floor(rand() * taps.length)]!);
        const shown = viewMatches(list, view, user, 'library');
        expect(shown.length, `seed ${seed}, step ${step}, view ${JSON.stringify(view)}`).toBeGreaterThan(0);
        // Sliders only reorder: the list on screen is exactly what the chips let through.
        expect(shown.length).toBe(filterMatches(list, view).length);
      }
    }
  });
});
