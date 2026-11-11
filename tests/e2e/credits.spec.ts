// Two small fixes to the credits page and the book icon that opens it, from the third adversarial review of PR #38 (QWW-57):
//   A. "‹ Back" in the credits tab. The Deezer line and the book icon open /credits in a new tab, so reading it keeps the singer's tuning.
//      Its "‹ Back" used to load "/" into that tab: a second app, untuned, while the tuned tab sat hidden behind it. Now a tab of its
//      own (one entry in its history) is closed, a page with earlier pages behind it goes back, and a browser that will not close the
//      tab gets "/" after a moment, as the link always did.
//   B. The book icon's link is a 44 px box at the list's right end, not a band as wide as the list, so only the icon opens the credits.
// The tuner is reached as the other tuner specs reach it (tests/helpers/tunerE2e.ts). tests/screen/credits.test.tsx has A's logic in jsdom,
// with the browser stubbed; here it is the real browser, on the production build.

import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { MockSong } from '../fixtures/setlist';
import { eraButton, handle, open, rows, tuner } from '../helpers/tunerE2e';

// A 390x844 touch phone, like the other tuner specs. Motion is off: the list would never be "stable" for Playwright otherwise.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

/** A song that leads the list under the defaults and has a Deezer preview, so the line that names Deezer (and links to the credits) is under the list. */
const WITH_PREVIEW: MockSong = { title: 'Can Play', artist: 'Has Preview', era: 's90', difficulty: 3, history: 50, popularity: 100, tempo: 50, deezerId: 4242 };

const deezerLine = (page: Page) => page.getByRole('link', { name: /^Previews from Deezer/ });
const bookIcon = (page: Page) => page.getByRole('link', { name: 'Sources and credits', exact: true });
const back = (page: Page) => page.getByRole('link', { name: '‹ Back' });
const hook = (page: Page, patch: object) => page.evaluate((p) => (window as unknown as { setlist: { setState(p: object): void } }).setlist.setState(p), patch);

/** The tuner, tuned: a gear moved and an era picked (the '90s, which the song with the preview is from, so the Deezer line stays under the list). */
async function tune(page: Page) {
  await hook(page, { difficulty: 80, popularity: 35 });
  await eraButton(page, 's90').tap();
  await expect.poll(async () => (await tuner(page)).eras).toEqual(['s90']);
}

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

/** Taps `link` in the tuner and returns the tab it opens, with the credits loaded in it. */
async function openCredits(context: BrowserContext, link: Locator) {
  await link.scrollIntoViewIfNeeded();
  const opened = context.waitForEvent('page');
  await link.tap();
  const tab = await opened;
  await hydrated(tab);
  expect(new URL(tab.url()).pathname).toBe('/credits');
  return tab;
}

// ============================================================================================================
// A. "‹ Back" in the credits tab
// ============================================================================================================

for (const [via, link] of [['the Deezer line', deezerLine], ['the book icon', bookIcon]] as const) {
  test(`A. "‹ Back" in the tab ${via} opened closes that tab: one tab is left, the tuned one, as it was`, async ({ page, context }) => {
    await open(page, { extra: [WITH_PREVIEW] });
    await tune(page);
    const before = await tuner(page);
    expect(before.difficulty).toBe(80);

    const tab = await openCredits(context, link(page));
    // It is a tab of its own, which is what lets a script close it.
    expect(await tab.evaluate(() => history.length)).toBe(1);
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
}

test('A. with pages behind it in the tab, "‹ Back" goes back to them and the tab stays open', async ({ page, context }) => {
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

test('A. a browser that will not close the tab gets the app after a moment, as the link always did', async ({ page, context }) => {
  await open(page, { extra: [WITH_PREVIEW] });
  const tab = await openCredits(context, bookIcon(page));
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

test('A. with no script "‹ Back" is still a link, and it opens the app', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  const tab = await context.newPage();
  await tab.goto('/credits');
  await expect(back(tab)).toHaveAttribute('href', '/');
  await back(tab).click();
  await expect.poll(() => new URL(tab.url()).pathname).toBe('/');
  await context.close();
});

// ============================================================================================================
// B. The book icon's link is the size of its touch target
// ============================================================================================================

const BELOW: [string, MockSong[]][] = [['under the connect note', []], ['under the Deezer line', [WITH_PREVIEW]]];
for (const [below, extra] of BELOW) {
  test(`B. the book icon ${below} is a 44 px box at the list's right end: a tap beside it opens nothing, a tap on it opens the credits`, async ({ page, context }) => {
    await open(page, { extra });
    const link = bookIcon(page);
    const popups: Page[] = [];
    context.on('page', (popup) => popups.push(popup));

    for (const mode of ['expanded', 'mini']) {
      if (mode === 'mini') await handle(page).click();
      await page.locator('#list-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));

      const box = (await link.boundingBox())!;
      const icon = (await link.locator('svg').boundingBox())!;
      const column = (await page.locator('#list-scroll ol').boundingBox())!;
      const scroller = (await page.locator('#list-scroll').boundingBox())!;
      const above = await link.evaluate((el) => el.previousElementSibling!.getBoundingClientRect().bottom);
      const handleTop = (await handle(page).boundingBox())!.y;

      // The size: the touch target and no more, where it was a band as wide as the list (328 px).
      expect(box.width, `${mode}: width`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${mode}: width`).toBeLessThanOrEqual(48);
      expect(box.height, `${mode}: height`).toBeGreaterThanOrEqual(44);
      // Where it is: its right end is the list's, with the icon flush against it and 6 px under what comes before it, as the icon always was.
      expect(Math.abs(box.x + box.width - (column.x + column.width)), `${mode}: the right end`).toBeLessThanOrEqual(1);
      expect(Math.abs(icon.x + icon.width - (box.x + box.width)), `${mode}: the icon at the right end`).toBeLessThanOrEqual(1);
      expect([icon.width, icon.height], `${mode}: the icon`).toEqual([18, 18]);
      expect(Math.abs(icon.y - above - 6), `${mode}: the icon 6 px under what is above`).toBeLessThanOrEqual(1);
      // The list ends where it did: the icon is 24 px (the spacer under the list) above the end of what scrolls.
      expect(Math.abs(scroller.y + scroller.height - (icon.y + icon.height) - 24), `${mode}: the end of the list`).toBeLessThanOrEqual(1);
      // Nothing else is under it: it starts below what is above and ends above the handle's touch area.
      expect(box.y, `${mode}: below what is above`).toBeGreaterThanOrEqual(above - 0.5);
      expect(box.y + box.height, `${mode}: above the handle's reach`).toBeLessThanOrEqual(handleTop);

      // All of the box is the link (a tap on any corner of it is its own), and the space to the left of the icon is not.
      const reaches = (points: number[][]) =>
        page.evaluate((ps) => ps.map(([x, y]) => document.elementFromPoint(x!, y!)?.closest('a')?.getAttribute('aria-label') ?? null), points);
      const right = box.x + box.width - 1;
      const bottom = box.y + box.height - 1;
      expect(await reaches([[box.x + 1, box.y + 1], [right, box.y + 1], [box.x + 1, bottom], [right, bottom]]), `${mode}: the corners`).toEqual(Array(4).fill('Sources and credits'));
      const middle = box.y + box.height / 2;
      const beside = [icon.x - 60, icon.x - 150].map((x) => [x, middle]);
      expect(await reaches(beside), `${mode}: the space beside the icon`).toEqual([null, null]);

      // Real taps: on the space beside the icon, which opened the credits when the link was a band, and then on the icon.
      for (const [x, y] of beside) await page.touchscreen.tap(x!, y!);
      await page.waitForTimeout(500);
      expect(popups, `${mode}: a tap beside the icon opens nothing`).toHaveLength(0);
      expect(new URL(page.url()).pathname).toBe('/');

      const opened = context.waitForEvent('page');
      await page.touchscreen.tap(icon.x + icon.width / 2, icon.y + icon.height / 2);
      const tab = await opened;
      await tab.waitForLoadState();
      expect(new URL(tab.url()).pathname, `${mode}: a tap on the icon`).toBe('/credits');
      await tab.close();
      popups.length = 0;
    }
  });
}
