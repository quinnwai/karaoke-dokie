// The second adversarial review of PR #38 (QWW-57), items 1 to 3, on the production build, where Next.js owns the History API:
//   1. a song page opened while a re-rank is pending stays open, with the match it was opened with; Back shows the new ranking
//   2. the system Back (a phone's back button or swipe) closes the song page like the page's own ‹ Back, the tuning kept
//   3. the mic and note steps of a redo show "Back to songs" (old range, tuning and list kept), and the system Back does the same
// and of the final pass on d623eda:
//   a. a double tap lands once: the second tap, on the screen the first one brought up, is ignored for a moment (400 ms), for the song
//      page's ‹ (the tuner's low note is under it), a range note ("Back to songs" is under it) and "Back to songs" (redo is under it)
//   b. "That's your range" after a redo (no Spotify) answers the system Back and "Back to songs": the old range and the tuning come back
//   c. closing a song page puts the focus on the row that opened it, at its place in the list now
//   d. a reload in the middle of a one-note redo comes back to the songs, not to a first test
// and of the fourth pass on 828aaca:
//   e. a run of quick taps never gets through: a tap the guard ignores puts the guard off by another 400 ms (three or four taps on ‹ started a redo)
//      (the double tap on a row, and where ‹ puts the list, are tests/e2e/setlist-row-tap.spec.ts's)
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
/** KaraokeApp's TAP_GUARD_MS: a tap this soon after another one changed the screen is the second of a double tap. */
const GUARD = 400;
const pastTheGuard = (page: Page) => page.waitForTimeout(GUARD + 150);
/** The button a tap at a point would reach in the page right now: its name, or its words. */
const reaches = (page: Page, at: { x: number; y: number }) =>
  page.evaluate(({ x, y }) => {
    const button = document.elementFromPoint(x, y)?.closest('button');
    return button?.getAttribute('aria-label') ?? button?.textContent ?? null;
  }, at);
const tap = (page: Page, at: { x: number; y: number }) => page.touchscreen.tap(at.x, at.y);
const stateOf = (page: Page) => page.evaluate(() => (history.state as { kdOverlay?: string } | null)?.kdOverlay ?? null);

let micBrowser: Browser | null = null;
test.afterAll(async () => {
  await micBrowser?.close();
});

/**
 * A phone with a microphone that hears an A3 (220 Hz, which a sung note is read as), and says yes to its own question, for a singer without
 * Spotify who kept A2 to C5 on the device. The tuner is up when it returns.
 */
async function micPhone(baseURL: string | undefined) {
  micBrowser ??= await launchWithMic(writeTone(`back-220-${test.info().workerIndex}.wav`, 220)); // a file per worker: a repeat run has several
  const context = await micBrowser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, baseURL, reducedMotion: 'reduce' });
  await mockApi(context, { loggedIn: false, events: [] });
  await context.addInitScript(() => {
    // Only on the first load of the page: a reload must find what the page itself left (a redo's progress, a range that was kept).
    if (!sessionStorage.getItem('kd.seeded')) {
      sessionStorage.setItem('kd.seeded', '1');
      localStorage.setItem('kd.range', JSON.stringify({ low: 45, high: 72 }));
    }
  });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('#app [data-row]').first()).toBeVisible({ timeout: 20_000 });
  return { context, page };
}
/** Holds the note button until the microphone has heard the tone, then lets go. */
async function sing(page: Page, button: ReturnType<Page['getByRole']>, note: string) {
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId('live-pitch')).toHaveText(note, { timeout: 3000 });
  await page.waitForTimeout(800);
  await page.mouse.up();
}

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
  test('one end of the range: the mic step has it, and so does the system Back', async ({ page }) => {
    await open(page);
    await tune(page);
    const before = await snapshot(page);

    for (const how of ['button', 'system'] as const) {
      await page.getByRole('button', { name: /^Redo your low note/ }).tap();
      await expect(page.getByRole('button', { name: 'Turn on microphone' })).toBeVisible();
      await expect(backToSongs(page)).toBeVisible();
      if (how === 'button') {
        await pastTheGuard(page); // a tap that is meant comes after the moment a double tap's second one would
        await backToSongs(page).tap();
      } else await page.goBack();
      await expect(page.locator('#sheet')).toBeVisible();
      await expect.poll(() => snapshot(page)).toEqual(before);
      await pastTheGuard(page); // the next tap on a range note is a choice, not a double tap's second
    }
  });

  test('the whole test: the steps have it, the list loads again, and the first test has none', async ({ page }) => {
    await open(page);
    await tune(page);
    const before = await snapshot(page);
    await page.getByRole('button', { name: 'Redo the range test' }).tap();
    await expect(page.getByRole('button', { name: 'Turn on microphone' })).toBeVisible({ timeout: 10_000 });
    await backToSongs(page).tap();
    await expect(rows(page).first()).toBeVisible();
    await expect.poll(() => snapshot(page)).toEqual(before);
  });

  test('is on the note step too, in the corner and clear of the step\'s own text', async ({ baseURL }) => {
    test.setTimeout(90_000);
    const { context, page } = await micPhone(baseURL);
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

test.describe('a. a double tap lands once', () => {
  // Milliseconds between the two taps. 300 and Playwright's own overhead stay inside the 400 ms moment.
  const GAPS = [60, 250, 300];

  test('the geometry that makes it a hazard: a redo control is under the song page’s ‹, "Back to songs" under the low note, and redo again under "Back to songs"', async ({ page }) => {
    await open(page);
    await openButton(rows(page).nth(1)).tap();
    const dot = await centre(backToSongs(page));
    await page.goBack();
    await expect(page.locator('#sheet')).toBeVisible();
    expect(await reaches(page, dot), 'under the ‹').toMatch(/^Redo /);

    const note = page.getByRole('button', { name: /^Redo your low note/ });
    const noteAt = await centre(note);
    await note.tap();
    await expect(backToSongs(page)).toBeVisible();
    expect(await reaches(page, noteAt), 'under the low note').toContain('Back to songs');

    const backAt = await centre(backToSongs(page));
    await pastTheGuard(page);
    await backToSongs(page).tap();
    await expect(page.locator('#sheet')).toBeVisible();
    expect(await reaches(page, backAt), 'under "Back to songs"').toMatch(/^Redo /);
  });

  for (const gap of GAPS) {
    test(`‹ on a song page, then the same spot ${gap} ms later: the tuner, not a redo started under it; a tap after the moment works`, async ({ page }) => {
      await open(page);
      await tune(page);
      const before = await snapshot(page);
      await openButton(rows(page).nth(1)).tap();
      await expect(songTitle(page)).toBeVisible();
      const at = await centre(backToSongs(page));
      await tap(page, at); // the first: the page closes
      await page.waitForTimeout(gap);
      await tap(page, at); // the second: on what the tuner has under the ‹
      await page.waitForTimeout(200); // anything it started has started
      await expect(page.locator('#sheet')).toBeVisible();
      await expect(page.getByRole('button', { name: /Turn on microphone|Find a quiet spot/ })).toHaveCount(0);
      expect(await snapshot(page)).toEqual(before);
      await expect.poll(() => stateOf(page)).toBeNull();

      await pastTheGuard(page);
      await page.getByRole('button', { name: /^Redo your low note/ }).tap(); // after the moment it is a choice
      await expect(page.getByRole('button', { name: 'Turn on microphone' })).toBeVisible();
    });

    test(`a range note, then the same spot ${gap} ms later: the mic step, not a redo cancelled at once; a tap after the moment works`, async ({ page }) => {
      await open(page);
      await tune(page);
      const before = await snapshot(page);
      const at = await centre(page.getByRole('button', { name: /^Redo your low note/ }));
      await tap(page, at); // the first: the mic step comes up
      await page.waitForTimeout(gap);
      await tap(page, at); // the second: on "Back to songs"
      await page.waitForTimeout(200);
      await expect(page.getByRole('button', { name: 'Turn on microphone' })).toBeVisible();
      await expect(page.locator('#sheet')).toHaveCount(0);
      expect(await stateOf(page)).toBe('redo');

      await pastTheGuard(page);
      await backToSongs(page).tap();
      await expect(page.locator('#sheet')).toBeVisible();
      await expect.poll(() => snapshot(page)).toEqual(before);
    });

    test(`"Back to songs", then the same spot ${gap} ms later: the tuner, not the whole test started again; a tap after the moment works`, async ({ page }) => {
      await open(page);
      await tune(page);
      const before = await snapshot(page);
      await page.getByRole('button', { name: /^Redo your low note/ }).tap();
      await expect(backToSongs(page)).toBeVisible();
      await pastTheGuard(page);
      const at = await centre(backToSongs(page));
      await tap(page, at); // the first: back to the list
      await page.waitForTimeout(gap);
      await tap(page, at); // the second: on redo
      await page.waitForTimeout(200);
      await expect(page.locator('#sheet')).toBeVisible();
      await expect(page.getByRole('button', { name: /Find a quiet spot|Turn on microphone/ })).toHaveCount(0);
      expect(await snapshot(page), 'the list was not emptied and fetched again').toEqual(before);

      await pastTheGuard(page);
      await page.getByRole('button', { name: 'Redo the range test' }).tap(); // after the moment it is a choice
      await expect(page.getByRole('button', { name: /Find a quiet spot/ })).toBeVisible();
    });
  }

  /** Between a finger's taps in a run of them: three of these are more than the moment, so the fourth tap is more than a moment after the first. */
  const EVERY = 150;

  test('‹ four times, 150 ms apart: the list is showing and no redo has started; a tap on the low note after the moment starts one', async ({ page }) => {
    await open(page);
    await tune(page);
    const before = await snapshot(page);
    await openButton(rows(page).nth(1)).tap();
    await expect(songTitle(page)).toBeVisible();
    const at = await centre(backToSongs(page));
    const taps: number[] = [];
    for (let i = 0; i < 4; i++) {
      if (i > 0) await page.waitForTimeout(EVERY);
      await tap(page, at); // the first closes the page; the rest land on the tuner's low note, which is under the ‹
      taps.push(Date.now());
    }
    expect(taps[3]! - taps[0]!, 'the fourth tap is more than a moment after the first: the first moment alone would not cover it').toBeGreaterThan(GUARD);
    await page.waitForTimeout(200); // anything it started has started
    await expect(page.locator('#sheet')).toBeVisible();
    await expect(page.getByRole('button', { name: /Turn on microphone|Find a quiet spot/ })).toHaveCount(0);
    expect(await snapshot(page)).toEqual(before);
    await expect.poll(() => stateOf(page)).toBeNull();

    await pastTheGuard(page);
    await page.getByRole('button', { name: /^Redo your low note/ }).tap(); // after the moment it is a choice
    await expect(page.getByRole('button', { name: 'Turn on microphone' })).toBeVisible();
  });

  test('a range note, then "Back to songs" three times 150 ms apart: the redo is still there; a tap after the moment leaves it', async ({ page }) => {
    await open(page);
    await tune(page);
    const before = await snapshot(page);
    const note = await centre(page.getByRole('button', { name: /^Redo your low note/ }));
    const taps: number[] = [];
    await tap(page, note); // the first: the mic step comes up, with "Back to songs" under the finger
    taps.push(Date.now());
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(EVERY);
      await tap(page, note);
      taps.push(Date.now());
    }
    expect(taps[3]! - taps[0]!, 'the last tap is more than a moment after the first').toBeGreaterThan(GUARD);
    await page.waitForTimeout(200);
    await expect(page.getByRole('button', { name: 'Turn on microphone' })).toBeVisible();
    await expect(page.locator('#sheet')).toHaveCount(0);
    expect(await stateOf(page)).toBe('redo');

    await pastTheGuard(page);
    await backToSongs(page).tap();
    await expect(page.locator('#sheet')).toBeVisible();
    await expect.poll(() => snapshot(page)).toEqual(before);
  });
});

test.describe('b. "That’s your range" after a redo, for a singer without Spotify', () => {
  /** Redoes the low note, sings an A3 and lands on "That's your range" (A3 to C5). */
  async function redoToTheResult(page: Page) {
    await page.getByRole('button', { name: /^Redo your low note/ }).tap();
    await page.getByRole('button', { name: 'Turn on microphone', exact: true }).tap();
    const hold = page.getByRole('button', { name: 'Hold to record your lowest note' });
    await expect(hold).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1300); // the step's lyric sings in
    await sing(page, hold, 'A3');
    await expect(page.getByTestId('range-low')).toHaveText('A3', { timeout: 5000 });
    await expect(page.getByTestId('range-high')).toHaveText('C5');
  }
  const kept = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('kd.range') ?? 'null') as { low: number; high: number } | null);

  test('the system Back brings back the songs: the old range, the tuning and the list; the new range is not kept', async ({ baseURL }) => {
    test.setTimeout(90_000);
    const { context, page } = await micPhone(baseURL);
    await tune(page);
    const before = await snapshot(page);
    await redoToTheResult(page);
    expect(await stateOf(page), 'the redo’s history entry is still there').toBe('redo');

    await page.goBack();
    await expect(page.locator('#sheet')).toBeVisible();
    await expect.poll(() => snapshot(page)).toEqual(before);
    expect(await kept(page)).toMatchObject({ low: 45, high: 72 });
    expect(await page.evaluate(() => sessionStorage.getItem('kd.test'))).toBeNull();
    expect(await stateOf(page)).toBeNull();
    await context.close();
  });

  test('"Back to songs" there does the same', async ({ baseURL }) => {
    test.setTimeout(90_000);
    const { context, page } = await micPhone(baseURL);
    await tune(page);
    const before = await snapshot(page);
    await redoToTheResult(page);
    await expect(backToSongs(page)).toBeVisible();
    await backToSongs(page).tap();
    await expect(page.locator('#sheet')).toBeVisible();
    await expect.poll(() => snapshot(page)).toEqual(before);
    expect(await kept(page)).toMatchObject({ low: 45, high: 72 });
    await expect.poll(() => stateOf(page)).toBeNull();
    await page.goBack();
    expect(page.url(), 'one Back left leaves the page').toBe('about:blank');
    await context.close();
  });

  test('Continue keeps the new range, as ever, and the redo’s entry goes with it', async ({ baseURL }) => {
    test.setTimeout(90_000);
    const { context, page } = await micPhone(baseURL);
    await redoToTheResult(page);
    await page.getByRole('button', { name: 'Continue' }).tap();
    await expect(page.locator('#sheet')).toBeVisible();
    await expect(page.locator('[role="group"][aria-label^="Your range"]')).toHaveAttribute('aria-label', 'Your range A3 to C5');
    expect(await kept(page)).toMatchObject({ low: 57, high: 72 });
    await expect.poll(() => stateOf(page)).toBeNull();
    await expect(backToSongs(page)).toHaveCount(0);
    await context.close();
  });
});

test.describe('c. closing a song page puts the focus back on its row', () => {
  const active = (page: Page) =>
    page.evaluate(() => {
      const a = document.activeElement;
      return { label: a?.getAttribute('aria-label') ?? null, rank: a?.closest('[data-row]')?.getAttribute('data-rank') ?? null, body: a === document.body };
    });

  test('‹ Back by the keyboard: the row that opened the page has the focus, not the top of the page', async ({ page }) => {
    await open(page);
    const button = openButton(rows(page).nth(3));
    const label = await button.getAttribute('aria-label');
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(songTitle(page)).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(backToSongs(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#sheet')).toBeVisible();
    await expect.poll(() => active(page)).toMatchObject({ label, rank: '4' });
  });

  test('a tap on ‹ Back, and the system Back, do the same: the focus is the row’s whoever closes the page', async ({ page }) => {
    await open(page);
    for (const how of ['tap', 'system'] as const) {
      const button = openButton(rows(page).nth(2));
      const label = await button.getAttribute('aria-label');
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(songTitle(page)).toBeVisible();
      if (how === 'tap') await backToSongs(page).tap();
      else await page.goBack();
      await expect(page.locator('#sheet')).toBeVisible();
      await expect.poll(() => active(page), how).toMatchObject({ label, rank: '3' });
      await pastTheGuard(page);
    }
  });

  test('at the row’s new place when a re-rank moved it while the page was open', async ({ page }) => {
    // The second ranking request, the re-rank, is held until the test lets it go.
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
    const first = openButton(rows(page).first());
    const label = await first.getAttribute('aria-label');
    expect(await rows(page).first().getAttribute('data-rank')).toBe('1');

    await hook(page, { difficulty: 95 }); // the re-rank
    await reRank;
    await first.focus();
    await page.keyboard.press('Enter'); // opened in the list the singer was looking at
    await expect(songTitle(page)).toBeVisible();
    release();
    await page.waitForTimeout(600);
    await expect(songTitle(page)).toBeVisible();

    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.locator('#sheet')).toBeVisible();
    const now = await active(page);
    expect(now.label, 'the same song’s button').toBe(label);
    expect(now.rank, 'at its place in the new ranking: the song moved, and the focus with it').not.toBe('1');
    expect(now.body).toBe(false);
  });
});

test('d. a reload in the middle of a one-note redo comes back to the songs with the old range, not to a first test with no way back', async ({ baseURL }) => {
  test.setTimeout(90_000);
  const { context, page } = await micPhone(baseURL);
  await page.getByRole('button', { name: /^Redo your high note/ }).tap();
  await page.getByRole('button', { name: 'Turn on microphone', exact: true }).tap();
  await expect(page.getByRole('button', { name: 'Hold to record your highest note' })).toBeVisible({ timeout: 10_000 });
  // The test's progress is kept for a Spotify round trip: the low end of the range, with the high note still to sing.
  expect(await page.evaluate(() => sessionStorage.getItem('kd.test'))).not.toBeNull();

  await page.reload();
  await expect(page.locator('#app [data-row]').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[role="group"][aria-label^="Your range"]')).toHaveAttribute('aria-label', 'Your range A2 to C5');
  await expect(page.getByRole('button', { name: /Turn on microphone|Hold to record/ })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('kd.test')), 'the half-finished test is dropped').toBeNull();
  await context.close();
});
