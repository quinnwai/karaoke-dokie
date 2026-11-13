// Quinn-Wai's signed-in review of #38 (QWW-57, R31, 12 Nov: "Default should be listening history maxed when logged in, that's the purpose of logging in"):
//   R31  Signed in, the tuner opens with History on at 100 ("On repeat"), so the singer's own top and liked songs come first, and the first list request
//        says so. Logged out stays as it was: History is off (and disabled: there is no history). Turning History off with its ✕ puts it back at 100 and
//        off, as every gear's does (R21), and a nudge turns it on again from there.
// The tuner is reached as the other tuner specs reach it (tests/helpers/tunerE2e.ts), with the server's own ranking behind the mocked API
// (tests/helpers/setlistServer.ts, which counts the library, and History with it, only for a signed-in session).

import { expect, test, type Page } from '@playwright/test';
import type { SetlistRequest } from '../../src/lib/contracts';
import { open, pressKey, resetButton, rows, strip, tuner, value } from '../helpers/tunerE2e';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

/** Every POST /api/setlist the page sends, in order: what the screen asked the ranking engine. */
function recordRequests(page: Page): SetlistRequest[] {
  const asked: SetlistRequest[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/setlist') asked.push(r.postDataJSON() as SetlistRequest);
  });
  return asked;
}

/** The reason line of each row on screen, in rank order. */
const reasons = (page: Page) => rows(page).evaluateAll((els) => els.map((el) => el.querySelector('[data-row-why]')?.textContent ?? ''));

test('R31. signed in, the first list request has History on at 100, and the top rows say "On repeat"', async ({ page }) => {
  const asked = recordRequests(page);
  await open(page, { loggedIn: true });
  // The very first question to the engine: History is a target of 100 and not among the parts that are off.
  expect(asked.length).toBeGreaterThan(0);
  expect(asked[0]!.gears.history).toBe(100);
  expect(asked[0]!.off).toEqual(['tempo', 'era']);
  expect(asked[0]!.off).not.toContain('history');
  // The sheet shows it: the gear is on, usable, at "On repeat", with its ✕.
  await expect(strip(page, 'history')).not.toHaveAttribute('data-off', /.*/);
  expect(await value(page, 'history')).toBe(100);
  await expect(resetButton(page, 'history')).toBeVisible();
  expect((await tuner(page)).off).toEqual(['tempo', 'era']);
  // The list is the history's: its top rows say why, "On repeat", the end of the gear History is at.
  const top = (await reasons(page)).slice(0, 3);
  expect(top.some((why) => /On repeat/.test(why)), `the top three reasons: ${top.join(' | ')}`).toBe(true);
});

test('R31. logged out, History is off and cannot be switched on, and the first request says so', async ({ page }) => {
  const asked = recordRequests(page);
  await open(page, { loggedIn: false });
  expect(asked.length).toBeGreaterThan(0);
  expect(asked[0]!.off).toEqual(['history', 'tempo', 'era']);
  await expect(strip(page, 'history')).toHaveAttribute('data-off', 'true');
  await expect(page.locator('#slider-history')).toBeDisabled();
  expect((await tuner(page)).off).toEqual(['history', 'tempo', 'era']);
  // No listening history, so no reason about it either.
  expect((await reasons(page)).filter((why) => /On repeat|Rediscover/.test(why))).toEqual([]);
});

test('R31. signed in, History\'s ✕ turns it off at 100 like every gear\'s (R21), the list stops being the history\'s, and a nudge turns it on again from 100', async ({ page }) => {
  const asked = recordRequests(page);
  await open(page, { loggedIn: true });
  await resetButton(page, 'history').click();
  await expect(strip(page, 'history')).toHaveAttribute('data-off', 'true');
  expect(await value(page, 'history')).toBe(100);
  await expect.poll(() => asked.at(-1)!.off).toEqual(['tempo', 'era', 'history']);
  await pressKey(page, 'history', 'ArrowLeft');
  await expect(strip(page, 'history')).not.toHaveAttribute('data-off', /.*/);
  expect(await value(page, 'history')).toBe(99);
  await expect.poll(() => asked.at(-1)!.off).toEqual(['tempo', 'era']);
});

test('R31. a reload while signed in starts over with History on again, whatever the singer had done to it', async ({ page }) => {
  await open(page, { loggedIn: true });
  await resetButton(page, 'history').click();
  await expect(strip(page, 'history')).toHaveAttribute('data-off', 'true');
  await page.reload();
  await expect(rows(page).first()).toBeVisible();
  await expect(strip(page, 'history')).not.toHaveAttribute('data-off', /.*/);
  expect(await value(page, 'history')).toBe(100);
});
