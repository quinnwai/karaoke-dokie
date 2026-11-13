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
//   the list changes along the whole length (QWW-33). Tempo (QWW-40) is placed the same way, by rank
//   of the song's beats per minute. Sliders only reorder, so they can never empty
//   the list either, and every view is computed on the phone in one pass.
//
// Maybe songs (ranges we are less sure of) come last in every view. With no slider set the list stays in the
// server's Top picks order, which puts songs the singer knows before saved-only ones ("pick a song that
// you know well"); once any slider is set, the sliders alone order the songs (QWW-33), so that rule
// does not hold the other sliders back.

import type { Decade, Match, Mood, ResultsMode, ResultsView, SliderId, VocalRange } from '../contracts';
import { MOODS, SLIDER_IDS } from '../contracts';
import { difficultyFromEdgeTime, edgeTime, strainOf } from './match';
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
  { id: 'tempo', left: 'Slow jams', right: 'Party bops' }, // the Mood gear's words (Round 7, QWW-72)
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
  tempo: null,
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
 * (Quinn-Wai's call, QWW-32), and so does Tempo (QWW-40); songs whose popularity or tempo is unknown
 * go after the rest when it is set.
 */
export function availableSliders(mode: ResultsMode, _matches: Match[]): SliderId[] {
  return SLIDER_IDS.filter((id) => (id === 'familiarity' ? mode === 'library' : true));
}

/** The three difficulty labels as bands on the Light work to Locked in track, easiest first. */
const BANDS: Record<string, number> = { easy: 0, medium: 1, hard: 2 };

/**
 * A song's difficulty band (0 Easy, 1 Medium, 2 Hard) and its strain inside the band. The band is the
 * label the song shows, from the same edge-time numbers (match.ts); a Maybe song shows no label but
 * is banded the same way, as if its range were sure. The strain comes with the match (server side,
 * from the pitch histogram) or is estimated from the range for a match without one.
 */
export function difficultyBand(m: Match, user: VocalRange): { band: number; strain: number } {
  const shift = m.octave === 'up' ? 12 : m.octave === 'down' ? -12 : 0;
  const edges = m.strain === undefined || BANDS[m.difficulty] === undefined ? edgeTime(user, m.range, shift) : null;
  const band = BANDS[m.difficulty] ?? BANDS[difficultyFromEdgeTime(edges!)]!;
  return { band, strain: m.strain ?? strainOf(edges!) };
}

/**
 * A song's score on a slider, or null when we do not know. Difficulty is its label's band plus its
 * strain inside the band (the label first, then how hard within it), so the slider and the label
 * are one measure: Locked in is Hard songs, hardest first, then Medium, then Easy. Familiarity,
 * popularity and tempo are 0 to 1 or bpm. The score only sorts the songs; where a song sits on the
 * track is its rank by this score (sliderPlaces).
 */
export function sliderValue(m: Match, id: SliderId, user: VocalRange): number | null {
  if (id === 'difficulty') {
    const { band, strain } = difficultyBand(m, user);
    return band + clamp01(strain / 3) * 0.999;
  }
  if (id === 'familiarity') return typeof m.parts?.familiarity === 'number' ? clamp01(m.parts.familiarity) : null;
  if (id === 'tempo') return typeof m.tempo === 'number' ? m.tempo : null;
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
  if (id === 'difficulty') {
    // Each label gets a third of the track, whatever its share of the songs, and its songs spread
    // evenly over that third by strain, none on its edge (so no Easy song ties with a Medium one). The
    // middle of the track is then Medium songs, and the nearer the thumb is to an end the more that
    // label's songs come first (QWW-33).
    const byBand: number[][] = [[], [], []];
    scored.forEach(({ score }, rank) => byBand[Math.floor(score)]!.push(rank));
    byBand.forEach((ranks, band) =>
      ranks.forEach((rank, k) => {
        places[scored[rank]!.at] = (band + (k + 0.5) / ranks.length) / 3;
      }),
    );
    return places;
  }
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
 * The Maybe songs come after all the others and are laid out on the sliders on their own
 * (sliderPlaces), so the block shown first fills the whole track whatever the Maybe songs look like.
 * Within a block, the songs closest to every set target come first. Songs you know and saved-only
 * songs are not told apart here: only the unsorted list (and the "on repeat" slider) does that.
 */
export function orderMatches(matches: Match[], view: ResultsView, user: VocalRange, _mode: ResultsMode): Match[] {
  const sliders = activeSliders(view);
  if (!sliders.length) return [...matches];
  const block = (m: Match) => (m.difficulty === 'maybe' ? 1 : 0);

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
 * the main (non-Maybe) part of the list, or -1 when no divider belongs (a slider is set, so the list
 * is not in Top picks order) or nothing precedes it.
 */
export function savedDividerIndex(list: Match[], mode: ResultsMode, view: ResultsView = DEFAULT_VIEW): number {
  if (mode !== 'library' || activeSliders(view).length > 0) return -1;
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
