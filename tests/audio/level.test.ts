import { describe, expect, it } from 'vitest';
import { HEARD_LEVEL, LEVEL_CEIL_DB, LEVEL_FLOOR_DB, levelOf } from '../../src/lib/audio/level';
import { noise, sine, voice } from '../helpers/synth';

/** A constant signal at this many dBFS (its RMS is its amplitude). */
const atDb = (db: number, n = 2048) => new Float32Array(n).fill(10 ** (db / 20));

describe('levelOf', () => {
  it('is 0 for silence and for nothing at all', () => {
    expect(levelOf(new Float32Array(2048))).toBe(0);
    expect(levelOf(new Float32Array(0))).toBe(0);
  });

  it('is empty at the floor, full at the ceiling, and stays inside 0 to 1 beyond them', () => {
    expect(levelOf(atDb(LEVEL_FLOOR_DB))).toBeCloseTo(0, 5);
    expect(levelOf(atDb(LEVEL_CEIL_DB))).toBeCloseTo(1, 5);
    expect(levelOf(atDb(-90))).toBe(0);
    expect(levelOf(atDb(0))).toBe(1);
    expect(levelOf(new Float32Array(2048).fill(1))).toBe(1);
  });

  it('rises with loudness, evenly in decibels: halving the amplitude is 6 dB down', () => {
    const loud = levelOf(atDb(-30));
    const half = levelOf(atDb(-30 - 6.0206));
    expect(loud).toBeGreaterThan(half);
    expect(loud - half).toBeCloseTo(6.0206 / (LEVEL_CEIL_DB - LEVEL_FLOOR_DB), 4);
  });

  it('does not depend on the sign of the samples', () => {
    const wave = Float32Array.from({ length: 2048 }, (_, i) => (i % 2 ? 0.01 : -0.01));
    expect(levelOf(wave)).toBeCloseTo(levelOf(atDb(-40)), 5);
  });

  it('puts a sung "ahh" past the "we can hear you" line, and a quiet room well under it', () => {
    expect(levelOf(voice(220, 0.1))).toBeGreaterThan(HEARD_LEVEL);
    expect(levelOf(sine(220, 0.1))).toBeGreaterThan(HEARD_LEVEL);
    // Room noise at -60 dBFS (uniform noise of amplitude a has an RMS of a / sqrt(3)): the bar may stir, but it is nowhere near "heard".
    const room = levelOf(noise(0.1, 0.001 * Math.sqrt(3)));
    expect(room).toBeGreaterThan(0);
    expect(room).toBeLessThan(HEARD_LEVEL / 2);
  });

  it('the "heard" line sits about -49 dBFS', () => {
    const db = LEVEL_FLOOR_DB + HEARD_LEVEL * (LEVEL_CEIL_DB - LEVEL_FLOOR_DB);
    expect(db).toBeGreaterThan(-52);
    expect(db).toBeLessThan(-46);
  });

  it('takes any array of numbers', () => {
    expect(levelOf([0.1, -0.1, 0.1, -0.1])).toBeCloseTo(levelOf(atDb(-20)), 5);
  });
});
