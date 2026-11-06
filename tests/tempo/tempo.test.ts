import { describe, expect, it } from 'vitest';
import { combineTempo, deezerTempo, foldBpm, isStudioVersion, median, tempoOf, ultrastarTempo } from '../../src/lib/tempo/tempo';

describe('foldBpm', () => {
  it('doubles or halves into 70 to 180', () => {
    expect(foldBpm(171)).toBe(171);
    expect(foldBpm(200.7)).toBeCloseTo(100.35);
    expect(foldBpm(43)).toBe(86);
    expect(foldBpm(180)).toBe(90);
    expect(foldBpm(70)).toBe(70);
    expect(foldBpm(35)).toBe(70);
  });
  it('is null for anything that is not a tempo', () => {
    for (const bad of [0, -5, NaN, Infinity, undefined, null]) expect(foldBpm(bad)).toBeNull();
  });
});

describe('isStudioVersion', () => {
  it('skips live, acoustic, remix, karaoke and sped-up versions', () => {
    for (const t of ['Africa - Live', 'Torn (Acoustic)', 'Levitating (Remix)', 'Flowers (Sped Up)', 'Hello (Karaoke Version)', 'Hello (Slowed + Reverb)', 'APT. (Instrumental)']) {
      expect(isStudioVersion(t), t).toBe(false);
    }
  });
  it('keeps the recording as released, remasters and single versions included', () => {
    for (const t of ['Africa', 'Dancing Queen', 'Every Breath You Take (Remastered 2003)', 'Hey Jude - 2015 Remaster', 'Let It Be (Single Version)', "Don't Stop Believin' (Album Version)"]) {
      expect(isStudioVersion(t), t).toBe(true);
    }
  });
});

describe('deezerTempo', () => {
  it('folds each version, then takes the median, ignoring Deezer zeros', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
    // Dancing Queen's two versions, 200.7 and 107.1, agree once folded
    expect(deezerTempo([200.7, 107.1, 0])).toBeCloseTo(103.725);
    expect(deezerTempo([0, 0])).toBeNull();
    expect(deezerTempo([])).toBeNull();
  });
});

describe('combineTempo', () => {
  it('prefers Deezer, then the tracker, then UltraStar', () => {
    expect(combineTempo({ deezerBpm: 120, trackerBpm: 121, ultrastarBpm: 480 })).toEqual({ tempo: 120, source: 'deezer' });
    expect(combineTempo({ trackerBpm: 99 })).toEqual({ tempo: 99, source: 'tracker' });
    expect(combineTempo({ ultrastarBpm: 344 })).toEqual({ tempo: ultrastarTempo(344)!, source: 'ultrastar' });
    expect(ultrastarTempo(344)).toBe(86);
    expect(combineTempo({})).toBeNull();
  });
  it('folds whatever a source says', () => {
    expect(combineTempo({ trackerBpm: 40 })).toEqual({ tempo: 80, source: 'tracker' });
  });
  it('lets UltraStar break a Deezer and tracker disagreement, at 1:1 or 2:1 (4:3 is not agreement)', () => {
    // Deezer 90 vs tracker 117, grid 468 (= 117 after /4): tracker wins
    expect(combineTempo({ deezerBpm: 90, trackerBpm: 117, ultrastarBpm: 468 })).toEqual({ tempo: 117, source: 'tracker' });
    // a grid at half speed (234 / 4 = 58.5, folds to 117 when doubled)
    expect(combineTempo({ deezerBpm: 90, trackerBpm: 117, ultrastarBpm: 234 })).toEqual({ tempo: 117, source: 'tracker' });
    // grid agrees with Deezer: Deezer wins
    expect(combineTempo({ deezerBpm: 90, trackerBpm: 117, ultrastarBpm: 360 })).toEqual({ tempo: 90, source: 'deezer' });
    // no grid: Deezer
    expect(combineTempo({ deezerBpm: 90, trackerBpm: 117 })).toEqual({ tempo: 90, source: 'deezer' });
  });
  it('tempoOf is the number only', () => {
    expect(tempoOf({ deezerBpm: 100 })).toBe(100);
    expect(tempoOf(undefined)).toBeUndefined();
    expect(tempoOf({})).toBeUndefined();
  });
});
