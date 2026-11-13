// The era text (src/lib/setlist/eras.ts, Round 6A §8, QWW-57): `songCountText`, which the screen header's count uses (R19: the
// song count left the Era panel's title), and the note the Era panel's header carries while Era is off.

import { describe, expect, it } from 'vitest';
import { ERA_OFF_NOTE, songCountText } from '../../src/lib/setlist/eras';

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

describe('ERA_OFF_NOTE', () => {
  it('says "OFF · all eras" after a middle dot, and has no count in it (R19)', () => {
    expect(ERA_OFF_NOTE).toBe('· OFF · all eras');
    expect(ERA_OFF_NOTE).not.toMatch(/\d|song/);
  });
});
