// The curve behind an interrupted slide (src/components/setlist/flip.ts): how much of a slide is left is worked out
// from when it began, because a row that React moves loses the animation the browser was running on it. That
// the curve is the browser's own `ease` is checked in a browser, in tests/e2e/setlist.spec.ts.

import { describe, expect, it } from 'vitest';
import { easeProgress, SLIDE_MS, slideOffset } from '../../src/components/setlist/flip';

describe('easeProgress (CSS ease, cubic-bezier(.25, .1, .25, 1))', () => {
  it('starts at 0 and ends at 1, and stays there outside the slide', () => {
    expect(easeProgress(0)).toBe(0);
    expect(easeProgress(1)).toBe(1);
    expect(easeProgress(-0.5)).toBe(0);
    expect(easeProgress(3)).toBe(1);
  });

  it('only ever moves forward', () => {
    let last = -1;
    for (let p = 0; p <= 1.0001; p += 0.02) {
      const now = easeProgress(p);
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
  });

  it('leaves gently, is quick through the middle and settles at the end: most of a slide is done by its middle', () => {
    expect(easeProgress(0.1)).toBeLessThan(0.15);
    expect(easeProgress(0.25)).toBeGreaterThan(0.35);
    expect(easeProgress(0.5)).toBeGreaterThan(0.75);
    expect(easeProgress(0.5)).toBeLessThan(0.85);
    expect(easeProgress(0.9)).toBeGreaterThan(0.97);
  });
});

describe('slideOffset', () => {
  it('is the whole offset when the slide has just begun, and nothing once it is over', () => {
    expect(slideOffset(120, 0)).toBe(120);
    expect(slideOffset(120, SLIDE_MS)).toBe(0);
    expect(slideOffset(120, SLIDE_MS * 3)).toBe(0);
  });

  it('keeps the direction of the slide', () => {
    expect(slideOffset(-120, 70)).toBeLessThan(0);
    expect(slideOffset(120, 70)).toBeGreaterThan(0);
    expect(slideOffset(-120, 70)).toBeCloseTo(-slideOffset(120, 70), 9);
  });

  it('shrinks as time goes on, and is proportional to where the slide began', () => {
    const early = slideOffset(200, 40);
    const late = slideOffset(200, 200);
    expect(early).toBeGreaterThan(late);
    expect(slideOffset(100, 90) * 2).toBeCloseTo(slideOffset(200, 90), 9);
  });
});
