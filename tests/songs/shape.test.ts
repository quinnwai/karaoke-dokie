// The time-in-range shape behind the song page's bars (QWW-55). Bars were drawn where the song is not: a bin that
// held the song's top note ran past it, notes the song's range skips still counted, and notes past the singer's
// range were piled into the edge bin. Everything here is about shapeOf (score.ts); tests/screen/rangeBarShape.test.ts
// takes it on to the pixels.
import { describe, expect, it } from 'vitest';
import { SHAPE_BINS, type SongRange, type VocalRange } from '../../src/lib/contracts';
import { shapeOf } from '../../src/lib/songs/score';
import { areYouWithMe, sweepCases, USER_D2_TO_D5 } from './rangeBarFixture';

const user: VocalRange = { low: 48, high: 72, source: 'test' }; // C3 to C5: bins two semitones wide, edges on whole notes
const song = (low: number, high: number, pitchShare?: [number, number][]): SongRange => ({
  low,
  high,
  tessitura: (low + high) / 2,
  source: 'note-file',
  confidence: 'high',
  fastLyrics: false,
  ...(pitchShare ? { pitchShare } : {}),
});

/** Where a bin of the user's range starts and ends, in semitones. */
const binEdges = (u: VocalRange, i: number): [number, number] => [u.low + (i * (u.high - u.low)) / SHAPE_BINS, u.low + ((i + 1) * (u.high - u.low)) / SHAPE_BINS];

describe('shapeOf: Are You With Me, D#2 to D5 (QWW-55)', () => {
  const range = areYouWithMe();

  it('the note file keeps notes outside the range it reports: low and high skip 5% of sung time at each end', () => {
    expect(range).toMatchObject({ low: 67, high: 73 }); // G4 to C#5
    const outside = range.pitchShare!.filter(([midi]) => midi < 67 || midi > 73);
    expect(outside.map(([midi]) => midi)).toEqual([64, 65, 66, 74, 75, 76]);
    expect(outside.reduce((sum, [, share]) => sum + share, 0)).toBeCloseTo(0.08, 6);
  });

  it('counts only the notes inside G4 to C#5, so no bin is filled below the song or at the singer’s edge', () => {
    const shape = shapeOf(USER_D2_TO_D5, range, 'none')!;
    expect(shape).toHaveLength(SHAPE_BINS);
    // A twelfth is 2.9 semitones: G4 and G#4 are in bin 9, A4 to B4 in bin 10, C5 and C#5 in bin 11.
    expect(shape).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 35, 16, 49]);
  });

  it('the whole histogram, as it was binned, filled a bin wholly below G4 and the last bin with notes past D5', () => {
    const wholeHistogram = new Array<number>(SHAPE_BINS).fill(0);
    for (const [midi, share] of range.pitchShare!) {
      const at = (midi - USER_D2_TO_D5.low) / (USER_D2_TO_D5.high - USER_D2_TO_D5.low);
      wholeHistogram[Math.min(SHAPE_BINS - 1, Math.max(0, Math.floor(at * SHAPE_BINS)))]! += share;
    }
    const wholly = (i: number) => {
      const [lo, hi] = binEdges(USER_D2_TO_D5, i);
      return hi <= range.low || lo >= range.high;
    };
    expect(wholeHistogram.flatMap((b, i) => (b > 0 && wholly(i) ? [i] : []))).toEqual([8]); // 2% in 62.3 to 65.3, below G4 (67)
    expect(wholeHistogram[11]).toBeCloseTo(0.49, 6); // 0.45 from C5 and C#5, plus 0.04 from D5 to E5, two of those semitones past the singer's top
    const shape = shapeOf(USER_D2_TO_D5, range, 'none')!;
    expect(shape.flatMap((b, i) => (b > 0 && wholly(i) ? [i] : []))).toEqual([]);
  });

  it('gives the same shape for the notes recorded an octave higher and sung an octave down', () => {
    const recordedHigh: SongRange = {
      ...range,
      low: range.low + 12,
      high: range.high + 12,
      tessitura: range.tessitura + 12,
      pitchShare: range.pitchShare!.map(([midi, share]) => [midi + 12, share]),
    };
    expect(shapeOf(USER_D2_TO_D5, recordedHigh, 'down')).toEqual(shapeOf(USER_D2_TO_D5, range, 'none'));
    const recordedLow: SongRange = { ...recordedHigh, low: range.low - 12, high: range.high - 12, pitchShare: range.pitchShare!.map(([midi, share]) => [midi - 12, share]) };
    expect(shapeOf(USER_D2_TO_D5, recordedLow, 'up')).toEqual(shapeOf(USER_D2_TO_D5, range, 'none'));
  });
});

describe('shapeOf: which notes count', () => {
  it('skips the outlier notes the song’s range skips, instead of binning them past the song', () => {
    // C3 to C5, song D3 to B3 (50 to 59): the notes at 40 and 70 are the trimmed 4% at each end.
    const s = song(50, 59, [[40, 0.04], [50, 0.46], [59, 0.46], [70, 0.04]]);
    expect(shapeOf(user, s, 'none')).toEqual([0, 50, 0, 0, 0, 50, 0, 0, 0, 0, 0, 0]);
  });

  it('drops a note outside the singer’s range, not piling it into the edge bin', () => {
    // A song wider than the singer (the range is not trimmed away): its end notes have no bin.
    const s = song(40, 80, [[40, 0.2], [60, 0.6], [80, 0.2]]);
    expect(shapeOf(user, s, 'none')).toEqual([0, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, 0]);
  });

  it('has no shape without a histogram, with none of its notes in range, or with no room', () => {
    expect(shapeOf(user, song(50, 58), 'none')).toBeUndefined();
    expect(shapeOf(user, song(50, 58, [[40, 0.5], [70, 0.5]]), 'none')).toBeUndefined();
    expect(shapeOf(user, song(50, 58, [[50, 0], [58, 0]]), 'none')).toBeUndefined();
    expect(shapeOf({ low: 60, high: 60, source: 'test' }, song(60, 60, [[60, 1]]), 'none')).toBeUndefined();
  });
});

describe('shapeOf: which bin a note goes in', () => {
  it('puts a note on a bin’s edge in the bin above, and the song’s top note in the bin below', () => {
    // Bin edges are on whole notes: 48, 50, 52, ...
    const s = song(50, 62, [[50, 0.2], [56, 0.6], [62, 0.2]]);
    const shape = shapeOf(user, s, 'none')!;
    expect(shape[1]).toBe(20); // 50 starts bin 1 (50 to 52)
    expect(shape[4]).toBe(60); // 56 starts bin 4
    expect(shape[6]).toBe(20); // 62 is the top note: bin 6 (60 to 62), which the song's range reaches, not bin 7 (62 to 64), which it only touches
    expect(shape[7]).toBe(0);
  });

  it('keeps the singer’s own top note in the last bin', () => {
    const shape = shapeOf(user, song(66, 72, [[66, 0.5], [72, 0.5]]), 'none')!;
    expect(shape[9]).toBe(50);
    expect(shape[11]).toBe(50);
  });

  it('puts a bin with any sung time at 1 or more, so 0 means no notes', () => {
    const shape = shapeOf(user, song(60, 63, [[60, 0.999], [63, 0.001]]), 'none')!;
    expect(shape[6]).toBe(100);
    expect(shape[7]).toBe(1); // 0.1% rounds to 0, and would have drawn nothing
    expect(shape.filter((b) => b === 0)).toHaveLength(SHAPE_BINS - 2);
  });
});

describe('shapeOf: over many singers and songs', () => {
  const cases = sweepCases();

  it('gives every bin with notes some width inside the song, and none to a bin without', () => {
    for (const { label, user: u, song: s, octave } of cases) {
      const shape = shapeOf(u, s, octave);
      expect(shape, label).toBeDefined();
      const shift = octave === 'down' ? -12 : octave === 'up' ? 12 : 0;
      const [pinkLow, pinkHigh] = [s.low + shift, s.high + shift];
      shape!.forEach((b, i) => {
        const [lo, hi] = binEdges(u, i);
        const overlap = Math.min(hi, pinkHigh) - Math.max(lo, pinkLow);
        // The notes of this bin: those the song's range covers, as sung, that this bin's slice holds.
        const notes = s.pitchShare!.filter(([midi]) => midi >= s.low && midi <= s.high).map(([midi]) => midi + shift);
        const inBin = notes.filter((n) => n >= lo && n <= hi);
        if (b > 0) expect(overlap, `${label}: bin ${i}`).toBeGreaterThan(0);
        else expect(inBin.filter((n) => n > lo && n < hi), `${label}: bin ${i}`).toEqual([]); // 0 is no notes (an edge note may be in the bin next door)
      });
    }
  });

  it('shares out 100 percent over the bins that have notes, each off by less than a whole percent for rounding', () => {
    for (const { label, user: u, song: s, octave } of cases) {
      const shape = shapeOf(u, s, octave)!;
      const filled = shape.filter((b) => b > 0).length;
      expect(Math.abs(shape.reduce((a, b) => a + b, 0) - 100), label).toBeLessThanOrEqual(filled);
    }
  });
});
