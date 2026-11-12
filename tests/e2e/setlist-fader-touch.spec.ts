// The gate on 4e324f5 (QWW-57, 12 Nov): what a finger does on a fader, and what follows a tap on a ✕. The rule that took a drag back when it turned up or down compared the
// finger's vertical travel with its current sideways offset from where it landed, so it cancelled ordinary fine-tuning (a finger that goes out 24 px, comes back past
// where it landed and drifts 2 px: it passes through the landing point, where it is more up than to the side), and it kept swipes that kicked 30 px or more to the side and
// then went 120 px up (a kick of 40 px was final). It now compares the farthest the finger has been up or down with the farthest it has been to the side (src/lib/setlist/
// fader.ts, `takesBack`): a drag is taken back, and the gear put back as it was, only if the first is more than 1.5 times the second. Checked at 360, 375 and 390 px,
// expanded and in mini, at a touch radius of 1, 8 and 12, with real touch in Chromium (Input.dispatchTouchEvent) and, where it is installed, WebKit's own taps and the
// pointer events a touch raises:
//   - fine-tuning that goes out 16, 24 and 30 px and comes back to within 8 px of where it landed, with up to 4 px of drift, ends where the finger is, as one gear_change
//   - a kick of 15 (in its first 6 to 8 px), 30, 40 and 50 px and then 120 px up or down, a 30 degree diagonal for 40 px and then 100 px up, and a wide thumb's arc (35 px
//     right, 150 px up) change nothing: not the value, not on or off, not the open part or the sheet's mode, and nothing is recorded
//   - drags at 20, 30 and 44 degrees still move the value, as one gear_change
//   - a double tap on every gear's ✕ and on Era's, 150 and 300 ms apart, with the second tap 0 to 12 px lower than the first, at a radius of 10: the gear ends off at its
//     default with one gear_change (Era: one era_change); the fader and the eras are held for a moment after a finger's tap on a ✕
//   - the handle takes a tap on the bottom of its 44 px box in an expanded sheet, and the first Enter after a touch drag of it toggles the sheet
// The arithmetic is tests/setlist/fader.test.ts, the handlers' rules tests/setlist/faderStrip.test.tsx and setlistScreen.test.tsx.

import { devices, expect, test, webkit, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { DEFAULTS } from '../../src/lib/setlist/defaults';
import type { AppEvent } from '../../src/lib/contracts';
import type { GearId } from '../../src/lib/setlist/types';
import { cdpFinger, isOff, makeScreensDir, MODES, openAt, recorded, setThumbOn, stateOf, syntheticFinger, thumb, valueAt, type Finger, type Point } from '../helpers/faderE2e';
import { eraButton, resetButton, tab, touchDrag, tuner, value } from '../helpers/tunerE2e';

test.beforeAll(() => makeScreensDir());
test.describe.configure({ mode: 'parallel' });
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

const WIDTHS = [360, 375, 390] as const;
const RADII = [1, 8, 12] as const;
const clampTo = (min: number, max: number, x: number) => Math.min(Math.max(x, min + 3), max - 3);

/** Sets the gear off (the rest as it is), waited for, so that what a test compares is what the page holds. */
async function turnOff(page: Page, gear: GearId) {
  const offNow = (await tuner(page)).off;
  await page.evaluate(([g, list]) => (window as unknown as { setlist: { setState(p: object): void } }).setlist.setState({ off: [...new Set([...(list as string[]), g as string])] }), [gear, offNow] as const);
  await expect.poll(async () => (await tuner(page)).off.includes(gear)).toBe(true);
}

/** A path of fingers from `from`, each point an offset from it, as a finger reports it. */
const pathOf = (from: Point, offsets: [number, number][]): Point[] => [from, ...offsets.map(([dx, dy]) => ({ x: from.x + dx, y: from.y + dy }))];
const stepsTo = (fromX: number, toX: number, y: (i: number) => number, step = 2): [number, number][] =>
  Array.from({ length: Math.ceil(Math.abs(toX - fromX) / step) }, (_, k) => [fromX + Math.sign(toX - fromX) * Math.min(step * (k + 1), Math.abs(toX - fromX)), y(k + 1)] as [number, number]);

// ============================================================================================================
// What each check does, once for a finger, whichever engine drives it
// ============================================================================================================

/** Fine-tuning: out, back to within 8 px of where it landed, with drift: the finger's place gives the value, and it is one adjustment. */
async function checkFineTuning(page: Page, events: AppEvent[], gear: GearId, at: string, finger: Finger, radii: readonly number[], off: boolean, full = true) {
  const failures: string[] = [];
  for (const radius of radii) {
    for (const out of full ? [16, 24, 30] : [24]) {
      for (const back of full ? [-8, 0, 8] : [-8, 8]) {
        for (const drift of full ? [0, 4] : [4]) {
          for (const dir of [1, -1]) {
            if (off) {
              await setThumbOn(page, gear, DEFAULTS[gear]);
              await turnOff(page, gear);
            } else await setThumbOn(page, gear, 50);
            const t = await thumb(page, gear);
            const from = { x: t.x, y: t.y };
            const offsets = [...stepsTo(0, dir * out, (i) => (i % 2 ? drift : 0)), ...stepsTo(dir * out, dir * back, (i) => (i % 2 ? drift : 1))];
            const before = (await recorded(page, events, 'gear_change')).length;
            await finger.drag(pathOf(from, offsets), undefined, radius);
            const endX = from.x + dir * back;
            const label = `${gear}${off ? ' (off)' : ''}, out ${out} px ${dir > 0 ? 'right' : 'left'}, back to ${dir * back}, drift ${drift}, touch radius ${radius}`;
            await expect.poll(() => value(page, gear), { message: `${at}, ${label}` }).toBeGreaterThanOrEqual(0);
            const want = valueAt(t.track, endX);
            const got = await value(page, gear);
            if (Math.abs(got - want) > 1) failures.push(`${label}: the value is ${got}, the finger says ${want}`);
            if (await isOff(page, gear)) failures.push(`${label}: the gear is off`);
            const made = (await recorded(page, events, 'gear_change')).length - before;
            if (made !== 1) failures.push(`${label}: ${made} gear_change records, not 1`);
          }
        }
      }
    }
  }
  expect(failures, `${at}: fine-tuning`).toEqual([]);
}

/** Swipes that kick sideways (or go along a diagonal or an arc) and then go up or down change nothing at all. */
async function checkKicksAndArcs(page: Page, events: AppEvent[], gear: GearId, at: string, finger: Finger, radii: readonly number[], off: boolean) {
  const failures: string[] = [];
  const up = (from: number, to: number, x: number): [number, number][] => Array.from({ length: Math.floor(Math.abs(to - from) / 6) }, (_, k) => [x, from + Math.sign(to - from) * 6 * (k + 1)] as [number, number]);
  const swipes: [string, [number, number][]][] = [];
  for (const [kx, ky] of [[15, 6], [15, 8], [30, 4], [40, 4], [50, 6]] as const) {
    for (const dir of [1, -1]) swipes.push([`a kick of ${kx} px in its first ${ky} px, then 120 px ${dir > 0 ? 'down' : 'up'}`, [[kx, dir * ky], ...up(dir * ky, dir * 120, kx)]]);
  }
  swipes.push(['a 30 degree diagonal for 40 px, then 100 px up', [...Array.from({ length: 8 }, (_, i) => [5 * 0.866 * (i + 1), -2.5 * (i + 1)] as [number, number]), ...up(-20, -120, 34.64)]]);
  swipes.push(["a wide thumb's arc, 35 px right and 150 px up", [...Array.from({ length: 7 }, (_, i) => [5 * (i + 1), -1.5 * (i + 1)] as [number, number]), ...up(-10, -150, 35)]]);
  for (const radius of radii) {
    for (const [name, offsets] of swipes) {
      if (off) {
        await setThumbOn(page, gear, DEFAULTS[gear]);
        await turnOff(page, gear);
      } else await setThumbOn(page, gear, 0);
      const t = await thumb(page, gear);
      const was = await stateOf(page, gear);
      const before = (await recorded(page, events, 'gear_change')).length;
      await finger.drag(pathOf({ x: t.x + 60, y: t.y }, offsets), undefined, radius);
      await page.waitForTimeout(150);
      const now = await stateOf(page, gear);
      const label = `${gear}${off ? ' (off)' : ''}, ${name}, touch radius ${radius}`;
      if (JSON.stringify(now) !== JSON.stringify(was)) failures.push(`${label}: the state went from ${JSON.stringify(was)} to ${JSON.stringify(now)}`);
      const made = (await recorded(page, events, 'gear_change')).length - before;
      if (made !== 0) failures.push(`${label}: ${made} gear_change records`);
    }
  }
  expect(failures, `${at}: swipes that kick, slant or arc and then go up or down`).toEqual([]);
}

/** Deliberate drags along a line at 20, 30 and 44 degrees move the value to the finger, as one adjustment. */
async function checkAngles(page: Page, events: AppEvent[], gear: GearId, at: string, finger: Finger, radii: readonly number[]) {
  const failures: string[] = [];
  for (const radius of radii) {
    for (const degrees of [20, 30, 44]) {
      for (const [dirX, dirY] of [[1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
        await setThumbOn(page, gear, 50);
        const t = await thumb(page, gear);
        const k = Math.tan((degrees * Math.PI) / 180);
        const length = 50;
        const offsets = Array.from({ length: Math.round(length / 4) }, (_, i) => [dirX * 4 * (i + 1), dirY * 4 * (i + 1) * k] as [number, number]);
        const before = (await recorded(page, events, 'gear_change')).length;
        await finger.drag(pathOf({ x: t.x, y: t.y }, offsets), undefined, radius);
        const endX = t.x + offsets.at(-1)![0];
        const label = `${gear}, a drag at ${degrees} degrees (${dirX > 0 ? 'right' : 'left'}, ${dirY > 0 ? 'down' : 'up'}), touch radius ${radius}`;
        await page.waitForTimeout(100);
        const got = await value(page, gear);
        const want = valueAt(t.track, clampTo(t.track.left, t.track.right, endX));
        if (Math.abs(got - want) > 1) failures.push(`${label}: the value is ${got}, the finger says ${want}`);
        if (await isOff(page, gear)) failures.push(`${label}: the gear is off`);
        const made = (await recorded(page, events, 'gear_change')).length - before;
        if (made !== 1) failures.push(`${label}: ${made} gear_change records, not 1`);
      }
    }
  }
  expect(failures, `${at}: deliberate drags`).toEqual([]);
}

/** A double tap on a ✕ (or Era's) with the second tap `lower` px lower than the first: off at its default, with one record. */
async function checkDoubleTapLower(page: Page, events: AppEvent[], part: GearId | 'era', at: string, finger: Finger, lowers: readonly number[], gaps: readonly number[], radius: number) {
  const failures: string[] = [];
  const name = part === 'era' ? 'era_change' : 'gear_change';
  for (const lower of lowers) {
    for (const gap of gaps) {
      if (part === 'era') await page.evaluate(() => (window as unknown as { setlist: { setState(p: object): void } }).setlist.setState({ off: [], eras: ['s80'] }));
      else await setThumbOn(page, part, 60);
      await expect(resetButton(page, part)).toBeVisible();
      const icon = await resetButton(page, part).locator('svg').boundingBox();
      const glyph = { x: icon!.x + icon!.width / 2, y: icon!.y + icon!.height / 2 };
      const before = (await recorded(page, events, name)).length;
      await finger.tap(glyph, radius);
      await page.waitForTimeout(Math.max(gap - 120, 0));
      await finger.tap({ x: glyph.x, y: glyph.y + lower }, radius);
      await page.waitForTimeout(250);
      const t = await tuner(page);
      const label = `${part}, a double tap ${gap} ms apart with the second ${lower} px lower, touch radius ${radius}`;
      if (!t.off.includes(part)) failures.push(`${label}: it ended ON`);
      else if (part !== 'era' && t[part] !== DEFAULTS[part]) failures.push(`${label}: it ended off at ${t[part]}, not ${DEFAULTS[part]}`);
      else if (part === 'era' && t.eras.join() !== DEFAULTS.eras.join()) failures.push(`${label}: Era ended off with the picks ${t.eras.join()}`);
      const made = (await recorded(page, events, name)).length - before;
      if (made !== 1) failures.push(`${label}: ${made} ${name} records, not 1`);
    }
  }
  expect(failures, `${at}: double taps on the ✕, the second one lower`).toEqual([]);
}

/** In an expanded sheet the handle's whole 44 px box is the handle's: the bottom of it, over the first strip's top, takes a tap. */
async function checkHandleReach(page: Page, finger: Finger, at: string) {
  const box = (await page.locator('#handle').boundingBox())!;
  for (const inset of [2, 5]) {
    const p = { x: box.x + box.width / 2 - 20, y: box.y + box.height - inset };
    expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('#handle'), p), `${at}: ${inset} px above the bottom of the handle's box is the handle`).toBe(true);
    await finger.tap(p, 1);
    await expect(page.locator('#app'), `${at}: a tap ${inset} px above the bottom of the handle's box folds the sheet`).toHaveAttribute('data-mode', 'mini');
    await page.evaluate(() => (window as unknown as { setlist: { setState(p: object): void } }).setlist.setState({ mini: false }));
    await expect(page.locator('#app')).toHaveAttribute('data-mode', 'expanded');
  }
}

// ============================================================================================================
// Chromium, with real touch
// ============================================================================================================

for (const width of WIDTHS) {
  for (const mode of MODES) {
    test.describe(`${width} px, ${mode}`, () => {
      test.use({ viewport: { width, height: 844 } });
      test.beforeEach(({ browserName }) => test.skip(browserName !== 'chromium', 'touch is driven through Chromium DevTools'));
      const at = `${width} px, ${mode}`;
      // The whole matrix at 390 px, where the gate looked; a lighter one at 360 and 375 (the handlers do not depend on the width, the layout is what differs).
      const full = width === 390;
      const show = async (page: Page, part: GearId | 'era') => {
        if (mode === 'mini') await tab(page, part).click();
      };

      test('fine-tuning that goes out 16 to 30 px and comes back to within 8 px of where it landed, with up to 4 px of drift, ends where the finger is, as one gear_change', async ({ page }) => {
        test.setTimeout(240_000);
        const { events } = await openAt(page, mode, 'tempo');
        const finger = cdpFinger(page);
        await show(page, 'difficulty');
        await checkFineTuning(page, events, 'difficulty', at, finger, full ? RADII : [12], false, full);
        // Tempo starts off: a correction turns it on and keeps it on.
        await show(page, 'tempo');
        await checkFineTuning(page, events, 'tempo', at, finger, [8], true, full);
      });

      test('a kick of 15 to 50 px and then 120 px up or down, a 30 degree diagonal and a wide arc change nothing: Tempo stays off, Difficulty stays at 0, nothing is recorded', async ({ page }) => {
        test.setTimeout(240_000);
        const { events } = await openAt(page, mode, 'tempo');
        const finger = cdpFinger(page);
        await show(page, 'tempo');
        await checkKicksAndArcs(page, events, 'tempo', at, finger, full ? [1, 12] : [12], true);
        await show(page, 'difficulty');
        await checkKicksAndArcs(page, events, 'difficulty', at, finger, full ? RADII : [12], false);
      });

      test('deliberate drags at 20, 30 and 44 degrees move the value to the finger, as one gear_change', async ({ page }) => {
        test.setTimeout(180_000);
        const { events } = await openAt(page, mode);
        await show(page, 'difficulty');
        await checkAngles(page, events, 'difficulty', at, cdpFinger(page), full ? RADII : [12]);
      });

      test('a double tap on every ✕ and on Era\'s, 150 and 300 ms apart, with the second tap 0 to 12 px lower, leaves it off at its default with one record', async ({ page }) => {
        test.setTimeout(240_000);
        const { events } = await openAt(page, mode);
        const finger = cdpFinger(page);
        for (const part of ['difficulty', 'popularity', 'tempo', 'history'] as GearId[]) {
          await show(page, part);
          await checkDoubleTapLower(page, events, part, at, finger, full ? [0, 4, 8, 12] : [8, 12], full ? [150, 300] : [150], 10);
        }
        await show(page, 'era');
        await checkDoubleTapLower(page, events, 'era', at, finger, full ? [0, 4, 8, 12] : [8, 12], full ? [150, 300] : [150], 10);
        expect(await eraButton(page, 's20').count()).toBe(1);
      });
    });
  }

  test.describe(`${width} px, expanded, the handle`, () => {
    test.use({ viewport: { width, height: 844 } });
    test.beforeEach(({ browserName }) => test.skip(browserName !== 'chromium', 'touch is driven through Chromium DevTools'));

    test('the handle takes a tap on the bottom of its 44 px box, and the first Enter after a touch drag of it toggles the sheet', async ({ page }) => {
      test.setTimeout(90_000);
      await openAt(page, 'expanded');
      await checkHandleReach(page, cdpFinger(page), `${width} px, expanded`);
      // A touch drag of the handle (down, to the other mode) has no click of its own: the first Enter after it must still toggle.
      const handle = page.locator('#handle');
      const b = (await handle.boundingBox())!;
      await touchDrag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, 90);
      await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
      await page.waitForTimeout(50);
      await handle.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('#app'), 'the first Enter after the drag toggles the sheet').toHaveAttribute('data-mode', 'expanded');
    });
  });
}

// ============================================================================================================
// WebKit (desktop, not iOS Safari: see tests/e2e/setlist-fader.spec.ts)
// ============================================================================================================

test.describe('in WebKit (desktop WebKit, not iOS Safari)', () => {
  test.skip(!existsSync(webkit.executablePath()), 'WebKit is not installed here (CI installs Chromium only)');

  for (const width of WIDTHS) {
    for (const mode of MODES) {
      test(`${width} px, ${mode}: fine-tuning, kicks and arcs, angles, a double tap on the ✕ with the second tap lower, and the handle's reach`, async ({ baseURL }) => {
        test.setTimeout(300_000);
        const browser = await webkit.launch();
        try {
          const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width, height: 844 }, baseURL, reducedMotion: 'reduce' });
          const page = await context.newPage();
          const at = `WebKit, ${width} px, ${mode}`;
          const finger: Finger = syntheticFinger(page);
          const { events } = await openAt(page, mode, 'tempo');
          const show = async (part: GearId | 'era') => {
            if (mode === 'mini') await tab(page, part).click();
          };
          await show('difficulty');
          await checkFineTuning(page, events, 'difficulty', at, finger, [1], false);
          await checkAngles(page, events, 'difficulty', at, finger, [1]);
          await checkKicksAndArcs(page, events, 'difficulty', at, finger, [1], false);
          await show('tempo');
          await checkKicksAndArcs(page, events, 'tempo', at, finger, [1], true);
          for (const part of ['difficulty', 'popularity'] as GearId[]) {
            await show(part);
            await checkDoubleTapLower(page, events, part, at, finger, [0, 8, 12], [150, 300], 1);
          }
          await show('era');
          await checkDoubleTapLower(page, events, 'era', at, finger, [0, 8, 12], [150, 300], 1);
          if (mode === 'expanded') await checkHandleReach(page, finger, at);
          await context.close();
        } finally {
          await browser.close();
        }
      });
    }
  }
});
