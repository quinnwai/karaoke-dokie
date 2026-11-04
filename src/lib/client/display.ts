// Plain-words text and geometry for the screen. No music jargon reaches the user.

import type { DataSourceLogEntry, Label, LogOutcome, Match, Midi, OctaveShift, SliderId, SongRange, VocalRange } from '../contracts';
import { midiToNoteName } from '../audio/notes';

export function difficultyLabel(d: Label): string {
  return d === 'easy' ? 'Easy' : d === 'medium' ? 'Medium' : d === 'hard' ? 'Hard' : 'Maybe';
}

/** Shown only when the song fits after moving it; null when it fits as written. */
export function octaveWording(octave: OctaveShift): string | null {
  if (octave === 'up') return 'Sing it higher than the artist';
  if (octave === 'down') return 'Sing it lower than the artist';
  return null;
}

const OUTCOME_TEXT: Record<LogOutcome, string> = {
  'note-file': 'Measured from a note-by-note file of this song.',
  'audio-full': 'From a recording of this song.',
  'artist-typical': "Estimated from this artist's usual singing range.",
  'artist-external': 'Estimated from published info about this artist.',
  skipped: "We couldn't find range info for this song.",
};

/** Under the Maybe heading in the results. */
export const MAYBE_NOTE = 'We only have an estimate of these songs’ range. They fit yours, give or take a couple of notes.';

const MAYBE_TEXT = 'This range is only an estimate, so the song is a maybe: it fits your range, give or take a couple of notes.';

/** Text for the "i" button on a song; Maybe songs also say their range is an estimate. */
export function sourceTooltip(entry: DataSourceLogEntry | undefined, maybe = false): string {
  const reason = entry?.reason.trim();
  const text = !entry
    ? "We don't have details on where this song's range came from."
    : reason
      ? `${OUTCOME_TEXT[entry.outcome]} ${reason}`
      : OUTCOME_TEXT[entry.outcome];
  return maybe ? `${text} ${MAYBE_TEXT}` : text;
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

// ---- results view (QWW-3) ----

/** Which reasons speak to each slider, so the reason line leads with why the song is where it is. */
const SLIDER_REASONS: Record<SliderId, RegExp> = {
  difficulty: /^(In your sweet spot|Mostly comfortable|A few notes near your (high|low) end|Spends time at your (high|low) end)$/,
  familiarity: /^(In your top songs(?: this month|, past 6 months|, past year)|Played recently|In your playlists|You (play this a lot|know this one))$/,
  popularity: /^Crowd favourite/,
};

/** The song's reasons with the one that matches the leading slider first (unchanged when no slider leads). */
export function reasonsForSlider(reasons: string[] | undefined, lead: SliderId | null): string[] {
  const list = reasons ?? [];
  if (!lead) return list;
  const re = SLIDER_REASONS[lead];
  return [...list.filter((r) => re.test(r)), ...list.filter((r) => !re.test(r))];
}

/** "Take Lady Gaga's part" for a duet matched on one part; null for everything else. */
export function duetPartLine(m: Pick<Match, 'part' | 'partSinger' | 'range'>): string | null {
  if (!m.range.duet || !m.part) return null;
  const singer = m.partSinger?.trim();
  return singer ? `Duet: take ${singer}'s part` : `Duet: take part ${m.part}`;
}

/** "Queen · 1975", or just the artist when the year is unknown. */
export function artistLine(m: Pick<Match, 'track' | 'year'>): string {
  return typeof m.year === 'number' ? `${m.track.artist} · ${m.year}` : m.track.artist;
}

/** Catalogue songs have no Spotify track of their own, only a search. */
export const isCatalogueTrack = (trackId: string) => trackId.startsWith('cat:');
