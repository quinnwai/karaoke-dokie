// Which song range wins when sources disagree. Every writer of song ranges (bulk import, USDB
// sync and fill) goes by this one order: a better source replaces a worse one, a measured range
// is never replaced by an estimate, and nothing replaces a note file.

import type { RangeSource, SongRange } from '../contracts';

export const SOURCE_RANK: Record<RangeSource, number> = {
  'note-file': 3,
  'audio-full': 2,
  'artist-typical': 1,
  'artist-external': 1,
};

/** Ranks from here up are measured from the song itself (note file or recording), not estimated. */
export const MEASURED_RANK = SOURCE_RANK['audio-full'];

/** Rank of a stored range; a skipped song (null) or no row at all ranks 0. */
export function sourceRank(range: SongRange | null | undefined): number {
  return range ? SOURCE_RANK[range.source] : 0;
}

export const isKnownSource = (source: string): source is RangeSource => Object.hasOwn(SOURCE_RANK, source);

export const isMeasured = (range: SongRange): boolean => sourceRank(range) >= MEASURED_RANK;

/**
 * True when an imported range should replace the stored one: it ranks higher, or it is the same
 * source from another export (its `method` differs), so a newer export replaces an older one's
 * rows while re-importing the same file keeps them.
 */
export function importReplaces(incoming: SongRange, stored: SongRange | null | undefined): boolean {
  const rank = sourceRank(incoming);
  const storedRank = sourceRank(stored);
  if (rank !== storedRank) return rank > storedRank;
  return stored?.source === incoming.source && stored.method !== incoming.method;
}
