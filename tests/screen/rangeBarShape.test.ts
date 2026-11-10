// The bars above the song page's range bar (QWW-55): one for each bin that has sung time, none for an empty bin,
// and none that sticks out of the pink stretch. tests/songs/shape.test.ts covers which notes land in which bin;
// this takes the shape on to the geometry the screen draws.
import { describe, expect, it } from 'vitest';
import { rangeBar, type RangeBar } from '../../src/lib/client/display';
import { SHAPE_BINS, type SongRange, type VocalRange } from '../../src/lib/contracts';
import { shapeOf } from '../../src/lib/songs/score';
import { areYouWithMe, seeded, sweepCases, USER_D2_TO_D5 } from '../songs/rangeBarFixture';

/** Percent: the bar's numbers are rounded to two decimals. */
const TOLERANCE = 0.01;
/** Percent: how far into an empty bin a bar must reach to count as over it. A bin is at least 1 semitone, 1.5% of the bar or more. */
const INSET = 0.05;

/** Every bar has some width, sits inside the pink stretch, and comes after the one before it without overlapping it. */
function expectBarsInsidePink(bar: RangeBar, label: string) {
  const pinkLeft = bar.song.left;
  const pinkRight = bar.song.left + bar.song.width;
  let end = -Infinity;
  for (const b of bar.shape ?? []) {
    expect(b.width, label).toBeGreaterThan(0);
    expect(b.left, label).toBeGreaterThanOrEqual(pinkLeft - TOLERANCE);
    expect(b.left + b.width, label).toBeLessThanOrEqual(pinkRight + TOLERANCE);
    expect(b.left, label).toBeGreaterThanOrEqual(end - TOLERANCE);
    expect(b.height, label).toBeGreaterThanOrEqual(0);
    expect(b.height, label).toBeLessThanOrEqual(100);
    end = b.left + b.width;
  }
}

describe('range bar shape: Are You With Me, D#2 to D5 (QWW-55)', () => {
  const range = areYouWithMe();
  const shape = shapeOf(USER_D2_TO_D5, range, 'none');
  const bar = rangeBar(USER_D2_TO_D5, range, 'none', shape);

  it('draws a bar for each of the three bins with singing in them, and none for the nine empty ones', () => {
    expect(shape).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 35, 16, 49]);
    expect(bar.song).toMatchObject({ low: 'G4', high: 'C#5' });
    expect(bar.shape).toHaveLength(3);
    expect(bar.shape!.map((b) => b.height)).toEqual([71, 33, 100]);
  });

  it('cuts the first bar at G4 and the last at C#5, where they used to run on to the edge of the singer’s range', () => {
    const [first, middle, last] = bar.shape!;
    const pinkRight = bar.song.left + bar.song.width;
    // Bin 9 is 65.25 to 68.2 and starts 1.75 semitones before G4 (67); bin 11 is 71.1 to 74 and ends a semitone after C#5 (73).
    expect(first!.left).toBeCloseTo(bar.song.left, 2);
    expect(last!.left + last!.width).toBeCloseTo(pinkRight, 2);
    expect(last!.left + last!.width).toBeLessThan(bar.user.left + bar.user.width); // D5 is further right
    // The bin between is whole: 68.2 to 71.1 is inside G4 to C#5.
    expect(middle).toEqual({ left: 79.91, width: 7.48, height: 33 });
    expectBarsInsidePink(bar, 'Are You With Me');
  });

  it('sung an octave lower, the same notes make the same bars', () => {
    const recordedHigh: SongRange = {
      ...range,
      low: range.low + 12,
      high: range.high + 12,
      pitchShare: range.pitchShare!.map(([midi, share]) => [midi + 12, share]),
    };
    const down = rangeBar(USER_D2_TO_D5, recordedHigh, 'down', shapeOf(USER_D2_TO_D5, recordedHigh, 'down'));
    expect(down.shape).toEqual(bar.shape);
    expect(down.song).toEqual(bar.song);
  });
});

describe('range bar shape: which bars there are', () => {
  const user: VocalRange = { low: 45, high: 72, source: 'test' }; // A2 to C5, bins 2.25 semitones wide
  const song = (low: number, high: number): SongRange => ({ low, high, tessitura: (low + high) / 2, source: 'note-file', confidence: 'high', fastLyrics: false });

  it('has no bar for a bin with no sung time', () => {
    const bar = rangeBar(user, song(50, 64), 'none', [0, 0, 5, 0, 0, 5, 0, 0, 0, 0, 0, 0]);
    // Bin 2 (49.5 to 51.75, cut at 50) and bin 5 (56.25 to 58.5); nothing between or after.
    expect(bar.shape).toEqual([
      { left: 22.58, width: 5.65, height: 100 },
      { left: 42.74, width: 7.26, height: 100 },
    ]);
  });

  it('has no bar for a bin wholly outside the song, and no bars at all when every bin is', () => {
    expect(rangeBar(user, song(50, 64), 'none', [5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5]).shape).toBeUndefined();
  });

  it('keeps a bar for a bin with only a little sung time, at least a sliver tall', () => {
    const bar = rangeBar(user, song(50, 64), 'none', [0, 0, 0, 1, 99, 0, 0, 0, 0, 0, 0, 0]);
    expect(bar.shape!.map((b) => b.height)).toEqual([1, 100]);
  });
});

describe('range bar shape: over many singers and songs', () => {
  it('draws a bar inside the pink stretch for every bin with sung time, and for no other', () => {
    for (const { label, user, song, octave } of sweepCases()) {
      const shape = shapeOf(user, song, octave)!;
      const bar = rangeBar(user, song, octave, shape);
      expect(bar.shape?.length, label).toBe(shape.filter((b) => b > 0).length);
      expectBarsInsidePink(bar, label);
      expect(Math.max(...bar.shape!.map((b) => b.height)), label).toBe(100);
    }
  });

  it('stays inside the pink stretch and out of the empty bins for any shape, even one with sung time where the song is not', () => {
    const rand = seeded(7);
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    for (const { label, user, song, octave } of sweepCases()) {
      for (let k = 0; k < 8; k++) {
        const shape = Array.from({ length: SHAPE_BINS }, () => (rand() < 0.45 ? 0 : int(1, 60)));
        const bar = rangeBar(user, song, octave, shape);
        expectBarsInsidePink(bar, `${label}, ${shape.join(' ')}`);
        expect(bar.shape?.length ?? 0, label).toBeLessThanOrEqual(shape.filter((b) => b > 0).length);
        // An empty bin's own stretch of the bar, between the bars of its neighbours: nothing is drawn over it.
        const x = (midi: number) => bar.user.left + ((midi - user.low) / (user.high - user.low)) * bar.user.width;
        shape.forEach((b, i) => {
          if (b > 0) return;
          const from = x(user.low + (i * (user.high - user.low)) / SHAPE_BINS) + INSET;
          const to = x(user.low + ((i + 1) * (user.high - user.low)) / SHAPE_BINS) - INSET;
          const over = (bar.shape ?? []).filter((s) => s.left < to && s.left + s.width > from);
          expect(over, `${label}, empty bin ${i}`).toEqual([]);
        });
      }
    }
  });
});
