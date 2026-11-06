import { describe, expect, it } from 'vitest';
import { calibrate, MIN_OVERLAP, onScale, quantile, type CalibrationSong } from '../../src/lib/popularity/calibrate';

describe('onScale', () => {
  const points: [number, number][] = [[0, 0], [10, 0.5], [100, 1]];
  it('interpolates between points and clamps outside them', () => {
    expect(onScale(points, -5)).toBe(0);
    expect(onScale(points, 5)).toBeCloseTo(0.25);
    expect(onScale(points, 55)).toBeCloseTo(0.75);
    expect(onScale(points, 1e9)).toBe(1);
  });
});

describe('quantile', () => {
  it('interpolates between neighbours', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([0, 10], 0.25)).toBe(2.5);
  });
});

describe('calibrate', () => {
  // 1,000 songs: USDB views 1..1000; karaoke views 1000x theirs (another unit, same order); stars
  // 1-5; the top 100 charted in the top 20, the 200 below them lower down the chart.
  const songs: CalibrationSong[] = Array.from({ length: 1000 }, (_, i) => ({
    usdbViews: i + 1,
    karaokeViews: (i + 1) * 1000,
    usdbRating: 1 + Math.floor(i / 200),
    chartRank: i >= 700 ? (i >= 900 ? 5 : 50) : undefined,
  }));
  const { scale, counts } = calibrate(songs);

  it('scores USDB views by their percentile in the catalogue', () => {
    expect(onScale(scale.usdbViews, 1)).toBe(0);
    expect(onScale(scale.usdbViews, 500.5)).toBeCloseTo(0.5, 2);
    expect(onScale(scale.usdbViews, 1000)).toBe(1);
  });

  it('gives a song the same score whichever source measured it', () => {
    for (const v of [20, 377, 650, 990]) {
      expect(onScale(scale.karaokeViews, v * 1000)).toBeCloseTo(onScale(scale.usdbViews, v), 2);
    }
  });

  it('sets each chart floor at the lower quartile of its tier', () => {
    // Top 20: songs scoring 0.9 to 1, lower quartile 0.93 (to 2 places). The others: 0.7 to 0.9, so 0.75.
    expect(scale.chartFloor.top20).toBe(0.93);
    expect(scale.chartFloor.top100).toBe(0.75);
    expect(counts).toMatchObject({ anchor: 1000, karaokeViews: 1000, spotify: 0, top20: 100, top100: 200 });
  });

  it('leaves Spotify and Deezer empty when too few songs have them', () => {
    expect(scale.spotify).toEqual([]);
    expect(scale.deezer).toEqual([]);
  });

  it('links Deezer rank to USDB views on the songs that have both (QWW-37)', () => {
    // Deezer rank in its own unit (500x the views, plus 100,000), same order.
    const withDeezer = songs.map((s, i) => (i % 2 ? { ...s, deezerRank: 100_000 + s.usdbViews! * 500 } : s));
    const linked = calibrate(withDeezer);
    expect(linked.counts.deezer).toBe(500);
    for (const v of [20, 377, 650, 990]) {
      expect(onScale(linked.scale.deezer, 100_000 + v * 500)).toBeCloseTo(onScale(linked.scale.usdbViews, v), 1);
    }
  });

  it('refuses to calibrate without enough USDB views', () => {
    expect(() => calibrate(songs.slice(0, MIN_OVERLAP - 1))).toThrow(/USDB views/);
  });
});
