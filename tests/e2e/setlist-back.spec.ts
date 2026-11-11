// The second adversarial review of PR #38 (QWW-57), items 1 to 3, on the production build, where Next.js owns the History API:
//   1. a song page opened while a re-rank is pending stays open, with the match it was opened with; Back shows the new ranking
//   2. the system Back (a phone's back button or swipe) closes the song page like the page's own ‹ Back, the tuning kept
//   3. the mic and note steps of a redo show "Back to songs" (old range, tuning and list kept), and the system Back does the same;
//      a double tap on the song page's ‹ Back, whose second tap lands on the tuner, ends there
// The tuner is reached the way the other tuner specs reach it (tests/helpers/tunerE2e.ts). tests/screen/songPage.test.tsx has the
// same in jsdom, against the app alone.

import { devices, expect, test, type Browser, type Page } from '@playwright/test';
import { mockPage } from '../fixtures/setlist';
import { centre, eraButton, handle, mockApi, ONLY_80S, open, openButton, resetButton, rows, titles, tuner } from '../helpers/tunerE2e';
import { launchWithMic, writeTone } from './fakeMic';

// A 390x844 touch phone, tall enough for the expanded sheet (a 664 px one opens it in mini). Motion is off: the list would never be "stable" for Playwright otherwise.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

const songTitle = (page: Page, title?: string) => page.getByRole('heading', { level: 2, ...(title ? { name: title } : {}) });
const backToSongs = (page: Page) => page.getByRole('button', { name: 'Back to songs' });
const byTitle = (page: Page, title: string) => rows(page).filter({ hasText: title });
const hook = (page: Page, patch: object) => page.evaluate((p) => (window as unknown as { setlist: { setState(p: object): void } }).setlist.setState(p), patch);
const mode = (page: Page) => page.locator('#app').getAttribute('data-mode');
/** What the singer set and sees: the tuner's state (gears, eras, sheet mode), the range chip, and the list. */
const snapshot = async (page: Page) => ({
  tuner: await tuner(page),
  range: await page.locator('[role="group"][aria-label^="Your range"]').getAttribute('aria-label'),
  titles: await titles(page),
});
/** The singer's tuning: a gear, an era and the sheet's mode. */
async function tune(page: Page) {
  await hook(page, { difficulty: 80, popularity: 35 });
  await eraButton(page, 's80').tap();
  await expect.poll(() => titles(page)).toHaveLength(ONLY_80S.length);
  await handle(page).tap(); // expanded to mini
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
}
const entries = (page: Page) => page.evaluate(() => history.length);

let micBrowser: Browser | null = null;
test.afterAll(async () => {
  await micBrowser?.close();
});

test.describe('2. the browser\'s Back on a song page', () => {
  test('closes the page and the tuner is as the singer left it: gears, eras, sheet mode and list; the address never changes', async ({ page }) => {
    await open(page);
    await tune(page);
    const before = await snapshot(page);
    const length = await entries(page);

    await openButton(rows(page).nth(1)).tap();
    await expect(songTitle(page)).toBeVisible();
    expect(await entries(page)).toBe(length + 1);
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/');

    await page.goBack();
    await expect(page.locator('#sheet')).toBeVisible();
    await expect(songTitle(page)).toHaveCount(0);
    expect(await snapshot(page)).toEqual(before);
    expect(await mode(page)).toBe('mini');
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('is one entry: the Back after it leaves the page, as it did before the page pushed anything', async ({ page }) => {
    await open(page);
    await openButton(rows(page).first()).tap();
    await expect(songTitle(page)).toBeVisible();
    await page.goBack();
    await expect(page.locator('#sheet')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/'); // still the app, one entry back
    await page.goBack(); // the page the test came from
    expect(page.url()).toBe('about:blank');
  });

  test('the page\'s own ‹ Back takes the entry off the stack too, so one Back press leaves the page', async ({ page }) => {
    await open(page);
    const length = await entries(page);
    await openButton(rows(page).first()).tap();
    await expect(songTitle(page)).toBeVisible();
    await backToSongs(page).tap();
    await expect(page.locator('#sheet')).toBeVisible();
    // The entry is taken off by a history.back() of the page's own, which is asynchronous: wait for it.
    await expect.poll(() => page.evaluate(() => (history.state as { kdOverlay?: string } | null)?.kdOverlay ?? null)).toBeNull();
    expect(await entries(page)).toBe(length + 1); // History.length counts the entry ahead, not the current one
    await page.goBack();
    expect(page.url()).toBe('about:blank');
  });

  test('does it again for each song opened, with the tuning kept through all of them', async ({ page }) => {
    await open(page);
    await tune(page);
    const before = await snapshot(page);
    for (const i of [0, 2, 1]) {
      await openButton(rows(page).nth(i)).tap();
      await expect(songTitle(page)).toBeVisible();
      await page.goBack();
      await expect(page.locator('#sheet')).toBeVisible();
      expect(await snapshot(page)).toEqual(before);
    }
  });
});

test.describe('3. "Back to songs" on the mic and note steps of a redo', () => {
  test('a double tap on the song page\'s ‹ Back ends on a step with "Back to songs", which returns to the tuner as it was', async ({ page }) => {
    await open(page);
    await tune(page);
    const before = await snapshot(page);

    await openButton(rows(page).nth(1)).tap();
    await expect(songTitle(page)).toBeVisible();
    // Two taps 250 ms apart on the ‹. The first closes the page; the second lands on whatever the tuner has under the ‹.
    const at = await centre(backToSongs(page));
    await page.touchscreen.tap(at.x, at.y);
    await page.waitForTimeout(250);
    await page.touchscreen.tap(at.x, at.y);
    // It left the tuner: the second tap started a redo (the mic step, after the quiet one if the whole test was asked for).
    await expect(page.locator('#sheet')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Turn on microphone' })).toBeVisible({ timeout: 10_000 });
    await expect(backToSongs(page)).toBeVisible();

    await backToSongs(page).tap();
    await expect(page.locator('#sheet')).toBeVisible();
    await expect.poll(() => snapshot(page)).toEqual(before);
    // And that left nothing on the history stack: one Back leaves the page.
    await expect.poll(() => page.evaluate(() => (history.state as { kdOverlay?: string } | null)?.kdOverlay ?? null)).toBeNull();
    await page.goBack();
    expect(page.url()).toBe('about:blank');
  });

  test('one end of the range: the mic step has it, and so does the system Back', async ({ page }) => {
    await open(page);
    await tune(page);
    const before = await snapshot(page);

    for (const how of ['button', 'system'] as const) {
      await page.getByRole('button', { name: /^Redo your low note/ }).tap();
      await expect(page.getByRole('button', { name: 'Turn on microphone' })).toBeVisible();
      await expect(backToSongs(page)).toBeVisible();
      if (how === 'button') await backToSongs(page).tap();
      else await page.goBack();
      await expect(page.locator('#sheet')).toBeVisible();
      await expect.poll(() => snapshot(page)).toEqual(before);
    }
  });

  test('the whole test: the steps have it, the list loads again, and the first test has none', async ({ page }) => {
    await open(page);
    await tune(page);
    const before = await snapshot(page);
    await page.getByRole('button', { name: 'Redo the singing test' }).tap();
    await expect(page.getByRole('button', { name: 'Turn on microphone' })).toBeVisible({ timeout: 10_000 });
    await backToSongs(page).tap();
    await expect(rows(page).first()).toBeVisible();
    await expect.poll(() => snapshot(page)).toEqual(before);
  });

  test('is on the note step too, in the corner and clear of the step\'s own text', async ({ baseURL }) => {
    test.setTimeout(90_000);
    // A microphone that hears a tone, and says yes to its own question: the note step is one tap on "Turn on microphone" away.
    micBrowser ??= await launchWithMic(writeTone(`back-220-${test.info().workerIndex}.wav`, 220)); // a file per worker: a repeat run has several
    const context = await micBrowser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, baseURL, reducedMotion: 'reduce' });
    await mockApi(context, { loggedIn: false, events: [] });
    await context.addInitScript(() => localStorage.setItem('kd.range', JSON.stringify({ low: 45, high: 72 })));
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('#app [data-row]').first()).toBeVisible({ timeout: 20_000 });
    const before = await snapshot(page);

    await page.getByRole('button', { name: /^Redo your low note/ }).tap();
    await page.getByRole('button', { name: 'Turn on microphone', exact: true }).tap();
    await expect(page.getByRole('button', { name: 'Hold to record your lowest note' })).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1300); // the step's lyric sings in
    const back = (await backToSongs(page).boundingBox())!;
    expect(back.x).toBeGreaterThanOrEqual(0);
    expect(back.y).toBeGreaterThanOrEqual(0);
    expect(back.height).toBeGreaterThanOrEqual(44);
    // Clear of the step's own words: the lyric starts below it.
    const lyric = (await page.locator('[data-lyric]').first().boundingBox())!;
    expect(lyric.y).toBeGreaterThanOrEqual(back.y + back.height - 1);
    await backToSongs(page).tap();
    await expect(page.locator('#sheet')).toBeVisible();
    await expect.poll(() => snapshot(page)).toEqual(before);
    await context.close();
  });
});

test.describe('1. a song page opened while a re-rank is pending', () => {
  test('stays open with the song the singer tapped, though the new list leaves it out; Back shows the new list; nothing opens without a tap', async ({ page }) => {
    const X = 'Dancing Queen'; // a '70s song: picking the 80s takes it out of the list
    const catalogue = mockPage({ idPrefix: 'cat:' });
    // The screen's own list lacks it, as a big library or the whole catalogue does: only the ranking holds it. So once the ranking
    // moves on, nothing can find it.
    await page.route('**/api/catalogue/recommendations*', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...catalogue, matches: catalogue.matches.filter((m) => m.track.title !== X) }) }),
    );
    // The second ranking request, the re-rank, is held until the test lets it go (every other goes straight to the mocked API).
    let asked = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reRankAsked!: () => void;
    const reRank = new Promise<void>((resolve) => (reRankAsked = resolve));
    await page.route('**/api/setlist', async (route) => {
      if (++asked === 2) {
        reRankAsked();
        await gate;
      }
      await route.fallback();
    });
    await open(page);
    expect(await titles(page)).toContain(X);

    await eraButton(page, 's80').tap(); // the re-rank
    await reRank; // asked, not answered
    await openButton(byTitle(page, X)).tap(); // tapped in the list the singer was looking at
    await expect(songTitle(page, X)).toBeVisible();

    release(); // the answer lands: the 80s, without Dancing Queen
    await page.waitForTimeout(600);
    await expect(songTitle(page, X)).toBeVisible();
    await expect(page.locator('#sheet')).toHaveCount(0);

    await page.goBack(); // the system Back shows the new ranking
    await expect(page.locator('#sheet')).toBeVisible();
    await expect(songTitle(page)).toHaveCount(0);
    await expect.poll(() => titles(page)).toEqual(ONLY_80S);

    // A later list that has the song again opens nothing. (Era off again: every song is back.)
    await resetButton(page, 'era').tap();
    await expect.poll(() => titles(page)).toContain(X);
    await page.waitForTimeout(300);
    await expect(songTitle(page)).toHaveCount(0);
    await expect(page.locator('#sheet')).toBeVisible();
  });
});
