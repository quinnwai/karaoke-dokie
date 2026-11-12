// Quinn-Wai's review of #38 on an iPhone (QWW-57, R14 to R30), the header and the tuner's first notes, one check each as the ticket asks:
//   R14  redo is a round icon button: a circle, an arrow in it, no text, a 44 px target, and the sign keeps 8 px from it (R1) at 360, 390 and 430 px
//        with C#2 to G#5
//   R15  the sign stays on the frame's true centre: R1's checks again after R14 (setlist-frame.spec.ts) and a 390 px screenshot with F2 to D4
//   R18  the "Want personalized recommendations?" block under the list is gone, at every width
//   R19  the count of songs is at the header's top right, under the Spotify button, and follows every answer; the Era panel no longer shows it
//   R21  each gear's reset arrow is a ✕ named "Turn off <gear>", and a tap turns the gear off
//   R30  the Spotify button on touch: the first tap shows its tooltip, a second connects, a tap elsewhere hides it; a desktop keeps hover and click.
//        A second tap inside TAP_GUARD_MS (400 ms) of the first is a double tap's and is ignored, so the tests here wait the moment out between their
//        taps; the double tap itself, in Chromium and WebKit, is tests/e2e/setlist-row-tap.spec.ts's (8)
// The tuner is reached as the other tuner specs reach it (tests/helpers/tunerE2e.ts). tests/setlist/header.test.tsx has the logic in jsdom.

import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { centre, css, eraButton, ONLY_80S, open, resetButton, rows, titles, tuner } from '../helpers/tunerE2e';

const SCREENS = path.resolve('test-results/screens');
test.beforeAll(() => mkdirSync(SCREENS, { recursive: true }));

// A 390x844 touch phone, as the other tuner specs. Motion is off: the list would never be "stable" for Playwright otherwise.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });
const DESKTOP = { hasTouch: false, isMobile: false } as const;

const redoOf = (page: Page) => page.getByRole('button', { name: 'Redo the range test' });
const spotifyOf = (page: Page) => page.getByRole('button', { name: 'Connect to Spotify' });
const hook = (page: Page, patch: object) => page.evaluate((p) => (window as unknown as { setlist: { setState(p: object): void } }).setlist.setState(p), patch);

/** The header's parts in page pixels: redo, the sign (null while hidden), the Spotify button, the count, and the TV's screen. */
const headerBox = (page: Page) =>
  page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const box = (e: Element | null) => {
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: b.x, y: b.y, r: b.x + b.width, b: b.y + b.height, w: b.width, h: b.height };
    };
    const bar = document.querySelector('#app header > div') as HTMLElement;
    const sign = bar.querySelector<HTMLElement>('[data-sign]')!;
    return {
      redo: box(bar.querySelector('button[aria-label="Redo the range test"]')),
      sign: sign.hasAttribute('data-hidden') ? null : box(sign),
      spotify: box(bar.querySelector('[data-sign-right]')),
      count: box(document.querySelector('[data-song-count]')),
      screen: box(document.querySelector('section[aria-label="Karaoke screen"]')),
    };
  });

// ---- R14 ----

for (const width of [360, 390, 430]) {
  test(`R14. at ${width} px redo is a circle with an arrow and no text, 44 px to tap, and the sign keeps 8 px from it with C#2 to G#5`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page, { range: { low: 37, high: 80 } }); // C#2 to G#5, the longest range
    const redo = redoOf(page);
    const b = (await redo.boundingBox())!;
    // A circle: square, with a radius of half.
    expect(Math.abs(b.width - b.height), 'width and height').toBeLessThanOrEqual(0.5);
    expect(await css(redo, 'border-top-left-radius')).toBe('50%');
    expect(await css(redo, 'border-top-width')).toBe('1px');
    // An arrow in it, no text, and the arrow is inside the circle.
    expect((await redo.textContent())!.trim()).toBe('');
    const svg = (await redo.locator('svg').boundingBox())!;
    expect(svg.x).toBeGreaterThanOrEqual(b.x + 4);
    expect(svg.x + svg.width).toBeLessThanOrEqual(b.x + b.width - 4);
    expect(svg.y).toBeGreaterThanOrEqual(b.y + 4);
    expect(svg.y + svg.height).toBeLessThanOrEqual(b.y + b.height - 4);
    // 44 px to tap: a point 21 px from its centre reaches it, a point 26 px away does not.
    const c = await centre(redo);
    const reaches = (dx: number, dy: number) => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') ?? null, { x: c.x + dx, y: c.y + dy });
    for (const [dx, dy] of [[21, 0], [-21, 0], [0, 21], [0, -21]]) expect(await reaches(dx!, dy!), `${dx},${dy}`).toBe('Redo the range test');
    for (const [dx, dy] of [[26, 0], [-26, 0], [0, 26], [0, -26]]) expect(await reaches(dx!, dy!), `${dx},${dy}`).not.toBe('Redo the range test');
    // The sign keeps 8 px from redo and from the Spotify button when it is shown (R1), and nothing in the header overlaps.
    const h = await headerBox(page);
    if (h.sign) {
      expect(h.sign.x - h.redo!.r, 'sign from redo').toBeGreaterThanOrEqual(8);
      expect(h.spotify!.x - h.sign.r, 'sign from the logo').toBeGreaterThanOrEqual(8);
    }
    expect(h.redo!.r).toBeLessThanOrEqual(h.spotify!.x);
  });
}

test('R14. redo still re-sings both ends: a tap starts the whole test again', async ({ page }) => {
  await open(page);
  await redoOf(page).tap();
  await expect(page.getByRole('button', { name: /Find a quiet spot/ })).toBeVisible({ timeout: 10_000 });
});

// ---- R15 ----

test('R15. the sign is on the frame\'s true centre (within 1 px) with F2 to D4 at 390 px, and its screenshot', async ({ page }) => {
  await open(page, { range: { low: 41, high: 62 } }); // F2 to D4
  const h = await headerBox(page);
  expect(h.sign, 'the sign is shown').not.toBeNull();
  const signCentre = h.sign!.x + h.sign!.w / 2;
  const frameCentre = h.screen!.x + h.screen!.w / 2;
  expect(Math.abs(signCentre - frameCentre), 'the sign\'s centre and the frame\'s').toBeLessThanOrEqual(1);
  await page.screenshot({ path: path.join(SCREENS, 'header-390-F2-D4.png') });
});

// ---- R18 ----

for (const width of [360, 390, 430, 1280]) {
  test(`R18. at ${width} px the "Want personalized recommendations?" block is not under the list, signed out`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1280 ? 800 : 844 });
    await open(page);
    await expect(rows(page).first()).toBeVisible();
    // To the end of the list: the block stood there.
    await page.locator('#list-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    for (const words of ['Want personalized recommendations?', 'Invited testers only for now.']) await expect(page.getByText(words)).toHaveCount(0);
    // Signed out, the header's Spotify button is the way to connect, and it stays.
    await expect(spotifyOf(page)).toHaveCount(1);
  });
}

// ---- R19 ----

test('R19. the count is at the header\'s top right, under the Spotify button, and follows the eras; the Era panel no longer shows it', async ({ page }) => {
  await open(page);
  const count = page.locator('[data-song-count]');
  await expect(count).toHaveText('25 songs');
  const h = await headerBox(page);
  expect(h.count!.y, 'below the Spotify button').toBeGreaterThanOrEqual(h.spotify!.b - 1);
  expect(Math.abs(h.count!.r - h.spotify!.r), 'the right edges line up').toBeLessThanOrEqual(2);
  expect(h.count!.r, 'inside the screen').toBeLessThanOrEqual(h.screen!.x + h.screen!.w);

  // An era: the count follows the answer, to every song of that era; Era off again: every song.
  await eraButton(page, 's80').tap();
  await expect(count).toHaveText(`${ONLY_80S.length} songs`);
  await expect.poll(() => titles(page)).toHaveLength(ONLY_80S.length);
  await resetButton(page, 'era').tap();
  await expect(count).toHaveText('25 songs');
  // A gear re-ranks and keeps the count (it is the songs that fit, not their order), and the count is still there.
  await hook(page, { difficulty: 90 });
  await expect(count).toHaveText('25 songs');

  // The Era panel's title says ERA and its state, and no count.
  const panel = (await page.locator('#era-panel').textContent())!;
  expect(panel).not.toMatch(/\bsongs?\b/);
});

test('R19. the count fits beside the title at 360 px, with the longest title and a thousand songs', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 844 });
  await open(page);
  await page.evaluate(() => {
    document.querySelector('[data-song-count]')!.textContent = '12,345 songs';
  });
  const title = (await page.getByRole('heading', { name: 'Tune your setlist' }).boundingBox())!;
  const count = (await page.locator('[data-song-count]').boundingBox())!;
  expect(title.x + title.width, 'the title and the count do not overlap').toBeLessThanOrEqual(count.x);
});

// ---- R21 ----

test('R21. each gear\'s reset arrow is a ✕ named "Turn off <gear>", and a tap turns the gear off', async ({ page }) => {
  await open(page);
  await page.locator('#app').evaluate((el) => el.getAttribute('data-mode')); // the sheet in whichever mode the phone opens it
  await hook(page, { off: [], mini: false });
  const names: Record<string, string> = { difficulty: 'Turn off difficulty', popularity: 'Turn off popularity', tempo: 'Turn off tempo', era: 'Turn off era' };
  await hook(page, { eras: ['s90'], off: [] });
  for (const [gear, name] of Object.entries(names)) {
    const button = page.locator(`button[data-reset="${gear}"]`);
    await expect(button, gear).toHaveAttribute('aria-label', name);
    await expect(button, gear).toBeVisible();
    // A ✕: one path of two crossing strokes, no arrow.
    expect(await button.locator('path').evaluateAll((ps) => ps.map((p) => p.getAttribute('d')))).toEqual(['M6 6L18 18M18 6L6 18']);
    expect(await button.textContent()).toBe('');
    await button.tap();
    expect((await tuner(page)).off, `after turning ${gear} off`).toContain(gear);
    await expect(button, `${gear}'s ✕ goes with it`).toBeHidden();
  }
});

// ---- R30 ----

test.describe('R30. on a touch screen', () => {
  const tip = (page: Page) => spotifyOf(page).locator('span');
  const login = (page: Page) => page.waitForRequest((r) => /\/api\/auth\/login/.test(r.url()), { timeout: 10_000 });

  test('the first tap shows the tooltip and goes nowhere, a second tap starts sign-in', async ({ page }) => {
    await open(page);
    const requests: string[] = [];
    page.on('request', (r) => {
      if (/\/api\/auth\/login/.test(r.url())) requests.push(r.url());
    });
    await expect.poll(() => css(tip(page), 'opacity')).toBe('0');
    await spotifyOf(page).tap();
    await expect.poll(() => css(tip(page), 'opacity')).toBe('1');
    await page.waitForTimeout(500); // past the moment (400 ms) in which a second tap is a double tap's and is ignored
    expect(requests, 'the first tap connects to nothing').toEqual([]);
    expect(new URL(page.url()).pathname).toBe('/');

    const started = login(page);
    await spotifyOf(page).tap();
    await started;
  });

  test('a tap anywhere else hides the tooltip, and the next tap on the button shows it again instead of connecting', async ({ page }) => {
    await open(page);
    let logins = 0;
    page.on('request', (r) => {
      if (/\/api\/auth\/login/.test(r.url())) logins++;
    });
    await spotifyOf(page).tap();
    await expect.poll(() => css(tip(page), 'opacity')).toBe('1');
    await page.getByRole('heading', { name: 'Tune your setlist' }).tap();
    await expect.poll(() => css(tip(page), 'opacity'), 'hidden by a tap elsewhere').toBe('0');
    await spotifyOf(page).tap();
    await expect.poll(() => css(tip(page), 'opacity')).toBe('1');
    await page.waitForTimeout(400);
    expect(logins).toBe(0);
  });

  test('a stuck :hover after the tap does not keep the tooltip up: only the tap\'s own state does', async ({ page }) => {
    await open(page);
    await spotifyOf(page).tap();
    await expect.poll(() => css(tip(page), 'opacity')).toBe('1');
    // Chromium leaves the touch\'s hover on the button; a tap on bare screen must still hide the tooltip.
    await page.touchscreen.tap(20, 600);
    await expect.poll(() => css(tip(page), 'opacity')).toBe('0');
  });
});

test.describe('R30. with a pointer', () => {
  test.use({ viewport: { width: 1280, height: 800 }, ...DESKTOP });

  test('hovering shows the tooltip, leaving hides it, and one click starts sign-in', async ({ page }) => {
    await open(page);
    const tip = spotifyOf(page).locator('span');
    await expect.poll(() => css(tip, 'opacity')).toBe('0');
    await spotifyOf(page).hover();
    await expect.poll(() => css(tip, 'opacity')).toBe('1');
    await page.mouse.move(5, 5);
    await expect.poll(() => css(tip, 'opacity')).toBe('0');
    const started = page.waitForRequest((r) => /\/api\/auth\/login/.test(r.url()), { timeout: 10_000 });
    await spotifyOf(page).click();
    await started;
  });
});
