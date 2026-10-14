// Full-stack walk-through: the real API routes, the memory store and the offline mock
// Spotify client (SPOTIFY_MOCK=1, set in playwright.config.ts). Nothing is mocked in the
// browser. The singing test itself is covered in screen.spec.ts with a fake mic; here the
// finished test (A2 to C5) is put in sessionStorage, as the screen does after the high note.

import { devices, expect, test } from '@playwright/test';
import path from 'node:path';

const SCREENS = path.resolve('test-results/screens');

test('signs in, saves the range, recommends real matches, stores feedback and logs sources', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ...devices['iPhone 13'], baseURL, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('kd.e2e')) {
      sessionStorage.setItem('kd.e2e', '1');
      sessionStorage.setItem('kd.test', JSON.stringify({ low: 45, high: 72 }));
    }
  });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByTestId('range-low')).toHaveText('A2');
  await expect(page.getByTestId('range-high')).toHaveText('C5');

  await page.getByRole('button', { name: 'Continue' }).click();

  // Back from the (mock) Spotify sign-in: the range is saved and real matches load.
  const songs = page.locator('ol li');
  await expect(songs).toHaveCount(5, { timeout: 20_000 });
  await page.screenshot({ path: path.join(SCREENS, 'fullstack-01-results.png') });

  const me = await (await page.request.get('/api/me')).json();
  expect(me.range).toEqual({ low: 45, high: 72, source: 'test' });

  // Every listed song fits A2 to C5 as written or an octave away, and carries a label.
  const recs = await (await page.request.get('/api/recommendations?offset=0&limit=5')).json();
  expect(recs.matches).toHaveLength(5);
  for (const m of recs.matches) {
    const shift = m.octave === 'down' ? -12 : m.octave === 'up' ? 12 : 0;
    expect(m.range.low + shift).toBeGreaterThanOrEqual(45);
    expect(m.range.high + shift).toBeLessThanOrEqual(72);
    expect(['easy', 'medium', 'hard']).toContain(m.difficulty);
  }

  // Open the first song, check the info line, leave feedback.
  await songs.first().getByRole('button').first().click();
  await expect(page.getByRole('link', { name: 'Open in Spotify' })).toBeVisible();
  await page.getByRole('button', { name: 'Where this came from' }).click();
  await expect(page.getByRole('tooltip')).toBeVisible();
  const feedback = page.waitForResponse((r) => r.url().includes('/api/feedback'));
  await page.getByRole('button', { name: 'It went well' }).click();
  expect((await feedback).status()).toBe(200);
  await page.screenshot({ path: path.join(SCREENS, 'fullstack-02-feedback.png') });

  // The hidden admin log lists where each song's data came from, and is locked without the token.
  expect((await page.request.get('/api/admin/log')).status()).toBe(403);
  const log = await (await page.request.get('/api/admin/log', { headers: { 'x-admin-token': 'e2e-admin' } })).json();
  expect(log.entries.length).toBeGreaterThan(0);
  expect(log.entries.some((e: { outcome: string }) => e.outcome === 'skipped')).toBe(true);

  await context.close();
});
