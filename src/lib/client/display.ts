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

/**
 * Under the Maybe heading in the results. A Maybe range is an artist's estimate, a rough recording, or a very narrow
 * range of a song that stays on a note or two (QWW-60), so this says only that we are less sure, never that it is an estimate.
 */
export const MAYBE_NOTE = 'We’re less sure of these songs’ range. They fit yours, give or take a couple of notes.';

const MAYBE_TEXT = 'We’re less sure of this song’s range, so it’s a maybe: it fits your range, give or take a couple of notes.';

/** Text for the "i" button on a song; Maybe songs also say we are less sure of their range. */
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

/** One bar of the time-in-range histogram above the range bar. */
export interface ShapeBar {
  /** Percent from the left edge of the bar, on the same scale as Span. */
  left: number;
  /** Percent of the bar's width. */
  width: number;
  /** Share of sung time as a height, 0 to 100: the tallest bin is 100. */
  height: number;
}

export interface RangeBar {
  user: Span;
  /** The song as the user will sing it (octave shift applied). */
  song: Span;
  /** The song as recorded, drawn faintly, when it is sung an octave away; clipped to the bar. */
  original?: { left: number; width: number };
  /**
   * The time-in-range histogram: one bar for each bin of the user's range that has sung time, none for an
   * empty bin, and each cut to the song's span so no bar sticks out of the pink stretch. Unset when there are none.
   */
  shape?: ShapeBar[];
}

const PAD = 2; // semitones of breathing room at each end

/**
 * Lays the song's range over the user's range on one scale.
 * When the song fits an octave up or down, the song span shows the notes the
 * user will actually sing.
 */
export function rangeBar(user: VocalRange, song: SongRange, octave: OctaveShift, shape?: number[]): RangeBar {
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
  const bar: RangeBar = { user: span(user.low, user.high), song: span(songLow, songHigh) };
  if (shift !== 0) {
    const lo = Math.max(min, song.low);
    const hi = Math.min(max, song.high);
    if (hi > lo) bar.original = { left: span(lo, hi).left, width: span(lo, hi).width };
  }
  const tallest = Math.max(0, ...(shape ?? []));
  if (shape && tallest > 0) {
    // The bins are equal slices of the user's range, 2.9 semitones wide for D#2 to D5, so a bin holding the song's
    // top note ran on past it. Each bar is cut to the pink stretch as drawn instead; a bin outside it has no bar.
    const pinkLeft = bar.song.left;
    const pinkRight = bar.song.left + bar.song.width;
    const binWidth = (user.high - user.low) / shape.length;
    const edge = (i: number) => round(((user.low + i * binWidth - min) / (max - min)) * 100);
    const bars: ShapeBar[] = [];
    shape.forEach((share, i) => {
      if (!(share > 0)) return;
      const left = Math.max(edge(i), pinkLeft);
      const width = round(Math.min(edge(i + 1), pinkRight) - left);
      if (width > 0) bars.push({ left, width, height: Math.round((100 * share) / tallest) });
    });
    if (bars.length) bar.shape = bars;
  }
  return bar;
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
  difficulty: /^(In your sweet spot|Mostly comfortable|(?:Some|Lots of) (?:high|low) notes)$/,
  familiarity: /^(Top songs(?: this month|, past 6 months| this past year)|Played recently|In your playlists|You (play this a lot|know this one))$/,
  popularity: /^Crowd favourite/,
  tempo: /^(?!)/, // no reason line speaks to tempo
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
