// Finding 1 of the adversarial review of PR #38 (QWW-57): "phones on their side show no songs". A phone on its side is wider than
// 430 px, so it got the 390 px TV at the window's height less 32 px (328 px at 640x360): no list, and the sheet cut off. Decided: on a
// touch screen in landscape under 500 px tall, a full-screen "Turn your phone upright" covers every step, and everything under it
// stays as it is. This is what a browser does with that, which jsdom cannot show: where it shows and where it does not, that it
// covers the viewport and fits, that nothing under it can be tapped, and that turning the phone back finds the page as it was.
// The words, the icon and the stylesheet text are tests/screen/rotateNotice.test.tsx.
//
// "Touch" is the media features of a primary input that is a finger, `(hover: none) and (pointer: coarse)`. Playwright's
// `hasTouch: true` reports both (`isMobile` alone reports neither), so a context with it is a phone and one without it a desktop.

import { devices, expect, test, type Browser, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { launchWithMic, writeTone } from './fakeMic';
import { mockApi, open, openButton, rgb, rows, titles, tuner } from '../helpers/tunerE2e';

const SCREENS = path.resolve('test-results/screens');
test.beforeAll(() => mkdirSync(SCREENS, { recursive: true }));

// The default is a touch phone upright, like the tuner specs; the describes below say otherwise.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

const WORDS = 'Turn your phone upright';
interface Size {
  width: number;
  height: number;
}
const UPRIGHT: Size = { width: 390, height: 844 };
const PORTRAIT: Size = { width: 360, height: 640 };
const LANDSCAPE: Size = { width: 640, height: 360 };
/** Phones on their side: the sizes the finding measured, and 844x390 of the sheet's own test. Each is wider than 430 px and under 500 tall. */
const SIDEWAYS: Size[] = [LANDSCAPE, { width: 667, height: 375 }, { width: 664, height: 390 }, { width: 780, height: 412 }, { width: 844, height: 390 }];

const notice = (page: Page) => page.getByRole('dialog', { name: WORDS });

/**
 * The message as the browser draws it. It is in the page whether or not it shows (it is `display: none` then), so this throws when
 * it is not in the page at all, and a test that expects it hidden cannot pass because it is missing.
 */
const read = (page: Page) =>
  page.evaluate((words) => {
    const p = [...document.querySelectorAll('p')].find((e) => e.textContent === words);
    if (!p) throw new Error('the message is not in the page');
    const el = p.closest<HTMLElement>('[role="dialog"]')!;
    const icon = el.querySelector('svg')!;
    const box = (e: Element) => {
      const b = e.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    const style = getComputedStyle(el);
    const root = document.documentElement;
    // Everything the singer could tap under it: is what is on top at its centre the message? (Whole pixels: at a half pixel on the
    // last row of the viewport, elementFromPoint answers null.)
    const exposed = [...document.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex]')].flatMap((e) => {
      const b = e.getBoundingClientRect();
      const x = Math.floor(b.x + b.width / 2);
      const y = Math.floor(b.y + b.height / 2);
      if (el.contains(e) || b.width === 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return [];
      return el.contains(document.elementFromPoint(x, y)) ? [] : [e.getAttribute('aria-label') || e.textContent?.trim() || e.id || e.tagName];
    });
    // And the corners and the middle, in case nothing interactive is there.
    const bare = [[0, 0], [innerWidth - 1, 0], [0, innerHeight - 1], [innerWidth - 1, innerHeight - 1], [innerWidth / 2, innerHeight / 2]].filter(
      ([x, y]) => !el.contains(document.elementFromPoint(x!, y!)),
    );
    return {
      display: style.display,
      position: style.position,
      touchAction: style.touchAction,
      animation: style.animationName,
      transition: style.transitionDuration,
      background: style.backgroundColor,
      color: getComputedStyle(p).color,
      box: box(el),
      words: box(p),
      icon: box(icon),
      iconHidden: icon.getAttribute('aria-hidden'),
      clipped: [el, p].some((e) => e.scrollWidth > e.clientWidth || e.scrollHeight > e.clientHeight),
      viewport: { width: innerWidth, height: innerHeight },
      scroll: { rootW: root.scrollWidth, rootH: root.scrollHeight, bodyW: document.body.scrollWidth, bodyH: document.body.scrollHeight },
      exposed,
      bare,
    };
  }, WORDS);

/** The message is up: it is the whole viewport, nothing in it is cut, the page behind it does not scroll, and nothing behind it can be tapped. */
async function expectCovered(page: Page, size: Size, what: string) {
  await expect(notice(page), `${what}: the message shows`).toBeVisible();
  const m = await read(page);
  expect(m.viewport, `${what}: the page sees the size that was set`).toEqual(size);
  expect(m.position, `${what}: fixed to the viewport`).toBe('fixed');
  expect(m.box, `${what}: its box is the viewport`).toEqual({ x: 0, y: 0, ...size });
  expect(m.exposed, `${what}: every button and field under it has the message over its centre`).toEqual([]);
  expect(m.bare, `${what}: and so do the corners and the middle`).toEqual([]);
  // Nothing is cut: no scroll size over its client size, and the icon and the words are inside the page's own padding (16 and 24 px).
  expect(m.clipped, `${what}: nothing in it is clipped`).toBe(false);
  for (const part of [m.icon, m.words]) {
    expect(part.y, `${what}: top`).toBeGreaterThanOrEqual(16);
    expect(part.y + part.height, `${what}: bottom`).toBeLessThanOrEqual(size.height - 16);
    expect(part.x, `${what}: left`).toBeGreaterThanOrEqual(24);
    expect(part.x + part.width, `${what}: right`).toBeLessThanOrEqual(size.width - 24);
  }
  expect(m.scroll.rootW, `${what}: the page has no sideways scrollbar`).toBeLessThanOrEqual(size.width);
  expect(m.scroll.rootH, `${what}: the page has no scrollbar`).toBeLessThanOrEqual(size.height);
  expect(m.scroll.bodyW).toBeLessThanOrEqual(size.width);
  expect(m.scroll.bodyH).toBeLessThanOrEqual(size.height);
  // How it looks: the page's own dark and the app's text, a hidden icon, and still (reduced motion or not).
  expect(m.iconHidden, `${what}: the icon is hidden from a screen reader`).toBe('true');
  expect(m.background).toBe(rgb('#07060a'));
  expect(m.color).toBe(rgb('#f4f1f6'));
  expect(m.animation).toBe('none');
  expect(m.transition).toBe('0s');
  // A drag on it must not pull the page to refresh, which would lose what is under it.
  expect(m.touchAction).toBe('none');
}

/** No message: it is in the page but not drawn, so it is not in the accessibility tree, and the TV is what is on top at the TV's centre. */
async function expectNone(page: Page, what: string) {
  await expect(page.getByRole('dialog'), `${what}: no dialog in the accessibility tree`).toHaveCount(0);
  await expect(page.getByText(WORDS), `${what}: the words are not shown`).toBeHidden();
  const m = await read(page);
  expect(m.display, `${what}: display`).toBe('none');
  expect(m.box).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  const tvOnTop = await page.evaluate(() => {
    const tv = document.querySelector('section[aria-label="Karaoke screen"]')!;
    const b = tv.getBoundingClientRect();
    return tv.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2));
  });
  expect(tvOnTop, `${what}: the TV is not covered`).toBe(true);
}

type Step = 'the tuner' | 'the title' | 'the song page';

/** Gets the page to a step, upright. The title is what a singer with no range saved sees first. */
async function reach(page: Page, step: Step) {
  if (step === 'the title') {
    await mockApi(page.context(), { loggedIn: false, events: [] });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
    return;
  }
  await open(page);
  if (step === 'the song page') {
    await openButton(rows(page).first()).click();
    await expect(page.getByRole('button', { name: 'Back to songs' })).toBeVisible();
  }
}

const setState = (page: Page, patch: Record<string, unknown>) =>
  page.evaluate((p) => (window as unknown as { setlist: { setState(p: object): void } }).setlist.setState(p), patch);

// ============================================================================================================
// On its side: the message, on every step, at every size
// ============================================================================================================

for (const step of ['the tuner', 'the title', 'the song page'] as const) {
  test(`${step} is covered by the message when the phone is turned to its side, at every size from 640x360 to 844x390, and is as it was when it is turned back`, async ({ page }) => {
    await reach(page, step);
    await expectNone(page, `${step} upright`);
    for (const size of SIDEWAYS) {
      const what = `${step} at ${size.width}x${size.height}`;
      await page.setViewportSize(size);
      await expectCovered(page, size, what);
      if (size === LANDSCAPE) await page.screenshot({ path: path.join(SCREENS, `landscape-${step.replace(/ /g, '-')}-640x360.png`) });
      await page.setViewportSize(UPRIGHT);
      await expectNone(page, `${what}, turned back`);
    }
  });
}

test.describe('opened on its side', () => {
  test.use({ viewport: LANDSCAPE });

  for (const step of ['the tuner', 'the title'] as const) {
    test(`${step} is covered from the first paint at 640x360, with nothing cut`, async ({ page }) => {
      await reach(page, step);
      await expectCovered(page, LANDSCAPE, `${step} opened at 640x360`);
    });
  }
});

test('a tap on what is under it does nothing: the tap lands on the message, and redo, which it covers, is not pressed', async ({ page }) => {
  await open(page);
  await page.setViewportSize(LANDSCAPE);
  await expect(notice(page)).toBeVisible();
  const redo = (await page.getByRole('button', { name: 'Redo the singing test' }).boundingBox())!;
  expect(redo.y + redo.height, 'redo is on the screen, so the tap below is a real one').toBeLessThan(LANDSCAPE.height);
  // Who gets each click: the message, or something under it.
  await page.evaluate(() => {
    const w = window as unknown as { clicks: string[] };
    w.clicks = [];
    document.addEventListener('click', (e) => w.clicks.push((e.target as Element).closest('[role="dialog"]') ? 'message' : (e.target as Element).closest('button')?.getAttribute('aria-label') ?? 'other'), true);
  });
  await page.touchscreen.tap(redo.x + redo.width / 2, redo.y + redo.height / 2);
  await expect.poll(() => page.evaluate(() => (window as unknown as { clicks: string[] }).clicks)).toEqual(['message']);
  await expect(page.locator('#app')).toBeVisible();
  await page.setViewportSize(UPRIGHT);
  await expect(notice(page)).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Tune your setlist' })).toBeVisible();
});

test('it is over the Spotify account box when that is open, and over the sheet', async ({ page }) => {
  await open(page, { loggedIn: true });
  await page.getByRole('button', { name: 'Spotify account' }).tap();
  await expect(page.getByText('Logged in as Quinn')).toBeVisible();
  await page.setViewportSize(LANDSCAPE);
  await expectCovered(page, LANDSCAPE, 'with the account box open');
  // The account box's own text and button, and the sheet's handle, are where something would be tapped; the message is on top of each.
  const onTop = await page.evaluate(() => {
    const msg = document.querySelector('[role="dialog"]')!;
    const centre = (e: Element) => {
      const b = e.getBoundingClientRect();
      return { x: Math.floor(b.x + b.width / 2), y: Math.floor(b.y + b.height / 2) };
    };
    const names: Record<string, Element | null> = {
      'the account box': [...document.querySelectorAll('span')].find((s) => s.textContent === 'Logged in as Quinn') ?? null,
      'log out': [...document.querySelectorAll('button')].find((b) => b.textContent === 'Log out') ?? null,
      'the sheet handle': document.getElementById('handle'),
    };
    return Object.fromEntries(
      Object.entries(names).map(([name, e]) => {
        if (!e) return [name, 'missing'];
        const { x, y } = centre(e);
        return [name, x >= 0 && y >= 0 && x < innerWidth && y < innerHeight ? msg.contains(document.elementFromPoint(x, y)) : 'off screen'];
      }),
    );
  });
  expect(onTop).toEqual({ 'the account box': true, 'log out': true, 'the sheet handle': true });
});

// The line is where the finding put it: 500 px tall (inclusive), so a phone on its side is under it and a small tablet is not.
test('the line is at 500 px tall: 700x500 on its side shows it, 700x501 does not', async ({ page }) => {
  await open(page);
  await page.setViewportSize({ width: 700, height: 500 });
  await expectCovered(page, { width: 700, height: 500 }, '700x500');
  await page.setViewportSize({ width: 700, height: 501 });
  await expectNone(page, '700x501');
});

// ============================================================================================================
// Turned back: the page is as it was left
// ============================================================================================================

/** What a singer has set and sees on the tuner. */
const snapshot = async (page: Page) => ({
  state: await tuner(page),
  titles: await titles(page),
  scroll: await page.locator('#list-scroll').evaluate((el) => el.scrollTop),
  mode: await page.locator('#app').getAttribute('data-mode'),
  open: await page.locator('#app').getAttribute('data-open'),
});

test('turning the phone to its side and back leaves the tuner as it was: its gears, its list and where it is scrolled to, and the sheet', async ({ page }) => {
  await page.setViewportSize(PORTRAIT);
  await open(page);
  const first = await titles(page);
  await setState(page, { difficulty: 40, open: 'popularity' });
  await expect.poll(() => titles(page), 'the list is ranked again for the new gear').not.toEqual(first);
  await page.locator('#list-scroll').evaluate((el) => {
    el.scrollTop = 150;
  });
  const before = await snapshot(page);
  expect(before.state.difficulty).toBe(40);
  expect(before.scroll, 'the list is scrolled').toBeGreaterThan(0);
  expect(before.titles.length).toBeGreaterThan(5);

  await page.setViewportSize(LANDSCAPE);
  await expectCovered(page, LANDSCAPE, 'on its side');
  await page.setViewportSize(PORTRAIT);
  await expect(notice(page)).toBeHidden();
  await expect.poll(() => snapshot(page)).toEqual(before);
});

test('the song page is still the song page after the phone is turned and back, and Back finds the tuner as it was left', async ({ page }) => {
  await page.setViewportSize(PORTRAIT);
  await open(page);
  const first = await titles(page);
  await setState(page, { difficulty: 40 });
  await expect.poll(() => titles(page)).not.toEqual(first);
  const before = await snapshot(page);
  const song = before.titles[0]!;
  await openButton(rows(page).first()).click();
  const heading = page.getByRole('heading', { name: song, exact: true });
  await expect(heading).toBeVisible();
  await expect(page.locator('#app')).toHaveCount(0);

  await page.setViewportSize(LANDSCAPE);
  await expectCovered(page, LANDSCAPE, 'the song page on its side');
  await page.setViewportSize(PORTRAIT);
  await expect(notice(page)).toBeHidden();
  await expect(heading).toBeVisible();
  await expect(page.locator('#app')).toHaveCount(0);

  await page.getByRole('button', { name: 'Back to songs' }).click();
  await expect(page.locator('#app')).toBeVisible();
  await expect.poll(() => tuner(page)).toEqual(before.state);
  await expect.poll(() => titles(page)).toEqual(before.titles);
});

let micBrowser: Browser | null = null;
test.afterAll(async () => {
  await micBrowser?.close();
});

test('a microphone that is running is still running after the phone is turned to its side and back: the note it is held for is heard', async ({ baseURL }) => {
  test.setTimeout(90_000);
  micBrowser ??= await launchWithMic(writeTone(`landscape-220-${test.info().workerIndex}.wav`, 220)); // a file per worker: a repeat run has several
  const context = await micBrowser.newContext({ ...devices['iPhone 13'], viewport: PORTRAIT, baseURL, reducedMotion: 'reduce' });
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/me') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"signed out"}' });
    if (url.pathname === '/api/events') return route.fulfill({ status: 204 });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not mocked"}' });
  });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByRole('button', { name: /Find a quiet spot/ }).click();
  await page.getByRole('button', { name: 'Turn on microphone', exact: true }).click();
  const record = page.getByRole('button', { name: 'Hold to record your lowest note' });
  await expect(record).toBeVisible();
  await page.waitForTimeout(1300); // the step's lyric sings in

  await page.setViewportSize(LANDSCAPE);
  await expectCovered(page, LANDSCAPE, 'the low note step on its side');
  await page.setViewportSize(PORTRAIT);
  await expect(notice(page)).toBeHidden();
  await expect(record).toBeVisible();

  // Held like a finger would: the microphone opened before the turn still hears the tone, and the step goes on to the high note.
  const box = (await record.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId('live-pitch')).toHaveText('A3', { timeout: 3000 });
  await page.waitForTimeout(800);
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Hold to record your highest note' })).toBeVisible({ timeout: 5000 });
  await context.close();
});

// ============================================================================================================
// Not on its side, or not a phone: no message
// ============================================================================================================

const QUIET: { what: string; size: Size; touch: boolean }[] = [
  { what: 'a touch phone upright, 390x844', size: UPRIGHT, touch: true },
  { what: 'a touch phone upright, 360x640', size: PORTRAIT, touch: true },
  // Under 500 px tall, but upright: the message is for a phone on its side, not for a short window.
  { what: 'a small touch phone upright, 320x480', size: { width: 320, height: 480 }, touch: true },
  { what: 'a touch tablet on its side, 1024x768', size: { width: 1024, height: 768 }, touch: true },
  { what: 'a desktop, 640x360', size: LANDSCAPE, touch: false },
  { what: 'a desktop, 1280x800', size: { width: 1280, height: 800 }, touch: false },
  { what: 'a desktop, 844x390', size: { width: 844, height: 390 }, touch: false },
];

for (const { what, size, touch } of QUIET) {
  test.describe(`${what}: no message`, () => {
    test.use({ viewport: size, hasTouch: touch, isMobile: touch });

    test('on the title and on the tuner', async ({ page }) => {
      await reach(page, 'the title');
      await expectNone(page, `${what}, the title`);
      await reach(page, 'the tuner');
      await expectNone(page, `${what}, the tuner`);
    });
  });
}
