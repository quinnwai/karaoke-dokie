// The art rules from spec §5 (row lane) and §6 (gear art), with the numbers the spec gives.

import { describe, expect, it } from 'vitest';
import { EASY, HARD, itemOpacity, laneArt, laneColor, metronome, MID, rowLane } from '../../src/lib/setlist/art';

describe('laneColor (spec §6)', () => {
  it('is green below 34, amber below 67 and red from there, for the whole numbers a slider holds', () => {
    expect([0, 1, 33].map(laneColor)).toEqual([EASY, EASY, EASY]);
    expect([34, 50, 66].map(laneColor)).toEqual([MID, MID, MID]);
    expect([67, 100].map(laneColor)).toEqual([HARD, HARD]);
    expect([EASY, MID, HARD]).toEqual(['#4FD17A', '#F5B82E', '#FF6B70']);
  });

  it('cuts at exact thirds, the thirds the engine places Easy, Medium and Hard songs in: 33.4 is Medium and 66.7 is Hard', () => {
    // A row's place has a decimal, and a song at 33.4 is in the Medium third. For whole numbers this is the spec's 34 and 67.
    expect([33.3, 33.33].map(laneColor)).toEqual([EASY, EASY]);
    expect([33.4, 33.9].map(laneColor)).toEqual([MID, MID]);
    expect([66.6, 66.66].map(laneColor)).toEqual([MID, MID]);
    expect([66.7, 66.9].map(laneColor)).toEqual([HARD, HARD]);
    // The cuts themselves belong to the next tier up: 100 / 3 is amber, 200 / 3 is red.
    expect([100 / 3, 200 / 3].map(laneColor)).toEqual([MID, HARD]);
  });

  it('agrees with a whole number\'s tier at every whole number from 0 to 100, as the spec\'s cuts do', () => {
    const spec = (v: number) => (v < 34 ? EASY : v < 67 ? MID : HARD);
    for (let v = 0; v <= 100; v++) expect(laneColor(v), `at ${v}`).toBe(spec(v));
  });
});

describe('difficulty art (spec §6)', () => {
  it('draws a band of 14 + difficulty × 0.62 around y = 40', () => {
    // 20 -> 26.4 high, top 40 - 13.2 = 26.8
    expect(laneArt(20)).toMatchObject({ bandH: 26, bandY: 27, color: EASY });
    // 0 -> 14 high; 100 -> 76 high
    expect(laneArt(0)).toMatchObject({ bandH: 14, bandY: 33 });
    expect(laneArt(100)).toMatchObject({ bandH: 76, bandY: 2, color: HARD });
  });

  it('spreads seven dashes over the band, offset by DASH_OFFSETS', () => {
    // difficulty 60: bandH = 51.2, so y = round(40 + o × (25.6 - 3) - 3) = round(37 + o × 22.6)
    expect(laneArt(60).dashY).toEqual([55, 42, 14, 30, 60, 23, 17]);
    // The band is only a backdrop: a harder song spreads the dashes wider.
    const spread = (d: number) => Math.max(...laneArt(d).dashY) - Math.min(...laneArt(d).dashY);
    expect(spread(100)).toBeGreaterThan(spread(60));
    expect(spread(60)).toBeGreaterThan(spread(0));
  });
});

describe('history notes and popularity bolts (spec §6)', () => {
  it('shows item i once the value reaches (i + 0.5) × 100 / 7', () => {
    const shown = (v: number) => [0, 1, 2, 3, 4, 5, 6].map((i) => itemOpacity(v, i));
    expect(shown(0)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(shown(7)).toEqual([0, 0, 0, 0, 0, 0, 0]); // threshold of the first is 7.14
    expect(shown(8)).toEqual([1, 0, 0, 0, 0, 0, 0]);
    expect(shown(50)).toEqual([1, 1, 1, 1, 0, 0, 0]);
    expect(shown(100)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
});

describe('metronome (spec §6, test 12)', () => {
  it('Tempo 55 swings ±14° with a half-swing of 0.45 s', () => {
    expect(metronome(55)).toMatchObject({ amplitude: 14, keyframes: 'swing14', period: '0.45', animation: 'swing14 0.45s ease-in-out infinite alternate' });
  });

  it('swings ±20° at the slow end and ±8° at the fast end', () => {
    expect(metronome(0)).toMatchObject({ amplitude: 20, keyframes: 'swing20', period: '1.20' });
    expect(metronome(100)).toMatchObject({ amplitude: 8, keyframes: 'swing8', period: '0.30' });
  });

  it('slides the weight down the rod as tempo rises', () => {
    expect(metronome(0).weightY).toBe(16);
    expect(metronome(45).weightY).toBe(28);
    expect(metronome(100).weightY).toBe(43);
  });

  it('only uses keyframes that exist', () => {
    const names = new Set([20, 18, 16, 14, 12, 10, 8].map((n) => `swing${n}`));
    for (let t = 0; t <= 100; t++) expect(names.has(metronome(t).keyframes)).toBe(true);
  });
});

describe('row lane (spec §5)', () => {
  it('makes the band 6 + d × 0.22 high around the middle of the 30 px lane', () => {
    // d = 0: band 6, top 12
    expect(rowLane(0)).toMatchObject({ bandHeight: 6, bandTop: 12, color: EASY });
    // d = 100: band 28, top 1
    expect(rowLane(100)).toMatchObject({ bandHeight: 28, bandTop: 1, color: HARD });
  });

  it('puts the three dashes at offsets 0.7, -1 and 0.2 of the band', () => {
    const d = 50; // band = 17
    const lane = rowLane(d);
    const dash = (o: number) => Math.round(15 + o * (17 / 2 - 1.5) - 1.5);
    expect(lane.dashTop).toEqual([dash(0.7), dash(-1), dash(0.2)]);
  });

  it('colours by tier', () => {
    expect([rowLane(10).color, rowLane(50).color, rowLane(90).color]).toEqual([EASY, MID, HARD]);
  });
});
