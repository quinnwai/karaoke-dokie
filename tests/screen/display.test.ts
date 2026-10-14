// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { difficultyLabel, octaveWording, rangeBar, scalePosition, sourceTooltip } from '../../src/lib/client/display';
import type { SongRange, VocalRange } from '../../src/lib/contracts';
import { source } from '../fixtures/screen';

const user: VocalRange = { low: 45, high: 72, source: 'test' }; // A2 to C5
const song = (low: number, high: number): SongRange => ({ low, high, tessitura: (low + high) / 2, source: 'note-file', confidence: 'high', fastLyrics: false });

describe('rangeBar', () => {
  it('places both ranges on one padded scale', () => {
    const bar = rangeBar(user, song(50, 64), 'none');
    // scale is 43..74 (31 semitones)
    expect(bar.user).toEqual({ left: 6.45, width: 87.1, low: 'A2', high: 'C5' });
    expect(bar.song.low).toBe('D3');
    expect(bar.song.high).toBe('E4');
    expect(bar.song.left).toBeCloseTo((7 / 31) * 100, 1);
    expect(bar.song.width).toBeCloseTo((14 / 31) * 100, 1);
  });

  it('widens the scale when the song goes past the user', () => {
    const bar = rangeBar(user, song(40, 76), 'none');
    expect(bar.song.left).toBeCloseTo((2 / 40) * 100, 1);
    expect(bar.song.left + bar.song.width).toBeCloseTo((38 / 40) * 100, 1);
    expect(bar.user.left).toBeGreaterThan(bar.song.left);
  });

  it('shows the notes the user will sing for octave matches', () => {
    expect(rangeBar(user, song(58, 77), 'down').song).toMatchObject({ low: 'A#2', high: 'F4' });
    expect(rangeBar(user, song(40, 52), 'up').song).toMatchObject({ low: 'E3', high: 'E4' });
  });

  it('keeps spans inside 0..100', () => {
    for (const [lo, hi] of [[30, 90], [45, 72], [60, 61]] as const) {
      const bar = rangeBar(user, song(lo, hi), 'none');
      for (const s of [bar.user, bar.song]) {
        expect(s.left).toBeGreaterThanOrEqual(0);
        expect(s.left + s.width).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('wording', () => {
  it('octave matches use plain words', () => {
    expect(octaveWording('up')).toBe('Sing it higher than the artist');
    expect(octaveWording('down')).toBe('Sing it lower than the artist');
    expect(octaveWording('none')).toBeNull();
    for (const o of ['up', 'down'] as const) expect(octaveWording(o)).not.toMatch(/octave|transpose|key/i);
  });

  it('difficulty labels', () => {
    expect(['easy', 'medium', 'hard'].map((d) => difficultyLabel(d as 'easy'))).toEqual(['Easy', 'Medium', 'Hard']);
  });
});

describe('sourceTooltip', () => {
  it('explains the outcome and adds the reason', () => {
    expect(sourceTooltip(source(0))).toBe('Measured from a note-by-note file of this song. Matched a note file by title and artist.');
    expect(sourceTooltip(source(1))).toBe("Estimated from this artist's usual singing range. No note file found, used Kenshi Yonezu's usual range.");
  });

  it('covers every outcome and missing data', () => {
    expect(sourceTooltip({ ...source(0), outcome: 'artist-external', reason: '' })).toBe('Estimated from published info about this artist.');
    expect(sourceTooltip({ ...source(0), outcome: 'skipped', reason: ' ' })).toMatch(/couldn't find/);
    expect(sourceTooltip(undefined)).toMatch(/don't have details/);
  });
});

describe('scalePosition', () => {
  it('maps C2..C6 to 0..100 and clamps', () => {
    expect(scalePosition(36)).toBe(0);
    expect(scalePosition(60)).toBe(50);
    expect(scalePosition(84)).toBe(100);
    expect(scalePosition(20)).toBe(0);
    expect(scalePosition(100)).toBe(100);
  });
});
