// Review item R33 of QWW-57 (Quinn-Wai's iPhone review of #38, 11 Nov): faders are easy to grab by touch. On a phone a gear's fader "either
// doesn't work or needs a very precise press": a native range input takes a touch only on its own 14 by 20 px thumb (iOS WebKit above all), and
// `touch-action: none` over the whole strip stopped the sheet scrolling too. The strip now takes the pointer on a hit area of its own
// (src/components/setlist/GearStrip.tsx, `.faderHit` in sheet.module.css): the track's full width and 44 px tall, centred on the drawn track, over
// the labels and under the ✕. The input stays under it for the keyboard and screen readers. Checked at 375 and 390 px, expanded and in mini, for
// all four gears:
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
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AppEvent } from '../../src/lib/contracts';
import { DEFAULTS } from '../../src/lib/setlist/defaults';
import type { GearId } from '../../src/lib/setlist/types';
import { open, rack, slider, strip, tab, tuner, value } from '../helpers/tunerE2e';

const SCREENS = path.resolve('test-results/screens');
test.beforeAll(() => mkdirSync(SCREENS, { recursive: true }));

// A touch phone, 844 px tall so that the expanded sheet opens expanded at either width. Motion is off, so nothing is mid-flicker when it is measured.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

const GEARS: GearId[] = ['difficulty', 'popularity', 'tempo', 'history'];
const WIDTHS = [375, 390] as const;
const MODES = ['expanded', 'mini'] as const;
type Mode = (typeof MODES)[number];

interface Point {
  x: number;
  y: number;
}
interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

// ---- measuring ----

/** The boxes of a strip's hit area, drawn track, knob and ✕ (null when it has none or it is not shown), in page px. */
const boxes = (page: Page, gear: GearId) =>
  strip(page, gear).evaluate((el) => {
    const box = (e: Element | null): Box | null => {
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return b.width === 0 && b.height === 0 ? null : { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
    };
    const knob = el.querySelector('[data-knob]')!;
    return { hit: box(el.querySelector('[data-fader]')), track: box(knob.parentElement)!, knob: box(knob)!, reset: box(el.querySelector('button[data-reset]')) };
  });

/** Where the drawn knob's centre is, and the track it travels. */
async function thumb(page: Page, gear: GearId) {
  const b = await boxes(page, gear);
  return { x: b.knob.left + b.knob.width / 2, y: b.knob.top + b.knob.height / 2, track: b.track };
}

/** The value a pointer at `x` should give: the track's length is 0 to 100. */
const valueAt = (track: Box, x: number) => Math.max(0, Math.min(100, Math.round(((x - track.left) / track.width) * 100)));

/** What is on top at a point: the gear whose hit area it is, or the ✕ of a gear, or the tag of anything else. */
const under = (page: Page, p: Point) =>
  page.evaluate(({ x, y }) => {
    const e = document.elementFromPoint(x, y);
    const gear = e?.closest('[data-strip]')?.getAttribute('data-gear') ?? null;
    if (e?.closest('[data-fader]')) return `fader:${gear}`;
    if (e?.closest('button[data-reset]')) return `reset:${gear}`;
    return e ? `${e.tagName.toLowerCase()}${gear ? `:${gear}` : ''}` : 'nothing';
  }, p);

/** A point is in a box as the browser's hit test sees it: the left and top edges are in, the right and bottom edges are not. */
const inside = (b: Box | null, p: Point) => b !== null && p.x >= b.left && p.x < b.right && p.y >= b.top && p.y < b.bottom;

/** The tuner's state with the gear's value set and nothing else changed, so the thumb is where a test wants it. */
async function setThumb(page: Page, gear: GearId, v: number) {
  await page.evaluate(([g, n]) => (window as unknown as { setlist: { setState(patch: object): void } }).setlist.setState({ [g as string]: n }), [gear, v] as const);
  await expect.poll(() => value(page, gear)).toBe(v);
}

/** The value is within a step of what the finger's position says, as the tuner reads it. */
async function expectValue(page: Page, gear: GearId, expected: number, why: string) {
  await expect.poll(async () => Math.abs((await value(page, gear)) - expected), { message: `${why}: the value should be about ${expected}` }).toBeLessThanOrEqual(1);
}

const isOff = async (page: Page, gear: GearId) => (await tuner(page)).off.includes(gear);

// ---- the way in, and a finger ----

/** The tuner at a width and in a mode, signed in so that History's slider works too, with a gear's strip on show. */
async function openAt(page: Page, mode: Mode, gear: GearId = 'difficulty', loggedIn = true) {
  const opened = await open(page, { mini: mode === 'mini', loggedIn });
  if (loggedIn) await expect(slider(page, 'history')).toBeEnabled();
  await expect(page.locator('#app')).toHaveAttribute('data-mode', mode);
  if (mode === 'mini') await tab(page, gear).click();
  await expect(strip(page, gear)).toBeVisible();
  return opened;
}

interface Finger {
  /** Down at the first point, along the rest, up. `down` runs after the touch has landed, `end` before it lifts. */
  drag(path: Point[], hooks?: { down?(): Promise<void>; end?(): Promise<void> }): Promise<void>;
  tap(p: Point): Promise<void>;
}

/** Real touch through Chromium's DevTools, which raises the same touch and pointer events a finger does. */
const cdpFinger = (page: Page): Finger => ({
  async drag(points, hooks) {
    const cdp = await page.context().newCDPSession(page);
    try {
      const [first, ...rest] = points;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first!] });
      await hooks?.down?.();
      for (const p of rest) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] });
      await hooks?.end?.();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await cdp.detach();
    }
  },
  tap: (p) => page.touchscreen.tap(p.x, p.y),
});

/**
 * WebKit: a real tap, and for a drag the PointerEvents a touch raises, dispatched from the page at whatever is on top where the finger lands
 * (the target of its moves is that element, as a touch's is). This checks our handler under WebKit, not iOS's touch handling.
 */
const syntheticFinger = (page: Page): Finger => {
  const fire = (type: 'pointerdown' | 'pointermove' | 'pointerup', p: Point) =>
    page.evaluate(
      ({ type, p }) => {
        const w = window as unknown as { __finger?: Element | null };
        if (type === 'pointerdown') w.__finger = document.elementFromPoint(p.x, p.y);
        w.__finger?.dispatchEvent(
          new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 41, pointerType: 'touch', isPrimary: true, clientX: p.x, clientY: p.y, button: 0, buttons: type === 'pointerup' ? 0 : 1 }),
        );
        if (type === 'pointerup') w.__finger = null;
      },
      { type, p },
    );
  return {
    async drag(points, hooks) {
      const [first, ...rest] = points;
      await fire('pointerdown', first!);
      await hooks?.down?.();
      for (const p of rest) await fire('pointermove', p);
      await hooks?.end?.();
      await fire('pointerup', rest.at(-1) ?? first!);
    },
    tap: (p) => page.touchscreen.tap(p.x, p.y),
  };
};

/** A straight line of fingers from `a` to `b`, `a` first. */
const line = (a: Point, b: Point, steps = 10): Point[] => Array.from({ length: steps + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps }));

/** Dots where a finger starts (red) and ends (green), over the sheet, for a screenshot of it. */
async function shot(page: Page, name: string, from: Point, to: Point) {
  await page.evaluate(
    (dots) => {
      for (const d of dots) {
        const i = document.createElement('i');
        i.setAttribute('data-test-mark', '');
        i.style.cssText = `position:fixed;left:${d.x - 7}px;top:${d.y - 7}px;width:14px;height:14px;border-radius:50%;background:${d.colour};opacity:.9;pointer-events:none;z-index:99999`;
        document.body.append(i);
      }
    },
    [
      { ...from, colour: '#ff2d2d' },
      { ...to, colour: '#27e36a' },
    ],
  );
  await page.locator('#sheet').screenshot({ path: path.join(SCREENS, `${name}.png`) });
  await page.evaluate(() => document.querySelectorAll('[data-test-mark]').forEach((e) => e.remove()));
}

/** Listens for the browser taking a touch away from the page (pointercancel, which it sends when it starts a scroll with it). */
const countCancels = async (page: Page) => {
  await page.evaluate(() => {
    const w = window as unknown as { __cancels?: number };
    if (w.__cancels !== undefined) return;
    w.__cancels = 0;
    document.addEventListener('pointercancel', () => w.__cancels!++, true);
  });
  const before = await page.evaluate(() => (window as unknown as { __cancels: number }).__cancels);
  return async () => (await page.evaluate(() => (window as unknown as { __cancels: number }).__cancels)) - before;
};

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
    // Centred on the drawn track.
    const centre = b.track.top + b.track.height / 2;
    expect(Math.abs(hit.top + hit.height / 2 - centre), `${why}: the hit area is level with the track`).toBeLessThan(1);
    expect(Math.abs(b.knob.top + b.knob.height / 2 - centre), `${why}: the knob is level with the track`).toBeLessThan(1);
    expect(await slider(page, gear).evaluate((el) => getComputedStyle(el).pointerEvents), `${why}: the input takes no pointer`).toBe('none');
    expect(await page.locator(`[data-strip][data-gear="${gear}"] [data-fader]`).evaluate((el) => getComputedStyle(el).touchAction), `${why}: a swipe up or down is the browser's`).toBe('pan-y');

    // What is on top 20 px above and below the track's centre and at both ends of the track, and at the hit area's own corners: the gear's own
    // hit area, except where its ✕ is (that sits over it, and keeps its tap).
    const xs = [b.track.left, b.track.left + 1, b.track.left + b.track.width / 2, b.track.right - 1, b.track.right, hit.left + 1, hit.right - 1];
    const ys = [centre - 20, centre - 10, centre, centre + 10, centre + 20, hit.top + 1, hit.bottom - 1];
    for (const x of xs) {
      for (const y of ys) {
        const p = { x, y };
        const expected = inside(b.reset, p) ? `reset:${gear}` : `fader:${gear}`;
        expect(await under(page, p), `${why}: on top at x ${Math.round(x)}, ${Math.round(y - centre)} px from the track's centre`).toBe(expected);
      }
    }
    // Past the box it is no fader's: not this gear's, and not a neighbour's, whose strip is 6 px away.
    for (const y of [hit.top - 2, hit.bottom + 2]) expect(await under(page, { x: b.track.left + b.track.width / 2, y }), `${why}: 2 px past the hit area`).not.toMatch(/^fader:/);
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

/** The three drags and a tap, for a gear that is on: the thumb is set to 25 (or 75, for a drag to the left), and each moves it to the finger. */
async function checkTouchDrags(page: Page, finger: Finger, gears: GearId[], at: string, shots?: string) {
  for (const gear of gears) {
    const cases = (t: Awaited<ReturnType<typeof thumb>>) => [
      { name: 'starts 16 px above the thumb', start: 25, from: { x: t.x, y: t.y - 16 }, to: { x: t.x + 70, y: t.y - 10 }, file: 'above' },
      { name: 'starts on the track 60 px right of the thumb', start: 25, from: { x: t.x + 60, y: t.y }, to: { x: Math.min(t.x + 95, t.track.right - 3), y: t.y + 4 }, file: 'away' },
      { name: 'starts on the thumb', start: 25, from: { x: t.x, y: t.y }, to: { x: t.x + 55, y: t.y + 3 }, file: 'thumb' },
    ];
    await setThumb(page, gear, 25);
    const t25 = await thumb(page, gear);
    const list = cases(t25);
    // And one to the left, from a thumb at 75.
    await setThumb(page, gear, 75);
    const t75 = await thumb(page, gear);
    list.push({ name: 'starts on the track 60 px left of the thumb', start: 75, from: { x: t75.x - 60, y: t75.y }, to: { x: Math.max(t75.x - 100, t75.track.left + 3), y: t75.y - 4 }, file: 'left' });

    for (const c of list) {
      const why = `${at}, ${gear}, a drag that ${c.name}`;
      await setThumb(page, gear, c.start);
      const t = await thumb(page, gear);
      expect(await under(page, c.from), `${why}: the finger lands on the gear's hit area`).toBe(`fader:${gear}`);
      const wasOff = await isOff(page, gear);
      await finger.drag(line(c.from, c.to), {
        down: async () => {
          // The thumb does not jump at the first touch (it may be about to scroll), and an off gear stays off.
          await page.waitForTimeout(50);
          expect(await value(page, gear), `${why}: the thumb jumped at the first touch`).toBe(c.start);
          expect(await isOff(page, gear), `${why}: the gear changed at the first touch`).toBe(wasOff);
          if (shots && gear === 'difficulty' && c.file === 'away') await shot(page, `${shots}-first-touch`, c.from, c.from);
        },
        end: async () => expectValue(page, gear, valueAt(t.track, c.to.x), `${why} (while the finger is down)`),
      });
      await expectValue(page, gear, valueAt(t.track, c.to.x), `${why} (after it lifts)`);
      expect(await isOff(page, gear), `${why}: the gear is on`).toBe(false);
      if (shots && gear === 'difficulty') await shot(page, `${shots}-${c.file}`, c.from, c.to);
    }

    // A tap on the track 60 px from the thumb jumps the thumb there.
    await setThumb(page, gear, 25);
    const t = await thumb(page, gear);
    const target = { x: t.x + 60, y: t.y };
    await finger.tap(target);
    await expectValue(page, gear, valueAt(t.track, target.x), `${at}, ${gear}, a tap 60 px from the thumb`);
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

// ============================================================================================================
// Chromium, with real touch
// ============================================================================================================

for (const width of WIDTHS) {
  for (const mode of MODES) {
    test.describe(`${width} px, ${mode}`, () => {
      test.use({ viewport: { width, height: 844 } });
      test.beforeEach(({ browserName }) => test.skip(browserName !== 'chromium', 'touch is driven through Chromium DevTools'));
      const at = `${width} px, ${mode}`;

      test('the hit area is at least 44 px tall and spans the track and 7 px more at each end, centred on it, and the gear is what is on top at points above, below and at its ends', async ({ page }) => {
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
          await checkTouchDrags(page, cdpFinger(page), [gear], at, width === 390 && mode === 'expanded' ? `fader-${width}-${mode}` : undefined);
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
