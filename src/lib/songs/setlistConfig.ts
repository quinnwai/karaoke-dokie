// The Setlist tuner's defaults, in one place so a reset and the first load always agree (round 5
// spec §11). There is no ranking code here, so the screen can import this file; the engine is setlist.ts.
//
// Why each value (QWW-47, ranking model A, Quinn-Wai 10 Nov): the default view is "most popular
// first, then easiest" for someone who is logged out, and the engine's weights (Popularity counts
// double) turn these values into exactly that, among the songs they can sing as written, which come
// before any song that needs an octave jump (QWW-58).
//
//   Difficulty  0    on   "Light work" end: among equally popular songs the easiest comes first. Zero rather
//                         than a low-ish 15, because a song easier than the target would otherwise lose to one
//                         sitting on it.
//   History     100  off  "On repeat" end. Off because a logged-out singer has no history and the default view
//                         does not use it. Switched on, it starts where it brings their own top and liked songs
//                         to the front, so touching it visibly does something.
//   Popularity  100  on   "Pop hits" end: the most popular songs first.
//   Tempo       50   off  The neutral middle: tempo is a taste, not a default.
//   Era         off       No default picks. Era off shows every era, and the first tap on an era button picks
//                         just that era (spec §4: with Era off the tap applies to the default picks).

import type { EraId, TunerPart } from '../contracts';

export const DEFAULTS = Object.freeze({
  difficulty: 0,
  history: 100,
  popularity: 100,
  tempo: 50,
  eras: Object.freeze([]) as readonly EraId[],
});

/** The parts that start out reset (off), as the sheet loads. */
export const DEFAULT_OFF: readonly TunerPart[] = Object.freeze(['history', 'tempo', 'era']);

/** Songs per page of POST /api/setlist: the number sent when `limit` is left out, and the most one request may ask for. */
export const SETLIST_PAGE = Object.freeze({ default: 100, max: 200 });

/** The button labels (spec §2). The apostrophe is U+2019. */
export const ERA_LABEL: Record<EraId, string> = {
  pre: 'Pre-’70s',
  s70: '’70s',
  s80: '’80s',
  s90: '’90s',
  s00: '’00s',
  s10: '’10s',
  s20: '’20s',
};

/** The era of a release year, or null when there is none. 'pre' is before 1970 and 's20' is 2020 on. */
export function eraOf(year: number | undefined): EraId | null {
  if (typeof year !== 'number' || !Number.isFinite(year)) return null;
  if (year < 1970) return 'pre';
  if (year < 1980) return 's70';
  if (year < 1990) return 's80';
  if (year < 2000) return 's90';
  if (year < 2010) return 's00';
  if (year < 2020) return 's10';
  return 's20';
}
