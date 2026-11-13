// Sources and credits inside the TV (QWW-57, the review of the 6A preview, R28; R29 for Deezer's credit), and the credits page that stays for direct visits.
//   R28  The link is in the frame's bottom left, on every step. A tap opens a panel inside the TV's screen, on the same page: the address does
//        not change, no tab opens, and nothing under the panel is unmounted. ✕ and Escape close it. While it is open the step under it is inert
//        (nothing in it takes a tap, a key, the focus or a screen reader), the focus is in the panel, and on close it goes back to the link; the
//        step is as it was (its gears, its list and its scroll, a running microphone). The panel scrolls inside the frame when the text is taller.
//   R29  Deezer's credit stays where it is: the line under the list (tests/e2e/preview.spec.ts, setlist-rows.spec.ts). Sources and credits names Deezer
//        in words too, with no logo of its own.
//   /credits  A plain page, for a direct visit: the same content, and its "‹ Back" closes a tab of its own and goes back anywhere else.
// The tuner is reached as the other tuner specs reach it (tests/helpers/tunerE2e.ts). tests/screen/credits.test.tsx has the DOM, the keys and the
// timers in jsdom; here it is the real browser, on the production build: layout, touch targets, `inert`, focus, scrolling, a real swipe.

import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { CREDITS } from '../../src/lib/credits';
import type { MockSong } from '../fixtures/setlist';
import { launchWithMic, writeTone } from './fakeMic';
import { centre, css, mockApi, open, openButton, rows, slider, titles, touchDrag, tuner } from '../helpers/tunerE2e';

const SCREENS = path.resolve('test-results/screens');
test.beforeAll(() => mkdirSync(SCREENS, { recursive: true }));

// A 390x844 touch phone, like the other tuner specs. Motion is off: the list would never be "stable" for Playwright otherwise.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

/** A song that leads the list under the defaults and has a Deezer preview: the row that used to bring the "Previews from Deezer" line. */
const WITH_PREVIEW: MockSong = { title: 'Can Play', artist: 'Has Preview', era: 's90', difficulty: 3, history: 50, popularity: 100, tempo: 50, deezerId: 4242 };

const tv = (page: Page) => page.locator('section[aria-label="Karaoke screen"]');
const link = (page: Page) => page.getByRole('button', { name: 'Sources and credits', exact: true });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Sources and credits' });
const closeButton = (page: Page) => page.getByRole('button', { name: 'Close sources and credits' });
const back = (page: Page) => page.getByRole('link', { name: '‹ Back' });
const setState = (page: Page, patch: Record<string, unknown>) =>
  page.evaluate((p) => (window as unknown as { setlist: { setState(p: object): void } }).setlist.setState(p), patch);
/** KaraokeApp's TAP_GUARD_MS, and Tv's CREDITS_GUARD_MS (tests/screen/credits.test.tsx holds the two together): a tap this soon after a close is the second of a double tap. */
const GUARD = 400;
const pastTheGuard = (page: Page) => page.waitForTimeout(GUARD + 150);

type Step = 'the title' | 'the tuner' | 'a song page' | 'the mic step' | 'a redo';

/** Gets the page to a step, upright. The title is what a singer with no range saved sees first; the mic step is the next but one. */
async function reach(page: Page, step: Step) {
  if (step === 'the title' || step === 'the mic step') {
    await mockApi(page.context(), { loggedIn: false, events: [] });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
    if (step === 'the mic step') {
      await page.getByRole('button', { name: 'Start' }).click();
      await page.getByRole('button', { name: /Find a quiet spot/ }).click();
      await expect(page.getByRole('button', { name: 'Turn on microphone', exact: true })).toBeVisible();
    }
    return;
  }
  await open(page, { extra: [WITH_PREVIEW] });
  if (step === 'a song page') {
    await openButton(rows(page).first()).click();
    await expect(page.getByRole('button', { name: 'Back to songs' })).toBeVisible();
  }
  // A redo's mic step has "Back to songs" in the screen's top left, stacked above the page (z-index 2): the panel must be over that too.
  if (step === 'a redo') {
    await page.getByRole('button', { name: /^Redo your low note/ }).tap();
    await expect(page.getByRole('button', { name: 'Back to songs' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Turn on microphone', exact: true })).toBeVisible();
  }
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  b: number;
  cx: number;
  cy: number;
}

/** The parts of the frame, in page pixels: the TV, its screen (the first part) and its chin (the last), and the chin's link, its book, its label and its LED. */
const frame = (page: Page) =>
  page.evaluate(() => {
    const tvEl = document.querySelector('section[aria-label="Karaoke screen"]')!;
    const chinEl = tvEl.lastElementChild!;
    const linkEl = chinEl.querySelector('button')!;
    const labelEl = [...chinEl.querySelectorAll('span')].find((s) => s.textContent === 'karaoke-dokie')!;
    const box = (e: Element): Box => {
      const b = e.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom, cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
    };
    return {
      tv: box(tvEl),
      screen: box(tvEl.firstElementChild!),
      chin: box(chinEl),
      link: box(linkEl),
      icon: box(linkEl.querySelector('svg')!),
      label: box(labelEl),
      led: box(chinEl.lastElementChild!),
      viewport: { w: innerWidth, h: innerHeight },
    };
  });

/**
 * Over the whole of the screen (inside its rounded corners): where what is on top is not the credits panel, from a grid of points 20 px apart,
 * and what is there instead. Empty when the panel covers it all, whatever the tuner stacks above its own parts (the sheet, the gears' ✕, the tips).
 */
const showsThrough = (page: Page, screen: Box) =>
  page.evaluate(({ x, y, w, h }) => {
    const found: string[] = [];
    for (let py = y + 22; py <= y + h - 22; py += 20) {
      for (let px = x + 22; px <= x + w - 22; px += 20) {
        const top = document.elementFromPoint(px, py);
        if (!top?.closest('section[aria-label="Karaoke screen"] [role="dialog"]')) {
          found.push(`${Math.round(px)},${Math.round(py)}: ${top?.getAttribute('aria-label') ?? top?.getAttribute('class') ?? top?.tagName}`);
        }
      }
    }
    return found.slice(0, 8);
  }, screen);

/** Where the keyboard focus is: in the TV or not, in the panel or not, and what has it (so a failure names it). */
const focusAt = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return {
      inTv: !!el?.closest('section[aria-label="Karaoke screen"]'),
      inPanel: !!el?.closest('section[aria-label="Karaoke screen"] [role="dialog"]'),
      what: el?.getAttribute('aria-label') || el?.id || el?.tagName || null,
    };
  });

/**
 * What Chromium's accessibility tree holds, as a screen reader gets it: the nodes that are not ignored, as a role and a name. Playwright's
 * getByRole still finds what is inert, so it cannot answer whether something is out of a screen reader's reach; the browser's own tree can.
 */
async function controls(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    return nodes
      .filter((n) => !n.ignored && ['button', 'slider', 'link', 'tab', 'textbox'].includes(String(n.role?.value ?? '')))
      .map((n) => `${String(n.role?.value)}: ${String(n.name?.value ?? '')}`);
  } finally {
    await cdp.detach();
  }
}

// ============================================================================================================
// R28. The link, on every step; the panel, over the whole screen, on the same page
// ============================================================================================================

for (const step of ['the title', 'the tuner', 'a song page', 'the mic step', 'a redo'] as const) {
  test(`R28. on ${step} the link is in the frame's bottom left, the chin is as it was, and a tap opens the panel over the whole of the screen and ✕ closes it`, async ({ page }) => {
    await reach(page, step);
    const f = await frame(page);
    await expect(panel(page)).toHaveCount(0);

    // Where it is: the book is in the chin's left end, the chin is as tall as it was (34 px, the LED still at its right end) and the TV has not moved.
    expect(f.chin.h, 'the chin').toBe(34);
    expect([f.icon.w, f.icon.h], 'the book').toEqual([18, 18]);
    expect(Math.abs(f.icon.cy - f.chin.cy), 'the book is in the middle of the chin').toBeLessThanOrEqual(1.5);
    expect(Math.abs(f.icon.x - (f.chin.x + 10)), 'the book starts where the chin\'s own padding does').toBeLessThanOrEqual(1);
    expect(f.icon.cx - f.tv.x, 'in the TV\'s left fifth').toBeLessThan(f.tv.w / 5);
    expect(f.tv.b - f.icon.cy, 'in the bottom 34 px').toBeLessThan(34);
    expect(Math.abs(f.label.cx - f.tv.cx), 'the label is in the middle of the TV').toBeLessThanOrEqual(1.5);
    expect(f.label.x - f.icon.r, 'and clear of the book').toBeGreaterThanOrEqual(8);
    expect(Math.abs(f.led.r - (f.chin.r - 10)), 'the LED is at the right end').toBeLessThanOrEqual(1);
    expect([f.led.w, f.led.h]).toEqual([6, 6]);
    // The touch target: 44 px each way, from the chin's top, reaching into the page's padding under the TV and never up into the screen.
    expect(f.link.w).toBeGreaterThanOrEqual(44);
    expect(f.link.w).toBeLessThanOrEqual(46);
    expect(f.link.h).toBeGreaterThanOrEqual(44);
    expect(Math.abs(f.link.y - f.chin.y), 'it starts at the chin\'s top').toBeLessThanOrEqual(1);
    expect(f.link.b, 'and ends in the page').toBeLessThanOrEqual(f.viewport.h);
    // All of the box is the link, and just above it (the screen's bottom edge) is not.
    const reaches = await page.evaluate(({ x, y, w, h }) => {
      const name = (px: number, py: number) => document.elementFromPoint(px, py)?.closest('button')?.getAttribute('aria-label') ?? null;
      return { corners: [name(x + 1, y + 1), name(x + w - 1, y + 1), name(x + 1, y + h - 1), name(x + w - 1, y + h - 1)], above: name(x + w / 2, y - 3) };
    }, f.link);
    expect(reaches.corners, 'the corners of the box').toEqual(Array(4).fill('Sources and credits'));
    expect(reaches.above, 'just above the box is the step\'s').not.toBe('Sources and credits');
    if (step === 'the title' || step === 'the tuner') await page.screenshot({ path: path.join(SCREENS, `credits-link-${step.replace(/ /g, '-')}.png`) });

    // A tap opens it: it is the screen's box, and it is what is on top over all of it (the tuner's sheet, its gears and its header included).
    await link(page).tap();
    await expect(panel(page)).toBeVisible();
    const p = (await panel(page).boundingBox())!;
    for (const [what, got, want] of [['x', p.x, f.screen.x], ['y', p.y, f.screen.y], ['width', p.width, f.screen.w], ['height', p.height, f.screen.h]] as const) {
      expect(Math.abs(got - want), `the panel is the TV's screen: ${what}`).toBeLessThanOrEqual(1);
    }
    expect(await showsThrough(page, f.screen), 'nothing of the step is on top of the panel anywhere on the screen').toEqual([]);
    // And it is stacked above every part of the step that is stacked (the tuner's tips and menus are 2, a redo's "Back to songs" 2), so one that is
    // out of sight now cannot come up over it later; the landscape message (1000) is above it.
    const z = await page.evaluate(() => {
      const inner = document.querySelector('section[aria-label="Karaoke screen"]')!.firstElementChild!;
      const own = inner.querySelector('[role="dialog"]')!;
      const step = [...inner.querySelectorAll('*')].filter((e) => e !== own && !own.contains(e)).map((e) => Number.parseInt(getComputedStyle(e).zIndex, 10));
      return { panel: Number.parseInt(getComputedStyle(own).zIndex, 10), step: Math.max(0, ...step.filter((n) => !Number.isNaN(n))) };
    });
    expect(z.panel, 'the panel is above everything the step stacks').toBeGreaterThan(z.step);
    expect(z.panel, 'and below the landscape message').toBeLessThan(1000);
    await expect(link(page)).toHaveAttribute('aria-expanded', 'true');
    expect((await frame(page)).tv, 'the TV has not moved or changed size').toEqual(f.tv);
    if (step === 'the title' || step === 'the tuner') await page.screenshot({ path: path.join(SCREENS, `credits-open-${step.replace(/ /g, '-')}.png`) });

    // ✕ is a labelled button, 44 px, in the panel's top right; a tap on it closes the panel, and the focus is on the link.
    const x = (await closeButton(page).boundingBox())!;
    expect([x.width, x.height], '✕ is 44 px').toEqual([44, 44]);
    expect(p.x + p.width - (x.x + x.width), '✕ is in the top right').toBeLessThanOrEqual(12);
    expect(x.y - p.y).toBeLessThanOrEqual(12);
    await closeButton(page).tap();
    await expect(panel(page)).toHaveCount(0);
    await expect(link(page)).toBeFocused();
    await expect(link(page)).toHaveAttribute('aria-expanded', 'false');
    expect((await frame(page)).tv, 'and the TV is as it was').toEqual(f.tv);
  });
}

test('R28. on the same page: the address does not change, no tab opens, and there is no history entry, whether the panel is opened, scrolled or closed', async ({ page, context }) => {
  await open(page, { extra: [WITH_PREVIEW] });
  const popups: Page[] = [];
  context.on('page', (popup) => popups.push(popup));
  const before = { url: page.url(), entries: await page.evaluate(() => history.length), state: await page.evaluate(() => history.state) };

  await link(page).tap();
  await expect(panel(page)).toBeVisible();
  await panel(page).evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await closeButton(page).tap();
  await expect(panel(page)).toHaveCount(0);
  await page.waitForTimeout(500);

  expect(page.url()).toBe(before.url);
  expect(await page.evaluate(() => history.length), 'no history entry').toBe(before.entries);
  expect(await page.evaluate(() => history.state), 'and none marked').toEqual(before.state);
  expect(popups, 'no tab').toHaveLength(0);
  expect(context.pages()).toHaveLength(1);
});

test('R28. the sources in the panel open outside the app, in a tab of their own: the tuned tab is not lost', async ({ page, context }) => {
  await context.route('https://www.deezer.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Deezer</title>' }));
  await open(page, { extra: [WITH_PREVIEW] });
  await link(page).tap();
  const deezer = panel(page).getByRole('link', { name: 'Deezer' });
  await deezer.scrollIntoViewIfNeeded();
  await expect(deezer).toHaveAttribute('href', 'https://www.deezer.com/');
  await expect(deezer).toHaveAttribute('target', '_blank');
  const opened = context.waitForEvent('page');
  await deezer.tap();
  const tab = await opened;
  await tab.waitForLoadState();
  expect(new URL(tab.url()).hostname).toBe('www.deezer.com');
  await tab.close();
  // This tab never moved, and the panel is still open in it.
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(panel(page)).toBeVisible();
});

// ============================================================================================================
// R28. Under the panel: inert while it is open, and as it was when it closes
// ============================================================================================================

/** What of the tuner a singer would notice if it were made again: its gears, the list and where it is scrolled to, the sheet, and a mark on the node that holds it. */
const snapshot = async (page: Page) => ({
  state: await tuner(page),
  titles: await titles(page),
  scroll: await page.locator('#list-scroll').evaluate((el) => el.scrollTop),
  mode: await page.locator('#app').getAttribute('data-mode'),
  open: await page.locator('#app').getAttribute('data-open'),
  kept: await page.evaluate(() => document.querySelectorAll('[data-kept]').length),
});

test('R28. the tuner under the panel is out of reach while it is open (no key, no Tab, no screen reader), and is as it was when it closes: its gears, its list, its scroll, the same nodes', async ({ page }) => {
  await open(page);
  const first = await titles(page);
  await setState(page, { difficulty: 80, popularity: 35 });
  await expect.poll(() => titles(page), 'the list is ranked again for the gears').not.toEqual(first);
  await page.locator('#list-scroll').evaluate((el) => {
    el.scrollTop = 150;
  });
  // A mark on the page's nodes: a tuner that was made again would lose it.
  await page.evaluate(() => {
    document.getElementById('app')!.setAttribute('data-kept', '');
    document.querySelector('[data-row]')!.setAttribute('data-kept', '');
  });
  const before = await snapshot(page);
  expect(before.state.difficulty).toBe(80);
  expect(before.scroll, 'the list is scrolled').toBeGreaterThan(0);
  expect(before.kept).toBe(2);
  const upright = await controls(page);
  expect(upright, 'the tuner has things to press and move').toContain('button: Redo the range test');
  expect(upright).toContain('button: Sources and credits');

  await link(page).tap();
  await expect(panel(page)).toBeVisible();
  // A screen reader's tree holds the panel's controls (✕, then the sources) and nothing of the tuner, not even the link that opened it.
  expect(await controls(page), 'what a screen reader can reach').toEqual(['button: Close sources and credits', ...CREDITS.map((c) => `link: ${c.name}`)]);
  // Tab never takes the focus under the panel, forwards or back; the first Tab from the panel is ✕.
  const walk: Awaited<ReturnType<typeof focusAt>>[] = [];
  for (const [key, times] of [['Tab', 26], ['Shift+Tab', 5]] as const) {
    for (let i = 0; i < times; i++) {
      await page.keyboard.press(key);
      walk.push(await focusAt(page));
    }
  }
  expect(walk[0], 'the first Tab is ✕').toMatchObject({ inPanel: true, what: 'Close sources and credits' });
  expect(walk.filter((w) => w.inTv && !w.inPanel).map((w) => w.what), 'no key takes the focus under the panel').toEqual([]);
  // A slider cannot be given the focus, so its arrow keys go to the panel: the gear does not move.
  await slider(page, 'tempo').focus({ timeout: 2000 }).catch(() => {});
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  expect(await tuner(page), 'the keys changed no gear').toEqual(before.state);
  // The panel is the one thing that is not inert: nothing above it is.
  expect(await panel(page).evaluate((el) => el.closest('[inert]') === null)).toBe(true);

  await closeButton(page).tap();
  await expect(panel(page)).toHaveCount(0);
  await pastTheGuard(page);
  expect(await snapshot(page), 'as it was').toEqual(before);
  expect(await controls(page), 'and every control is back in the screen reader\'s tree').toEqual(upright);
});

test('R28. with a keyboard: Enter and Space open it with the focus in the panel, Escape closes it (on the panel and on the page), and the link has the focus again, ringed round the book', async ({ page }) => {
  await open(page);
  await link(page).focus();
  await page.keyboard.press('Enter');
  await expect(panel(page)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(closeButton(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(link(page)).toBeFocused();
  // The ring is drawn round the book, not round the 44 px box that reaches out under the TV.
  expect(await css(link(page), 'outline-style')).toBe('none');
  expect(await css(link(page).locator('svg'), 'outline-style')).toBe('solid');
  expect(await css(link(page).locator('svg'), 'outline-color')).toBe('rgb(255, 46, 147)');

  await page.keyboard.press('Space');
  await expect(panel(page)).toBeFocused();
  // With the focus off the panel, on the page's body, Escape still closes it.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  expect((await focusAt(page)).inTv).toBe(false);
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(link(page)).toBeFocused();
  // And with the panel closed, Escape does nothing.
  await page.keyboard.press('Escape');
  await expect(link(page)).toBeFocused();
});

for (const gap of [60, 250, 300]) {
  test(`R28. a double tap on ✕, ${gap} ms apart: the second tap lands on nothing, not on the tuner's Spotify button under ✕; the tuner is usable once the moment is over`, async ({ page }) => {
    await open(page);
    await link(page).tap();
    await expect(panel(page)).toBeVisible();
    const at = await centre(closeButton(page));
    // The Spotify button is the one thing under ✕: a tap there would show its tooltip, and a second one would leave the app.
    const connect = (await page.getByRole('button', { name: 'Connect to Spotify' }).boundingBox())!;
    expect(Math.abs(connect.x + connect.width / 2 - at.x), 'it is under ✕').toBeLessThanOrEqual(22);
    expect(Math.abs(connect.y + connect.height / 2 - at.y)).toBeLessThanOrEqual(22);

    // Where every click lands from here on.
    await page.evaluate(() => {
      const clicked: { inApp: boolean; what: string }[] = [];
      (window as unknown as { clicked: typeof clicked }).clicked = clicked;
      document.addEventListener(
        'click',
        (e) => {
          const target = e.target as Element;
          clicked.push({ inApp: target.closest('#app') !== null, what: target.closest('button, a')?.getAttribute('aria-label') ?? target.tagName });
        },
        true,
      );
    });
    await page.touchscreen.tap(at.x, at.y);
    await page.waitForTimeout(gap);
    await page.touchscreen.tap(at.x, at.y);
    await page.waitForTimeout(200);
    const clicks = await page.evaluate(() => (window as unknown as { clicked: { inApp: boolean; what: string }[] }).clicked);
    expect(clicks[0], 'the first tap is ✕').toMatchObject({ what: 'Close sources and credits' });
    expect(clicks.slice(1).filter((c) => c.inApp), 'the second tap reached the tuner').toEqual([]);
    expect(page.url()).toMatch(/\/$/);
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator('button[data-tip="open"]'), 'the Spotify button was not tapped: its tooltip is not up').toHaveCount(0);

    // After the moment the tuner takes taps again.
    await pastTheGuard(page);
    await expect(page.locator('#app').locator('xpath=..')).not.toHaveAttribute('inert');
    await page.touchscreen.tap(at.x, at.y);
    await page.waitForTimeout(150);
    const later = await page.evaluate(() => (window as unknown as { clicked: { inApp: boolean }[] }).clicked.at(-1));
    expect(later?.inApp, 'a tap after the moment is a choice, and the tuner has it').toBe(true);
  });
}

let micBrowser: Browser | null = null;
test.afterAll(async () => {
  await micBrowser?.close();
});

test('R28. a microphone that is running is still running after the panel opens and closes: it is not asked for again, and the note it is held for is heard', async ({ baseURL }) => {
  test.setTimeout(90_000);
  micBrowser ??= await launchWithMic(writeTone(`credits-220-${test.info().workerIndex}.wav`, 220)); // a file per worker: a repeat run has several
  const context = await micBrowser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, baseURL, reducedMotion: 'reduce' });
  // How many times the page asks for the microphone: once, however often the panel is opened.
  await context.addInitScript(() => {
    const asked = { n: 0 };
    (window as unknown as { asked: typeof asked }).asked = asked;
    const media = navigator.mediaDevices;
    const real = media.getUserMedia.bind(media);
    media.getUserMedia = (constraints) => {
      asked.n += 1;
      return real(constraints);
    };
  });
  await mockApi(context, { loggedIn: false, events: [] });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByRole('button', { name: /Find a quiet spot/ }).click();
  await page.getByRole('button', { name: 'Turn on microphone', exact: true }).click();
  const record = page.getByRole('button', { name: 'Hold to record your lowest note' });
  await expect(record).toBeVisible();
  await page.waitForTimeout(1300); // the step's lyric sings in
  expect(await page.evaluate(() => (window as unknown as { asked: { n: number } }).asked.n)).toBe(1);

  for (let i = 0; i < 2; i++) {
    await link(page).tap();
    await expect(panel(page)).toBeVisible();
    await page.waitForTimeout(300);
    await closeButton(page).tap();
    await expect(panel(page)).toHaveCount(0);
  }
  await pastTheGuard(page);
  await expect(record).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { asked: { n: number } }).asked.n), 'the microphone was not asked for again').toBe(1);

  // Held like a finger would: the microphone opened before the panel still hears the tone, and the step goes on to the high note.
  const box = (await record.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId('live-pitch')).toHaveText('A3', { timeout: 3000 });
  await page.waitForTimeout(800);
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Hold to record your highest note' })).toBeVisible({ timeout: 5000 });
  await context.close();
});

test('R28. the phone on its side with the panel open: the message covers it, and upright again the panel is still open, with the focus in it', async ({ page }) => {
  await open(page);
  await link(page).tap();
  await expect(panel(page)).toBeFocused();
  const message = page.getByRole('dialog', { name: 'Turn your phone upright' });

  await page.setViewportSize({ width: 640, height: 360 });
  await expect(message).toBeVisible();
  await expect(tv(page)).toHaveAttribute('inert', '');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(message).toBeHidden();
  await expect(tv(page)).not.toHaveAttribute('inert');
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toBeFocused();
  await closeButton(page).tap();
  await expect(panel(page)).toHaveCount(0);
  await expect(link(page)).toBeFocused();
});

// ============================================================================================================
// R28. The panel scrolls inside the frame when the text is taller
// ============================================================================================================

for (const size of [
  { width: 390, height: 844 },
  { width: 375, height: 553 },
  { width: 320, height: 568 },
]) {
  test.describe(`at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test('R28. the panel scrolls inside the frame under a heading and ✕ that stay, by a real swipe, and neither the page nor the list under it moves', async ({ page }) => {
      await open(page);
      await page.locator('#list-scroll').evaluate((el) => el.scrollTo(0, 120));
      const listBefore = await page.locator('#list-scroll').evaluate((el) => el.scrollTop);
      await link(page).tap();
      await expect(panel(page)).toBeVisible();
      const m = await panel(page).evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight, wide: el.scrollWidth > el.clientWidth, top: el.scrollTop }));
      expect(m.scroll, 'the text is taller than the screen').toBeGreaterThan(m.client + 200);
      expect(m.wide, 'and nothing spills sideways').toBe(false);
      const x0 = (await closeButton(page).boundingBox())!;
      const heading0 = (await panel(page).getByRole('heading', { name: 'Sources and credits' }).boundingBox())!;
      expect(x0.y + x0.height, '✕ is inside the screen').toBeLessThanOrEqual(size.height);

      // A swipe up, from the middle of the panel: the text moves, and the heading and ✕ do not.
      const p = (await panel(page).boundingBox())!;
      await touchDrag(page, { x: p.x + p.width / 2, y: p.y + p.height * 0.75 }, -(p.height * 0.5));
      await expect.poll(() => panel(page).evaluate((el) => el.scrollTop), 'the swipe scrolled the panel').toBeGreaterThan(100);
      const x1 = (await closeButton(page).boundingBox())!;
      const heading1 = (await panel(page).getByRole('heading', { name: 'Sources and credits' }).boundingBox())!;
      expect(Math.abs(x1.y - x0.y), '✕ stays').toBeLessThanOrEqual(1);
      expect(Math.abs(heading1.y - heading0.y), 'the heading stays').toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollTop), 'the page did not scroll').toBe(0);
      expect(await page.locator('#list-scroll').evaluate((el) => el.scrollTop), 'nor the list under the panel').toBe(listBefore);

      // To the end: the last paragraph is whole, and clear of the panel's bottom edge; and a swipe past the end does not pull the page.
      await panel(page).evaluate((el) => el.scrollTo(0, el.scrollHeight));
      const last = (await panel(page).locator('section p').last().boundingBox())!;
      const edge = (await panel(page).boundingBox())!;
      expect(last.y + last.height, 'the end of the text is above the panel\'s edge').toBeLessThanOrEqual(edge.y + edge.height - 24);
      await touchDrag(page, { x: p.x + p.width / 2, y: p.y + p.height * 0.75 }, -(p.height * 0.5));
      expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0);
      expect(await page.locator('#list-scroll').evaluate((el) => el.scrollTop)).toBe(listBefore);

      // ✕ is still where a tap reaches it, at the end of the text.
      await closeButton(page).tap();
      await expect(panel(page)).toHaveCount(0);
      if (size.width === 390) {
        await link(page).tap();
        await panel(page).getByRole('link', { name: 'Deezer' }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(SCREENS, 'credits-open-deezer-390x844.png') });
      }
    });
  });
}

test.describe('on a desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false });

  test('R28. the link is at the bottom left of the phone-shaped TV, and a click opens the panel in it; the wheel scrolls it, a click on ✕ closes it', async ({ page }) => {
    await open(page);
    const f = await frame(page);
    expect(f.tv.w).toBe(390);
    expect(f.icon.cx - f.tv.x, 'bottom left of the TV').toBeLessThan(f.tv.w / 5);
    expect(f.tv.b - f.icon.cy).toBeLessThan(34);
    expect(f.link.b, 'the box reaches into the page\'s padding under the TV and no further').toBeLessThanOrEqual(f.tv.b + 12);
    // The colour is the page's dim text at rest, and its ink on hover.
    const rest = await css(link(page), 'color');
    expect(rest).toBe('rgba(244, 241, 246, 0.56)');
    await link(page).hover();
    await expect.poll(() => css(link(page), 'color'), 'hover lights it to the page\'s ink').toBe('rgb(244, 241, 246)');
    await page.screenshot({ path: path.join(SCREENS, 'credits-link-desktop.png') });

    await link(page).click();
    await expect(panel(page)).toBeVisible();
    const p = (await panel(page).boundingBox())!;
    expect(Math.abs(p.x - f.screen.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(p.width - f.screen.w)).toBeLessThanOrEqual(1);
    expect(Math.abs(p.height - f.screen.h)).toBeLessThanOrEqual(1);
    await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2);
    await page.mouse.wheel(0, 400);
    await expect.poll(() => panel(page).evaluate((el) => el.scrollTop), 'the wheel scrolled the panel').toBeGreaterThan(100);
    expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0);
    await page.screenshot({ path: path.join(SCREENS, 'credits-open-desktop.png') });
    await closeButton(page).click();
    await expect(panel(page)).toHaveCount(0);
  });
});

// ============================================================================================================
// R29. Deezer's credit stays where it is, under the list; Sources and credits names Deezer in words too
// ============================================================================================================

test('R29. the line under the list is there with a song that has a preview to play, as it was; Sources and credits names Deezer in words, with no logo of its own', async ({ page }) => {
  await open(page, { extra: [WITH_PREVIEW] });
  await expect(page.getByRole('button', { name: 'Play Can Play by Has Preview' })).toBeVisible();
  await page.locator('#list-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  const line = page.getByRole('link', { name: /^Previews from Deezer/ });
  await expect(line).toBeVisible();
  await expect(line).toHaveAttribute('href', '/credits');
  await expect(line).toHaveAttribute('target', '_blank');
  // The only credits link in the list is that line: the book is in the TV's chin (R28), and no row shows a Deezer mark.
  await expect(page.locator('#list-scroll a[href="/credits"]')).toHaveCount(1);
  await expect(page.locator('#list-scroll [data-row]').getByText('Deezer')).toHaveCount(0);

  await link(page).tap();
  const deezer = panel(page).getByRole('link', { name: 'Deezer' });
  await deezer.scrollIntoViewIfNeeded();
  await expect(deezer).toBeVisible();
  await expect(deezer.locator('svg')).toHaveCount(0);
  // Its words: what the previews are for, and that no audio is kept.
  const words = (await deezer.locator('xpath=following-sibling::p').innerText()).replace(/\s+/g, ' ');
  expect(words).toContain('streamed from Deezer for your own private, non-commercial listening');
  expect(words).toContain('We never keep the audio');
  await page.screenshot({ path: path.join(SCREENS, 'credits-deezer.png') });
});

// ============================================================================================================
// /credits: still a page of its own, for a direct visit
// ============================================================================================================

test('/credits is the same list and the same note as the panel, for a direct visit', async ({ page }) => {
  await open(page);
  await link(page).tap();
  const inPanel = {
    sources: await panel(page).locator('li').allInnerTexts(),
    note: (await panel(page).locator('section').innerText()).replace(/\s+/g, ' '),
  };
  expect(inPanel.sources).toHaveLength(CREDITS.length);

  await page.goto('/credits');
  await expect(page.getByRole('heading', { name: 'Sources and credits' })).toBeVisible();
  expect(await page.locator('main li').allInnerTexts()).toEqual(inPanel.sources);
  expect((await page.locator('main section').innerText()).replace(/\s+/g, ' ')).toBe(inPanel.note);
  // Deezer is named in words here too, and the logo stays in the line under the list (R29).
  await expect(page.getByRole('link', { name: 'Deezer' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Deezer' }).locator('svg')).toHaveCount(0);
});

/**
 * The credits page in `tab`, after its script has taken over "‹ Back". Until React has hydrated the link (it marks each element it owns with a
 * `__reactProps$...` key) a tap is the plain link's, which is not what these tests are about.
 */
async function hydrated(tab: Page) {
  await tab.waitForLoadState();
  await expect(tab.getByRole('heading', { name: 'Sources and credits' })).toBeVisible();
  await tab.waitForFunction(() => {
    const link = document.querySelector('main a[href="/"]');
    return link !== null && Object.keys(link).some((key) => key.startsWith('__reactProps$'));
  });
}

/** Taps "‹ Back". A tab that closes under the tap can make Playwright report a closed target: that is the result, not a failure. */
async function tapBack(tab: Page) {
  await back(tab)
    .tap()
    .catch((error: unknown) => {
      if (!tab.isClosed()) throw error;
    });
}

/**
 * /credits in a tab of its own, with one entry in its history: what a link that opens a new tab makes (an old link, a bookmark). It is
 * opened by script with no opener, as such a link's tab is, so only its one entry lets it close itself. (A tab made by Playwright has the
 * blank page before it in its history, so it has two.)
 */
async function creditsTab(page: Page, context: BrowserContext) {
  const opened = context.waitForEvent('page');
  await page.evaluate((href) => {
    window.open(href, '_blank', 'noopener');
  }, new URL('/credits', page.url()).href);
  const tab = await opened;
  await hydrated(tab);
  expect(await tab.evaluate(() => history.length), 'a tab of its own').toBe(1);
  return tab;
}

test('/credits. "‹ Back" in a tab of its own (one entry in its history) closes that tab: one tab is left, the tuned one, as it was', async ({ page, context }) => {
  await open(page);
  await setState(page, { difficulty: 80 });
  await expect.poll(() => tuner(page)).toMatchObject({ difficulty: 80 });
  const before = await tuner(page);

  const tab = await creditsTab(page, context);
  expect(context.pages()).toHaveLength(2);

  await tapBack(tab);
  await expect.poll(() => tab.isClosed()).toBe(true);
  expect(context.pages()).toHaveLength(1);
  expect(context.pages()[0]).toBe(page);
  // The tuned tab never moved: the tuning, and its list, are as they were.
  expect(new URL(page.url()).pathname).toBe('/');
  expect(await tuner(page)).toEqual(before);
  await expect(rows(page).first()).toBeVisible();
});

test('/credits. with pages behind it in the tab, "‹ Back" goes back to them and the tab stays open', async ({ page, context }) => {
  await open(page);
  await page.goto('/credits');
  await hydrated(page);
  const entries = await page.evaluate(() => history.length);
  expect(entries).toBeGreaterThan(1);

  await tapBack(page);
  await expect(rows(page).first()).toBeVisible({ timeout: 20_000 });
  expect(new URL(page.url()).pathname).toBe('/');
  expect(page.isClosed()).toBe(false);
  expect(context.pages()).toHaveLength(1);
  // It went back, not on: a new entry for "/" would have made the history one longer, and the credits page would be a Back away.
  expect(await page.evaluate(() => history.length)).toBe(entries);
});

test('/credits. a browser that will not close the tab gets the app after a moment, as the link always did', async ({ page, context }) => {
  await open(page);
  const tab = await creditsTab(page, context);
  // What a browser does with a tab it does not count as one a script can close: close() does nothing, and `closed` stays false.
  const said: string[] = [];
  tab.on('console', (message) => said.push(message.text()));
  await tab.evaluate(() => {
    window.close = () => console.log('close() was called');
  });
  await tapBack(tab);
  await expect.poll(() => new URL(tab.url()).pathname).toBe('/');
  // It asked the browser to close the tab first, and went to the app when the browser would not.
  expect(said).toContain('close() was called');
  expect(tab.isClosed()).toBe(false);
  expect(context.pages()).toHaveLength(2);
});

test('/credits. with no script "‹ Back" is still a link, and it opens the app', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  const tab = await context.newPage();
  await tab.goto('/credits');
  await expect(back(tab)).toHaveAttribute('href', '/');
  await back(tab).click();
  await expect.poll(() => new URL(tab.url()).pathname).toBe('/');
  await context.close();
});
