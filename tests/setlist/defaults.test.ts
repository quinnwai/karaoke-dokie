// The tuner's defaults (src/lib/setlist/defaults.ts) are the server's (src/lib/songs/setlistConfig.ts), imported and not
// repeated (QWW-57): the screen's first load and every Reset read the same numbers the engine's own defaults are made of.

import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../src/lib/setlist/defaults';
import { initialTuner } from '../../src/lib/setlist/tuner';
import { DEFAULT_OFF, DEFAULTS as SERVER_DEFAULTS } from '../../src/lib/songs/setlistConfig';

describe('the tuner defaults', () => {
  it('are the server\'s own objects, so a change on the server moves the screen with it', () => {
    expect(DEFAULTS.off).toBe(DEFAULT_OFF);
    expect(DEFAULTS.eras).toBe(SERVER_DEFAULTS.eras);
    for (const gear of ['difficulty', 'history', 'popularity', 'tempo'] as const) expect(DEFAULTS[gear]).toBe(SERVER_DEFAULTS[gear]);
  });

  it('are QWW-47\'s decision: easiest of the most popular first, History, Tempo and Era off, no era picked', () => {
    expect({ difficulty: DEFAULTS.difficulty, history: DEFAULTS.history, popularity: DEFAULTS.popularity, tempo: DEFAULTS.tempo }).toEqual({
      difficulty: 0,
      history: 100,
      popularity: 100,
      tempo: 50,
    });
    expect([...DEFAULTS.off]).toEqual(['history', 'tempo', 'era']);
    expect([...DEFAULTS.eras]).toEqual([]);
  });

  it('add only the screen\'s own fields: the mini sheet opens on Difficulty, and the sheet starts expanded', () => {
    expect(DEFAULTS.open).toBe('difficulty');
    expect(DEFAULTS.mini).toBe(false);
    expect(Object.keys(DEFAULTS).sort()).toEqual(['difficulty', 'eras', 'history', 'mini', 'off', 'open', 'popularity', 'tempo']);
  });

  it('are what the tuner starts from', () => {
    expect(initialTuner()).toEqual({ difficulty: 0, history: 100, popularity: 100, tempo: 50, eras: [], off: ['history', 'tempo', 'era'], open: 'difficulty', mini: false });
  });
});
