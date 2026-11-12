// The gate on 1ee41b4 (QWW-57, 12 Nov), R33 once more: what is near a fader. The ✕ and the title sit just above the track, and Chromium hands the pointer events and
// the click of a touch with a radius to a button or label near the finger, a little more than the radius away: a press in the fader's area was named for the ✕ or the
// title (a drag from 16 px above the thumb moved nothing, from a radius of 12), and a press outside it was named for the fader once the fader had a mousedown
// listener of its own (a double tap on a ✕ put its second tap on the fader under it, and a tap between the title and the ✕ moved the gear). The strip now goes by
// where the finger is, and the ✕ and the era buttons count a click only if the press began on them. Checked at 360, 375 and 390 px, expanded and in mini, with real
// touch in Chromium (Input.dispatchTouchEvent with a radius) and, where it is installed, WebKit's own taps and the pointer events a touch raises:
//   - a drag and a tap that start 10, 14, 16 and 18 px above the thumb's centre (the hit area's top edge is 18 px above it), with the thumb at 100 and at 25, at a radius
//     of 1, 10, 12 and 16, move the fader and never turn the gear off or hand the press to the ✕ or the title
//   - a double tap on each gear's ✕ and on Era's, 120 and 400 ms apart, at a radius of 6, 10 and 14, leaves it off at its default with one gear_change (one era_change)
//   - taps on the title, between the title and the ✕, beside the ✕ and just above the track change nothing, at a radius of 6, 10 and 14 (nor does the sheet's handle,
//     which is just above the first strip and takes a big finger's tap in the blank part of its title row, fold the sheet)
//   - a swipe that kicks 15 px sideways in its first 6, 7 or 8 px and then goes 120 px up or down changes nothing: not the value, not on or off, not the open part,
//     and nothing is recorded; deliberate drags still move the value (tests/e2e/setlist-fader.spec.ts and setlist-fader-ends.spec.ts)
//   - the ✕ draws one ring on keyboard focus, and the slider shows no keyboard ring after a mouse click on its fader until a key is pressed
//   - the ✕ is 29 px tall in a mini strip, and a tap near the glyph's bottom still turns the gear off
// The arithmetic is tests/setlist/fader.test.ts, the handlers' rules tests/setlist/faderStrip.test.tsx and setlistScreen.test.tsx.

import { devices, expect, test, webkit, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { DEFAULTS } from '../../src/lib/setlist/defaults';
import type { GearId } from '../../src/lib/setlist/types';
import {
  boxes,
  cdpFinger,
  isOff,
  line,
  makeScreensDir,
  MODES,
  openAt,
  setThumb,
  setThumbOn,
  syntheticFinger,
  thumb,
  valueAt,
  type Box,
  type Finger,
  type Mode,
  type Point,
} from '../helpers/faderE2e';
import { eraButton, resetButton, slider, tab, tuner, value } from '../helpers/tunerE2e';
import type { AppEvent } from '../../src/lib/contracts';

test.beforeAll(() => makeScreensDir());
test.describe.configure({ mode: 'parallel' });
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

const WIDTHS = [360, 375, 390] as const;
const centreOf = (b: Box): Point => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 });

/** The gear_change (or era_change) records so far, once the page has sent what it holds. */
async function recorded(page: Page, events: AppEvent[], name: 'gear_change' | 'era_change') {
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.waitForTimeout(150);
  return events.filter((e) => e.name === name);
}

/** The state a test compares: a gear's value, what is off, which part is open, the eras and the sheet's mode (the handle, at the top of the first strip, is near a title). */
const stateOf = async (page: Page, gear: GearId) => {
  const t = await tuner(page);
  return { value: t[gear], off: [...t.off].sort(), open: t.open, eras: [...t.eras].sort(), mini: t.mini };
};

const clampTo = (track: Box, x: number) => Math.min(Math.max(x, track.left + 3), track.right - 3);

// ============================================================================================================
// What each check does, once for a finger, whichever engine drives it
// ============================================================================================================

/** Drags and taps that start 10 to 18 px above the thumb's centre, with the thumb at 100 and at 25: each moves the fader, and the gear stays on. */
async function checkAbove(page: Page, finger: Finger, gear: GearId, at: string, radii: readonly number[]) {
  const failures: string[] = [];
  for (const v of [100, 25]) {
    for (const radius of radii) {
      for (const k of [10, 14, 16, 18]) {
        for (const how of ['drag', 'tap'] as const) {
          await setThumbOn(page, gear, v);
          const t = await thumb(page, gear);
          const toward = v >= 50 ? -1 : 1;
          const from = { x: t.x, y: t.y - k };
          const to = { x: clampTo(t.track, t.x + toward * (how === 'drag' ? 60 : 40)), y: from.y + 4 };
          if (how === 'drag') await finger.drag(line(from, to), undefined, radius);
          else await finger.tap(to, radius);
          const got = await value(page, gear);
          const want = valueAt(t.track, to.x);
          const off = await isOff(page, gear);
          const label = `${gear}, thumb at ${v}, a ${how} from ${k} px above its centre, touch radius ${radius}`;
          if (off) failures.push(`${label}: the gear went OFF`);
          else if (Math.abs(got - want) > 1) failures.push(`${label}: the value is ${got}, the finger says ${want}`);
        }
      }
    }
  }
  expect(failures, `${at}: presses 10 to 18 px above the thumb that did not move it where the finger was`).toEqual([]);
}

/** A double tap on a gear's ✕ (or Era's): the second tap lands where the ✕ was, which has gone. It stays off, at its default, with one record. */
async function checkDoubleTapReset(page: Page, events: AppEvent[], part: GearId | 'era', at: string, radii: readonly number[], gaps: readonly number[], touch: (p: Point, r: number) => Promise<void>) {
  const failures: string[] = [];
  const name = part === 'era' ? 'era_change' : 'gear_change';
  for (const radius of radii) {
    for (const gap of gaps) {
      if (part === 'era') await page.evaluate(() => (window as unknown as { setlist: { setState(p: object): void } }).setlist.setState({ off: [], eras: ['s80'] }));
      else await setThumbOn(page, part, 60);
      await expect(resetButton(page, part)).toBeVisible();
      const icon = await resetButton(page, part).locator('svg').boundingBox();
      const glyph = { x: icon!.x + icon!.width / 2, y: icon!.y + icon!.height / 2 };
      const before = (await recorded(page, events, name)).length;
      await touch(glyph, radius);
      await page.waitForTimeout(Math.max(gap - 120, 0));
      await touch(glyph, radius);
      await page.waitForTimeout(250);
      const t = await tuner(page);
      const label = `${part}, a double tap ${gap} ms apart, touch radius ${radius}`;
      if (!t.off.includes(part)) failures.push(`${label}: it ended ON`);
      else if (part !== 'era' && t[part] !== DEFAULTS[part]) failures.push(`${label}: it ended off at ${t[part]}, not ${DEFAULTS[part]}`);
      else if (part === 'era' && t.eras.join() !== DEFAULTS.eras.join()) failures.push(`${label}: Era ended off with the picks ${t.eras.join()}`);
      const made = (await recorded(page, events, name)).length - before;
      if (made !== 1) failures.push(`${label}: ${made} ${name} records, not 1`);
    }
  }
  expect(failures, `${at}: double taps on the ✕`).toEqual([]);
}

/** Taps on the title, in the gap between it and the ✕, beside the ✕ and just above the track change nothing, wherever the touch's radius reaches. */
async function checkTapsNear(page: Page, events: AppEvent[], gear: GearId, at: string, radii: readonly number[], touch: (p: Point, r: number) => Promise<void>, off = false) {
  const failures: string[] = [];
  if (!off) await setThumbOn(page, gear, 60);
  const b = await boxes(page, gear);
  const title = b.title!;
  const reset = b.reset;
  const hit = b.hit!;
  const points: [string, Point][] = [['the title', { x: title.left + title.width / 2, y: title.top + title.height / 2 }]];
  if (reset && reset.left - title.right > 14) points.push(['between the title and the ✕', { x: (title.right + reset.left) / 2, y: title.top + title.height / 2 }]);
  if (reset && reset.left - title.right > 14) points.push(['5 px beside the ✕', { x: reset.left - 5, y: title.top + title.height / 2 }]);
  points.push(['just above the track', { x: b.track.left + b.track.width / 2, y: hit.top - 3 }]);
  // (Not under the ✕: its box reaches down to the hit area, so just above the track at its right end is the ✕.)
  points.push(['above the track, beside the ✕', { x: (reset?.left ?? b.track.right) - 5, y: hit.top - 3 }]);
  const was = await stateOf(page, gear);
  const before = (await recorded(page, events, 'gear_change')).length;
  for (const radius of radii) {
    for (const [name, p] of points) {
      await touch(p, radius);
      // A tap that took the page somewhere else (the tuner is gone from it) is a failure to name, not an exception to read.
      if (!(await page.evaluate(() => 'setlist' in window))) {
        failures.push(`${gear}, a tap on ${name} at ${Math.round(p.x)},${Math.round(p.y)}, touch radius ${radius}: the tuner is gone from the page (${page.url()})`);
        break;
      }
      const now = await stateOf(page, gear);
      if (JSON.stringify(now) !== JSON.stringify(was)) failures.push(`${gear}, a tap on ${name}, touch radius ${radius}: the state went from ${JSON.stringify(was)} to ${JSON.stringify(now)}`);
    }
  }
  const made = (await recorded(page, events, 'gear_change')).length - before;
  if (made !== 0) failures.push(`${gear}: ${made} gear_change records from taps that change nothing`);
  expect(failures, `${at}: taps near the fader`).toEqual([]);
}

/** A swipe that kicks 15 px sideways in its first 6, 7 or 8 px and then goes 120 px up or down changes nothing at all. */
async function checkKickedSwipes(page: Page, events: AppEvent[], gear: GearId, at: string, finger: Finger, radii: readonly number[], off: boolean) {
  const failures: string[] = [];
  for (const radius of radii) {
    for (const ky of [6, 7, 8]) {
      for (const dir of [1, -1]) {
        if (off) {
          // The gear off and the rest as they are (Era is off to begin with), waited for, so that what is compared is what the page holds.
          const offNow = (await tuner(page)).off;
          await page.evaluate(([g, list]) => (window as unknown as { setlist: { setState(p: object): void } }).setlist.setState({ off: [...new Set([...(list as string[]), g as string])] }), [gear, offNow] as const);
          await expect.poll(async () => (await tuner(page)).off.includes(gear)).toBe(true);
        } else await setThumbOn(page, gear, 0);
        const t = await thumb(page, gear);
        const was = await stateOf(page, gear);
        const before = (await recorded(page, events, 'gear_change')).length;
        const from = { x: t.x + 70, y: t.y };
        const path = [from, { x: from.x + 15, y: from.y + ky }];
        for (let dy = 12; dy <= 120; dy += 6) path.push({ x: from.x + 15, y: from.y + dir * dy });
        await finger.drag(path, undefined, radius);
        await page.waitForTimeout(150);
        const now = await stateOf(page, gear);
        const label = `${gear}${off ? ' (off)' : ''}, a swipe that kicked 15 px across in its first ${ky} px and went ${dir > 0 ? 'down' : 'up'} 120 px, touch radius ${radius}`;
        if (JSON.stringify(now) !== JSON.stringify(was)) failures.push(`${label}: the state went from ${JSON.stringify(was)} to ${JSON.stringify(now)}`);
        const made = (await recorded(page, events, 'gear_change')).length - before;
        if (made !== 0) failures.push(`${label}: ${made} gear_change records`);
      }
    }
  }
  expect(failures, `${at}: swipes that kicked sideways`).toEqual([]);
}

/** The ✕'s own ring on keyboard focus is one ring (its icon's), and the page's ring is not on the button as well. */
async function checkOneRing(page: Page, gear: GearId, at: string) {
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate((g) => document.activeElement?.getAttribute('data-reset') === g, gear)) break;
  }
  const rings = await page.evaluate((g) => {
    const b = document.querySelector<HTMLElement>(`button[data-reset="${g}"]`)!;
    const svg = b.querySelector('svg')!;
    return { focused: document.activeElement === b, visible: b.matches(':focus-visible'), button: getComputedStyle(b).outlineStyle, icon: getComputedStyle(svg).outlineStyle };
  }, gear);
  expect(rings.focused, `${at}, ${gear}: Tab reached the ✕`).toBe(true);
  expect(rings.visible, `${at}, ${gear}: the focus is a keyboard's`).toBe(true);
  expect(rings.button, `${at}, ${gear}: the button draws no ring of its own`).toBe('none');
  expect(rings.icon, `${at}, ${gear}: the icon draws the ring`).toBe('solid');
}

/** A mouse click on the fader leaves the slider focused and with no keyboard ring; a key press then moves it and shows the ring. */
async function checkMouseFocus(page: Page, gear: GearId, at: string) {
  await setThumb(page, gear, 25);
  const t = await thumb(page, gear);
  await page.mouse.click(t.x + 40, t.y);
  // The focus comes once the click has been handled (a moment after it).
  await expect.poll(() => page.evaluate((g) => document.activeElement === document.getElementById(`slider-${g}`), gear), { message: `${at}, ${gear}: the slider has the focus after a click` }).toBe(true);
  expect(await page.evaluate((g) => document.getElementById(`slider-${g}`)!.matches(':focus-visible'), gear), `${at}, ${gear}: and shows no keyboard ring`).toBe(false);
  const clicked = await value(page, gear);
  await page.keyboard.press('ArrowRight');
  expect(await value(page, gear), `${at}, ${gear}: an arrow key moves it`).toBe(clicked + 1);
  expect(await slider(page, gear).evaluate((el) => el.matches(':focus-visible')), `${at}, ${gear}: and then the ring shows`).toBe(true);
}

/** The ✕'s box in a strip, and taps near the bottom of its glyph, which are the ✕'s. */
async function checkResetReach(page: Page, finger: Finger, gear: GearId, at: string, mode: Mode) {
  await setThumbOn(page, gear, 60);
  const b = await boxes(page, gear);
  const reset = b.reset!;
  expect(reset.height, `${at}, ${gear}: the ✕'s box is ${mode === 'mini' ? 29 : 20} px tall`).toBeGreaterThanOrEqual(mode === 'mini' ? 29 : 20);
  expect(reset.top, `${at}, ${gear}: the ✕'s box is inside the strip`).toBeGreaterThanOrEqual(b.strip.top - 0.01);
  const icon = b.icon!;
  for (const inset of [1, 3, 5]) {
    await setThumbOn(page, gear, 60);
    await finger.tap({ x: icon.left + icon.width / 2, y: icon.bottom - inset }, 1);
    await expect.poll(() => isOff(page, gear), { message: `${at}, ${gear}: a tap ${inset} px above the icon's bottom turns the gear off` }).toBe(true);
    expect(await value(page, gear), `${at}, ${gear}: and does not move it`).toBe(DEFAULTS[gear]);
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
      /** One gear's strip in turn: all of them are on the page when expanded, one is behind its tab in mini. */
      const show = async (page: Page, part: GearId | 'era') => {
        if (mode === 'mini') await tab(page, part).click();
      };

      test('a drag and a tap that start 10 to 18 px above the thumb, with the thumb at 100 and at 25, move the fader at a touch radius of 1, 10, 12 and 16, and never turn the gear off', async ({ page }) => {
        test.setTimeout(180_000);
        await openAt(page, mode);
        // (Popularity starts at 100 and sits under the ✕; Difficulty too once set. The second gear only at 390, where chief-keef looked: the strips are the same.)
        for (const gear of (width === 390 ? ['popularity', 'difficulty'] : ['popularity']) as GearId[]) {
          await show(page, gear);
          await checkAbove(page, cdpFinger(page), gear, at, [1, 10, 12, 16]);
        }
      });

      test('a double tap on each gear\'s ✕ and on Era\'s, 120 and 400 ms apart, leaves it off at its default with one record', async ({ page }) => {
        test.setTimeout(180_000);
        const { events } = await openAt(page, mode);
        const finger = cdpFinger(page);
        const touch = (p: Point, r: number) => finger.tap(p, r);
        for (const part of ['difficulty', 'popularity', 'tempo', 'history'] as GearId[]) {
          await show(page, part);
          await checkDoubleTapReset(page, events, part, at, [6, 10, 14], [120, 400], touch);
        }
        await show(page, 'era');
        await checkDoubleTapReset(page, events, 'era', at, [6, 10, 14], [120, 400], touch);
      });

      test('taps on the title, between it and the ✕, beside the ✕ and just above the track change nothing, at a touch radius of 6, 10 and 14', async ({ page }) => {
        test.setTimeout(120_000);
        const { events } = await openAt(page, mode);
        const finger = cdpFinger(page);
        const touch = (p: Point, r: number) => finger.tap(p, r);
        for (const gear of ['difficulty', 'popularity', 'history'] as GearId[]) {
          await show(page, gear);
          await checkTapsNear(page, events, gear, at, [6, 10, 14], touch);
        }
        // Tempo starts off: nothing there turns it on either.
        await show(page, 'tempo');
        await checkTapsNear(page, events, 'tempo', at, [6, 10, 14], touch, true);
      });

      test('a swipe that kicks 15 px sideways in its first 6 to 8 px and then goes 120 px up or down changes nothing: Tempo stays off, and Difficulty stays at 0', async ({ page }) => {
        test.setTimeout(180_000);
        const { events } = await openAt(page, mode, 'tempo');
        const finger = cdpFinger(page);
        await show(page, 'tempo');
        await checkKickedSwipes(page, events, 'tempo', at, finger, [1, 12], true);
        await show(page, 'difficulty');
        await checkKickedSwipes(page, events, 'difficulty', at, finger, [1, 12], false);
      });

      test('the ✕ is as tall as its strip allows, and a tap near the bottom of its glyph turns the gear off', async ({ page }) => {
        test.setTimeout(90_000);
        await openAt(page, mode);
        for (const gear of ['difficulty', 'popularity', 'history'] as GearId[]) {
          await show(page, gear);
          await checkResetReach(page, cdpFinger(page), gear, at, mode);
        }
      });
    });
  }
}

test.describe('at 390 px, expanded, in Chromium', () => {
  test.beforeEach(({ browserName }) => test.skip(browserName !== 'chromium', 'the ring is a real browser\'s'));

  test('the ✕ draws one ring on keyboard focus', async ({ page }) => {
    test.setTimeout(60_000);
    await openAt(page, 'expanded');
    for (const gear of ['difficulty', 'popularity', 'history'] as GearId[]) {
      await setThumbOn(page, gear, 40);
      await checkOneRing(page, gear, '390 px, expanded');
    }
    await page.evaluate(() => (window as unknown as { setlist: { setState(p: object): void } }).setlist.setState({ off: [], eras: ['s80'] }));
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement?.getAttribute('data-reset') === 'era')) break;
    }
    expect(await eraButton(page, 's80').count()).toBe(1);
    const era = await page.evaluate(() => {
      const b = document.querySelector<HTMLElement>('button[data-reset="era"]')!;
      return { focused: document.activeElement === b, button: getComputedStyle(b).outlineStyle, icon: getComputedStyle(b.querySelector('svg')!).outlineStyle };
    });
    expect(era).toEqual({ focused: true, button: 'none', icon: 'solid' });
  });

  test('a click on a fader leaves its slider focused with no keyboard ring until a key is pressed (a page that has seen no key)', async ({ page }) => {
    test.setTimeout(60_000);
    await openAt(page, 'expanded');
    await checkMouseFocus(page, 'popularity', '390 px, expanded');
    await checkMouseFocus(page, 'difficulty', '390 px, expanded');
  });
});

// ============================================================================================================
// WebKit (desktop, not iOS Safari: see tests/e2e/setlist-fader.spec.ts)
// ============================================================================================================

test.describe('in WebKit (desktop WebKit, not iOS Safari)', () => {
  test.skip(!existsSync(webkit.executablePath()), 'WebKit is not installed here (CI installs Chromium only)');

  for (const width of WIDTHS) {
    for (const mode of MODES) {
      test(`${width} px, ${mode}: presses above the thumb, double taps on the ✕, taps near the fader, kicked swipes, the ✕'s reach and the focus`, async ({ baseURL }) => {
        test.setTimeout(240_000);
        const browser = await webkit.launch();
        try {
          const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width, height: 844 }, baseURL, reducedMotion: 'reduce' });
          const page = await context.newPage();
          const at = `WebKit, ${width} px, ${mode}`;
          const finger = syntheticFinger(page);
          const { events } = await openAt(page, mode);
          const show = async (part: GearId | 'era') => {
            if (mode === 'mini') await tab(page, part).click();
          };
          const touch = (p: Point, r: number) => finger.tap(p, r);
          for (const gear of ['popularity', 'difficulty'] as GearId[]) {
            await show(gear);
            await checkAbove(page, finger, gear, at, [1]);
            await checkDoubleTapReset(page, events, gear, at, [1], [120, 400], touch);
            await checkTapsNear(page, events, gear, at, [1], touch);
            await checkResetReach(page, finger, gear, at, mode);
          }
          await show('tempo');
          await checkKickedSwipes(page, events, 'tempo', at, finger, [1], true);
          await show('difficulty');
          await checkKickedSwipes(page, events, 'difficulty', at, finger, [1], false);
          await show('era');
          await checkDoubleTapReset(page, events, 'era', at, [1], [120, 400], touch);
          // (Not the keyboard ring: Safari's Tab skips buttons unless the user has asked it to, so a desktop WebKit cannot Tab to the ✕.)
          if (mode === 'expanded') await checkMouseFocus(page, 'popularity', at);
          await context.close();
        } finally {
          await browser.close();
        }
      });
    }
  }
});
