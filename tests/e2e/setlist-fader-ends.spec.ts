// The gate on 828aaca (QWW-57, 12 Nov), R33, the blocker: a gear's ✕ took the touches meant for the fader at the right end of the track. Popularity starts at
// 100 and History at 100 signed in, so their thumbs sit under the ✕; the ✕ (z-index 1) covered the top 12 px of the fader's hit area, and in Chromium a tap
// that lands on the fader is given to the nearest button within the touch's radius when the fader itself has no click listener of its own (React's are on the
// root), so a tap on the upper half of the thumb turned the gear off, and a drag from the thumb's upper half or from 16 px above it moved nothing. The ✕ and the
// fader's hit area are now apart (the ✕ ends where the hit area begins), and the fader answers a tap itself. Checked at 360, 375 and 390 px, expanded and in
// mini, with the thumb at 100, 80 and 25 (the right end, just inside the ✕'s column, and well clear of it):
//   - the geometry: no overlap between the ✕ and the hit area; the fader is what is on top at every point of the thumb and 16 px above its centre; the ✕ is
//     what is on top at the glyph; the ✕ is still 44 px wide and the hit area still 44 px tall
//   - a tap anywhere on the thumb moves it to the finger and never turns the gear off, with a touch 1, 10, 12 and 16 px in radius (Chromium looks that far for a button)
//   - a drag from 16 px above the thumb, from the thumb and from the track 60 px away each moves the value to the finger
//   - a tap on the ✕'s glyph still turns the gear off, and puts the value back at its default
// Chromium takes real touch through DevTools (Input.dispatchTouchEvent) and is the one that matters here: it is what CI runs, and what chief-keef's preview was
// checked in. WebKit (where it is installed) runs the same checks with desktop WebKit's own taps and the pointer events a touch raises (see
// tests/e2e/setlist-fader.spec.ts for what that does and does not show: iOS Safari's own touch handling cannot be reproduced on a desktop).

import { devices, expect, test, webkit, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { DEFAULTS } from '../../src/lib/setlist/defaults';
import type { GearId } from '../../src/lib/setlist/types';
import { boxes, cdpFinger, checkTouchDrags, GEARS, isOff, makeScreensDir, MODES, openAt, setThumbOn, syntheticFinger, thumb, under, valueAt, type Finger, type Mode, type Point } from '../helpers/faderE2e';
import { tab, value } from '../helpers/tunerE2e';

test.beforeAll(() => makeScreensDir());

// Each width and mode is its own page and shares nothing, so a worker each: the file's tests are slow (every one taps or drags a good many times).
test.describe.configure({ mode: 'parallel' });

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

const WIDTHS = [360, 375, 390] as const;
/** Where the thumb is when the finger lands: the right end (Popularity and History start there), just inside the ✕'s column, and well clear of it. */
const VALUES = [100, 80, 25] as const;
/** The radius of the touch in px: DevTools' own 1, a finger's 10 and 12 (the review's), and 16, a large finger's (Chromium looks that far, and a good deal further than that for a small button, for one to give a tap to). */
const RADII = [1, 10, 12, 16] as const;
/** Points over the 14 by 20 px thumb, from its centre, 1 px inside its edges: the middle, the four corners and the middle of the top. */
const KNOB_POINTS: [number, number][] = [
  [0, 0],
  [-6, -9],
  [6, -9],
  [-6, 9],
  [6, 9],
  [0, -9],
];
const centreOf = (b: { left: number; top: number; width: number; height: number }): Point => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 });

/** The ✕ and the hit area are apart, and the fader is on top over the thumb and 16 px above it, whatever the value; the ✕ is on top at its glyph. */
async function checkApart(page: Page, gears: GearId[], at: string) {
  for (const gear of gears) {
    await setThumbOn(page, gear, 50);
    const b = await boxes(page, gear);
    const why = `${at}, ${gear}`;
    expect(b.reset, `${why}: the ✕ is drawn`).not.toBeNull();
    expect(b.hit, `${why}: the fader has its hit area`).not.toBeNull();
    const { reset, hit, icon } = { reset: b.reset!, hit: b.hit!, icon: b.icon! };
    const across = Math.min(reset.right, hit.right) - Math.max(reset.left, hit.left);
    const down = Math.min(reset.bottom, hit.bottom) - Math.max(reset.top, hit.top);
    expect(across > 0 && down > 0, `${why}: the ✕ (${Math.round(reset.top)} to ${Math.round(reset.bottom)}) and the hit area (${Math.round(hit.top)} to ${Math.round(hit.bottom)}) overlap by ${down.toFixed(1)} px`).toBe(false);
    // What each keeps of its size: a ✕ that is 44 px wide (it was 44 by 26; it cannot grow down, and the rack clips what is above a strip, so it is 20 tall),
    // a 44 px tall hit area that reaches 18 px above the thumb's centre, so that 16 px above it is inside.
    expect(reset.width, `${why}: the ✕ is 44 px wide`).toBeGreaterThanOrEqual(44);
    expect(reset.height, `${why}: the ✕ is 20 px tall or more`).toBeGreaterThanOrEqual(20);
    expect(hit.height, `${why}: the hit area is 44 px tall or more`).toBeGreaterThanOrEqual(44);
    expect(hit.top, `${why}: the hit area reaches 18 px above the thumb's centre`).toBeLessThanOrEqual(b.knob.top + b.knob.height / 2 - 18 + 0.01);
    // The glyph is wholly in the ✕'s own box, so no part of it is a press on the fader.
    expect(icon.left >= reset.left - 0.01 && icon.right <= reset.right + 0.01 && icon.top >= reset.top - 0.01 && icon.bottom <= reset.bottom + 0.01, `${why}: the ✕'s icon is inside its box`).toBe(true);
    expect(await under(page, centreOf(icon)), `${why}: the ✕ is on top at its glyph`).toBe(`reset:${gear}`);

    for (const v of VALUES) {
      await setThumbOn(page, gear, v);
      const t = await thumb(page, gear);
      const points: [string, Point][] = [...KNOB_POINTS.map(([dx, dy]): [string, Point] => [`the thumb at ${dx},${dy}`, { x: t.x + dx, y: t.y + dy }]), ['16 px above the thumb', { x: t.x, y: t.y - 16 }]];
      for (const [name, p] of points) expect(await under(page, p), `${why}, thumb at ${v}: ${name}`).toBe(`fader:${gear}`);
      // The ✕ keeps its own: the glyph, wherever the thumb is.
      expect(await under(page, centreOf((await boxes(page, gear)).icon!)), `${why}, thumb at ${v}: the glyph`).toBe(`reset:${gear}`);
    }
  }
}

/** A tap anywhere on the thumb moves it to the finger, and the gear stays on. */
async function checkTapsOnTheKnob(page: Page, finger: Finger, gears: GearId[], at: string, radii: readonly number[]) {
  const failures: string[] = [];
  for (const gear of gears) {
    for (const v of VALUES) {
      for (const radius of radii) {
        await setThumbOn(page, gear, v);
        const t = await thumb(page, gear);
        for (const [dx, dy] of KNOB_POINTS) {
          await setThumbOn(page, gear, v);
          const p = { x: t.x + dx, y: t.y + dy };
          await finger.tap(p, radius);
          const off = await isOff(page, gear);
          const got = await value(page, gear);
          const want = valueAt(t.track, p.x);
          if (off) failures.push(`${gear}, thumb at ${v}, a tap ${dx},${dy} px from its centre, touch radius ${radius}: the gear went OFF`);
          else if (Math.abs(got - want) > 1) failures.push(`${gear}, thumb at ${v}, a tap ${dx},${dy} px from its centre, touch radius ${radius}: the value is ${got}, the finger says ${want}`);
        }
      }
    }
  }
  expect(failures, `${at}: taps on the thumb that did not move it where the finger was, or turned the gear off`).toEqual([]);
}

/** A tap on the ✕'s glyph turns the gear off and puts its value at the default, wherever the thumb is. */
async function checkGlyphTap(page: Page, finger: Finger, gears: GearId[], at: string, radii: readonly number[]) {
  const failures: string[] = [];
  for (const gear of gears) {
    for (const v of VALUES) {
      for (const radius of radii) {
        await setThumbOn(page, gear, v);
        const b = await boxes(page, gear);
        await finger.tap(centreOf(b.icon!), radius);
        if (!(await isOff(page, gear))) failures.push(`${gear}, thumb at ${v}, touch radius ${radius}: a tap on the ✕'s glyph left the gear on`);
        else if ((await value(page, gear)) !== DEFAULTS[gear]) failures.push(`${gear}, thumb at ${v}, touch radius ${radius}: the ✕ left the value at ${await value(page, gear)}, not ${DEFAULTS[gear]}`);
      }
    }
  }
  expect(failures, `${at}: taps on the ✕'s glyph`).toEqual([]);
}

/** Gears with a ✕ to press (Tempo starts off, so it has none until it is on; the geometry check turns each on). */
const WITH_RESET: GearId[] = ['difficulty', 'popularity', 'history'];

for (const width of WIDTHS) {
  for (const mode of MODES) {
    test.describe(`${width} px, ${mode}`, () => {
      test.use({ viewport: { width, height: 844 } });
      test.beforeEach(({ browserName }) => test.skip(browserName !== 'chromium', 'touch is driven through Chromium DevTools'));
      const at = `${width} px, ${mode}`;

      /** Every gear's strip in turn: all of them on the page when expanded, one behind its tab in mini. */
      const eachGear = async (page: Page, gears: GearId[], check: (gear: GearId) => Promise<void>) => {
        for (const gear of gears) {
          if (mode === 'mini') await tab(page, gear).click();
          await check(gear);
        }
      };

      test('the ✕ and the fader do not overlap, and the fader is on top at every point of the thumb and 16 px above it, with the thumb at 100, 80 and 25', async ({ page }) => {
        test.setTimeout(90_000);
        await openAt(page, mode);
        await eachGear(page, GEARS, (gear) => checkApart(page, [gear], at));
      });

      test('a tap anywhere on the thumb moves it to the finger and never turns the gear off, with the thumb at 100, 80 and 25 and a touch 1, 10, 12 and 16 px in radius', async ({ page }) => {
        test.setTimeout(180_000);
        await openAt(page, mode);
        await eachGear(page, ['popularity', 'history'], (gear) => checkTapsOnTheKnob(page, cdpFinger(page), [gear], at, RADII));
      });

      test('a drag from 16 px above the thumb, from the thumb and from the track 60 px away moves the value, with the thumb at 100, 80 and 25', async ({ page }) => {
        test.setTimeout(180_000);
        await openAt(page, mode);
        await eachGear(page, GEARS, (gear) => checkTouchDrags(page, cdpFinger(page), [gear], at, { values: VALUES, on: true }));
      });

      test('a tap on the ✕ glyph turns the gear off at its default, with the thumb at 100, 80 and 25 and a touch 1, 10, 12 and 16 px in radius', async ({ page }) => {
        test.setTimeout(120_000);
        await openAt(page, mode);
        await eachGear(page, WITH_RESET, (gear) => checkGlyphTap(page, cdpFinger(page), [gear], at, RADII));
      });
    });
  }
}

test.describe('in WebKit (desktop WebKit, not iOS Safari: see tests/e2e/setlist-fader.spec.ts)', () => {
  test.skip(!existsSync(webkit.executablePath()), 'WebKit is not installed here (CI installs Chromium only)');

  for (const width of WIDTHS) {
    for (const mode of MODES as readonly Mode[]) {
      test(`${width} px, ${mode}: the ✕ and the fader are apart, a tap on the thumb or a drag from near it moves it, and the ✕'s glyph turns the gear off, with the thumb at 100, 80 and 25`, async ({ baseURL }) => {
        test.setTimeout(240_000);
        const browser = await webkit.launch();
        try {
          const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width, height: 844 }, baseURL, reducedMotion: 'reduce' });
          const page = await context.newPage();
          const at = `WebKit, ${width} px, ${mode}`;
          const finger = syntheticFinger(page);
          await openAt(page, mode);
          for (const gear of GEARS) {
            if (mode === 'mini') await tab(page, gear).click();
            await checkApart(page, [gear], at);
            if (gear !== 'tempo') await checkTapsOnTheKnob(page, finger, [gear], at, [1]);
            await checkTouchDrags(page, finger, [gear], at, { values: VALUES, on: true });
            if (gear !== 'tempo') await checkGlyphTap(page, finger, [gear], at, [1]);
          }
          await context.close();
        } finally {
          await browser.close();
        }
      });
    }
  }
});
