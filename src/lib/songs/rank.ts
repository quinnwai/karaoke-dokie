// Orders matched songs for the recommendations list and cuts it into pages.
//
// Scored matches (see score.ts) sort by score, highest first; ties go to comfort, then
// familiarity, then play rank. Unscored matches keep the old order: songs that fit as written,
// then octave-shifted ones, each by play rank. Ties keep their input order (stable sort).

import type { Match } from '../contracts';

export function rankMatches(matches: Match[]): Match[] {
  const group = (m: Match) => (m.octave === 'none' ? 0 : 1);
  return [...matches].sort(
    (a, b) =>
      (b.score ?? -Infinity) - (a.score ?? -Infinity) ||
      (b.parts?.comfort ?? 0) - (a.parts?.comfort ?? 0) ||
      (b.parts?.familiarity ?? 0) - (a.parts?.familiarity ?? 0) ||
      group(a) - group(b) ||
      a.track.playRank - b.track.playRank,
  );
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
