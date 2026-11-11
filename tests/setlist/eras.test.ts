// The Era panel's header (src/lib/setlist/eras.ts, Round 6A §8, QWW-57): "ERA · 1,204 songs". N is `SetlistResponse.total`,
// every song that fits the range and the picked eras, not just the loaded page.

import { describe, expect, it } from 'vitest';
import { eraCountText, songCountText } from '../../src/lib/setlist/eras';

describe('songCountText', () => {
  it.each<[number, string]>([
    [0, '0 songs'],
    [1, '1 song'],
    [2, '2 songs'],
    [10, '10 songs'],
    [999, '999 songs'],
    [1000, '1,000 songs'],
    [1204, '1,204 songs'],
    [7638, '7,638 songs'],
    [1234567, '1,234,567 songs'],
  ])('%i is "%s"', (count, text) => {
    expect(songCountText(count)).toBe(text);
  });
});

describe('eraCountText', () => {
  it('counts the songs that fit while Era is on: a middle dot, then the count', () => {
    expect(eraCountText(1204, false)).toBe('· 1,204 songs');
    expect(eraCountText(10, false)).toBe('· 10 songs');
  });

  it('says "1 song" for one, and "0 songs" when nothing fits', () => {
    expect(eraCountText(1, false)).toBe('· 1 song');
    expect(eraCountText(0, false)).toBe('· 0 songs');
  });

  it('says "OFF · all eras" while Era is off, whatever the count', () => {
    expect(eraCountText(1204, true)).toBe('· OFF · all eras');
    expect(eraCountText(null, true)).toBe('· OFF · all eras');
    expect(eraCountText(0, true)).toBe('· OFF · all eras');
  });

  it('says nothing before the engine has answered once', () => {
    expect(eraCountText(null, false)).toBe('');
  });
});
