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

import type { SongRange } from '../contracts';
import { parseUltrastar, secondsPerBeat, type UltrastarFile, type UltrastarNote } from './ultrastar';

export const FAST_LYRICS_SYLLABLES_PER_SECOND = 4.5;
export const FAST_LYRICS_WINDOW_SECONDS = 10;

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

  let low = Infinity;
  let high = -Infinity;
  let weighted = 0;
  let total = 0;
  for (const n of pitched) {
    low = Math.min(low, n.midi);
    high = Math.max(high, n.midi);
    weighted += n.midi * n.length;
    total += n.length;
  }

  return {
    low,
    high,
    tessitura: weighted / total,
    source: 'note-file',
    confidence: 'high',
    fastLyrics: syllableRate(notes, song.bpm) > FAST_LYRICS_SYLLABLES_PER_SECOND,
  };
}
