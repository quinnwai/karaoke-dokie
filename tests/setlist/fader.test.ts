// QWW-57, R33: the arithmetic of a gear's fader (src/lib/setlist/fader.ts). The hit area is the track with half a knob (7 px) more at each end,
// so on a 200 px track it is 214 px wide, and the knob's centre travels the 200 px between the two margins.

import { describe, expect, it } from 'vitest';
import { faderValue, KNOB_PX, liftsOnTheFader, takesBack, TAKE_BACK_RATIO, touchIntent, TOUCH_DECIDE_PX, TOUCH_SLOP_PX, TOUCH_VERDICT_PX } from '../../src/lib/setlist/fader';

describe('faderValue', () => {
  // A hit area that starts at x = 50 and is 214 px wide: the track runs from 57 to 257.
  const value = (x: number) => faderValue(x, 50, 214);

  it('is 0 where the knob is at the track\'s left end, and 100 at its right end', () => {
    expect(value(57)).toBe(0);
    expect(value(257)).toBe(100);
  });

  it('is 50 in the middle, and each quarter is its quarter', () => {
    expect(value(157)).toBe(50);
    expect(value(107)).toBe(25);
    expect(value(207)).toBe(75);
  });

  it('is the end value for a pointer in the margin or past the area, never outside 0 to 100', () => {
    expect(value(50)).toBe(0);
    expect(value(53)).toBe(0);
    expect(value(0)).toBe(0);
    expect(value(-500)).toBe(0);
    expect(value(261)).toBe(100);
    expect(value(264)).toBe(100);
    expect(value(10_000)).toBe(100);
  });

  it('rounds to the whole steps the input has: a step is 2 px on a 200 px track', () => {
    expect(value(57.9)).toBe(0); // 0.45 of a step
    expect(value(58.1)).toBe(1); // 0.55 of a step
    expect(value(59)).toBe(1);
    expect(value(106.2)).toBe(25);
    expect(value(108.2)).toBe(26);
    expect(Number.isInteger(value(123.456))).toBe(true);
  });

  it('follows the area, wherever the page has put it, and its width', () => {
    expect(faderValue(100, 0, 214)).toBe(faderValue(300, 200, 214));
    // A 164 px track (a 390 px phone's, beside the 120 px art): 1 px is about 0.6 of a step.
    expect(faderValue(7, 0, 178)).toBe(0);
    expect(faderValue(171, 0, 178)).toBe(100);
    expect(faderValue(89, 0, 178)).toBe(50);
  });

  it('is 0 for an area with no track to move along', () => {
    expect(faderValue(20, 0, KNOB_PX)).toBe(0);
    expect(faderValue(20, 0, 0)).toBe(0);
    expect(faderValue(20, 0, -30)).toBe(0);
  });
});

describe('touchIntent', () => {
  it('waits while the finger is inside TOUCH_DECIDE_PX, in any direction, so a tap that wobbles is still a tap and the first wobble of a swipe or dip of a drag says nothing', () => {
    expect(touchIntent(0, 0)).toBe('wait');
    expect(touchIntent(TOUCH_DECIDE_PX - 0.1, 0)).toBe('wait');
    expect(touchIntent(0, -(TOUCH_DECIDE_PX - 0.1))).toBe('wait');
    expect(touchIntent(11, 11)).toBe('wait');
    expect(touchIntent(TOUCH_SLOP_PX, TOUCH_SLOP_PX)).toBe('wait');
  });

  it('is a drag once the finger has gone TOUCH_DECIDE_PX and is at least twice as far sideways as up or down, either way', () => {
    expect(touchIntent(TOUCH_DECIDE_PX, 0)).toBe('drag');
    expect(touchIntent(-30, 4)).toBe('drag');
    expect(touchIntent(60, -20)).toBe('drag');
    expect(touchIntent(-16, 8)).toBe('drag');
    // Not twice as far: not yet.
    expect(touchIntent(16, 9)).toBe('wait');
    expect(touchIntent(20, 20)).toBe('wait');
  });

  it('judges the rest at TOUCH_VERDICT_PX, by which way it went more, and level counts as sideways', () => {
    expect(touchIntent(0, TOUCH_VERDICT_PX - 0.1)).toBe('wait');
    expect(touchIntent(0, TOUCH_VERDICT_PX)).toBe('scroll');
    expect(touchIntent(8, 60)).toBe('scroll');
    expect(touchIntent(-3, -40)).toBe('scroll');
    expect(touchIntent(22, 24)).toBe('scroll');
    expect(touchIntent(23, 23)).toBe('drag');
    expect(touchIntent(30, -25)).toBe('drag');
  });

  it('does not call a vertical swipe that wobbled sideways at the start a drag: 15 px across in the first 9 px down, then straight down', () => {
    expect(touchIntent(15, 9)).toBe('wait');
    expect(touchIntent(15, 20)).toBe('wait');
    expect(touchIntent(15, 28)).toBe('wait');
    expect(touchIntent(15, 29)).toBe('scroll');
    expect(touchIntent(15, 120)).toBe('scroll');
    // Even a first move of 15 px across with nothing up or down is waited out.
    expect(touchIntent(15, 0)).toBe('wait');
    expect(touchIntent(15, 25)).toBe('wait');
  });

  it('does not call a drag that dipped at the start a scroll: down 7 px, then sideways', () => {
    expect(touchIntent(0, 7)).toBe('wait');
    expect(touchIntent(8, 7)).toBe('wait');
    expect(touchIntent(14, 7)).toBe('wait');
    expect(touchIntent(16, 7)).toBe('drag');
    expect(touchIntent(80, 7)).toBe('drag');
    // And a dip past the old slop.
    expect(touchIntent(0, 12)).toBe('wait');
    expect(touchIntent(24, 12)).toBe('drag');
  });
});

describe('liftsOnTheFader', () => {
  it('is a press when the finger lifts inside the slop, in any direction', () => {
    expect(liftsOnTheFader(0, 0)).toBe(true);
    expect(liftsOnTheFader(0, TOUCH_SLOP_PX - 0.1)).toBe(true);
    expect(liftsOnTheFader(-(TOUCH_SLOP_PX - 0.1), 0)).toBe(true);
    expect(liftsOnTheFader(5, -5)).toBe(true);
  });

  it('is a press after a short drag, and level counts as sideways', () => {
    expect(liftsOnTheFader(12, 2)).toBe(true);
    expect(liftsOnTheFader(-20, 5)).toBe(true);
    expect(liftsOnTheFader(10, 10)).toBe(true);
  });

  it('is not a press after a short swipe up or down, so no swipe that ends mostly vertical turns a gear on', () => {
    expect(liftsOnTheFader(1, TOUCH_SLOP_PX)).toBe(false);
    expect(liftsOnTheFader(3, 20)).toBe(false);
    expect(liftsOnTheFader(-5, -28)).toBe(false);
  });
});

describe('takesBack', () => {
  /** The farthest a finger has been to the side and up or down along a path of points (from where it landed, at 0, 0). */
  const reach = (path: [number, number][]) => ({ x: Math.max(...path.map(([x]) => Math.abs(x))), y: Math.max(...path.map(([, y]) => Math.abs(y))) });
  const takenBack = (path: [number, number][]) => takesBack(reach(path).x, reach(path).y);

  it('is by the reaches, not by where the finger is: fine-tuning that goes out, comes back past where it landed and drifts a little is never taken back (the gate on 4e324f5)', () => {
    // Out 24 px, back to 16 px the other side of where it landed, with 2 px of drift: at that moment the finger is 16 px to the side and 2 up, which the old rule
    // compared, and while it passed through the landing point (0 to the side, 2 up) it was more up than to the side.
    expect(takenBack([[24, 0], [12, 1], [0, 2], [-16, 2]])).toBe(false);
    expect(takenBack([[30, 4], [8, 3], [-8, 4]])).toBe(false);
    expect(takenBack([[16, 0], [4, 4], [-4, 4], [-6, 0]])).toBe(false);
    for (const out of [16, 20, 24, 30]) for (const back of [-8, -4, 0, 4, 8]) for (const drift of [0, 2, 4]) expect(takenBack([[out, drift], [(out + back) / 2, drift], [back, drift]])).toBe(false);
  });

  it('takes back a swipe that kicked to the side and then went up or down, however far the kick, until the kick is more than the swipe\'s share of its length: 30, 50 and 70 px, then 120', () => {
    for (const kick of [15, 30, 40, 50, 70]) {
      expect(takenBack([[kick, 6], [kick, 40], [kick, 120]]), `a kick of ${kick} px, then 120 px down`).toBe(true);
      expect(takenBack([[kick, -6], [kick, -40], [kick, -120]]), `a kick of ${kick} px, then 120 px up`).toBe(true);
    }
    // A 30 degree diagonal for 40 px, then 100 px up; and a wide thumb's arc, 35 px right and 150 px up.
    expect(takenBack([[17, -10], [34.6, -20], [34.6, -60], [34.6, -120]])).toBe(true);
    expect(takenBack([[10, -30], [30, -80], [35, -150]])).toBe(true);
  });

  it('keeps a drag along a line up to about 56 degrees, and drags with the wander of a thumb\'s arc', () => {
    for (const degrees of [10, 20, 30, 44, 50]) {
      const t = Math.tan((degrees * Math.PI) / 180);
      expect(takenBack([[40, 40 * t], [100, 100 * t], [150, 150 * t]]), `${degrees} degrees`).toBe(false);
    }
    // With 4 px of jitter on every sample.
    expect(takenBack([[20, 20 + 4], [40, 38 + 4], [60, 61 + 4]])).toBe(false);
    expect(takenBack([[30, 8], [90, 40], [140, 60], [100, 20]])).toBe(false);
  });

  it('is on the ratio: more than TAKE_BACK_RATIO times the sideways reach takes it back, and exactly that does not', () => {
    expect(TAKE_BACK_RATIO).toBe(1.5);
    expect(takesBack(40, 60)).toBe(false);
    expect(takesBack(40, 60.1)).toBe(true);
    expect(takesBack(0, 0)).toBe(false);
    expect(takesBack(0, 1)).toBe(true);
  });
});
