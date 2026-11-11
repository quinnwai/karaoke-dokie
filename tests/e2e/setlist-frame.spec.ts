// Review items R1, R2, R4 and R9 of QWW-57 (Quinn-Wai's review of the 6A preview, 11 Nov), one check each as the ticket asks:
//   R1  the カラオケ sign is centred on the header's true middle, and goes when it would come within 8 px of redo or the logo
//   R2  the TV is phone-shaped on every screen: 390 px wide, min(844 px, window - 32 px) tall, centred, on every step
//   R4  "Find on Spotify" and "Open in Spotify" on the song page end with the external-link icon
//   R9  hovering or focusing the range notes and redo turns them pink
// The tuner is reached the way tests/e2e/setlist.spec.ts reaches it (tests/helpers/tunerE2e.ts); the title, mic and note steps
// with a fake microphone, as tests/e2e/mic-permission.spec.ts does.

import { expect, test, type Browser, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { launchWithMic, writeTone } from './fakeMic';
import { css, open, openButton, rgb, rows } from '../helpers/tunerE2e';

const SCREENS = path.resolve('test-results/screens');
test.beforeAll(() => mkdirSync(SCREENS, { recursive: true }));

// The default is a touch phone, like the tuner spec; the desktop describes below say otherwise.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

const PINK_TEXT = rgb('#FF6FB1');
const DESKTOP = { hasTouch: false, isMobile: false } as const;

// ============================================================================================================
// R1: the sign is centred on the header
// ============================================================================================================

/** The header row's parts, in page pixels; `sign` is null while it is hidden (`visibility: hidden`). */
const headerBox = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector('#app header > div') as HTMLElement;
    const box = (e: Element | null) => {
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom, cx: b.x + b.width / 2 };
    };
    const sign = bar.querySelector('[data-sign]') as HTMLElement;
    return {
      bar: box(bar),
      range: box(bar.querySelector('[role="group"]')),
      redo: box(bar.querySelector('button[aria-label="Redo the singing test"]')),
      sign: box(sign),
      signShown: getComputedStyle(sign).visibility !== 'hidden' && getComputedStyle(sign).display !== 'none',
      spotify: box(bar.querySelector('button[aria-label="Connect to Spotify"], button[aria-label="Spotify account"]')),
    };
  });

for (const width of [390, 412, 430]) {
  test(`R1. at ${width} px the sign's centre is the header's centre (within 1 px), and it is clear of redo and the logo by 8 px or more`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page, { range: { low: 41, high: 65 } }); // F2 to F4
    const h = await headerBox(page);
    expect(h.signShown).toBe(true);
    expect(Math.abs(h.sign!.cx - h.bar!.cx)).toBeLessThanOrEqual(1);
    expect(h.sign!.x - h.redo!.r).toBeGreaterThanOrEqual(8);
    expect(h.spotify!.x - h.sign!.r).toBeGreaterThanOrEqual(8);
    // It is the middle of the screen too: the header is as wide as the tuner, which is symmetric in the TV.
    const screenCentre = await page.evaluate(() => {
      const b = document.getElementById('app')!.getBoundingClientRect();
      return b.x + b.width / 2;
    });
    expect(Math.abs(h.sign!.cx - screenCentre)).toBeLessThanOrEqual(1);
  });
}

test('R1. at 390 px with F2 to F4 the sign shows, and with a range from the other end of the scale too', async ({ page }) => {
  await open(page, { range: { low: 41, high: 65 } });
  expect((await headerBox(page)).signShown).toBe(true);
  expect(await page.locator('#app header').textContent()).toContain('F2');
});

test('R1. at 360 px with C#2 to G#5 the sign is hidden and nothing overlaps', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await open(page, { range: { low: 37, high: 80 } }); // C#2 to G#5
  await expect(page.locator('#app header')).toContainText('C#2');
  const h = await headerBox(page);
  expect(h.signShown, 'the long range leaves the centred sign no room at 360 px').toBe(false);
  expect(h.range!.r).toBeLessThanOrEqual(h.redo!.x);
  expect(h.redo!.r).toBeLessThanOrEqual(h.spotify!.x);
  expect(h.spotify!.r).toBeLessThanOrEqual(h.bar!.r + 0.5);
  expect(h.bar!.h).toBe(28);
});

test('R1. the sign comes back when the room does, and goes again when it does not (a phone turned)', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await open(page, { range: { low: 37, high: 80 } });
  expect((await headerBox(page)).signShown).toBe(false);
  await page.setViewportSize({ width: 430, height: 740 });
  await expect.poll(async () => (await headerBox(page)).signShown).toBe(true);
  await page.setViewportSize({ width: 360, height: 740 });
  await expect.poll(async () => (await headerBox(page)).signShown).toBe(false);
});

test.describe('R1 on a desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, ...DESKTOP });

  test('R1. on a desktop the sign is at the header\'s centre too, inside the phone-shaped frame', async ({ page }) => {
    await open(page, { range: { low: 41, high: 65 } });
    const h = await headerBox(page);
    expect(h.signShown).toBe(true);
    expect(Math.abs(h.sign!.cx - h.bar!.cx)).toBeLessThanOrEqual(1);
    // And the frame's own middle is the window's middle.
    expect(Math.abs(h.sign!.cx - 1280 / 2)).toBeLessThanOrEqual(1);
  });
});

// ============================================================================================================
// R9: the header's hover and focus are pink
// ============================================================================================================

test.describe('R9, with a pointer', () => {
  test.use({ viewport: { width: 1280, height: 800 }, ...DESKTOP });

  const note = (page: Page) => page.getByRole('button', { name: /^Redo your low note/ });
  const noteMark = (page: Page) => note(page).locator('span').first();
  const redo = (page: Page) => page.getByRole('button', { name: 'Redo the singing test' });

  test('R9. hovering a range note turns its text and its dotted underline pink, and leaving puts them back', async ({ page }) => {
    await open(page);
    const before = { color: await css(noteMark(page), 'color'), line: await css(noteMark(page), 'border-bottom-color') };
    expect(before.color).not.toBe(PINK_TEXT);
    await note(page).hover();
    await expect.poll(() => css(noteMark(page), 'color')).toBe(PINK_TEXT);
    expect(await css(noteMark(page), 'border-bottom-color')).toBe(PINK_TEXT);
    expect(await css(noteMark(page), 'border-bottom-style')).toBe('dotted');
    await page.mouse.move(5, 400);
    await expect.poll(() => css(noteMark(page), 'color')).toBe(before.color);
    expect(await css(noteMark(page), 'border-bottom-color')).toBe(before.line);
  });

  test('R9. hovering redo turns its border and text pink, and leaving puts them back', async ({ page }) => {
    await open(page);
    const before = { color: await css(redo(page), 'color'), border: await css(redo(page), 'border-top-color') };
    expect(before.color).not.toBe(PINK_TEXT);
    await redo(page).hover();
    await expect.poll(() => css(redo(page), 'color')).toBe(PINK_TEXT);
    expect(await css(redo(page), 'border-top-color')).toBe(PINK_TEXT);
    await page.mouse.move(5, 400);
    await expect.poll(() => css(redo(page), 'color')).toBe(before.color);
    expect(await css(redo(page), 'border-top-color')).toBe(before.border);
  });

  test('R9. hovering the 44 px hit area, not only the text, is hovering the note and redo', async ({ page }) => {
    await open(page);
    const b = (await redo(page).boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 - 18); // above the 28 px outline, inside the 44 px target
    await expect.poll(() => css(redo(page), 'color')).toBe(PINK_TEXT);
  });

  test('R9. keyboard focus turns them pink too', async ({ page }) => {
    await open(page);
    const focus = async (label: RegExp) => {
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab');
        if (await page.evaluate((src) => new RegExp(src).test(document.activeElement?.getAttribute('aria-label') ?? ''), label.source)) return;
      }
      throw new Error(`Tab never reached ${label}`);
    };
    // The colour eases over 120 ms, so each is read once it has arrived.
    await focus(/^Redo your low note/);
    await expect.poll(() => css(noteMark(page), 'color')).toBe(PINK_TEXT);
    await expect.poll(() => css(noteMark(page), 'border-bottom-color')).toBe(PINK_TEXT);
    await focus(/^Redo the singing test/);
    await expect.poll(() => css(redo(page), 'color')).toBe(PINK_TEXT);
    await expect.poll(() => css(redo(page), 'border-top-color')).toBe(PINK_TEXT);
    await expect.poll(() => css(noteMark(page), 'color')).not.toBe(PINK_TEXT);
  });
});

test('R9. in a touch context there is no hover, so nothing turns pink and stays pink after a tap', async ({ page }) => {
  await open(page);
  const redo = page.getByRole('button', { name: 'Redo the singing test' });
  expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(false);
  const before = await css(redo, 'color');
  await redo.hover();
  await page.waitForTimeout(250);
  expect(await css(redo, 'color')).toBe(before);
  expect(await css(redo, 'border-top-color')).not.toBe(PINK_TEXT);
});

// ============================================================================================================
// R4: the external-link icon on the song page
// ============================================================================================================

for (const [signedIn, name] of [
  [false, 'Find on Spotify'],
  [true, 'Open in Spotify'],
] as const) {
  test(`R4. the "${name}" link ends with the external-link icon, in the link's colour, and its name is unchanged`, async ({ page }) => {
    await open(page, { loggedIn: signedIn });
    await openButton(rows(page).first()).click();
    const link = page.getByRole('link', { name, exact: true });
    await expect(link).toBeVisible();
    const m = await link.evaluate((a) => {
      const icon = a.querySelector('svg')!;
      const link = getComputedStyle(a);
      const mark = getComputedStyle(icon);
      const box = icon.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(a.firstChild!);
      return {
        last: a.lastElementChild === icon,
        hidden: icon.getAttribute('aria-hidden'),
        stroke: mark.stroke,
        linkColor: link.color,
        iconColor: mark.color,
        em: box.width / parseFloat(link.fontSize),
        iconAfterText: box.left >= text.getBoundingClientRect().right - 0.5,
        text: a.textContent,
      };
    });
    expect(m.last).toBe(true);
    expect(m.hidden).toBe('true');
    expect(m.iconColor).toBe(m.linkColor);
    expect(m.stroke).toBe(m.linkColor);
    expect(m.em).toBeGreaterThan(0.7);
    expect(m.em).toBeLessThan(0.9);
    expect(m.iconAfterText).toBe(true);
    expect(m.text).toBe(name);
    await page.screenshot({ path: path.join(SCREENS, `setlist-r4-${signedIn ? 'open' : 'find'}-on-spotify.png`) });
  });
}

// ============================================================================================================
// R2: the TV is phone-shaped on every screen
// ============================================================================================================

/** The TV (the bezel, `section[aria-label="Karaoke screen"]`) and the window, as the page sees them. */
const tv = (page: Page) =>
  page.evaluate(() => {
    const frames = document.querySelectorAll('section[aria-label="Karaoke screen"]');
    const b = frames[0]!.getBoundingClientRect();
    return { count: frames.length, x: b.x, y: b.y, w: b.width, h: b.height, vw: innerWidth, vh: innerHeight, scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight };
  });

/** The frame is 390 wide, min(844, window - 32) tall, and centred on both axes, within a pixel. */
async function expectPhoneShaped(page: Page, what: string) {
  const f = await tv(page);
  const height = Math.min(844, f.vh - 32);
  expect(f.count, `${what}: one frame`).toBe(1);
  expect(f.w, `${what}: width`).toBeCloseTo(390, 0);
  expect(f.h, `${what}: height`).toBeCloseTo(height, 0);
  expect(Math.abs(f.x + f.w / 2 - f.vw / 2), `${what}: centred across`).toBeLessThanOrEqual(1);
  expect(Math.abs(f.y + f.h / 2 - f.vh / 2), `${what}: centred down`).toBeLessThanOrEqual(1);
  expect(f.scrollW, `${what}: the page does not scroll sideways`).toBeLessThanOrEqual(f.vw);
}

const SIZES = [
  { width: 1280, height: 800, opens: 'mini' },
  { width: 1440, height: 900, opens: 'expanded' },
  { width: 1920, height: 1080, opens: 'expanded' },
] as const;

let micBrowser: Browser | null = null;
test.afterAll(async () => {
  await micBrowser?.close();
});

for (const size of SIZES) {
  test(`R2. at ${size.width}x${size.height} the TV is 390 wide and ${Math.min(844, size.height - 32)} tall, centred, on the title, the mic step, both note steps and the tuner`, async ({ baseURL }) => {
    test.setTimeout(90_000);
    micBrowser ??= await launchWithMic(writeTone('r2-220.wav', 220));
    const browser = micBrowser;
    const context = async (storage?: Record<string, string>) => {
      const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, baseURL, reducedMotion: 'reduce' });
      await ctx.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/me') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"signed out"}' });
        if (url.pathname === '/api/events') return route.fulfill({ status: 204 });
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not mocked"}' });
      });
      if (storage) await ctx.addInitScript((s) => Object.entries(s).forEach(([k, v]) => sessionStorage.setItem(k, v)), storage);
      return ctx;
    };

    // The title.
    let ctx = await context();
    let page = await ctx.newPage();
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
    await expectPhoneShaped(page, 'the title');
    await page.screenshot({ path: path.join(SCREENS, `setlist-r2-title-${size.width}.png`) });

    // The mic step, and then the low note.
    await page.getByRole('button', { name: 'Start' }).click();
    await page.getByRole('button', { name: /Find a quiet spot/ }).click();
    await expect(page.getByText('Set up your microphone')).toBeVisible();
    await expectPhoneShaped(page, 'the mic step');
    await page.screenshot({ path: path.join(SCREENS, `setlist-r2-mic-${size.width}.png`) });
    await page.getByRole('button', { name: 'Turn on microphone', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Hold to record your lowest note' })).toBeVisible();
    await expectPhoneShaped(page, 'the low note step');
    await page.waitForTimeout(1300); // the step's lyric sings in
    await page.screenshot({ path: path.join(SCREENS, `setlist-r2-low-note-${size.width}.png`) });
    await ctx.close();

    // The high note, reached with the low one kept for the visit.
    ctx = await context({ 'kd.test': JSON.stringify({ low: 45 }) });
    page = await ctx.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: 'Turn on microphone', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Hold to record your highest note' })).toBeVisible();
    await expectPhoneShaped(page, 'the high note step');
    await ctx.close();
  });

  test.describe(`R2 tuner at ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, ...DESKTOP });

    test(`R2. the tuner is in the same frame, fills it, and opens in ${size.opens}`, async ({ page }) => {
      await open(page);
      await expectPhoneShaped(page, 'the tuner');
      const m = await page.evaluate(() => {
        const frame = document.querySelector('section[aria-label="Karaoke screen"]')!.getBoundingClientRect();
        const app = document.getElementById('app')!;
        const a = app.getBoundingClientRect();
        const inner = app.parentElement!;
        return { appW: a.width, appH: a.height, frameW: frame.width, mode: app.dataset.mode, scrolls: inner.scrollHeight > inner.clientHeight };
      });
      // No column inside a wide TV: the tuner fills the screen of a 390 px frame (390 less the bezel's 9 px each side).
      expect(m.appW).toBeCloseTo(m.frameW - 18, 0);
      expect(m.scrolls).toBe(false);
      // The mode rule holds inside it: expanded only where it leaves 3 whole rows.
      await expect(page.locator('#app')).toHaveAttribute('data-mode', size.opens);
      if (size.opens === 'expanded') {
        const whole = await page.evaluate(() => {
          const list = document.getElementById('list-scroll')!.getBoundingClientRect();
          return [...document.querySelectorAll('[data-row]')].filter((r) => {
            const b = r.getBoundingClientRect();
            return b.top >= list.top - 0.5 && b.bottom <= list.bottom + 0.5;
          }).length;
        });
        expect(whole).toBeGreaterThanOrEqual(3);
      }
      await page.screenshot({ path: path.join(SCREENS, `setlist-r2-tuner-${size.width}x${size.height}.png`) });
    });
  });
}

test('R2. a phone is as it was: the TV is the whole page, with 6A\'s padding', async ({ page }) => {
  await open(page);
  const f = await tv(page);
  expect([f.x, f.y, f.w]).toEqual([10, 14, 370]);
  expect(f.y + f.h).toBe(844 - 12);
});
