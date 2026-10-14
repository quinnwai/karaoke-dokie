// Plain-words text and geometry for the screen. No music jargon reaches the user.

import type { DataSourceLogEntry, Difficulty, LogOutcome, Midi, OctaveShift, SongRange, VocalRange } from '../contracts';
import { midiToNoteName } from '../audio/notes';

export function difficultyLabel(d: Difficulty): string {
  return d === 'easy' ? 'Easy' : d === 'medium' ? 'Medium' : 'Hard';
}

/** Shown only when the song fits after moving it; null when it fits as written. */
export function octaveWording(octave: OctaveShift): string | null {
  if (octave === 'up') return 'Sing it higher than the artist';
  if (octave === 'down') return 'Sing it lower than the artist';
  return null;
}

const OUTCOME_TEXT: Record<LogOutcome, string> = {
  'note-file': 'Measured from a note-by-note file of this song.',
  'artist-typical': "Estimated from this artist's usual singing range.",
  'artist-external': 'Estimated from published info about this artist.',
  skipped: "We couldn't find range info for this song.",
};

/** Text for the "i" button on a song. */
export function sourceTooltip(entry: DataSourceLogEntry | undefined): string {
  if (!entry) return "We don't have details on where this song's range came from.";
  const reason = entry.reason.trim();
  return reason ? `${OUTCOME_TEXT[entry.outcome]} ${reason}` : OUTCOME_TEXT[entry.outcome];
}

export interface Span {
  /** Percent from the left edge of the bar. */
  left: number;
  /** Percent of the bar's width. */
  width: number;
  low: string;
  high: string;
}

export interface RangeBar {
  user: Span;
  song: Span;
}

const PAD = 2; // semitones of breathing room at each end

/**
 * Lays the song's range over the user's range on one scale.
 * When the song fits an octave up or down, the song span shows the notes the
 * user will actually sing.
 */
export function rangeBar(user: VocalRange, song: SongRange, octave: OctaveShift): RangeBar {
  const shift = octave === 'up' ? 12 : octave === 'down' ? -12 : 0;
  const songLow = song.low + shift;
  const songHigh = song.high + shift;
  const min = Math.min(user.low, songLow) - PAD;
  const max = Math.max(user.high, songHigh) + PAD;
  const span = (lo: Midi, hi: Midi): Span => ({
    left: round(((lo - min) / (max - min)) * 100),
    width: round(((hi - lo) / (max - min)) * 100),
    low: midiToNoteName(lo),
    high: midiToNoteName(hi),
  });
  return { user: span(user.low, user.high), song: span(songLow, songHigh) };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Live pitch scale on the hold steps: C2 at the bottom to C6 at the top. */
export const SCALE_LOW = 36;
export const SCALE_HIGH = 84;

/** Percent from the bottom of the scale, clamped to it. */
export function scalePosition(midi: number): number {
  const p = ((midi - SCALE_LOW) / (SCALE_HIGH - SCALE_LOW)) * 100;
  return Math.max(0, Math.min(100, round(p)));
}
