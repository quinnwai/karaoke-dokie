// QWW-33: a slider changes the list along its whole length, not just over the part of the track
// where its raw scores happen to fall. Each slider is swept from one end to the other in 10% steps on
// lists shaped like the real ones (tests/helpers/sliderFixtures.ts): the catalogue for two wide
// ranges, and a signed-in library whose songs are mostly saved and nothing else.

import { describe, expect, it } from 'vitest';
import type { Match, ResultsMode, SliderId, VocalRange } from '../../src/lib/contracts';
import { DEFAULT_VIEW, availableSliders, rangeCoverage, sliderValue, viewMatches } from '../../src/lib/songs/browse';
import { isKnown } from '../../src/lib/songs/rank';
import { E2_TO_E5, F2_TO_C5, catalogueMatches, libraryMatches } from '../helpers/sliderFixtures';

const A2_TO_C5: VocalRange = { low: 45, high: 72, source: 'test' };

interface Fixture {
  name: string;
  user: VocalRange;
  mode: ResultsMode;
  list: Match[];
}

const FIXTURES: Fixture[] = [
  { name: 'catalogue, F2 to C5', user: F2_TO_C5, mode: 'catalogue', list: catalogueMatches(F2_TO_C5) },
  { name: 'catalogue, E2 to E5', user: E2_TO_E5, mode: 'catalogue', list: catalogueMatches(E2_TO_E5) },
  { name: 'library, F2 to C5', user: F2_TO_C5, mode: 'library', list: libraryMatches(F2_TO_C5) },
  { name: 'library, A2 to C5', user: A2_TO_C5, mode: 'library', list: libraryMatches(A2_TO_C5) },
];

/** 0, 0.1, ... 1: the slider moved from one end to the other in 10% steps. */
const STEPS = Array.from({ length: 11 }, (_, i) => i / 10);

const shownAt = (f: Fixture, id: SliderId, target: number) => viewMatches(f.list, { ...DEFAULT_VIEW, [id]: target }, f.user, f.mode);
const titles = (list: Match[]) => list.map((m) => m.track.title);

describe.each(FIXTURES)('$name', (f) => {
  const sliders = availableSliders(f.mode, f.list);

  it('shapes the lists like the preview did: difficulty bunched low, familiarity in two big groups', () => {
    // Without this the sweeps below could pass on lists that never had the problem.
    const difficulty = f.list.map((m) => sliderValue(m, 'difficulty', f.user)!);
    expect(difficulty.filter((v) => v < 0.5).length / difficulty.length).toBeGreaterThanOrEqual(0.98);
    if (f.mode === 'catalogue') expect(difficulty.filter((v) => v < 0.25).length / difficulty.length).toBeGreaterThanOrEqual(0.85);
    if (f.mode === 'library') {
      const saved = f.list.filter((m) => m.parts!.familiarity === 0.15).length;
      expect(saved / f.list.length).toBeGreaterThanOrEqual(0.7);
    }
    expect(sliders).toEqual(f.mode === 'library' ? ['difficulty', 'familiarity', 'popularity'] : ['difficulty', 'popularity']);
    expect(f.list.length).toBeGreaterThan(800);
  });

  for (const id of ['difficulty', 'familiarity', 'popularity'] as SliderId[]) {
    if (!sliders.includes(id)) continue;

    it(`the ${id} slider changes the top 5 songs at every 10% step`, () => {
      const tops = STEPS.map((t) => titles(shownAt(f, id, t)).slice(0, 5));
      for (let k = 1; k < tops.length; k++) {
        const same = tops[k]!.every((title) => tops[k - 1]!.includes(title));
        expect(same, `${id} ${STEPS[k - 1]! * 100}% -> ${STEPS[k]! * 100}% left the top 5 as it was: ${tops[k]!.join(', ')}`).toBe(false);
      }
    });

    it(`the ${id} slider keeps the existing rules at every step: nothing dropped, Maybe last, known first`, () => {
      for (const t of STEPS) {
        const shown = shownAt(f, id, t);
        expect(shown).toHaveLength(f.list.length);
        expect(new Set(shown.map((m) => m.track.id)).size).toBe(f.list.length);
        const firstMaybe = shown.findIndex((m) => m.difficulty === 'maybe');
        if (firstMaybe >= 0) expect(shown.slice(firstMaybe).every((m) => m.difficulty === 'maybe')).toBe(true);
        // Songs you know come first unless On repeat is the slider being set.
        if (f.mode === 'library' && id !== 'familiarity') {
          const sure = shown.filter((m) => m.difficulty !== 'maybe');
          const firstSaved = sure.findIndex((m) => !isKnown(m.track));
          if (firstSaved >= 0) expect(sure.slice(firstSaved).some((m) => isKnown(m.track))).toBe(false);
        }
      }
    });
  }

  it('Light work lists Easy songs first', () => {
    const top = shownAt(f, 'difficulty', 0).slice(0, 5);
    expect(top.map((m) => m.difficulty)).toEqual(['easy', 'easy', 'easy', 'easy', 'easy']);
  });

  it('Locked in lists the songs that use the most of your range first', () => {
    const shown = shownAt(f, 'difficulty', 1);
    // Within the group listed first (known songs, in a library), the top 5 are among the widest tenth.
    const group = shown.filter((m) => m.difficulty !== 'maybe' && (f.mode === 'catalogue' || isKnown(m.track)));
    const widths = group.map((m) => rangeCoverage(m, f.user)).sort((a, b) => a - b);
    const widestTenth = widths[Math.floor(widths.length * 0.9)]!;
    for (const m of shown.slice(0, 5)) expect(rangeCoverage(m, f.user)).toBeGreaterThanOrEqual(widestTenth);
  });
});
