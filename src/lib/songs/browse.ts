// What the results screen shows for a view. Two kinds of control, kept apart on purpose:
//
// - Chips filter on discrete labels (decade, mood, duets): one pick per row, tapping the picked
//   chip again clears it. A chip's count is how many songs match it, given what is picked in the
//   other rows; a chip with a count of 0 is shown disabled, not hidden. So no chip tap can land on
//   an empty list: picking an enabled chip lands on its count, which is above 0, and clearing a
//   pick only widens the list.
// - Sliders are preferences on continuous scores (how hard, how much you play it, how well known).
//   Untouched, a slider does nothing. Set, it is a target from 0 (left end) to 1 (right end), and
//   the songs closest to every set target come first. A song sits on the track by its rank in the
//   list, not by its raw score, so every tenth of the track holds about a tenth of the songs and
//   the list changes along the whole length (QWW-33). Sliders only reorder, so they can never empty
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
}

export const SLIDERS: SliderDef[] = [
  { id: 'difficulty', left: 'Light work', right: 'Locked in' },
  { id: 'familiarity', left: 'Rediscover', right: 'On repeat' },
  { id: 'popularity', left: 'Deep cuts', right: 'Pop hits' },
];

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

/**
 * Which sliders make sense for this list. "On repeat" needs listening data. Popularity always shows
 * (Quinn-Wai's call, QWW-32); songs whose popularity is unknown go after the rest when it is set.
 */
export function availableSliders(mode: ResultsMode, _matches: Match[]): SliderId[] {
  return SLIDER_IDS.filter((id) => (id === 'familiarity' ? mode === 'library' : true));
}

/** Share of the singer's range the song covers: 1 = the song spans the whole range. */
export function rangeCoverage(m: Match, user: VocalRange): number {
  const span = user.high - user.low;
  return span > 0 ? clamp01((m.range.high - m.range.low) / span) : 0;
}

/**
 * A song's score on a slider, 0 to 1, or null when we do not know. Difficulty is how much of
 * the singer's range the song uses together with how little of it sits in their comfortable middle,
 * so the right end (Locked in) is songs that use your whole range and the left end (Light work) is
 * easy, centred songs. The score only sorts the songs; where a song sits on the track is its rank
 * by this score (sliderPlaces).
 */
export function sliderValue(m: Match, id: SliderId, user: VocalRange): number | null {
  if (id === 'difficulty') return clamp01((rangeCoverage(m, user) + (1 - (m.parts?.comfort ?? 0.5))) / 2);
  if (id === 'familiarity') return typeof m.parts?.familiarity === 'number' ? clamp01(m.parts.familiarity) : null;
  return m.parts?.popularityKnown ? clamp01(m.parts.popularity) : null;
}

/**
 * Where each of `songs` sits on a slider's track, 0 (left end) to 1 (right end), or null for a song
 * we know nothing about on it. A song's place is its rank by score within `songs`, as a share of the
 * songs, not the score itself. Scores bunch up (every catalogue song's difficulty is under 0.4, and
 * most library songs share one of two familiarity scores), and a track laid out by score then has
 * long stretches with no songs, where moving the thumb changes nothing. By rank, each tenth of the
 * track holds about a tenth of the songs, and the ends are still the lowest and the highest score.
 *
 * Songs with the same score are told apart by play rank, so a big tied group (every saved-only song
 * scores 0.15) spreads out too. In a library the play rank is Spotify's order (top lists, recent
 * plays, then saved songs newest first); in the catalogue it is the most-viewed-first order. The song
 * with the lower play rank sits further right, then the one earlier in `songs` (the better Top pick).
 */
export function sliderPlaces(songs: Match[], id: SliderId, user: VocalRange): (number | null)[] {
  const scored: { at: number; score: number }[] = [];
  songs.forEach((m, at) => {
    const score = sliderValue(m, id, user);
    if (score !== null) scored.push({ at, score });
  });
  scored.sort((a, b) => a.score - b.score || songs[b.at]!.track.playRank - songs[a.at]!.track.playRank || b.at - a.at);
  const places = songs.map((): number | null => null);
  scored.forEach(({ at }, rank) => {
    places[at] = scored.length > 1 ? rank / (scored.length - 1) : 0.5;
  });
  return places;
}

export const activeSliders = (view: ResultsView): SliderId[] => SLIDER_IDS.filter((id) => view[id] !== null);

/** A song we know nothing about on a slider counts as farther from any target than a song we know. */
const UNKNOWN_DISTANCE = 1.5;

/**
 * Orders matches for the sliders that are set. `matches` arrives in the server's Top picks order,
 * which is also the final tie-break; with no slider set, that order is kept as it is.
 *
 * The list is shown in blocks that never mix: songs you know, then saved-only ones (unless you set
 * "on repeat" yourself), with the Maybe songs after both. Each block is laid out on the sliders on
 * its own (sliderPlaces), so the block shown first fills the whole track, whatever the songs after
 * it look like. Within a block, the songs closest to every set target come first.
 */
export function orderMatches(matches: Match[], view: ResultsView, user: VocalRange, mode: ResultsMode): Match[] {
  const sliders = activeSliders(view);
  if (!sliders.length) return [...matches];
  const maybe = (m: Match) => (m.difficulty === 'maybe' ? 1 : 0);
  // Setting "on repeat" yourself replaces the known-first rule; catalogue songs are all unknown.
  const tier = (m: Match) => (mode === 'library' && view.familiarity === null && !isKnown(m.track) ? 1 : 0);
  const block = (m: Match) => maybe(m) * 2 + tier(m);

  const inBlock = new Map<number, number[]>();
  matches.forEach((m, i) => {
    const b = block(m);
    const indices = inBlock.get(b);
    if (indices) indices.push(i);
    else inBlock.set(b, [i]);
  });
  // Distance to every set target; a song we know nothing about for a slider goes after the rest.
  const distance = matches.map(() => 0);
  for (const indices of inBlock.values()) {
    const songs = indices.map((i) => matches[i]!);
    for (const id of sliders) {
      sliderPlaces(songs, id, user).forEach((place, k) => {
        distance[indices[k]!]! += place === null ? UNKNOWN_DISTANCE : Math.abs(place - view[id]!);
      });
    }
  }
  return matches
    .map((m, i) => ({ m, i }))
    .sort((a, b) => block(a.m) - block(b.m) || distance[a.i]! - distance[b.i]! || a.i - b.i)
    .map(({ m }) => m);
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
