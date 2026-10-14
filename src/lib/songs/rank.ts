// Orders matched songs for the recommendations list and cuts it into pages.
//
// Songs the user can sing as written come first, then songs that need an
// octave shift (up or down, treated alike). Within each group, songs the user
// plays more (lower Spotify playRank) come first. Ties keep their input order
// (Array.prototype.sort is stable since ES2019).

import type { Match } from '../contracts';

export function rankMatches(matches: Match[]): Match[] {
  const group = (m: Match) => (m.octave === 'none' ? 0 : 1);
  return [...matches].sort((a, b) => group(a) - group(b) || a.track.playRank - b.track.playRank);
}

export interface Page<T> {
  items: T[];
  /** Offset of the next page, or null when this page reaches the end. */
  nextOffset: number | null;
}

/** Offset/limit paging. Negative or fractional inputs are floored and clamped to 0. */
export function paginate<T>(list: T[], offset: number, limit: number): Page<T> {
  const start = Math.max(0, Math.floor(offset));
  const size = Math.max(0, Math.floor(limit));
  const items = list.slice(start, start + size);
  const end = start + items.length;
  return { items, nextOffset: size > 0 && end < list.length ? end : null };
}
