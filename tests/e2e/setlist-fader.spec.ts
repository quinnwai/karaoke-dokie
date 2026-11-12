// Review item R33 of QWW-57 (Quinn-Wai's iPhone review of #38, 11 Nov): faders are easy to grab by touch. On a phone a gear's fader "either
// doesn't work or needs a very precise press": a native range input takes a touch only on its own 14 by 20 px thumb (iOS WebKit above all), and
// `touch-action: none` over the whole strip stopped the sheet scrolling too. The strip now takes the pointer on a hit area of its own
// (src/components/setlist/GearStrip.tsx, `.faderHit` in sheet.module.css): the track's full width and 44 px tall (8 px above the drawn track, 16
// below it), over the labels, with the ✕'s touch area above it and none of it over it (the second pass, on the thumb at the track's ends, is
// tests/e2e/setlist-fader-ends.spec.ts). The input stays under it for the keyboard and screen readers. Checked at 375 and 390 px, expanded and in
// mini, for all four gears:
//   - the hit area's box, and what is under points above, below and at the ends of the track; a neighbouring strip's is not this one's
//   - a drag that starts 16 px above the thumb, one that starts on the track 60 px from it (either side) and one on the thumb all take the value to
//     the finger and follow it, without jumping at the first touch; a tap on the track 60 px from the thumb jumps there
//   - a swipe that is mostly vertical leaves the value, the gear's on/off and the event log alone, and the browser takes it (a pointercancel: it
//     can scroll with it, which `touch-action: none` stopped)
//   - the ✕ keeps its tap; a gear that cannot be used has no hit area; a mouse press jumps and a drag follows it outside the area; the keyboard
//     still moves the input, and one adjustment is one gear_change
//
// Chromium takes real touch through DevTools (Input.dispatchTouchEvent). Playwright's WebKit is desktop WebKit, not iOS Safari: there a tap is a
// real touchscreen.tap, but a drag is PointerEvents (pointerType 'touch') dispatched from the page, so it checks OUR handler and the layout under
// WebKit's engine, not iOS's own touch handling, which no desktop browser can reproduce. The WebKit tests run where WebKit is installed (CI
// installs Chromium only), as tests/e2e/setlist-play.spec.ts does. The arithmetic is tests/setlist/fader.test.ts, the handler's rules
// tests/setlist/faderStrip.test.tsx.

import { devices, expect, test, webkit, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import type { AppEvent } from '../../src/lib/contracts';
import { DEFAULTS } from '../../src/lib/setlist/defaults';
import type { GearId } from '../../src/lib/setlist/types';
import {
  boxes,
  cdpFinger,
  checkTouchDrags,
  countCancels,
  expectValue,
  GEARS,
  isOff,
  line,
  makeScreensDir,
  MODES,
  openAt,
  setThumb,
  shot,
  syntheticFinger,
  thumb,
  under,
  valueAt,
  type Finger,
} from '../helpers/faderE2e';
import { open, rack, slider, tab, tuner, value } from '../helpers/tunerE2e';

test.beforeAll(() => makeScreensDir());

// A touch phone, 844 px tall so that the expanded sheet opens expanded at either width. Motion is off, so nothing is mid-flicker when it is measured.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

const WIDTHS = [375, 390] as const;

// ============================================================================================================
// What each check does, once for a finger, whichever engine drives it
// ============================================================================================================

/** The hit area's box, and what is on top at points above, below and at the ends of the track, for every gear on show. */
async function checkGeometry(page: Page, gears: GearId[], at: string) {
  for (const gear of gears) {
    const b = await boxes(page, gear);
    const why = `${at}, ${gear}`;
    expect(b.hit, `${why}: it has a hit area`).not.toBeNull();
    const hit = b.hit!;
    expect(hit.height, `${why}: the hit area is ${hit.height} px tall`).toBeGreaterThanOrEqual(44);
    // The track and half a knob (7 px) more at each end, so the end values are easy to reach.
    expect(hit.left, `${why}: the hit area starts ${b.track.left - hit.left} px before the track`).toBeLessThanOrEqual(b.track.left - 7 + 0.5);
    expect(hit.right, `${why}: the hit area ends ${hit.right - b.track.right} px after the track`).toBeGreaterThanOrEqual(b.track.right + 7 - 0.5);
    // It reaches 8 px above the track (so 16 px above the thumb's centre is inside it) and 16 below, where the ✕'s area ends (setlist-fader-ends.spec.ts).
    const centre = b.track.top + b.track.height / 2;
    expect(b.track.top - hit.top, `${why}: the hit area reaches ${b.track.top - hit.top} px above the track`).toBeGreaterThanOrEqual(8 - 0.5);
    expect(hit.bottom - b.track.bottom, `${why}: the hit area reaches ${hit.bottom - b.track.bottom} px below the track`).toBeGreaterThanOrEqual(16 - 0.5);
    expect(Math.abs(b.knob.top + b.knob.height / 2 - centre), `${why}: the knob is level with the track`).toBeLessThan(1);
    expect(await slider(page, gear).evaluate((el) => getComputedStyle(el).pointerEvents), `${why}: the input takes no pointer`).toBe('none');
    expect(await page.locator(`[data-strip][data-gear="${gear}"] [data-fader]`).evaluate((el) => getComputedStyle(el).touchAction), `${why}: a swipe up or down is the browser's`).toBe('pan-y');

    // What is on top at the hit area's own corners, its middle and the ends of the track at several heights in it: the gear's own hit area, at every point
    // (the ✕ is above it, not over it, so there is no point of it that the ✕ takes).
    const xs = [b.track.left, b.track.left + 1, b.track.left + b.track.width / 2, b.track.right - 1, b.track.right, hit.left + 1, hit.right - 1];
    const ys = [hit.top + 1, centre - 10, centre, centre + 10, centre + 20, hit.bottom - 1];
    for (const x of xs) {
      for (const y of ys) {
        const p = { x, y };
        expect(await under(page, p), `${why}: on top at x ${Math.round(x)}, ${Math.round(y - centre)} px from the track's centre`).toBe(`fader:${gear}`);
      }
    }
    // Past the box it is no fader's: not this gear's, and not a neighbour's, whose strip is 6 px away.
    for (const y of [hit.top - 2, hit.bottom + 2]) expect(await under(page, { x: b.track.left + b.track.width / 2, y }), `${why}: 2 px past the hit area`).not.toMatch(/^fader:/);
    // And nothing of the ✕ is over it: where the hit area ends at the top, the ✕ is above it.
    if (b.reset) expect(b.reset.bottom, `${why}: the ✕ ends at ${b.reset.bottom}, the hit area begins at ${hit.top}`).toBeLessThanOrEqual(hit.top + 0.01);
  }
  // No two hit areas overlap, so a neighbouring gear's fader is never caught by this one's.
  const all = await Promise.all(gears.map(async (gear) => ({ gear, hit: (await boxes(page, gear)).hit! })));
  for (const a of all) {
    for (const c of all) {
      if (a.gear === c.gear) continue;
      const overlap = a.hit.left < c.hit.right && c.hit.left < a.hit.right && a.hit.top < c.hit.bottom && c.hit.top < a.hit.bottom;
      expect(overlap, `${at}: the ${a.gear} and ${c.gear} hit areas overlap`).toBe(false);
    }
  }
}

/** A swipe 8 px across and 60 px down that starts on the fader, 60 px from the thumb so that a thumb that jumped to it would show. */
async function checkVerticalSwipe(page: Page, finger: Finger, gears: GearId[], at: string, expectCancel: boolean, shots?: string) {
  const cancels = await countCancels(page);
  let expected = 0;
  for (const gear of gears) {
    await setThumb(page, gear, 25);
    const t = await thumb(page, gear);
    const from = { x: t.x + 60, y: t.y - 8 };
    const to = { x: from.x + 8, y: from.y + 60 };
    const was = await tuner(page);
    const why = `${at}, ${gear}, a swipe 8 px across and 60 px down`;
    expect(await under(page, from), `${why}: the finger lands on the gear's hit area`).toBe(`fader:${gear}`);
    await finger.drag(line(from, to));
    await page.waitForTimeout(100);
    if (shots && gear === 'difficulty') await shot(page, `${shots}-swipe`, from, to);
    const now = await tuner(page);
    expect(now[gear], `${why}: the value`).toBe(25);
    expect(now.off, `${why}: what is off`).toEqual(was.off);
    expect(now.open, `${why}: the open gear`).toBe(was.open);
    expect(await page.evaluate(() => scrollY), `${why}: the page`).toBe(0);
    if (expectCancel) expected++;
    expect(await cancels(), `${why}: the browser takes the swipe (a pointercancel)`).toBe(expected);
  }
}

/**
 * The review of 828aaca: a 120 px swipe down that drifts 15 px sideways in its first 9 px is not a drag, and no gear is turned on or moved by it, whether
 * the browser cancels the press or (as when it began sideways) does not. `off` leaves the gear off, as Tempo starts.
 */
async function checkWobblingSwipe(page: Page, finger: Finger, gear: GearId, at: string, off = false) {
  if (!off) await setThumb(page, gear, 25);
  const t = await thumb(page, gear);
  const from = { x: t.x + 60, y: t.y - 8 };
  const path = [
    [0, 0],
    [7, 4],
    [15, 9],
    [15, 20],
    [15, 40],
    [15, 70],
    [15, 100],
    [15, 120],
  ].map(([dx, dy]) => ({ x: from.x + dx!, y: from.y + dy! }));
  const was = await tuner(page);
  const why = `${at}, ${gear}${off ? ' (off)' : ''}, a swipe 120 px down that drifted 15 px across in its first 9 px`;
  expect(await under(page, from), `${why}: the finger lands on the gear's hit area`).toBe(`fader:${gear}`);
  await finger.drag(path, {
    end: async () => {
      expect((await tuner(page))[gear], `${why}: the value, before the finger lifts`).toBe(was[gear]);
      expect((await tuner(page)).off, `${why}: what is off, before the finger lifts`).toEqual(was.off);
    },
  });
  await page.waitForTimeout(100);
  const now = await tuner(page);
  expect(now[gear], `${why}: the value`).toBe(was[gear]);
  expect(now.off, `${why}: what is off`).toEqual(was.off);
}

/**
 * The review of 828aaca: a drag that dips 7 px down first and then goes 80 px sideways is a drag, and takes the value to the finger. A finger reports
 * every few px, so the sideways part is in small steps (2 px): the first move past 8 px in all is then still mostly down, which is what once made
 * the fader call it a scroll.
 */
async function checkDippingDrag(page: Page, finger: Finger, gear: GearId, at: string) {
  await setThumb(page, gear, 25);
  const t = await thumb(page, gear);
  const end = Math.min(t.x + 80, t.track.right - 3);
  const path = [{ x: t.x, y: t.y }, { x: t.x, y: t.y + 7 }, ...line({ x: t.x + 2, y: t.y + 7 }, { x: end, y: t.y + 8 }, Math.round((end - t.x) / 2) - 1)];
  const why = `${at}, ${gear}, a drag that dipped 7 px down and then went sideways`;
  await finger.drag(path, { end: async () => expectValue(page, gear, valueAt(t.track, end), `${why} (while the finger is down)`) });
  await expectValue(page, gear, valueAt(t.track, end), `${why} (after it lifts)`);
  expect(await isOff(page, gear), `${why}: the gear is on`).toBe(false);
}

/** Tapping a gear's ✕ turns the gear off and sets nothing: the hit area under it does not take the tap. */
async function checkResetTap(page: Page, finger: Finger, gear: GearId, at: string) {
  await setThumb(page, gear, 25);
  const b = await boxes(page, gear);
  expect(b.reset, `${at}, ${gear}: the ✕ is shown while the gear is on`).not.toBeNull();
  const centre = { x: b.reset!.left + b.reset!.width / 2, y: b.reset!.top + b.reset!.height / 2 };
  expect(await under(page, centre), `${at}, ${gear}: the ✕ is on top at its own centre`).toBe(`reset:${gear}`);
  await finger.tap(centre);
  await expect.poll(() => isOff(page, gear), { message: `${at}, ${gear}: the ✕ turned it off` }).toBe(true);
  expect(await value(page, gear), `${at}, ${gear}: the ✕ put it back at its default, not where the tap was`).toBe(DEFAULTS[gear]);
}

/**
 * A mouse click on a gear's fader: the browser's own step for a mousedown used to take the focus off the slider (the hit area cannot take it), so the arrow
 * keys did nothing after a click (the review of 828aaca). Real mouse events, which jsdom cannot give: the focus is the slider's, and a key moves it.
 */
async function checkMouseFocus(page: Page, gear: GearId) {
  await setThumb(page, gear, 25);
  const t = await thumb(page, gear);
  await page.mouse.click(t.x + 40, t.y);
  await expectValue(page, gear, valueAt(t.track, t.x + 40), `${gear}: the click`);
  expect(await page.evaluate(() => document.activeElement?.id ?? document.activeElement?.tagName), `${gear}: the slider has the focus after the click`).toBe(`slider-${gear}`);
  const clicked = await value(page, gear);
  await page.keyboard.press('ArrowRight');
  await expectValue(page, gear, clicked + 1, `${gear}: an arrow key after the click`);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expectValue(page, gear, clicked - 1, `${gear}: two arrow keys back`);
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

      test('the hit area is at least 44 px tall and spans the track and 7 px more at each end, reaching 8 px above it and 16 below, and the gear is what is on top at every point of it', async ({ page }) => {
        test.setTimeout(90_000);
        await openAt(page, mode);
        if (mode === 'expanded') await checkGeometry(page, GEARS, at);
        else
          for (const gear of GEARS) {
            await tab(page, gear).click();
            await checkGeometry(page, [gear], at);
          }
      });

      test('a drag from 16 px above the thumb, from the track 60 px away (either side) and from the thumb each take the value to the finger and follow it; a tap 60 px away jumps there', async ({ page }) => {
        test.setTimeout(120_000);
        await openAt(page, mode);
        for (const gear of GEARS) {
          if (mode === 'mini') await tab(page, gear).click();
          await checkTouchDrags(page, cdpFinger(page), [gear], at, { shots: width === 390 && mode === 'expanded' ? `fader-${width}-${mode}` : undefined });
        }
      });

      test('a swipe 8 px across and 60 px down that starts on the fader leaves the value, the on/off and the page alone, and the browser takes it', async ({ page }) => {
        test.setTimeout(90_000);
        await openAt(page, mode);
        for (const gear of GEARS) {
          if (mode === 'mini') await tab(page, gear).click();
          await checkVerticalSwipe(page, cdpFinger(page), [gear], at, true, width === 390 && mode === 'expanded' ? `fader-${width}-${mode}` : undefined);
        }
      });

      test('a 120 px swipe down that drifts 15 px sideways in its first 9 px changes nothing, and a drag that dips 7 px down and then goes 80 px sideways moves the value', async ({ page }) => {
        test.setTimeout(90_000);
        await openAt(page, mode, 'tempo');
        const finger = cdpFinger(page);
        // Tempo is off to begin with: the swipe must not turn it on.
        await checkWobblingSwipe(page, finger, 'tempo', at, true);
        for (const gear of ['difficulty', 'popularity', 'tempo', 'history'] as GearId[]) {
          if (mode === 'mini') await tab(page, gear).click();
          if (gear !== 'tempo') await checkWobblingSwipe(page, finger, gear, at);
          await checkDippingDrag(page, finger, gear, at);
        }
      });

      test('Tempo starts off: a drag or a tap on its fader turns it on at the finger, and a swipe up or down leaves it off', async ({ page }) => {
        test.setTimeout(60_000);
        await openAt(page, mode, 'tempo');
        const finger = cdpFinger(page);
        expect(await isOff(page, 'tempo'), 'Tempo starts off').toBe(true);
        let t = await thumb(page, 'tempo');
        const swipeFrom = { x: t.x + 60, y: t.y };
        await finger.drag(line(swipeFrom, { x: swipeFrom.x + 8, y: swipeFrom.y + 60 }));
        await page.waitForTimeout(100);
        expect(await isOff(page, 'tempo'), 'a swipe up or down leaves it off').toBe(true);
        expect(await value(page, 'tempo')).toBe(DEFAULTS.tempo);

        // A tap on the track 60 px from the (unlit) knob turns it on there.
        await finger.tap({ x: t.x + 60, y: t.y });
        await expect.poll(() => isOff(page, 'tempo'), { message: 'a tap turns it on' }).toBe(false);
        await expectValue(page, 'tempo', valueAt(t.track, t.x + 60), 'a tap 60 px from the knob');

        // Off again by its ✕, then a drag from 16 px above the knob.
        await checkResetTap(page, finger, 'tempo', at);
        t = await thumb(page, 'tempo');
        const from = { x: t.x, y: t.y - 16 };
        await finger.drag(line(from, { x: t.x + 60, y: from.y + 5 }));
        await expect.poll(() => isOff(page, 'tempo'), { message: 'a drag turns it on' }).toBe(false);
        await expectValue(page, 'tempo', valueAt(t.track, t.x + 60), 'a drag from 16 px above the knob');
      });

      test('the ✕ keeps its tap: it turns the gear off at its default and the fader under it does not take the touch', async ({ page }) => {
        test.setTimeout(60_000);
        await openAt(page, mode);
        for (const gear of ['difficulty', 'popularity', 'history'] as GearId[]) {
          if (mode === 'mini') await tab(page, gear).click();
          await checkResetTap(page, cdpFinger(page), gear, at);
        }
      });
    });
  }
}

test.describe('at 390 px, expanded, in Chromium', () => {
  test.beforeEach(({ browserName }) => test.skip(browserName !== 'chromium', 'touch is driven through Chromium DevTools'));

  test('one adjustment is one gear_change, at its end: a drag, a tap and a keyboard step each record one, a swipe up or down none', async ({ page }) => {
    const { events } = await openAt(page, 'expanded');
    const finger = cdpFinger(page);
    const flush = () => page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    const changes = (): AppEvent[] => events.filter((e) => e.name === 'gear_change');
    await setThumb(page, 'difficulty', 25);
    const t = await thumb(page, 'difficulty');

    await finger.drag(line({ x: t.x, y: t.y - 16 }, { x: t.x + 80, y: t.y - 12 }, 20));
    await expectValue(page, 'difficulty', valueAt(t.track, t.x + 80), 'the drag');
    await flush();
    await expect.poll(() => changes().length, { message: 'one record for the drag' }).toBe(1);
    expect(changes()[0]!.props).toMatchObject({ gear: 'difficulty', on: true, value: await value(page, 'difficulty') });

    await finger.drag(line({ x: t.x + 60, y: t.y }, { x: t.x + 68, y: t.y + 60 }));
    await page.waitForTimeout(200);
    await flush();
    await finger.tap({ x: t.x + 30, y: t.y });
    await expectValue(page, 'difficulty', valueAt(t.track, t.x + 30), 'the tap');
    await flush();
    await expect.poll(() => changes().length, { message: 'the swipe records none, the tap one' }).toBe(2);
    expect(changes()[1]!.props).toMatchObject({ gear: 'difficulty', on: true, value: await value(page, 'difficulty') });

    // The keyboard goes through the input, as it did: a step is one adjustment.
    await slider(page, 'difficulty').focus();
    await page.keyboard.press('ArrowRight');
    await flush();
    await expect.poll(() => changes().length, { message: 'a key step' }).toBe(3);
    expect(changes()[2]!.props).toMatchObject({ gear: 'difficulty', value: valueAt(t.track, t.x + 30) + 1 });
  });

  test('a mouse press jumps the value to the pointer and a drag follows it past the edge of the hit area; moving over it presses nothing', async ({ page }) => {
    await openAt(page, 'expanded');
    await setThumb(page, 'popularity', 25);
    const t = await thumb(page, 'popularity');
    await page.mouse.move(t.x + 80, t.y);
    await page.waitForTimeout(100);
    expect(await value(page, 'popularity'), 'a pointer passing over').toBe(25);
    await page.mouse.down();
    await expectValue(page, 'popularity', valueAt(t.track, t.x + 80), 'the press');
    await page.mouse.move(t.x + 100, t.y - 30, { steps: 4 });
    await page.mouse.move(t.x + 120, t.y - 90, { steps: 4 });
    await expectValue(page, 'popularity', valueAt(t.track, t.x + 120), 'a drag that has left the hit area');
    await page.mouse.up();
    await page.mouse.move(t.x + 10, t.y - 90, { steps: 4 });
    await page.waitForTimeout(100);
    await expectValue(page, 'popularity', valueAt(t.track, t.x + 120), 'after the button is up');
    expect(await isOff(page, 'popularity')).toBe(false);
  });

  test('a mouse press on the fader leaves the focus on its slider, so the arrow keys carry on from the press (the review of 828aaca)', async ({ page }) => {
    await openAt(page, 'expanded');
    await checkMouseFocus(page, 'popularity');
    await checkMouseFocus(page, 'difficulty');
  });

  test('a gear that cannot be used has no hit area and takes no touch: signed out, History stays off at its default', async ({ page }) => {
    const { events } = await open(page, { loggedIn: false });
    await expect(slider(page, 'history')).toBeDisabled();
    expect(await page.locator('[data-strip][data-gear="history"] [data-fader]').count()).toBe(0);
    const b = await boxes(page, 'history');
    const centre = { x: b.track.left + b.track.width / 2, y: b.track.top + b.track.height / 2 };
    expect(await under(page, centre)).not.toBe('fader:history');
    await cdpFinger(page).tap(centre);
    await cdpFinger(page).drag(line({ x: centre.x - 40, y: centre.y }, { x: centre.x + 40, y: centre.y }));
    await page.waitForTimeout(150);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    expect(await isOff(page, 'history')).toBe(true);
    expect(await value(page, 'history')).toBe(DEFAULTS.history);
    expect(events.filter((e) => e.name === 'gear_change')).toEqual([]);
  });

  test('the sheet does not scroll or resize while a finger drags a fader, up or down', async ({ page }) => {
    await openAt(page, 'expanded');
    await setThumb(page, 'tempo', 25);
    const t = await thumb(page, 'tempo');
    await cdpFinger(page).drag(line({ x: t.x, y: t.y }, { x: t.x + 70, y: t.y - 30 }));
    await expectValue(page, 'tempo', valueAt(t.track, t.x + 70), 'a drag that drifts up');
    expect((await rack(page)).height).toBe(416);
    expect(await page.evaluate(() => ({ y: scrollY, app: document.getElementById('app')!.scrollTop }))).toEqual({ y: 0, app: 0 });
  });
});

// ============================================================================================================
// WebKit (desktop, not iOS Safari: see the top of the file)
// ============================================================================================================

test.describe('in WebKit', () => {
  test.skip(!existsSync(webkit.executablePath()), 'WebKit is not installed here (CI installs Chromium only)');

  for (const width of WIDTHS) {
    for (const mode of MODES) {
      test(`${width} px, ${mode}: the hit area, a drag from 16 px above the thumb, from 60 px away and from the thumb, a tap, a swipe up or down and the ✕`, async ({ baseURL }) => {
        test.setTimeout(150_000);
        const browser = await webkit.launch();
        try {
          const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width, height: 844 }, baseURL, reducedMotion: 'reduce' });
          const page = await context.newPage();
          const at = `WebKit, ${width} px, ${mode}`;
          const finger = syntheticFinger(page);
          await openAt(page, mode);
          if (mode === 'expanded') await checkGeometry(page, GEARS, at);
          for (const gear of GEARS) {
            if (mode === 'mini') {
              await tab(page, gear).click();
              await checkGeometry(page, [gear], at);
            }
            await checkTouchDrags(page, finger, [gear], at);
            await checkVerticalSwipe(page, finger, [gear], at, false);
            await checkWobblingSwipe(page, finger, gear, at);
            await checkDippingDrag(page, finger, gear, at);
            if (mode === 'expanded' && gear !== 'tempo') await checkMouseFocus(page, gear);
            await checkResetTap(page, finger, gear, at);
          }
          await context.close();
        } finally {
          await browser.close();
        }
      });
    }
  }
});
