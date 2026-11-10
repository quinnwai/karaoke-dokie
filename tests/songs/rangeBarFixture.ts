// "Are You With Me" (Lost Frequencies) on the song page, the case behind QWW-55: a singer with D#2 to D5 and a
// song whose range is G4 to C#5. The notes are made up, but they go through the real note-file parser, so low and
// high are trimmed the way production's are (the 5% of sung time at each end is skipped) while pitchShare keeps
// every note, the outliers included.
import type { OctaveShift, SongRange, VocalRange } from '../../src/lib/contracts';
import { songRangeFromUltrastar } from '../../src/lib/songs/range';

/** D#2 to D5: 35 semitones, so a twelfth of the range is 2.9 semitones and the bin edges fall between notes. */
export const USER_D2_TO_D5: VocalRange = { low: 39, high: 74, source: 'test' };

/**
 * [semitones above C4, beats]: 100 beats, 4 below G4, 92 from G4 to C#5 and 4 above. The notes sit at the ends
 * of G4 to C#5 (a bin holding the top note ran past it), and D#5 and E5 are past the singer's D5.
 */
const NOTES: [number, number][] = [
  [4, 1], [5, 1], [6, 2], // E4, F4, F#4: below the range
  [7, 20], [8, 12], [9, 5], [10, 4], [11, 6], [12, 24], [13, 21], // G4 to C#5
  [14, 1], [15, 1], [16, 2], // D5, D#5, E5: above it
];

/** An UltraStar note file with these notes one after the other. */
export function noteFile(notes: [number, number][] = NOTES): string {
  let beat = 0;
  const lines = notes.map(([pitch, length]) => {
    const line = `: ${beat} ${length} ${pitch} la`;
    beat += length;
    return line;
  });
  return ['#BPM:120', ...lines, 'E', ''].join('\n');
}

/** The song as the server holds it: G4 to C#5 as the range, every note in pitchShare. */
export function areYouWithMe(): SongRange {
  return songRangeFromUltrastar(noteFile());
}

/** Pseudo-random numbers from a seed (mulberry32), so a failing case can be replayed. */
export function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SweepCase {
  label: string;
  user: VocalRange;
  song: SongRange;
  octave: OctaveShift;
}

/**
 * Many singers and songs the way the server lists them: user ranges 12 to 48 semitones wide (so a bin is 1 to 4
 * semitones, on whole notes for some and between notes for most), a song as sung anywhere inside the range, sung as
 * recorded or an octave away, with a note histogram that has gaps and a few semitones of outlier notes past each end of
 * the song's range (past the singer's range too, where it is close to the edge).
 */
export function sweepCases(): SweepCase[] {
  const rand = seeded(20261110);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const cases: SweepCase[] = [];
  for (const width of [12, 13, 17, 24, 29, 35, 36, 41, 48]) {
    for (let k = 0; k < 12; k++) {
      const user: VocalRange = { low: int(36, 48), high: 0, source: 'test' };
      user.high = user.low + width;
      const sungLow = int(user.low, user.high - 2);
      const sungHigh = int(sungLow + 2, user.high);
      const octave = (['none', 'down', 'up'] as const)[int(0, 2)]!;
      // The recording is an octave above what is sung for 'down' and an octave below for 'up'.
      const recorded = octave === 'down' ? 12 : octave === 'up' ? -12 : 0;
      const low = sungLow + recorded;
      const high = sungHigh + recorded;
      const weights: [number, number][] = [];
      for (let midi = low - 3; midi <= high + 3; midi++) {
        const atEnd = midi === low || midi === high;
        if (atEnd || rand() > 0.3) weights.push([midi, 0.1 + rand()]);
      }
      const total = weights.reduce((sum, [, w]) => sum + w, 0);
      const song: SongRange = {
        low,
        high,
        tessitura: (low + high) / 2,
        source: 'note-file',
        confidence: 'high',
        fastLyrics: false,
        pitchShare: weights.map(([midi, w]): [number, number] => [midi, w / total]),
      };
      cases.push({ label: `user ${user.low}-${user.high}, song ${low}-${high}, ${octave}`, user, song, octave });
    }
  }
  return cases;
}
