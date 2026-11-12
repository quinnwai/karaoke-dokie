// Turns a parsed UltraStar note file into a SongRange: the lowest and highest
// sung pitch, where the song mostly sits (tessitura), and whether the lyrics
// come fast.
//
// Only normal (':') and golden ('*') notes count for pitch. Freestyle ('F')
// and rap ('R', 'G') notes carry placeholder pitches that are never judged
// (https://usdx.eu/format/), so they would give nonsense ranges.
//
// Fast lyrics: for each sung syllable we count the syllables in the 10 seconds
// from it. Rap notes count (they are the fastest lyrics there are); notes
// written "~" or "~a", "~n" and so on do not, as they hold or finish the
// previous syllable rather than start a new one. A song has fast lyrics when
// at least a tenth of its syllables start a 10 s stretch above 4.5 syllables
// per second, so one busy run or ad-lib does not flag a slow song. Speech runs
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
// Narrow ranges (QWW-60): for a song sung almost on one note, that trim can leave 5
// semitones or fewer (Are You Bored Yet? came out G3 to A3 with 69% of the singing on
// one note), and a range that narrow looked Easy to everyone. applyNarrowRule widens a
// note file's range first, with a 1% trim from its pitch histogram, and marks what is
// still 5 semitones or fewer low confidence (the Maybe group, with no label). A
// recording's range, which has no use for the finer trim, is only marked.
//
// Octave: UltraStar scores pitch class only, so many note files are written
// one or two octaves off (pitch 0 should be C4, but real USDB files put a
// tenor's melody around E6). When the song's typical note lands outside
// E2 to C5, where almost every pop vocal sits, we shift the whole song by
// octaves until it lands inside.
//
// Duets: a file with sung notes in both P1 and P2 is sung as a pair, each
// singer on their own part, so each part gets its own range, measured the
// same way as a whole song (its own octave fix included). Lines marked P3 are
// sung by both, so the parser gives them to both parts.

import type { SongPart, SongRange } from '../contracts';
import { parseUltrastar, secondsPerBeat, type UltrastarFile, type UltrastarNote } from './ultrastar';

export const FAST_LYRICS_SYLLABLES_PER_SECOND = 4.5;
/** Share of syllables that must start a fast 10 s stretch. */
export const FAST_LYRICS_MIN_SHARE = 0.1;
export const FAST_LYRICS_WINDOW_SECONDS = 10;
export const OUTLIER_SHARE = 0.05;
/** A range of this many semitones or fewer is too narrow to trust (QWW-60). */
export const NARROW_SPAN = 5;
/** The trim a note file's narrow range is measured again with, instead of OUTLIER_SHARE. */
export const NARROW_OUTLIER_SHARE = 0.01;
/**
 * A step of this many semitones or more between neighbouring pitches that are sung, inside the narrow range's 1% trim, means a note
 * far from the rest: usually a typo in the note file, often an exact octave copy. Of the 654 note files that production's 1% trim
 * would widen (12 Nov), 7 step out by 8 to 16 semitones, each a single stray note, and the other 647 by 7 or less.
 */
export const STRAY_GAP = 8;
/** How far (semitones) a histogram's weighted mean may sit from the stored typical note, at the nearest whole octave, and still describe that song. */
const HISTOGRAM_MEAN_TOLERANCE = 1;
/** Note files outside these bounds are badly transcribed (or mash-ups), so the bulk import drops them and the narrow-range rule does not widen to them. */
export const PLAUSIBLE_SONG = { lowest: 28, highest: 91, widestSpan: 36 } as const;

/** Whether a range is one a song can have: inside PLAUSIBLE_SONG's bounds and no wider than its widest span. */
export function isPlausible(r: { low: number; high: number }): boolean {
  return r.low >= PLAUSIBLE_SONG.lowest && r.high <= PLAUSIBLE_SONG.highest && r.high - r.low <= PLAUSIBLE_SONG.widestSpan;
}
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

/**
 * A note file's range with the NARROW_OUTLIER_SHARE trim, from its stored pitch histogram and in the octave of the
 * stored range; null when there is no histogram, or it does not describe the song (its mean is not the typical note
 * at any whole octave). The octave fix moves a histogram along with the range (shiftRange), so the whole-octave gap
 * between the histogram's mean and the typical note, `octaves`, is 0 for every stored range; it is applied all the
 * same, so a histogram left in the file's octave lands the range in the stored one and not an octave away. `gap` is the
 * widest step between neighbouring pitches that are sung (a share above 0) inside that range.
 */
export function gentleRange(range: SongRange): { low: number; high: number; octaves: number; gap: number } | null {
  const shares = range.pitchShare;
  if (!shares?.length) return null;
  const total = shares.reduce((sum, [, share]) => sum + share, 0);
  if (!(total > 0)) return null;
  const mean = shares.reduce((sum, [midi, share]) => sum + midi * share, 0) / total;
  const octaves = Math.round((range.tessitura - mean) / 12);
  if (Math.abs(range.tessitura - mean - 12 * octaves) > HISTOGRAM_MEAN_TOLERANCE) return null;
  const { low, high } = trimmedRange(shares.map(([midi, length]) => ({ midi, length })), NARROW_OUTLIER_SHARE);
  const sung = shares.filter(([midi, share]) => share > 0 && midi >= low && midi <= high).map(([midi]) => midi).sort((a, b) => a - b);
  let gap = 0;
  for (let i = 1; i < sung.length; i++) gap = Math.max(gap, sung[i]! - sung[i - 1]!);
  return { low: low + 12 * octaves, high: high + 12 * octaves, octaves, gap };
}

/** Whether the narrow-range rule applies to `range`: a note file or a recording of NARROW_SPAN semitones or fewer, and not a duet with parts. */
export function isNarrow(range: SongRange): boolean {
  if (range.duet || range.parts?.length) return false;
  if (range.source !== 'note-file' && range.source !== 'audio-full') return false;
  return range.high - range.low <= NARROW_SPAN;
}

/**
 * The narrow-range rule (QWW-60), for a range the usual 5% trim has just measured or that is stored.
 *   1. A note file whose range is NARROW_SPAN semitones or fewer is measured again with a 1% trim from its pitch
 *      histogram (never narrower than it was). That trim is not used, and the range stays as it was, when it reaches
 *      pitches no song has (isPlausible: a note file with junk notes in it, one reaching G17) or a note STRAY_GAP
 *      semitones or more from its nearest sung neighbour (a typo in the file, often an octave copy: Pretty Maids All
 *      in a Row has 2.1% of its time on a note 16 semitones below the rest, which would make it a Hard song).
 *   2. A range that is still NARROW_SPAN semitones or fewer is marked `confidence: 'low'`: match.ts puts it in the
 *      Maybe group, with no difficulty label, and score.ts takes the low-confidence penalty off its score.
 *   3. A recording (`audio-full`) of NARROW_SPAN semitones or fewer is only marked: its extremes come from a pitch
 *      tracker, not from written notes, and rule 1 is for note files.
 * Duets with parts are left as they are, and so is anything that is not a note file or a recording (an artist
 * estimate is low confidence already). A range that is wider than NARROW_SPAN is returned as it is, so applying the
 * rule again changes nothing: a widened range is wide, a still-narrow one comes out the same from the same histogram.
 * Returns `range` itself when nothing changes.
 */
export function applyNarrowRule(range: SongRange): SongRange {
  if (!isNarrow(range)) return range;
  const finer = range.source === 'note-file' ? gentleRange(range) : null;
  const gentle = finer && isPlausible(finer) && finer.gap < STRAY_GAP ? finer : null;
  const low = gentle ? Math.min(range.low, gentle.low) : range.low;
  const high = gentle ? Math.max(range.high, gentle.high) : range.high;
  // A range the 1% trim widened keeps the confidence it had; one still this narrow is marked.
  const confidence = high - low > NARROW_SPAN ? range.confidence : 'low';
  if (low === range.low && high === range.high && confidence === range.confidence) return range;
  return { ...range, low, high, confidence };
}

const isPitched = (n: UltrastarNote) => n.type === 'normal' || n.type === 'golden';
/** "~" alone or "~" plus letters or punctuation continues the previous syllable. */
const isNewSyllable = (n: UltrastarNote) => !n.syllable.trim().startsWith('~');

/** Syllables per second in the 10 s window starting at each new syllable, in time order. */
function windowRates(notes: UltrastarNote[], bpm: number): number[] {
  const spb = secondsPerBeat(bpm);
  const times = notes
    .filter(isNewSyllable)
    .map((n) => n.start * spb)
    .sort((a, b) => a - b);
  const rates: number[] = [];
  let end = 0;
  // Two pointers: for each window start, count syllables starting before start + window.
  for (let i = 0; i < times.length; i++) {
    if (end < i) end = i;
    while (end < times.length && times[end]! < times[i]! + FAST_LYRICS_WINDOW_SECONDS) end++;
    rates.push((end - i) / FAST_LYRICS_WINDOW_SECONDS);
  }
  return rates;
}

/** Syllables per second in the busiest FAST_LYRICS_WINDOW_SECONDS window. */
export function syllableRate(notes: UltrastarNote[], bpm: number): number {
  return windowRates(notes, bpm).reduce((a, b) => Math.max(a, b), 0);
}

/** Share of syllables that start a 10 s stretch faster than FAST_LYRICS_SYLLABLES_PER_SECOND. */
export function fastShare(notes: UltrastarNote[], bpm: number): number {
  const rates = windowRates(notes, bpm);
  return rates.length ? rates.filter((r) => r > FAST_LYRICS_SYLLABLES_PER_SECOND).length / rates.length : 0;
}

/** Notes that carry a judged pitch and take up time: the only ones that measure a range. */
const pitchedNotes = (notes: UltrastarNote[]) => notes.filter((n) => isPitched(n) && n.length > 0);

/** One singer's notes measured: trimmed range and tessitura (octave-fixed), pitch histogram, fast-lyrics flag. */
function measure(notes: UltrastarNote[], bpm: number): Required<Omit<SongPart, 'singer'>> {
  const pitched = pitchedNotes(notes);
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
  const byPitch = new Map<number, number>();
  for (const n of pitched) byPitch.set(n.midi + shift, (byPitch.get(n.midi + shift) ?? 0) + n.length);
  const pitchShare = [...byPitch.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([midi, len]): [number, number] => [midi, Math.round((len / total) * 1000) / 1000]);

  return {
    low: low + shift,
    high: high + shift,
    tessitura: tessitura + shift,
    pitchShare,
    fastLyrics: fastShare(notes, bpm) >= FAST_LYRICS_MIN_SHARE,
  };
}

/** Each singer's part of a duet, P1 first; null unless both P1 and P2 have pitched notes. */
function duetParts(song: UltrastarFile): SongPart[] | null {
  const pair = song.players.slice(0, 2);
  if (pair.length < 2 || pair.some((notes) => pitchedNotes(notes).length === 0)) return null;
  return pair.map((notes, i) => {
    // #P1/#P2 since format 1.0; older duet files name the singers in #DUETSINGERP1/#DUETSINGERP2.
    const singer = song.headers[`P${i + 1}`] || song.headers[`DUETSINGERP${i + 1}`];
    return { ...(singer ? { singer } : {}), ...measure(notes, song.bpm) };
  });
}

/**
 * Range of one singer in an UltraStar file. `part` is the duet singer number
 * (1 = P1, 2 = P2); duets default to P1. A duet also gets `duet` and both
 * singers' `parts`; the top-level fields stay the asked-for part's.
 */
export function songRangeFromUltrastar(file: UltrastarFile | string, part = 1): SongRange {
  const song = typeof file === 'string' ? parseUltrastar(file) : file;
  const notes = song.players[part - 1];
  if (!notes || notes.length === 0) {
    throw new Error(`UltraStar file has no part ${part}`);
  }
  const { low, high, tessitura, pitchShare, fastLyrics } = measure(notes, song.bpm);
  const range: SongRange = { low, high, tessitura, source: 'note-file', confidence: 'high', fastLyrics, pitchShare };
  const parts = duetParts(song);
  if (parts) {
    range.duet = true;
    range.parts = parts;
  }
  return applyNarrowRule(range);
}
