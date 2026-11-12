// Quinn-Wai's review of the whole build (QWW-57, R34, 12 Nov): each gear's ✕ is vertically centred on its title (DIFFICULTY, ERA, ...).
//   R34  For every gear (Difficulty, Popularity, Tempo, History, Era), at 375 and 390 px, the centre of the ✕'s icon box and the centre of the title's
//        text box differ by 1 px or less, and a screenshot per gear is saved. Measured in Chromium and, where it is installed, WebKit (the engine of an
//        iPhone; CI installs Chromium only).
//   The ✕'s touch area (the button's box) is 44 px wide and 20 tall, and it is not centred on the title: it ends 1 px below the title row, where the
//   icon's box ends, and grows up from there, so that none of it is over the fader's hit area (R33, the gate on 828aaca) or, in the Era panel, the
//   '20s button (the second pass of the review of #38, item 7). The icon is in the bottom of it, whole.
// The tuner is reached as the other tuner specs reach it (tests/helpers/tunerE2e.ts).

import { devices, expect, test, webkit, type Page } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { mockApi, open, tab } from '../helpers/tunerE2e';

const SCREENS = path.resolve('test-results/screens');
test.beforeAll(() => mkdirSync(SCREENS, { recursive: true }));

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

const PARTS = ['difficulty', 'popularity', 'tempo', 'history', 'era'] as const;
type Part = (typeof PARTS)[number];

/** Every gear on and an era picked, so every ✕ is drawn (a gear that is off has none). */
const allOn = (page: Page, mini: boolean) =>
  page.evaluate((m) => (window as unknown as { setlist: { setState(p: object): void } }).setlist.setState({ off: [], eras: ['s80'], mini: m }), mini);

/** Where a part's ✕ and title stand, in page pixels: the icon's box, the button's box, the title element's box and the title's text; and what the ✕ must keep clear of. */
const centres = (page: Page, part: Part) =>
  page.evaluate(async (g) => {
    await document.fonts.ready;
    const button = document.querySelector<HTMLElement>(`button[data-reset="${g}"]`)!;
    const title = (g === 'era' ? document.querySelector('#era-label') : document.querySelector(`[data-strip][data-gear="${g}"] label`)) as HTMLElement;
    const mid = (r: DOMRect) => r.y + r.height / 2;
    const text = document.createRange();
    text.selectNodeContents(title);
    const icon = button.querySelector('svg')!.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    // The first thing that ✕ must not reach: the fader's hit area under a gear's, the row of era buttons under Era's.
    const below = g === 'era' ? document.querySelector('button[data-era]') : document.querySelector(`[data-strip][data-gear="${g}"] [data-fader]`);
    return {
      icon: mid(icon),
      iconH: icon.height,
      iconBottom: icon.bottom,
      iconLeft: icon.left,
      iconRight: icon.right,
      iconTop: icon.top,
      button: { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height },
      title: mid(title.getBoundingClientRect()),
      text: mid(text.getBoundingClientRect()),
      belowTop: below ? below.getBoundingClientRect().top : null,
    };
  }, part);

async function expectCentred(page: Page, part: Part, at: string) {
  const c = await centres(page, part);
  expect(c.iconH, `${at}: the ✕ is drawn`).toBe(16);
  expect(Math.abs(c.icon - c.text), `${at}: the ✕'s icon box and the title's text box, centre to centre`).toBeLessThanOrEqual(1);
  expect(Math.abs(c.icon - c.title), `${at}: the ✕'s icon box and the title's own box`).toBeLessThanOrEqual(1);
  // The 44 x 20 touch area has the whole icon in its bottom, ends 1 px below the title row (where the icon ends) and keeps clear of what is under it.
  expect(c.button.width, `${at}: the button is 44 px wide`).toBe(44);
  expect(c.button.height, `${at}: the button is 20 px tall`).toBe(20);
  expect(Math.abs(c.button.bottom - c.iconBottom), `${at}: the button ends where the icon does`).toBeLessThanOrEqual(0.5);
  expect(c.iconTop >= c.button.top - 0.01 && c.iconLeft >= c.button.left - 0.01 && c.iconRight <= c.button.right + 0.01, `${at}: the icon is inside the button`).toBe(true);
  expect(c.belowTop, `${at}: there is something under the ✕`).not.toBeNull();
  expect(c.button.bottom, `${at}: the ✕'s box ends at ${c.button.bottom}, what is under it begins at ${c.belowTop}`).toBeLessThanOrEqual(c.belowTop! + 0.01);
  if (part === 'era') expect(c.belowTop! - c.button.bottom, `${at}: the Era ✕ stops short of the era buttons`).toBeGreaterThanOrEqual(2);
}

for (const width of [375, 390]) {
  test(`R34. at ${width} px every gear's ✕ is vertically centred on its title within 1 px, expanded and in mini, and each gear has a screenshot`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page, { loggedIn: true });
    await allOn(page, false);
    await expect(page.locator('#app')).toHaveAttribute('data-mode', 'expanded');
    for (const part of PARTS) {
      await expectCentred(page, part, `${width} px, expanded, ${part}`);
      const shown = part === 'era' ? page.locator('#era-panel') : page.locator(`[data-strip][data-gear="${part}"]`);
      await shown.screenshot({ path: path.join(SCREENS, `setlist-r34-${part}-${width}.png`) });
    }
    await allOn(page, true);
    await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
    for (const part of PARTS) {
      await tab(page, part).click();
      await expectCentred(page, part, `${width} px, mini, ${part}`);
    }
  });
}

test.describe('in WebKit (the engine of an iPhone)', () => {
  test.skip(!existsSync(webkit.executablePath()), 'WebKit is not installed here (CI installs Chromium only)');

  for (const width of [375, 390]) {
    test(`R34. at ${width} px every gear's ✕ is vertically centred on its title within 1 px`, async ({ baseURL }) => {
      const browser = await webkit.launch();
      try {
        const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width, height: 844 }, baseURL, reducedMotion: 'reduce' });
        await mockApi(context, { loggedIn: true, events: [] });
        const page = await context.newPage();
        await page.goto('/');
        await expect(page.locator('#app [data-row]').first()).toBeVisible({ timeout: 20_000 });
        await allOn(page, false);
        for (const part of PARTS) await expectCentred(page, part, `WebKit, ${width} px, expanded, ${part}`);
      } finally {
        await browser.close();
      }
    });
  }
});
