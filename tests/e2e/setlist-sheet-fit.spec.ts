// Two more places where the sheet's text did not fit its box (QWW-57, the adversarial review of PR #38). Both are about sheet.module.css; the
// label on the gear strips (finding 4) is checked with the other R6 checks, in setlist-sheet.spec.ts.
//   7  every tab label has 3 px clear on each side inside its tab at 360, 375, 390 and 412 px, and "Popularity" has them with 4% to spare
//      over a Mac's width (Linux, in CI, sets it 2.3% wider): one size for the five labels, 11 px where the widest fits at it with that
//      spare, and the largest that fits where it does not
//   8  every era label fits its button, on a phone and in the desktop frame, and its size follows the panel it is in, not the window
// A tab or an era button is a box in a grid whose width is the sheet's, so what fits is read from the page: the width of the label's text (a Range
// over it) against the box. The tuner is reached the way tests/e2e/setlist.spec.ts reaches it (tests/helpers/tunerE2e.ts).

import { expect, test, type Page } from '@playwright/test';
import { handle, open, tab } from '../helpers/tunerE2e';

// A 390x844 touch phone, like the other sheet specs, and motion off.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

const DESKTOP = { hasTouch: false, isMobile: false } as const;
const PHONES = [360, 375, 390, 412, 430];

/** The fonts are loaded, so a width measured now is the one the page keeps. */
const fontsReady = (page: Page) =>
  page.evaluate(async () => {
    await document.fonts.load('600 11px Inter');
    await document.fonts.ready;
  });

/** The sheet in a mode (the handle toggles it). */
async function showMode(page: Page, mode: 'expanded' | 'mini') {
  const app = page.locator('#app');
  if ((await app.getAttribute('data-mode')) !== mode) await handle(page).click();
  await expect(app).toHaveAttribute('data-mode', mode);
}

// ============================================================================================================
// Finding 7: the tab labels
// ============================================================================================================

/** Each tab's label: its text, the width of that text, its size, and the tab's clientWidth (the box inside the 1 px borders). */
const tabLabels = (page: Page) =>
  page.locator('[data-tab]').evaluateAll((tabs) =>
    tabs.map((t) => {
      const label = t.querySelector(':scope > span') as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(label);
      return {
        name: label.textContent ?? '',
        text: range.getBoundingClientRect().width,
        size: Number.parseFloat(getComputedStyle(label).fontSize),
        client: t.clientWidth,
      };
    }),
  );

/** What fitting means for a tab label (finding 7): its text's width and 3 px on each side is no more than the tab's clientWidth. */
const CLEAR = 6;

/**
 * "Popularity", the widest label, is 4.9474 px per px of font size in Inter 600 as a Mac sets it. CI's Linux Chromium sets it about 2.3% wider
 * (platform text layout and hinting: 49.00 px at 9.68 px where a Mac measures 47.89 px, in a 54 px tab), which a fit with nothing to spare did
 * not allow for: it passed on a Mac and failed in CI. So the label is checked twice. As this platform measures it, it must fit. And as a Mac's
 * width plus 4% it must fit too, which is what a run on a Mac checks to catch what CI would. The second is the Mac's width per px, not the
 * measured width times 1.04: on Linux that is already 2.3% wider, and the two together ask for 6.4%, more than the size is given.
 */
const POPULARITY_PER_PX = 4.9474;
const SLACK = 1.04;

/**
 * Checks the five tab labels at the width the page is at: each keeps 3 px clear on each side as measured here, they share one size between 9
 * and 11 px, "Popularity" keeps them with 4% to spare over a Mac's width, and the size is 11 px (6A's) wherever that fits with the same
 * spare and no smaller than it must be where it does not.
 */
async function expectTabsFit(page: Page, width: number) {
  const labels = await tabLabels(page);
  expect(labels.map((l) => l.name), `${width} px`).toEqual(['Difficulty', 'Popularity', 'Tempo', 'History', 'Era']);
  for (const l of labels) expect(l.text + CLEAR, `${width} px: ${l.name} is ${l.text.toFixed(2)} px wide in a ${l.client} px tab`).toBeLessThanOrEqual(l.client);
  const size = labels[0]!.size;
  expect(new Set(labels.map((l) => l.size)).size, `${width} px: the five labels' sizes ${labels.map((l) => l.size)}`).toBe(1);
  expect(size, `${width} px`).toBeGreaterThanOrEqual(9);
  expect(size, `${width} px`).toBeLessThanOrEqual(11);
  const popularity = labels.find((l) => l.name === 'Popularity')!;
  const padded = POPULARITY_PER_PX * size * SLACK + CLEAR;
  expect(padded, `${width} px: Popularity 4% wider than a Mac sets it, at ${size}px, is ${(padded - CLEAR).toFixed(2)} px wide in a ${popularity.client} px tab`).toBeLessThanOrEqual(popularity.client);
  if (POPULARITY_PER_PX * 11 * SLACK + CLEAR <= popularity.client) expect(size, `${width} px: Popularity fits at 11 px with 4% to spare`).toBe(11);
  else expect(popularity.client - padded, `${width} px: more room than the size needs, at ${size}px`).toBeLessThan(1.5);
  return size;
}

test('7. every tab label has 3 px clear on each side inside its tab at 360, 375, 390, 412 and 430 px, in one size that grows with the width and is 11 px where it fits', async ({ page }) => {
  await open(page, { mini: true });
  const sizes: number[] = [];
  for (const width of PHONES) {
    await page.setViewportSize({ width, height: 844 });
    await fontsReady(page);
    await showMode(page, 'mini');
    sizes.push(await expectTabsFit(page, width));
  }
  // "Popularity" is the widest, so the size shrinks with the width and not below 9 px, and 6A's 11 px is back by 412 px.
  expect([...sizes].sort((x, y) => x - y), `the sizes at ${PHONES}: ${sizes}`).toEqual(sizes);
  expect(sizes[0], '360 px').toBeLessThan(11);
  expect(sizes[1], '375 px').toBeLessThan(11);
  expect(sizes.slice(3), '412 and 430 px').toEqual([11, 11]);
});

test.describe('7 on a desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, ...DESKTOP });

  test('7. inside the phone-shaped frame, which is 390 px wide whatever the window is, the tab labels keep 3 px clear in 6A\'s 11 px', async ({ page }) => {
    await open(page, { mini: true });
    await fontsReady(page);
    await showMode(page, 'mini');
    expect(await expectTabsFit(page, 1280)).toBe(11);
  });
});

// ============================================================================================================
// Finding 8: the era labels
// ============================================================================================================

/** Each era button's label in the Era panel: its text, the width of that text, the room inside the button's borders, its size and its lines. */
const eraLabels = (page: Page) =>
  page.locator('#era-panel button[data-era]').evaluateAll((buttons) =>
    buttons.map((b) => {
      const label = b.querySelector(':scope > span') as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(label);
      const text = range.getBoundingClientRect();
      const button = getComputedStyle(b);
      const style = getComputedStyle(label);
      return {
        name: label.textContent ?? '',
        text: text.width,
        room: b.getBoundingClientRect().width - Number.parseFloat(button.borderLeftWidth) - Number.parseFloat(button.borderRightWidth),
        size: Number.parseFloat(style.fontSize),
        lines: Math.round(text.height / Number.parseFloat(style.lineHeight)),
      };
    }),
  );

/** The Era panel on show: all of it, expanded; in mini its tab picks it. Seven buttons. */
async function showEra(page: Page, mode: 'expanded' | 'mini') {
  await showMode(page, mode);
  if (mode === 'mini') await tab(page, 'era').click();
  await expect(page.locator('#era-panel')).toBeVisible();
}

/** Each label on one line and no wider than its button's room, and the size of them all: they share one. */
async function expectErasFit(page: Page, at: string) {
  const labels = await eraLabels(page);
  expect(labels, at).toHaveLength(7);
  for (const l of labels) {
    expect(l.lines, `${at}: ${l.name} takes ${l.lines} lines`).toBe(1);
    expect(l.text, `${at}: ${l.name} is ${l.text.toFixed(2)} px wide in ${l.room.toFixed(2)} px, at ${l.size}px`).toBeLessThanOrEqual(l.room);
  }
  expect(new Set(labels.map((l) => l.size)).size, `${at}: the sizes ${labels.map((l) => l.size)}`).toBe(1);
  return labels[0]!.size;
}

/** What the era labels' type was while it followed the window: (window - 116) / 27.5, from 9 px to 6A's 10.5 px. The phone numbers must not move. */
const BY_THE_WINDOW = (window: number) => Math.min(Math.max((window - 116) / 27.5, 9), 10.5);

test('8. on a phone from 360 to 430 px every era label fits its button, in the expanded panel and in mini\'s Era view, in the size the window gave it', async ({ page }) => {
  await open(page);
  for (const width of PHONES) {
    await page.setViewportSize({ width, height: 844 });
    await fontsReady(page);
    for (const mode of ['expanded', 'mini'] as const) {
      await showEra(page, mode);
      const size = await expectErasFit(page, `${width} px, ${mode}`);
      expect(Math.abs(size - BY_THE_WINDOW(width)), `${width} px, ${mode}: ${size}px, and the window's formula gives ${BY_THE_WINDOW(width)}px`).toBeLessThanOrEqual(0.1);
    }
  }
});

test.describe('8 on a desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, ...DESKTOP });

  test('8. at 1280x800, in the 390 px frame, every era label fits its button, in the expanded panel and in mini\'s Era view, in 6A\'s 10.5 px', async ({ page }) => {
    await open(page);
    await fontsReady(page);
    for (const mode of ['expanded', 'mini'] as const) {
      await showEra(page, mode);
      expect(await expectErasFit(page, `1280 px, ${mode}`), mode).toBe(10.5);
    }
  });

  // The window is 1280 px wide whatever the frame is, so a label sized by the window is 10.5 px in any frame. A frame 370 px wide is what a
  // 390 px phone has (its page padding is 10 px a side): its label is the phone's, 9.96 px, and fits; at 10.5 px it would spill by a px.
  test('8. the era label follows its panel, not the window: in a 1280 px window, frames of 350, 370 and 390 px give the sizes a 370, 390 and 410 px phone has, and fit', async ({ page }) => {
    await open(page);
    await fontsReady(page);
    await showEra(page, 'expanded');
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.id = 'frame-width';
      document.head.append(style);
    });
    const sizes: number[] = [];
    for (const frame of [350, 370, 390]) {
      await page.evaluate((w) => {
        document.getElementById('frame-width')!.textContent = `[aria-label="Karaoke screen"] { width: ${w}px !important; }`;
      }, frame);
      const size = await expectErasFit(page, `a ${frame} px frame`);
      sizes.push(size);
      // A phone's TV is its width less 20 px; its label was sized by that window.
      expect(Math.abs(size - BY_THE_WINDOW(frame + 20)), `a ${frame} px frame: ${size}px, and a ${frame + 20} px phone has ${BY_THE_WINDOW(frame + 20)}px`).toBeLessThanOrEqual(0.1);
    }
    expect(sizes[0]!, 'the narrower frame, the smaller the type').toBeLessThan(sizes[1]!);
    expect(sizes[1]!).toBeLessThan(sizes[2]!);
  });
});
