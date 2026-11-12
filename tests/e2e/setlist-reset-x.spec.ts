// Quinn-Wai's review of the whole build (QWW-57, R34, 12 Nov): each gear's ✕ is vertically centred on its title (DIFFICULTY, ERA, ...).
//   R34  For every gear (Difficulty, Popularity, Tempo, History, Era), at 375 and 390 px, the centre of the ✕'s icon box and the centre of the title's
//        text box differ by 1 px or less. The button's own box (what its focus ring and the highlight of a tap are drawn on) is centred on the title too,
//        and a screenshot per gear is saved. Measured in Chromium and, where it is installed, WebKit (the engine of an iPhone; CI installs Chromium only).
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

/** Where a part's ✕ and title stand, in page pixels: the icon's box, the button's box, the title element's box and the title's text. */
const centres = (page: Page, part: Part) =>
  page.evaluate(async (g) => {
    await document.fonts.ready;
    const button = document.querySelector<HTMLElement>(`button[data-reset="${g}"]`)!;
    const title = (g === 'era' ? document.querySelector('#era-label') : document.querySelector(`[data-strip][data-gear="${g}"] label`)) as HTMLElement;
    const mid = (r: DOMRect) => r.y + r.height / 2;
    const text = document.createRange();
    text.selectNodeContents(title);
    const icon = button.querySelector('svg')!.getBoundingClientRect();
    return { icon: mid(icon), iconH: icon.height, button: mid(button.getBoundingClientRect()), buttonH: button.getBoundingClientRect().height, title: mid(title.getBoundingClientRect()), text: mid(text.getBoundingClientRect()) };
  }, part);

async function expectCentred(page: Page, part: Part, at: string) {
  const c = await centres(page, part);
  expect(c.iconH, `${at}: the ✕ is drawn`).toBe(16);
  expect(Math.abs(c.icon - c.text), `${at}: the ✕'s icon box and the title's text box, centre to centre`).toBeLessThanOrEqual(1);
  expect(Math.abs(c.icon - c.title), `${at}: the ✕'s icon box and the title's own box`).toBeLessThanOrEqual(1);
  // The 44 x 26 button is centred on the title as well: its focus ring and the highlight of a tap are not off to one side of the ✕.
  expect(c.buttonH, `${at}: the button is 26 px tall`).toBe(26);
  expect(Math.abs(c.button - c.title), `${at}: the button's box and the title's own box`).toBeLessThanOrEqual(1);
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
