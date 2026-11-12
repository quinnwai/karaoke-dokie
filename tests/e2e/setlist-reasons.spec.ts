// Quinn-Wai's review of the whole build (QWW-57, R35, 12 Nov): the row reason "Deep cut" is "Wildcard".
//   R35  No row says "Deep cut" any more; the least known songs say "Wildcard" (the rule, popularity 35 or less, is as it was); the Popularity gear's end
//        label stays "Deep cuts"; and the longest reason lines, "In your sweet spot · Wildcard" among them, fit a row at 360 px without being cut off.
// tests/setlist/rows.test.ts has `whyOf` itself; here is what a browser draws. The tuner is reached as the other tuner specs reach it (tests/helpers/tunerE2e.ts).

import { expect, test } from '@playwright/test';
import type { MockSong } from '../fixtures/setlist';
import { open, strip } from '../helpers/tunerE2e';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

/** A song nobody sings much, so it is among the least popular: its reason is the new word. */
const WILD: MockSong = { title: 'Quiet One', artist: 'Little Heard', era: 's90', difficulty: 3, history: 50, popularity: 1, tempo: 50 };

test('R35. no row says "Deep cut", the least known songs say "Wildcard", and the Popularity gear\'s end label is still "Deep cuts"', async ({ page }) => {
  await open(page, { extra: [WILD] });
  const reasons = await page.locator('[data-row-why]').allTextContents();
  expect(reasons.length).toBeGreaterThanOrEqual(25);
  expect(reasons.filter((why) => /Deep cut/.test(why)), 'rows that still say Deep cut').toEqual([]);
  expect(reasons.filter((why) => /Wildcard/.test(why)).length, 'rows that say Wildcard').toBeGreaterThan(0);
  const quiet = page.locator('[data-row]', { hasText: 'Quiet One' }).locator('[data-row-why]');
  await expect(quiet).toContainText('Wildcard');
  // The gear's own end label is a different thing, and stays.
  await expect(strip(page, 'popularity')).toContainText('Deep cuts');
  await expect(strip(page, 'popularity')).toContainText('Pop hits');
});

/**
 * Every reason line that has "Wildcard" in it. (Not "In your sweet spot · Crowd favourite": it is the one reason line that is wider than these, 205 px, and an
 * ellipsis cuts it at 360 px beside any badge and at 375 px beside Medium. That is as it was before R35, which renames nothing in it, and is on the ticket.)
 */
const LINES = ['Wildcard', 'In your sweet spot · Wildcard', 'Wildcard · Rediscover'];

for (const width of [360, 375, 390]) {
  test(`R35. at ${width} px "In your sweet spot · Wildcard" and the other long reason lines fit their row whole, beside an Easy, a Medium and a Hard badge`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page);
    // The reason line of the first row of each badge, given each line in turn (the badge is the widest part beside it, so Medium leaves the least room).
    const measured = await page.evaluate(async (lines) => {
      await document.fonts.ready;
      const firstOf = new Map<string, HTMLElement>();
      for (const row of document.querySelectorAll('[data-row]')) {
        const badge = row.querySelector('[data-badge]')?.textContent ?? '';
        if (!firstOf.has(badge)) firstOf.set(badge, row.querySelector<HTMLElement>('[data-row-why]')!);
      }
      const out: { badge: string; line: string; scroll: number; client: number; height: number; base: number }[] = [];
      for (const badge of ['Easy', 'Medium', 'Hard']) {
        const why = firstOf.get(badge);
        if (!why) continue;
        const kept = why.textContent ?? '';
        why.textContent = 'x';
        const base = why.getBoundingClientRect().height;
        for (const line of lines) {
          why.textContent = line;
          out.push({ badge, line, scroll: why.scrollWidth, client: why.clientWidth, height: why.getBoundingClientRect().height, base });
        }
        why.textContent = kept;
      }
      return out;
    }, LINES);
    expect([...new Set(measured.map((m) => m.badge))].sort()).toEqual(['Easy', 'Hard', 'Medium']);
    expect(measured).toHaveLength(3 * LINES.length);
    for (const m of measured) {
      expect(m.scroll, `"${m.line}" beside ${m.badge}: the line is not wider than its box`).toBeLessThanOrEqual(m.client);
      expect(m.height, `"${m.line}" beside ${m.badge}: still one line`).toBe(m.base);
    }
  });
}
