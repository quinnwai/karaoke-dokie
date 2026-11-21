import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/** Saved before the first script runs, as the signed-out screen keeps it: a range that skips the microphone. */
export const SEEDED_RANGE = { low: 41, high: 72 };

export const SCREENS = path.resolve('test-results/live-screens');

/**
 * Wires a page for the live suite:
 * - the bypass secret goes to the preview's origin only (never to Deezer or anyone else);
 * - the event log and PostHog are answered here, so a run writes nothing to the database the preview reads (production's
 *   until the Neon-branch ticket lands). Nothing else in the signed-out flow writes.
 */
export async function wire(page: Page, baseURL: string) {
  const origin = new URL(baseURL).origin;
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  await page.context().route(
    (url) => url.origin === origin,
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/events') || url.pathname.startsWith('/roadie')) return route.fulfill({ status: 204, body: '' });
      const headers = secret ? { ...route.request().headers(), 'x-vercel-protection-bypass': secret } : route.request().headers();
      return route.continue({ headers });
    },
  );
}

export async function openSeeded(page: Page, baseURL: string, range = SEEDED_RANGE) {
  await wire(page, baseURL);
  await page.context().addInitScript((saved) => localStorage.setItem('kd.range', JSON.stringify(saved)), range);
  await page.goto('/');
  await expect(page.locator('[data-row]').first(), 'the list has songs (an empty list means a broken deployment or database)').toBeVisible({ timeout: 45_000 });
}

/** A finger on a touch project, a click on desktop. */
export async function press(locator: Locator, touch: boolean) {
  if (touch) await locator.tap();
  else await locator.click();
}

export const topTitles = (page: Page, n = 5) =>
  page.locator('[data-row-title]').evaluateAll((els, k) => els.slice(0, k).map((e) => (e.textContent ?? '').trim()), n);

/** The top n once two reads 400 ms apart agree: the list comes back from the server a moment after each change. */
export async function settledTop(page: Page, n = 5): Promise<string[]> {
  let last = await topTitles(page, n);
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(400);
    const now = await topTitles(page, n);
    if (now.join('|') === last.join('|')) return now;
    last = now;
  }
  return last;
}

export async function shot(page: Page, info: TestInfo, name: string) {
  mkdirSync(SCREENS, { recursive: true });
  const file = path.join(SCREENS, `${info.project.name}-${name}.png`);
  await page.screenshot({ path: file });
  await info.attach(name, { path: file, contentType: 'image/png' });
}
