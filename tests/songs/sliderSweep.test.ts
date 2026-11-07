// QWW-33: a slider changes the list along its whole length, not just over the part of the track
// where its raw scores happen to fall. Each slider is swept from one end to the other in 10% steps on
// lists shaped like the real ones (tests/helpers/sliderFixtures.ts): the catalogue for two wide
// ranges, and a signed-in library whose songs are mostly saved and nothing else.

import { describe, expect, it } from 'vitest';
import type { Match, ResultsMode, SliderId, VocalRange } from '../../src/lib/contracts';
import { DEFAULT_VIEW, availableSliders, difficultyBand, sliderValue, viewMatches } from '../../src/lib/songs/browse';
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

  it('shapes the lists like the preview did: wide ranges are almost all Easy, familiarity in two big groups', () => {
    // Without this the sweeps below could pass on lists that never had the problem.
    const labels = (l: string) => f.list.filter((m) => m.difficulty === l).length;
    if (f.mode === 'catalogue') expect(labels('easy') / f.list.length).toBeGreaterThanOrEqual(0.98);
    if (f.mode === 'library') {
      for (const l of ['easy', 'medium', 'hard']) expect(labels(l)).toBeGreaterThanOrEqual(30);
      const saved = f.list.filter((m) => m.parts!.familiarity === 0.15).length;
      expect(saved / f.list.length).toBeGreaterThanOrEqual(0.7);
    }
    expect(sliders).toEqual(f.mode === 'library' ? ['difficulty', 'familiarity', 'popularity', 'tempo'] : ['difficulty', 'popularity', 'tempo']);
    expect(f.list.length).toBeGreaterThan(800);
  });

  for (const id of ['difficulty', 'familiarity', 'popularity'] as SliderId[]) {
    if (!sliders.includes(id)) continue;

    it(`the ${id} slider changes the top 5 songs at every 10% step`, () => {
      const tops = STEPS.map((t) => titles(shownAt(f, id, t)).slice(0, 5));
      // Difficulty gives each label a third of the track, so a step that stays inside the third of a label
      // with fewer than 10 songs (a wide range leaves almost no Medium or Hard ones) has nothing new to show.
      const third = (t: number) => Math.min(2, Math.floor(t * 3 + 1e-9));
      const count = (band: number) => f.list.filter((m) => difficultyBand(m, f.user).band === band).length;
      for (let k = 1; k < tops.length; k++) {
        if (id === 'difficulty' && (third(STEPS[k]!) !== third(STEPS[k - 1]!) || count(third(STEPS[k]!)) < 10)) continue;
        const same = tops[k]!.every((title) => tops[k - 1]!.includes(title));
        expect(same, `${id} ${STEPS[k - 1]! * 100}% -> ${STEPS[k]! * 100}% left the top 5 as it was: ${tops[k]!.join(', ')}`).toBe(false);
      }
    });

    it(`the ${id} slider keeps the existing rules at every step: nothing dropped, Maybe last`, () => {
      for (const t of STEPS) {
        const shown = shownAt(f, id, t);
        expect(shown).toHaveLength(f.list.length);
        expect(new Set(shown.map((m) => m.track.id)).size).toBe(f.list.length);
        const firstMaybe = shown.findIndex((m) => m.difficulty === 'maybe');
        if (firstMaybe >= 0) expect(shown.slice(firstMaybe).every((m) => m.difficulty === 'maybe')).toBe(true);
      }
    });
  }

  it('Light work lists Easy songs first', () => {
    const top = shownAt(f, 'difficulty', 0).slice(0, 5);
    expect(top.map((m) => m.difficulty)).toEqual(['easy', 'easy', 'easy', 'easy', 'easy']);
  });

  it('Locked in lists Hard songs first, hardest first, then Medium, then Easy; Light work is the reverse', () => {
    const key = (m: Match) => sliderValue(m, 'difficulty', f.user)!;
    const sure = (t: number) => shownAt(f, 'difficulty', t).filter((m) => m.difficulty !== 'maybe');
    const down = sure(1).map(key);
    const up = sure(0).map(key);
    for (let k = 1; k < down.length; k++) expect(down[k]!).toBeLessThanOrEqual(down[k - 1]!);
    for (let k = 1; k < up.length; k++) expect(up[k]!).toBeGreaterThanOrEqual(up[k - 1]!);
  });

  it('the middle of the track lists every Medium song before any other', () => {
    const sure = shownAt(f, 'difficulty', 0.5).filter((m) => m.difficulty !== 'maybe');
    const mediums = sure.filter((m) => m.difficulty === 'medium').length;
    // A Medium song is within 1/6 of the middle; the nearest Easy and Hard ones are at best that far (a tie at the edges of the third).
    expect(sure.slice(0, mediums).filter((m) => m.difficulty === 'medium').length).toBeGreaterThanOrEqual(mediums - 2);
    if (mediums > 0) expect(sure[0]!.difficulty).toBe('medium');
  });
});
