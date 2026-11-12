// Shared by the fader's Playwright specs (tests/e2e/setlist-fader.spec.ts, setlist-fader-ends.spec.ts; QWW-57, R33): measuring a gear's strip, a finger
// (real touch through Chromium's DevTools, or a desktop WebKit's own taps and the pointer events a touch raises), and the small readers. Moved out of
// setlist-fader.spec.ts so the second spec, the one that puts the thumb at the track's ends, shares one set.

import { expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { GearId } from '../../src/lib/setlist/types';
import { open, slider, strip, tab, tuner, value } from './tunerE2e';

export const SCREENS = path.resolve('test-results/screens');
export const makeScreensDir = () => mkdirSync(SCREENS, { recursive: true });

export const GEARS: GearId[] = ['difficulty', 'popularity', 'tempo', 'history'];
export const MODES = ['expanded', 'mini'] as const;
export type Mode = (typeof MODES)[number];

export interface Point {
  x: number;
  y: number;
}
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

// ---- measuring ----

/** The boxes of a strip's hit area, drawn track, knob and ✕ (null when it has none or it is not shown), in page px. */
export const boxes = (page: Page, gear: GearId) =>
  strip(page, gear).evaluate((el) => {
    const box = (e: Element | null): Box | null => {
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return b.width === 0 && b.height === 0 ? null : { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
    };
    const knob = el.querySelector('[data-knob]')!;
    // The title's text (the label's own box is as wide as the room it has), and the strip itself.
    const label = el.querySelector('label');
    let title: Box | null = null;
    if (label) {
      const range = document.createRange();
      range.selectNodeContents(label);
      const b = range.getBoundingClientRect();
      title = { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
    }
    return {
      hit: box(el.querySelector('[data-fader]')),
      track: box(knob.parentElement)!,
      knob: box(knob)!,
      reset: box(el.querySelector('button[data-reset]')),
      icon: box(el.querySelector('button[data-reset] svg')),
      title,
      strip: box(el)!,
    };
  });

/** Where the drawn knob's centre is, and the track it travels. */
export async function thumb(page: Page, gear: GearId) {
  const b = await boxes(page, gear);
  return { x: b.knob.left + b.knob.width / 2, y: b.knob.top + b.knob.height / 2, track: b.track, knob: b.knob };
}

/** The value a pointer at `x` should give: the track's length is 0 to 100. */
export const valueAt = (track: Box, x: number) => Math.max(0, Math.min(100, Math.round(((x - track.left) / track.width) * 100)));

/** What is on top at a point: the gear whose hit area it is, or the ✕ of a gear, or the tag of anything else. */
export const under = (page: Page, p: Point) =>
  page.evaluate(({ x, y }) => {
    const e = document.elementFromPoint(x, y);
    const gear = e?.closest('[data-strip]')?.getAttribute('data-gear') ?? null;
    if (e?.closest('[data-fader]')) return `fader:${gear}`;
    if (e?.closest('button[data-reset]')) return `reset:${gear}`;
    return e ? `${e.tagName.toLowerCase()}${gear ? `:${gear}` : ''}` : 'nothing';
  }, p);

type Hook = { setState(patch: object): void; getState(): { off: string[] } };

/** The tuner's state with the gear's value set and nothing else changed, so the thumb is where a test wants it. */
export async function setThumb(page: Page, gear: GearId, v: number) {
  await page.evaluate(([g, n]) => (window as unknown as { setlist: Hook }).setlist.setState({ [g as string]: n }), [gear, v] as const);
  await expect.poll(() => value(page, gear)).toBe(v);
}

/** The same, with the gear turned on too (a gear that is off has no ✕, and its thumb is dark), so a test can press it as a singer who has tuned it would. */
export async function setThumbOn(page: Page, gear: GearId, v: number) {
  await page.evaluate(
    ([g, n]) => {
      const hook = (window as unknown as { setlist: Hook }).setlist;
      hook.setState({ [g as string]: n, off: hook.getState().off.filter((x) => x !== g) });
    },
    [gear, v] as const,
  );
  await expect.poll(() => value(page, gear)).toBe(v);
  await expect.poll(async () => (await tuner(page)).off.includes(gear)).toBe(false);
}

/** The value is within a step of what the finger's position says, as the tuner reads it. */
export async function expectValue(page: Page, gear: GearId, expected: number, why: string) {
  await expect.poll(async () => Math.abs((await value(page, gear)) - expected), { message: `${why}: the value should be about ${expected}` }).toBeLessThanOrEqual(1);
}

export const isOff = async (page: Page, gear: GearId) => (await tuner(page)).off.includes(gear);

// ---- the way in, and a finger ----

/** The tuner at a width and in a mode, signed in so that History's slider works too, with a gear's strip on show. */
export async function openAt(page: Page, mode: Mode, gear: GearId = 'difficulty', loggedIn = true) {
  const opened = await open(page, { mini: mode === 'mini', loggedIn });
  if (loggedIn) await expect(slider(page, 'history')).toBeEnabled();
  await expect(page.locator('#app')).toHaveAttribute('data-mode', mode);
  if (mode === 'mini') await tab(page, gear).click();
  await expect(strip(page, gear)).toBeVisible();
  return opened;
}

export interface Finger {
  /**
   * Down at the first point, along the rest, up. `down` runs after the touch has landed, `end` before it lifts. `radius` is the touch's radius in px (Chromium's
   * DevTools take one; a finger's is 8 to 16), which decides how far Chromium looks for a button or label to hand the touch to; 1 where it is not given.
   */
  drag(path: Point[], hooks?: { down?(): Promise<void>; end?(): Promise<void> }, radius?: number): Promise<void>;
  /** A tap at a point. `radius` is the touch's radius in px (Chromium's DevTools take one; a finger's is 8 to 12), which decides how far Chromium looks for a button to give the tap to. */
  tap(p: Point, radius?: number): Promise<void>;
}

/** Real touch through Chromium's DevTools, which raises the same touch and pointer events a finger does. */
export const cdpFinger = (page: Page): Finger => ({
  async drag(points, hooks, radius = 1) {
    const cdp = await page.context().newCDPSession(page);
    try {
      const touch = (p: Point) => ({ x: p.x, y: p.y, radiusX: radius, radiusY: radius });
      const [first, ...rest] = points;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(first!)] });
      await hooks?.down?.();
      for (const p of rest) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(p)] });
      await hooks?.end?.();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await cdp.detach();
    }
  },
  async tap(p, radius = 1) {
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: radius, radiusY: radius }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await cdp.detach();
    }
    // The click a tap ends in comes a moment after the touch lifts.
    await page.waitForTimeout(120);
  },
});

/**
 * WebKit: a real tap, and for a drag the PointerEvents a touch raises, dispatched from the page at whatever is on top where the finger lands
 * (the target of its moves is that element, as a touch's is). This checks our handler under WebKit, not iOS's touch handling.
 */
export const syntheticFinger = (page: Page): Finger => {
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
    async tap(p) {
      await page.touchscreen.tap(p.x, p.y);
      await page.waitForTimeout(120);
    },
  };
};

/** A straight line of fingers from `a` to `b`, `a` first. */
export const line = (a: Point, b: Point, steps = 10): Point[] => Array.from({ length: steps + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps }));

/** Dots where a finger starts (red) and ends (green), over the sheet, for a screenshot of it. */
export async function shot(page: Page, name: string, from: Point, to: Point) {
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
export const countCancels = async (page: Page) => {
  await page.evaluate(() => {
    const w = window as unknown as { __cancels?: number };
    if (w.__cancels !== undefined) return;
    w.__cancels = 0;
    document.addEventListener('pointercancel', () => w.__cancels!++, true);
  });
  const before = await page.evaluate(() => (window as unknown as { __cancels: number }).__cancels);
  return async () => (await page.evaluate(() => (window as unknown as { __cancels: number }).__cancels)) - before;
};

/**
 * The drags and a tap, for a gear that is on, with the thumb at each of `values`: a drag that starts 16 px above the thumb's centre, one that starts on the
 * thumb and one that starts on the track 60 px from it, each toward the middle of the track (to the right from a thumb in the left half, to the left from one
 * in the right half, so a thumb at the end of the track is dragged off it), and a tap 60 px from the thumb. Each takes the value to the finger, and none
 * moves it at the first touch. `on` turns the gear on first (a gear that is off has no ✕ and a dark thumb; the default is to leave it as it is).
 */
export async function checkTouchDrags(
  page: Page,
  finger: Finger,
  gears: GearId[],
  at: string,
  opts: { shots?: string; values?: readonly number[]; on?: boolean; radii?: readonly number[] } = {},
) {
  const { shots, values = [25, 75], on = false, radii = [1] } = opts;
  const set = on ? setThumbOn : setThumb;
  for (const gear of gears) {
    for (const v of values) {
      const s = v >= 50 ? -1 : 1;
      const side = s > 0 ? 'right' : 'left';
      await set(page, gear, v);
      const t0 = await thumb(page, gear);
      const clamp = (x: number) => Math.min(Math.max(x, t0.track.left + 3), t0.track.right - 3);
      const list = [
        { name: 'starts 16 px above the thumb', from: { x: t0.x, y: t0.y - 16 }, to: { x: clamp(t0.x + s * 70), y: t0.y - 10 }, file: 'above' },
        { name: `starts on the track 60 px ${side} of the thumb`, from: { x: t0.x + s * 60, y: t0.y }, to: { x: clamp(t0.x + s * 95), y: t0.y + 4 }, file: 'away' },
        { name: 'starts on the thumb', from: { x: t0.x, y: t0.y }, to: { x: clamp(t0.x + s * 55), y: t0.y + 3 }, file: 'thumb' },
      ];
      for (const c of list.flatMap((c) => radii.map((radius) => ({ ...c, radius })))) {
        const why = `${at}, ${gear}, thumb at ${v}, a drag that ${c.name}${radii.length > 1 ? `, touch radius ${c.radius}` : ''}`;
        await set(page, gear, v);
        const t = await thumb(page, gear);
        expect(await under(page, c.from), `${why}: the finger lands on the gear's hit area`).toBe(`fader:${gear}`);
        const wasOff = await isOff(page, gear);
        await finger.drag(line(c.from, c.to), {
          down: async () => {
            // The thumb does not jump at the first touch (it may be about to scroll), and an off gear stays off.
            await page.waitForTimeout(50);
            expect(await value(page, gear), `${why}: the thumb jumped at the first touch`).toBe(v);
            expect(await isOff(page, gear), `${why}: the gear changed at the first touch`).toBe(wasOff);
            if (shots && gear === 'difficulty' && v === values[0] && c.file === 'away') await shot(page, `${shots}-first-touch`, c.from, c.from);
          },
          end: async () => expectValue(page, gear, valueAt(t.track, c.to.x), `${why} (while the finger is down)`),
        }, c.radius);
        await expectValue(page, gear, valueAt(t.track, c.to.x), `${why} (after it lifts)`);
        expect(await isOff(page, gear), `${why}: the gear is on`).toBe(false);
        if (shots && gear === 'difficulty' && v === values[0] && c.radius === radii[0]) await shot(page, `${shots}-${c.file}`, c.from, c.to);
      }

      // A tap on the track 60 px from the thumb jumps the thumb there.
      await set(page, gear, v);
      const t = await thumb(page, gear);
      const target = { x: clamp(t.x + s * 60), y: t.y };
      await finger.tap(target);
      await expectValue(page, gear, valueAt(t.track, target.x), `${at}, ${gear}, thumb at ${v}, a tap 60 px from the thumb`);
    }
  }
}
