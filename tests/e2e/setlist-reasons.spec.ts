// Quinn-Wai's review of the whole build (QWW-57, R35, 12 Nov): the row reason "Deep cut" is "Unconventional pick" (he first chose "Wildcard", then this).
//   R35  No row says "Deep cut" or "Wildcard"; the least known songs say "Unconventional pick" (the rule, popularity 35 or less, is as it was); the Popularity
//        gear's end label stays "Deep cuts"; and no reason line is cut off with an ellipsis at 360, 375 or 390 px, beside an Easy, a Medium or a Hard badge,
//        the longest ones included: "In your sweet spot · Unconventional pick" (230 px at 12 px) and the default view's "In your sweet spot · Crowd favourite" (205).
//        The line runs on under the badge, which ends above it, so it has the row's whole width, and on a phone too narrow for that its type tightens a little.
// tests/setlist/rows.test.ts has `whyOf` itself; here is what a browser draws, on real rows made to say those words, in Chromium and, where it is installed, in
// WebKit (the engine of an iPhone; CI installs Chromium only). A screenshot of each row is saved. The tuner is reached as the other tuner specs reach it
// (tests/helpers/tunerE2e.ts).

import { devices, expect, test, webkit, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { SetlistResponse } from '../../src/lib/contracts';
import type { MockSong } from '../fixtures/setlist';
import { open, rows, strip } from '../helpers/tunerE2e';

const SCREENS = path.resolve('test-results/screens');
test.beforeAll(() => mkdirSync(SCREENS, { recursive: true }));

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

const hook = (page: Page, patch: object) => page.evaluate((p) => (window as unknown as { setlist: { setState(p: object): void } }).setlist.setState(p), patch);

/** Three songs nobody sings much and three that everyone does, one of each label: set the Difficulty slider on one, and its row says it is in the sweet spot. */
const SONGS: (MockSong & { badge: string; why: string })[] = [
  { title: 'Quiet Easy', artist: 'Little Heard', era: 's90', difficulty: 3, history: 50, popularity: 1, tempo: 50, badge: 'Easy', why: 'In your sweet spot · Unconventional pick' },
  { title: 'Quiet Mid', artist: 'Little Heard', era: 's90', difficulty: 50, history: 50, popularity: 2, tempo: 50, badge: 'Medium', why: 'In your sweet spot · Unconventional pick' },
  { title: 'Quiet Hard', artist: 'Little Heard', era: 's90', difficulty: 90, history: 50, popularity: 3, tempo: 50, badge: 'Hard', why: 'In your sweet spot · Unconventional pick' },
  { title: 'Loud Easy', artist: 'Everybody', era: 's90', difficulty: 2, history: 50, popularity: 100, tempo: 50, badge: 'Easy', why: 'In your sweet spot · Crowd favourite' },
  { title: 'Loud Mid', artist: 'Everybody', era: 's90', difficulty: 51, history: 50, popularity: 99, tempo: 50, badge: 'Medium', why: 'In your sweet spot · Crowd favourite' },
  { title: 'Loud Hard', artist: 'Everybody', era: 's90', difficulty: 91, history: 50, popularity: 98, tempo: 50, badge: 'Hard', why: 'In your sweet spot · Crowd favourite' },
];
const EXTRA: MockSong[] = SONGS.map(({ badge: _badge, why: _why, ...song }) => song);

test('R35. no row says "Deep cut" or "Wildcard", the least known songs say "Unconventional pick", and the Popularity gear\'s end label is still "Deep cuts"', async ({ page }) => {
  await open(page, { extra: EXTRA });
  const reasons = await page.locator('[data-row-why]').allTextContents();
  expect(reasons.length).toBeGreaterThanOrEqual(25);
  expect(reasons.filter((why) => /Deep cut|Wildcard/.test(why)), 'rows that still say Deep cut or Wildcard').toEqual([]);
  expect(reasons.filter((why) => /Unconventional pick/.test(why)).length, 'rows that say Unconventional pick').toBeGreaterThan(0);
  await expect(strip(page, 'popularity')).toContainText('Deep cuts');
  await expect(strip(page, 'popularity')).toContainText('Pop hits');
});

/**
 * What a row draws for its reason line: whether it is cut (an ellipsis is drawn only when the text is wider than its box), whether it stays inside the row, and
 * how much the text's box and the badge's overlap (they must not meet: the line runs on under the badge, not over it).
 */
const reasonOf = (row: Locator) =>
  row.evaluate(async (li) => {
    await document.fonts.ready;
    const why = li.querySelector<HTMLElement>('[data-row-why]')!;
    const badge = li.querySelector<HTMLElement>('[data-badge]');
    const button = li.querySelector<HTMLElement>('button:not([data-preview])')!.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(why);
    const text = range.getBoundingClientRect();
    const b = badge?.getBoundingClientRect();
    const across = b ? Math.min(text.right, b.right) - Math.max(text.left, b.left) : 0;
    const down = b ? Math.min(text.bottom, b.bottom) - Math.max(text.top, b.top) : 0;
    return {
      text: why.textContent ?? '',
      badge: badge?.textContent ?? null,
      cut: why.scrollWidth > why.clientWidth,
      textRight: text.right,
      rowRight: button.right,
      overlap: across > 0 && down > 0 ? down : 0,
      size: parseFloat(getComputedStyle(why).fontSize),
      rowHeight: li.getBoundingClientRect().height,
    };
  });

/** The whole check, in whichever engine the page is in. */
async function checkReasonLines(page: Page, width: number, engine: string) {
  const asked: SetlistResponse[] = [];
  page.on('response', async (r) => {
    if (r.request().method() !== 'POST' || new URL(r.url()).pathname !== '/api/setlist') return;
    try {
      asked.push((await r.json()) as SetlistResponse);
    } catch {
      // An answer that arrives as the test ends has no body to read any more: nothing here needs it.
    }
  });
  await page.setViewportSize({ width, height: 844 });
  await open(page, { extra: EXTRA });
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  const placeOf = (title: string) => asked[0]!.songs.find((s) => s.match.track.title === title)!.gears.difficulty!;

  // Every reason line of the default list shows whole, whatever the song: no ellipsis anywhere.
  const everyRow = await rows(page).evaluateAll((els) => els.map((li) => (li.querySelector('[data-row-why]') as HTMLElement).scrollWidth > (li.querySelector('[data-row-why]') as HTMLElement).clientWidth));
  expect(everyRow.some(Boolean), `${engine} ${width} px: a reason line in the default list is cut`).toBe(false);

  for (const song of SONGS) {
    // The Difficulty slider on the song's own place, so its row says it is in the sweet spot, with the popularity word after it.
    await hook(page, { difficulty: Math.round(placeOf(song.title)) });
    const row = rows(page).filter({ hasText: song.title });
    await expect(row.locator('[data-row-why]')).toHaveText(song.why);
    await row.scrollIntoViewIfNeeded();
    const at = `${engine} ${width} px, ${song.badge}, "${song.why}"`;
    const m = await reasonOf(row);
    expect(m.badge, at).toBe(song.badge);
    expect(m.text, at).toBe(song.why);
    expect(m.cut, `${at}: the line is cut off`).toBe(false);
    expect(m.textRight, `${at}: the line stays inside the row`).toBeLessThanOrEqual(m.rowRight + 0.5);
    expect(m.overlap, `${at}: the line and the badge do not meet`).toBeLessThanOrEqual(1.5);
    expect(m.size, `${at}: easy to read`).toBeGreaterThanOrEqual(10.5);
    if (width >= 360) expect(m.size, `${at}: the type at 360 px and wider is the 12 px it was`).toBe(12);
    expect(m.rowHeight, `${at}: the row is the 66 px row of any song`).toBe(66);
    await row.screenshot({ path: path.join(SCREENS, `setlist-r35-${engine}-${width}-${song.badge.toLowerCase()}-${song.why.endsWith('pick') ? 'unconventional' : 'crowd'}.png`) });
  }
}

for (const width of [360, 375, 390]) {
  test(`R35. at ${width} px every reason line shows whole, with no ellipsis, beside an Easy, a Medium and a Hard badge, "In your sweet spot · Unconventional pick" and "In your sweet spot · Crowd favourite" included`, async ({ page }) => {
    await checkReasonLines(page, width, 'chromium');
  });
}

test.describe('in WebKit (the engine of an iPhone)', () => {
  test.skip(!existsSync(webkit.executablePath()), 'WebKit is not installed here (CI installs Chromium only)');

  for (const width of [360, 375, 390]) {
    test(`R35. at ${width} px every reason line shows whole, with no ellipsis, beside an Easy, a Medium and a Hard badge`, async ({ baseURL }) => {
      const browser = await webkit.launch();
      try {
        const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width, height: 844 }, baseURL, reducedMotion: 'reduce' });
        await checkReasonLines(await context.newPage(), width, 'webkit');
      } finally {
        await browser.close();
      }
    });
  }
});
