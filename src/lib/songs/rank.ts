// Orders matched songs for the recommendations list and cuts it into pages.
//
// The Maybe group (low-confidence ranges, see match.ts) comes after every other song, so it
// shows after the main list; within each, the order below applies.
// Songs the user knows (top lists, recent plays, their playlists) come first; saved-only songs
// follow. Within each tier, scored matches (see score.ts) sort by score, highest first; ties go
// to comfort, then familiarity, then play rank. Unscored matches keep the old order: songs that fit as written,
// then octave-shifted ones, each by play rank. Ties keep their input order (stable sort).

import type { Match, Track } from '../contracts';

/** Saved-only familiarity (spotify.ts SAVED_ONLY); kept here so the client bundle skips the server module. */
const SAVED_ONLY = 0.15;

/** Tracks without a `known` flag (cached before it existed) count as known unless only saved. */
export function isKnown(t: Track): boolean {
  if (typeof t.known === 'boolean') return t.known;
  return t.familiarity === undefined || t.familiarity > SAVED_ONLY + 1e-9;
}

export function rankMatches(matches: Match[]): Match[] {
  const maybe = (m: Match) => (m.difficulty === 'maybe' ? 1 : 0);
  const group = (m: Match) => (m.octave === 'none' ? 0 : 1);
  const tier = (m: Match) => (isKnown(m.track) ? 0 : 1);
  return [...matches].sort(
    (a, b) =>
      maybe(a) - maybe(b) ||
      tier(a) - tier(b) ||
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
