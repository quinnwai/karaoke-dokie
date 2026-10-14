// Estimated song ranges for when a song has no note file of its own.
//
// artistTypicalRange: singers keep to a similar range across their catalogue,
// so the typical range of an artist's other charted songs is a fair guess.
// Medians rather than means, so one unusual song (a falsetto single, a duet
// where the file tracks the other singer) does not skew the estimate. Only
// 'note-file' ranges are used, so one guess never feeds another.
//
// narrowExternalArtistRange: published "vocal range" figures for an artist
// (fan wikis, range databases) span their whole career, including one-off
// extremes such as a single whistle note, a growled low ad-lib, or live
// improvisation, that almost no individual song reaches. A typical song uses
// the middle of that span, so we drop a quarter of the span from each end and
// keep the middle half. That is a deliberately rough rule, flagged as low
// confidence everywhere it is shown.

import type { SongRange } from '../contracts';

export const EXTERNAL_RANGE_TRIM_FRACTION = 0.25;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Typical range of an artist from the note-file ranges of their other songs; null if there are none. */
export function artistTypicalRange(otherSongs: SongRange[]): SongRange | null {
  const usable = otherSongs.filter((s) => s.source === 'note-file');
  if (usable.length === 0) return null;
  return {
    low: median(usable.map((s) => s.low)),
    high: median(usable.map((s) => s.high)),
    tessitura: median(usable.map((s) => s.tessitura)),
    source: 'artist-typical',
    confidence: 'low',
    fastLyrics: false,
  };
}

/** Narrows a career-wide published range to the middle half a typical song uses. */
export function narrowExternalArtistRange(low: number, high: number): SongRange {
  const lo = Math.min(low, high);
  const hi = Math.max(low, high);
  const trim = (hi - lo) * EXTERNAL_RANGE_TRIM_FRACTION;
  return {
    low: lo + trim,
    high: hi - trim,
    tessitura: (lo + hi) / 2,
    source: 'artist-external',
    confidence: 'low',
    fastLyrics: false,
  };
}
