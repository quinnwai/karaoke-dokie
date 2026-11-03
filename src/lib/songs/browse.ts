// What the results screen shows for a view: the singer picks one sort and up to one chip per
// filter row, and this module turns the full list of matches into the list on screen, plus the
// count on every chip. It is pure, so the phone can re-sort and re-filter instantly.
//
// Rules (QWW-3 plan v2):
// - The sort row orders and never hides a song. Chips filter and never reorder.
// - One pick per row (decade, mood, duets). Tapping the picked chip again clears it.
// - A chip's count is how many songs match it, given what is picked in the other rows. A chip
//   with a count of 0 is shown disabled, not hidden.
// Together these mean no tap can land on an empty list: picking an enabled chip lands on its
// count, which is above 0, and clearing a pick only widens the list.
//
// Every sort keeps two rules from the original ranking: Maybe songs (estimated ranges) come
// last, and songs the singer knows come before saved-only ones. The second is the one taste
// assumption we keep, because every source agrees on it ("pick a song that you know well").

import type { Decade, Match, Mood, ResultsMode, ResultsView, SortId, VocalRange } from '../contracts';
import { MOODS } from '../contracts';
import { isKnown } from './rank';

export interface SortDef {
  id: SortId;
  label: string;
  /** Sung in under the sort row, saying what this order means. */
  lyric: string;
}

export const SORTS: SortDef[] = [
  { id: 'top', label: 'Top picks', lyric: 'Our best guess for you' },
  { id: 'played', label: 'Most played', lyric: 'The ones you play the most' },
  { id: 'warmup', label: 'Warm-up', lyric: 'Easiest for your voice first' },
  { id: 'showoff', label: 'Show-off', lyric: 'Uses your whole range' },
  { id: 'singalong', label: 'Singalongs', lyric: 'Songs the whole room knows' },
];

export const DECADES: { id: Decade; label: string }[] = [
  { id: '60s', label: '60s & earlier' },
  { id: '70s', label: '70s' },
  { id: '80s', label: '80s' },
  { id: '90s', label: '90s' },
  { id: '00s', label: '2000s' },
  { id: '10s', label: '2010s' },
  { id: '20s', label: '2020s' },
];

export const MOOD_LABELS: Record<Mood, string> = { upbeat: 'Upbeat', heartfelt: 'Heartfelt' };

export const DEFAULT_VIEW: ResultsView = { sort: 'top', decade: null, mood: null, duetsOnly: false };

/** Singalongs needs real popularity for most songs; below this share it would sort on guesses. */
export const MIN_KNOWN_POPULARITY_SHARE = 0.6;

export function decadeOf(year: number | undefined): Decade | null {
  if (typeof year !== 'number' || !Number.isFinite(year)) return null;
  if (year < 1970) return '60s';
  if (year < 1980) return '70s';
  if (year < 1990) return '80s';
  if (year < 2000) return '90s';
  if (year < 2010) return '00s';
  if (year < 2020) return '10s';
  return '20s';
}

const isDuet = (m: Match) => m.range.duet === true;
const hasMood = (m: Match, mood: Mood) => m.moods?.includes(mood) ?? false;

/** Which sorts make sense for this list. Most played needs listening data; Singalongs needs popularity. */
export function availableSorts(mode: ResultsMode, matches: Match[]): SortId[] {
  const known = matches.filter((m) => m.parts?.popularityKnown === true).length;
  const singalong = matches.length > 0 && known / matches.length >= MIN_KNOWN_POPULARITY_SHARE;
  return SORTS.map((s) => s.id).filter((id) => (id === 'played' ? mode === 'library' : id === 'singalong' ? singalong : true));
}

/** Which filter rows have any data at all. A row with no data is not shown (its chips would all be 0). */
export function availableFacets(matches: Match[]): { decades: boolean; moods: Mood[]; duets: boolean } {
  return {
    decades: matches.some((m) => decadeOf(m.year) !== null),
    moods: MOODS.filter((mood) => matches.some((m) => hasMood(m, mood))),
    duets: matches.some(isDuet),
  };
}

type Facet = 'decade' | 'mood' | 'duets';

/** True when the match passes every picked chip except the facet named in `skip`. */
function passes(m: Match, view: ResultsView, skip?: Facet): boolean {
  if (skip !== 'decade' && view.decade !== null && decadeOf(m.year) !== view.decade) return false;
  if (skip !== 'mood' && view.mood !== null && !hasMood(m, view.mood)) return false;
  if (skip !== 'duets' && view.duetsOnly && !isDuet(m)) return false;
  return true;
}

export function filterMatches(matches: Match[], view: ResultsView): Match[] {
  return matches.filter((m) => passes(m, view));
}

export interface ChipCounts {
  decades: Record<Decade, number>;
  moods: Record<Mood, number>;
  duets: number;
}

/** The count on every chip: songs matching that chip, given what is picked in the other rows. */
export function chipCounts(matches: Match[], view: ResultsView): ChipCounts {
  const decades = Object.fromEntries(DECADES.map((d) => [d.id, 0])) as Record<Decade, number>;
  const moods = Object.fromEntries(MOODS.map((m) => [m, 0])) as Record<Mood, number>;
  let duets = 0;
  for (const m of matches) {
    if (passes(m, view, 'decade')) {
      const d = decadeOf(m.year);
      if (d) decades[d]++;
    }
    if (passes(m, view, 'mood')) for (const mood of MOODS) if (hasMood(m, mood)) moods[mood]++;
    if (passes(m, view, 'duets') && isDuet(m)) duets++;
  }
  return { decades, moods, duets };
}

/** Share of the singer's range the song covers: 1 = the song spans the whole range. */
export function rangeCoverage(m: Match, user: VocalRange): number {
  const span = user.high - user.low;
  return span > 0 ? (m.range.high - m.range.low) / span : 0;
}

type Key = (m: Match, user: VocalRange) => number;

/** Each sort's key, higher first, and the songs it moves to the end of the list. */
const SORT_KEYS: Record<Exclude<SortId, 'top'>, { key: Key; last?: (m: Match) => boolean }> = {
  played: { key: (m) => m.parts?.familiarity ?? 0 },
  warmup: { key: (m) => m.parts?.comfort ?? 0, last: (m) => m.range.fastLyrics },
  // Hard means a lot of time at the singer's edges, so Show-off prefers songs that use the
  // whole range without living there.
  showoff: { key: rangeCoverage, last: (m) => m.difficulty === 'hard' },
  singalong: { key: (m) => m.parts?.popularity ?? 0 },
};

/**
 * Orders matches for a sort. `matches` arrives in the server's Top picks order, which is also
 * the final tie-break, so equal keys keep a stable, sensible order.
 */
export function sortMatches(matches: Match[], sort: SortId, user: VocalRange, mode: ResultsMode): Match[] {
  if (sort === 'top') return [...matches];
  const { key, last } = SORT_KEYS[sort];
  const maybe = (m: Match) => (m.difficulty === 'maybe' ? 1 : 0);
  // Catalogue songs are all unknown, so the known-first tier only applies to a library.
  const tier = (m: Match) => (mode === 'library' && !isKnown(m.track) ? 1 : 0);
  const end = (m: Match) => (last?.(m) ? 1 : 0);
  return matches
    .map((m, i) => ({ m, i, k: key(m, user) }))
    .sort((a, b) => maybe(a.m) - maybe(b.m) || tier(a.m) - tier(b.m) || end(a.m) - end(b.m) || b.k - a.k || a.i - b.i)
    .map(({ m }) => m);
}

/** The list on screen for a view: filtered, then sorted. */
export function viewMatches(matches: Match[], view: ResultsView, user: VocalRange, mode: ResultsMode): Match[] {
  return sortMatches(filterMatches(matches, view), view.sort, user, mode);
}

/**
 * Where the "Saved, not played lately" divider goes: the index of the first saved-only song in
 * the main (non-Maybe) part of the list, or -1 when there is no known song before it.
 */
export function savedDividerIndex(list: Match[], mode: ResultsMode): number {
  if (mode !== 'library') return -1;
  const sure = list.filter((m) => m.difficulty !== 'maybe');
  const first = sure.findIndex((m) => !isKnown(m.track));
  return first > 0 ? first : -1;
}

/** Applies a chip tap: one pick per row, and tapping the picked chip clears it. */
export function pickDecade(view: ResultsView, decade: Decade): ResultsView {
  return { ...view, decade: view.decade === decade ? null : decade };
}

export function pickMood(view: ResultsView, mood: Mood): ResultsView {
  return { ...view, mood: view.mood === mood ? null : mood };
}

export function toggleDuets(view: ResultsView): ResultsView {
  return { ...view, duetsOnly: !view.duetsOnly };
}

export function hasFilters(view: ResultsView): boolean {
  return view.decade !== null || view.mood !== null || view.duetsOnly;
}

/** Keeps a view valid for a new list: an unavailable sort falls back to Top picks, filters clear. */
export function resetViewFor(view: ResultsView, sorts: SortId[]): ResultsView {
  return { ...DEFAULT_VIEW, sort: sorts.includes(view.sort) ? view.sort : 'top' };
}
