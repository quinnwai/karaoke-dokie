// What the results screen shows for a view. Two kinds of control, kept apart on purpose:
//
// - Chips filter on discrete labels (decade, mood, duets): one pick per row, tapping the picked
//   chip again clears it. A chip's count is how many songs match it, given what is picked in the
//   other rows; a chip with a count of 0 is shown disabled, not hidden. So no chip tap can land on
//   an empty list: picking an enabled chip lands on its count, which is above 0, and clearing a
//   pick only widens the list.
// - Sliders are preferences on continuous scores (how hard, how much you play it, how well known).
//   Untouched, a slider does nothing. Set, it is a target from 0 (left end) to 1 (right end), and
//   the songs closest to every set target come first. Sliders only reorder, so they can never empty
//   the list either, and every view is computed on the phone in one pass.
//
// Two rules from the original ranking hold throughout: Maybe songs (estimated ranges) come last,
// and, unless the singer sets the "on repeat" slider themselves, songs they know come before
// saved-only ones. That second rule is the one taste assumption we keep, because every source
// agrees on it ("pick a song that you know well").

import type { Decade, Match, Mood, ResultsMode, ResultsView, SliderId, VocalRange } from '../contracts';
import { MOODS, SLIDER_IDS } from '../contracts';
import { isKnown } from './rank';

export interface SliderDef {
  id: SliderId;
  /** Words at each end of the track. */
  left: string;
  right: string;
  /** Sung in under the controls when this slider leads: near the left end, the middle, the right end. */
  lyrics: [string, string, string];
}

export const SLIDERS: SliderDef[] = [
  {
    id: 'difficulty',
    left: 'Ease in',
    right: 'Whole range',
    lyrics: ['Comfortable tunes to ease into', 'A little stretch, not too much', 'Using your whole range'],
  },
  {
    id: 'familiarity',
    left: 'Deep cuts',
    right: 'On repeat',
    lyrics: ['Saved songs you haven’t played in a while', 'Songs you know', 'The songs you’ve got on repeat'],
  },
  {
    id: 'popularity',
    left: 'Hidden gems',
    right: 'Big hits',
    lyrics: ['Hidden gems for your voice', 'Songs plenty of people know', 'Songs the whole room knows'],
  },
];

/** Sung in when no slider is set: the server's Top picks order. */
export const DEFAULT_LYRIC = 'Our best guess for you';

export const DECADES: { id: Decade; label: string }[] = [
  { id: '60s', label: 'Pre-70s' },
  { id: '70s', label: '70s' },
  { id: '80s', label: '80s' },
  { id: '90s', label: '90s' },
  { id: '00s', label: '2000s' },
  { id: '10s', label: '2010s' },
  { id: '20s', label: '2020s' },
];

export const MOOD_LABELS: Record<Mood, string> = { upbeat: 'Upbeat', heartfelt: 'Heartfelt' };

export const DEFAULT_VIEW: ResultsView = {
  difficulty: null,
  familiarity: null,
  popularity: null,
  decade: null,
  mood: null,
  duetsOnly: false,
};

/** The popularity slider needs real popularity for most songs; below this share it would order on guesses. */
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
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// ---- sliders ----

/** Which sliders make sense for this list. "On repeat" needs listening data; popularity needs data. */
export function availableSliders(mode: ResultsMode, matches: Match[]): SliderId[] {
  const known = matches.filter((m) => m.parts?.popularityKnown === true).length;
  const popularity = matches.length > 0 && known / matches.length >= MIN_KNOWN_POPULARITY_SHARE;
  return SLIDER_IDS.filter((id) => (id === 'familiarity' ? mode === 'library' : id === 'popularity' ? popularity : true));
}

/** Share of the singer's range the song covers: 1 = the song spans the whole range. */
export function rangeCoverage(m: Match, user: VocalRange): number {
  const span = user.high - user.low;
  return span > 0 ? clamp01((m.range.high - m.range.low) / span) : 0;
}

/**
 * Where a song sits on a slider, 0 to 1, or null when we do not know. Difficulty is how much of
 * the singer's range the song uses together with how little of it sits in their comfortable middle,
 * so the right end is "using your whole range" and the left end is easy, centred songs.
 */
export function sliderValue(m: Match, id: SliderId, user: VocalRange): number | null {
  if (id === 'difficulty') return clamp01((rangeCoverage(m, user) + (1 - (m.parts?.comfort ?? 0.5))) / 2);
  if (id === 'familiarity') return typeof m.parts?.familiarity === 'number' ? clamp01(m.parts.familiarity) : null;
  return m.parts?.popularityKnown ? clamp01(m.parts.popularity) : null;
}

export const activeSliders = (view: ResultsView): SliderId[] => SLIDER_IDS.filter((id) => view[id] !== null);

/**
 * Orders matches for the sliders that are set. `matches` arrives in the server's Top picks order,
 * which is also the final tie-break; with no slider set, that order is kept as it is.
 */
export function orderMatches(matches: Match[], view: ResultsView, user: VocalRange, mode: ResultsMode): Match[] {
  const sliders = activeSliders(view);
  if (!sliders.length) return [...matches];
  const maybe = (m: Match) => (m.difficulty === 'maybe' ? 1 : 0);
  // Setting "on repeat" yourself replaces the known-first rule; catalogue songs are all unknown.
  const tier = (m: Match) => (mode === 'library' && view.familiarity === null && !isKnown(m.track) ? 1 : 0);
  // Distance to every set target; a song we know nothing about for a slider goes after the rest.
  const distance = (m: Match) =>
    sliders.reduce((sum, id) => {
      const v = sliderValue(m, id, user);
      return sum + (v === null ? 1.5 : Math.abs(v - view[id]!));
    }, 0);
  return matches
    .map((m, i) => ({ m, i, d: distance(m) }))
    .sort((a, b) => maybe(a.m) - maybe(b.m) || tier(a.m) - tier(b.m) || a.d - b.d || a.i - b.i)
    .map(({ m }) => m);
}

/** The line sung in under the controls: the slider moved last leads, then any other set slider. */
export function lyricFor(view: ResultsView, lead: SliderId | null): string {
  const id = lead !== null && view[lead] !== null ? lead : activeSliders(view)[0];
  if (!id) return DEFAULT_LYRIC;
  const target = view[id]!;
  const lyrics = SLIDERS.find((s) => s.id === id)!.lyrics;
  return target < 1 / 3 ? lyrics[0] : target > 2 / 3 ? lyrics[2] : lyrics[1];
}

// ---- chips ----

/** Which chip rows have any data at all. A row with no data is not shown (its chips would all be 0). */
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

/** The list on screen for a view: filtered by the chips, then ordered by the sliders. */
export function viewMatches(matches: Match[], view: ResultsView, user: VocalRange, mode: ResultsMode): Match[] {
  return orderMatches(filterMatches(matches, view), view, user, mode);
}

/**
 * Where the "Saved, not played lately" divider goes: the index of the first saved-only song in
 * the main (non-Maybe) part of the list, or -1 when the known-first rule is off or nothing precedes it.
 */
export function savedDividerIndex(list: Match[], mode: ResultsMode, view: ResultsView = DEFAULT_VIEW): number {
  if (mode !== 'library' || view.familiarity !== null) return -1;
  const sure = list.filter((m) => m.difficulty !== 'maybe');
  const first = sure.findIndex((m) => !isKnown(m.track));
  return first > 0 ? first : -1;
}

/** Unsets sliders the list cannot offer, keeping everything else. */
export function fitViewTo(view: ResultsView, sliders: SliderId[]): ResultsView {
  const next = { ...view };
  for (const id of SLIDER_IDS) if (!sliders.includes(id)) next[id] = null;
  return next;
}
