import { describe, expect, it } from 'vitest';
import type { Decade, Label, Match, Mood, ResultsView, SliderId, VocalRange } from '../../src/lib/contracts';
import {
  DECADES,
  DEFAULT_LYRIC,
  DEFAULT_VIEW,
  SLIDERS,
  availableFacets,
  availableSliders,
  chipCounts,
  decadeOf,
  filterMatches,
  fitViewTo,
  hasFilters,
  lyricFor,
  orderMatches,
  pickDecade,
  pickMood,
  rangeCoverage,
  savedDividerIndex,
  sliderValue,
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
  comfort?: number;
  popularity?: number;
  popularityKnown?: boolean;
  low?: number;
  high?: number;
  fastLyrics?: boolean;
  duet?: boolean;
  moods?: Mood[];
}

function match(o: Opts): Match {
  const m: Match = {
    track: { id: o.id, title: o.id, artist: 'A', artistId: 'a', spotifyUrl: '', playRank: 0, known: o.known ?? true },
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
  // Difficulty values (range use and how little sits in the middle, user span 24):
  // top1 0.45, top2 0.275, top3 0.81, saved 0.25.
  const list = [
    match({ id: 'top1', familiarity: 0.2, comfort: 0.6, popularity: 0.9 }),
    match({ id: 'top2', familiarity: 0.9, comfort: 0.95, popularity: 0.2 }),
    match({ id: 'top3', familiarity: 0.5, comfort: 0.3, popularity: 0.6, difficulty: 'hard', low: 46, high: 68 }),
    match({ id: 'saved', known: false, familiarity: 0.15, comfort: 1, popularity: 1 }),
    match({ id: 'maybe', difficulty: 'maybe', familiarity: 1, comfort: 1, popularity: 1 }),
  ];
  const order = (view: Partial<ResultsView>, mode: 'library' | 'catalogue' = 'library') =>
    ids(orderMatches(list, { ...DEFAULT_VIEW, ...view }, user, mode));

  it('untouched sliders keep the server order', () => {
    expect(order({})).toEqual(['top1', 'top2', 'top3', 'saved', 'maybe']);
  });

  it('the difficulty slider runs from comfortable songs to ones using your whole range', () => {
    expect(order({ difficulty: 0 })).toEqual(['top2', 'top1', 'top3', 'saved', 'maybe']);
    expect(order({ difficulty: 1 })).toEqual(['top3', 'top1', 'top2', 'saved', 'maybe']);
    expect(rangeCoverage(list[2]!, user)).toBeCloseTo(22 / 24);
    expect(sliderValue(list[1]!, 'difficulty', user)).toBeCloseTo(0.275);
  });

  it('the on-repeat slider orders by how much you play a song, and replaces the known-first rule', () => {
    expect(order({ familiarity: 1 })).toEqual(['top2', 'top3', 'top1', 'saved', 'maybe']);
    // Deep cuts: the saved song you have not played in a while comes first.
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

  it('several sliders together put the song closest to every target first', () => {
    // top2: 0.275 + 0.1; saved: 0.25 + 0.85; top1: 0.45 + 0.8; top3: 0.81 + 0.5.
    expect(order({ difficulty: 0, familiarity: 1 })).toEqual(['top2', 'saved', 'top1', 'top3', 'maybe']);
  });

  it('keeps known songs before saved-only ones and Maybe songs last, and drops nothing, for any setting', () => {
    for (const difficulty of [null, 0, 0.5, 1]) {
      for (const popularity of [null, 0, 1]) {
        const out = order({ difficulty, popularity });
        expect(out).toHaveLength(list.length);
        expect(out.indexOf('saved')).toBe(3);
        expect(out[4]).toBe('maybe');
      }
    }
  });

  it('equal distances keep the server order', () => {
    const tied = [match({ id: 'a' }), match({ id: 'b' }), match({ id: 'c' })];
    expect(ids(orderMatches(tied, { ...DEFAULT_VIEW, difficulty: 0.9 }, user, 'library'))).toEqual(['a', 'b', 'c']);
  });

  it('in catalogue mode no song is treated as saved-only', () => {
    expect(order({ difficulty: 0 }, 'catalogue')).toEqual(['saved', 'top2', 'top1', 'top3', 'maybe']);
    expect(savedDividerIndex(list, 'catalogue')).toBe(-1);
  });
});

describe('the lyric line', () => {
  it('reads the slider moved last, in thirds of its track', () => {
    expect(lyricFor(DEFAULT_VIEW, null)).toBe(DEFAULT_LYRIC);
    expect(lyricFor({ ...DEFAULT_VIEW, difficulty: 0 }, 'difficulty')).toBe('Comfortable tunes to ease into');
    expect(lyricFor({ ...DEFAULT_VIEW, difficulty: 0.5 }, 'difficulty')).toBe('A little stretch, not too much');
    expect(lyricFor({ ...DEFAULT_VIEW, difficulty: 1 }, 'difficulty')).toBe('Using your whole range');
    expect(lyricFor({ ...DEFAULT_VIEW, familiarity: 0.9 }, 'familiarity')).toBe('The songs you’ve got on repeat');
    const both = { ...DEFAULT_VIEW, difficulty: 0.1, popularity: 0.95 };
    expect(lyricFor(both, 'popularity')).toBe('Songs the whole room knows');
    // A lead that is no longer set gives way to a slider that is.
    expect(lyricFor(both, 'familiarity')).toBe('Comfortable tunes to ease into');
  });

  it('every slider has words for both ends and three lyrics', () => {
    expect(SLIDERS.map((s) => [s.left, s.right])).toEqual([
      ['Ease in', 'Whole range'],
      ['Deep cuts', 'On repeat'],
      ['Hidden gems', 'Big hits'],
    ]);
    for (const s of SLIDERS) expect(new Set(s.lyrics).size).toBe(3);
  });
});

describe('available sliders and rows', () => {
  it('on repeat needs a library, and popularity needs real popularity for most songs', () => {
    const unknownPop = [match({ id: 'a' }), match({ id: 'b' })];
    expect(availableSliders('library', unknownPop)).toEqual(['difficulty', 'familiarity']);
    expect(availableSliders('catalogue', unknownPop)).toEqual(['difficulty']);
    const known = [match({ id: 'a', popularityKnown: true }), match({ id: 'b', popularityKnown: true }), match({ id: 'c' })];
    expect(availableSliders('catalogue', known)).toEqual(['difficulty', 'popularity']);
    expect(availableSliders('library', [])).toEqual(['difficulty', 'familiarity']);
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
    const view: ResultsView = { difficulty: 0.3, familiarity: 0.8, popularity: 0.5, decade: '80s', mood: 'upbeat', duetsOnly: true };
    expect(fitViewTo(view, ['difficulty'])).toEqual({ ...view, familiarity: null, popularity: null });
    expect(fitViewTo(view, ['difficulty', 'familiarity', 'popularity'])).toEqual(view);
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
