// Turns a parsed UltraStar note file into a SongRange: the lowest and highest
// sung pitch, where the song mostly sits (tessitura), and whether the lyrics
// come fast.
//
// Only normal (':') and golden ('*') notes count for pitch. Freestyle ('F')
// and rap ('R', 'G') notes carry placeholder pitches that are never judged
// (https://usdx.eu/format/), so they would give nonsense ranges.
//
// Fast lyrics: we count sung syllables in the busiest 10-second window. Rap
// notes count (they are the fastest lyrics there are); "~" notes do not, as
// they hold the previous vowel rather than start a new syllable. Speech runs
// at roughly 5-8 syllables per second (English about 6; Pellegrino, Coupé &
// Marsico 2011, "A cross-language perspective on speech information rate",
// Language 87(3)), while ballads sit around 1-3. A 10 s stretch above 4.5
// syllables/s is near speaking pace: patter, rap verses, tongue-twister
// choruses, which are hard to sing along to from a lyric screen.
//
// Outliers: a single grace note or shout should not set the range, so low and
// high skip the extreme pitches that together take up at most 5% of the sung
// time at each end (a duration-weighted 5th to 95th percentile).
//
// Octave: UltraStar scores pitch class only, so many note files are written
// one or two octaves off (pitch 0 should be C4, but real USDB files put a
// tenor's melody around E6). When the song's typical note lands outside
// E2 to C5, where almost every pop vocal sits, we shift the whole song by
// octaves until it lands inside.

import type { SongRange } from '../contracts';
import { parseUltrastar, secondsPerBeat, type UltrastarFile, type UltrastarNote } from './ultrastar';

export const FAST_LYRICS_SYLLABLES_PER_SECOND = 4.5;
export const FAST_LYRICS_WINDOW_SECONDS = 10;
export const OUTLIER_SHARE = 0.05;
/** Typical (tessitura) notes outside [E2, C5) are treated as octave errors in the file. */
export const PLAUSIBLE_TESSITURA = { low: 40, high: 72 } as const;

/** Whole-octave shift that moves `tessitura` into PLAUSIBLE_TESSITURA. */
export function octaveCorrection(tessitura: number): number {
  let shift = 0;
  while (tessitura + shift >= PLAUSIBLE_TESSITURA.high) shift -= 12;
  while (tessitura + shift < PLAUSIBLE_TESSITURA.low) shift += 12;
  return shift;
}

/** Lowest and highest pitch after dropping the extremes that cover at most `share` of sung time at each end. */
export function trimmedRange(notes: { midi: number; length: number }[], share = OUTLIER_SHARE): { low: number; high: number } {
  const byPitch = new Map<number, number>();
  let total = 0;
  for (const n of notes) {
    byPitch.set(n.midi, (byPitch.get(n.midi) ?? 0) + n.length);
    total += n.length;
  }
  const pitches = [...byPitch.keys()].sort((a, b) => a - b);
  const edge = (order: number[]) => {
    let cum = 0;
    for (const p of order) {
      cum += byPitch.get(p)!;
      if (cum > share * total) return p;
    }
    return order[order.length - 1]!;
  };
  return { low: edge(pitches), high: edge([...pitches].reverse()) };
}

const isPitched = (n: UltrastarNote) => n.type === 'normal' || n.type === 'golden';
const isNewSyllable = (n: UltrastarNote) => n.syllable.trim() !== '~';

/** Syllables per second in the busiest FAST_LYRICS_WINDOW_SECONDS window. */
export function syllableRate(notes: UltrastarNote[], bpm: number): number {
  const spb = secondsPerBeat(bpm);
  const times = notes
    .filter(isNewSyllable)
    .map((n) => n.start * spb)
    .sort((a, b) => a - b);
  let best = 0;
  let end = 0;
  // Two pointers: for each window start, count syllables starting before start + window.
  for (let i = 0; i < times.length; i++) {
    if (end < i) end = i;
    while (end < times.length && times[end]! < times[i]! + FAST_LYRICS_WINDOW_SECONDS) end++;
    best = Math.max(best, end - i);
  }
  return best / FAST_LYRICS_WINDOW_SECONDS;
}

/**
 * Range of one singer in an UltraStar file. `part` is the duet singer number
 * (1 = P1, 2 = P2); duets default to P1.
 */
export function songRangeFromUltrastar(file: UltrastarFile | string, part = 1): SongRange {
  const song = typeof file === 'string' ? parseUltrastar(file) : file;
  const notes = song.players[part - 1];
  if (!notes || notes.length === 0) {
    throw new Error(`UltraStar file has no part ${part}`);
  }
  const pitched = notes.filter((n) => isPitched(n) && n.length > 0);
  if (pitched.length === 0) {
    throw new Error('UltraStar file has no pitched notes to measure');
  }

  let weighted = 0;
  let total = 0;
  for (const n of pitched) {
    weighted += n.midi * n.length;
    total += n.length;
  }
  const tessitura = weighted / total;
  const shift = octaveCorrection(tessitura);
  const { low, high } = trimmedRange(pitched);

  return {
    low: low + shift,
    high: high + shift,
    tessitura: tessitura + shift,
    source: 'note-file',
    confidence: 'high',
    fastLyrics: syllableRate(notes, song.bpm) > FAST_LYRICS_SYLLABLES_PER_SECOND,
  };
}
