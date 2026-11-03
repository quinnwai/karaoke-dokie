// Full-stack walk-through: the real API routes, the memory store and the offline mock
// Spotify client (SPOTIFY_MOCK=1, set in playwright.config.ts). Nothing is mocked in the
// browser. The singing test itself is covered in screen.spec.ts with a fake mic; here the
// finished test (A2 to C5) is put in sessionStorage, as the screen does after the high note.
// The placeholder seeds (data/seed-song-ranges.json) give the catalogue every decade, three
// duets and mood labels; playwright.config.ts ships both moods and turns the event log on.

import { devices, expect, test } from '@playwright/test';
import path from 'node:path';

const SCREENS = path.resolve('test-results/screens');

test('no Spotify: catalogue songs with chips, then Connect Spotify for library songs, feedback, sources and the event log', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
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

  // ---- No Spotify: the arrow goes straight to real catalogue matches ----
  await page.getByRole('button', { name: 'Continue' }).click();
  const songs = page.locator('ol li');
  await expect(songs).toHaveCount(5, { timeout: 20_000 });
  await expect(page.getByRole('slider', { name: 'Ease in to Whole range' })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Deep cuts to On repeat' })).toHaveCount(0);
  await page.screenshot({ path: path.join(SCREENS, 'fullstack-01-catalogue.png') });

  // The catalogue route needs no session, and every song it lists fits A2 to C5 (as written or an
  // octave away). Catalogue songs never include the mock library's estimates.
  const cat = await (await page.request.get('/api/catalogue/recommendations?low=45&high=72&all=1')).json();
  expect(cat.complete).toBe(true);
  expect(cat.matches.length).toBeGreaterThan(10);
  for (const m of cat.matches) {
    const shift = m.octave === 'down' ? -12 : m.octave === 'up' ? 12 : 0;
    expect(m.range.low + shift).toBeGreaterThanOrEqual(45);
    expect(m.range.high + shift).toBeLessThanOrEqual(72);
    expect(m.track.id).toMatch(/^cat:/);
    expect(m.range.confidence).toBe('high');
  }

  // Decade, mood and duet chips come from real data, with counts.
  const filters = page.getByRole('group', { name: 'Filter songs' });
  await expect(filters.getByRole('button', { name: /^80s, \d+ songs?$/ })).toBeVisible();
  await expect(filters.getByRole('button', { name: /^Upbeat, \d+ songs?$/ })).toBeVisible();
  const duets = filters.getByRole('button', { name: /^Duets, \d+ songs?$/ });
  await expect(duets).toBeVisible();
  await duets.click();
  await expect(songs.first()).toContainText('Duet: take');
  for (const li of await songs.all()) await expect(li).toContainText('Duet: take');
  await page.screenshot({ path: path.join(SCREENS, 'fullstack-02-duets.png') });
  await page.getByRole('button', { name: 'Clear' }).click();

  await filters.getByRole('button', { name: /^80s, \d+ songs?$/ }).click();
  for (const li of await songs.all()) await expect(li).toContainText(/· 198\d/);
  await page.screenshot({ path: path.join(SCREENS, 'fullstack-03-80s.png') });

  // Feedback without an account goes to the catalogue route with this device's id.
  await songs.first().getByRole('button').first().click();
  await expect(page.getByRole('link', { name: 'Find on Spotify' })).toBeVisible();
  const catFeedback = page.waitForResponse((r) => r.url().includes('/api/catalogue/feedback'));
  await page.getByRole('button', { name: 'It went well' }).click();
  expect((await catFeedback).status()).toBe(200);
  await page.getByRole('button', { name: 'Back to songs' }).click();

  // ---- Connect Spotify (mock): the range carries over and library songs load ----
  await page.getByRole('button', { name: 'Connect Spotify' }).first().click();
  await expect(page.getByRole('slider', { name: 'Deep cuts to On repeat' })).toBeVisible({ timeout: 20_000 });
  await expect(songs).toHaveCount(5);
  await page.screenshot({ path: path.join(SCREENS, 'fullstack-04-library.png') });

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
  const feedback = page.waitForResponse((r) => r.url().endsWith('/api/feedback'));
  await page.getByRole('button', { name: 'It went well' }).click();
  expect((await feedback).status()).toBe(200);
  await page.screenshot({ path: path.join(SCREENS, 'fullstack-05-feedback.png') });

  // The placeholder estimates come after the labeled songs, under Maybe: within 2 semitones of
  // A2 to C5 (as written or an octave away), with no difficulty.
  const all = await (await page.request.get('/api/recommendations?all=1')).json();
  const maybe = all.matches.filter((m: { difficulty: string }) => m.difficulty === 'maybe');
  expect(maybe).toHaveLength(3);
  expect(all.matches.slice(0, all.matches.length - maybe.length).every((m: { difficulty: string }) => m.difficulty !== 'maybe')).toBe(true);
  for (const m of maybe) {
    const shift = m.octave === 'down' ? -12 : m.octave === 'up' ? 12 : 0;
    expect(m.range.confidence).toBe('low');
    expect(m.range.low + shift).toBeGreaterThanOrEqual(43);
    expect(m.range.high + shift).toBeLessThanOrEqual(74);
  }
  await page.getByRole('button', { name: 'Back to songs' }).click();
  const group = page.getByRole('region', { name: 'Maybe' });
  for (let i = 0; i < 10 && (await group.count()) === 0; i++) await page.getByRole('button', { name: 'Generate more songs' }).click();
  await expect(group.locator('li')).toHaveCount(3);
  await expect(group.locator('[data-difficulty]')).toHaveCount(0);
  await group.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SCREENS, 'fullstack-06-maybe.png') });

  // The hidden admin log lists where each song's data came from, and is locked without the token.
  expect((await page.request.get('/api/admin/log')).status()).toBe(403);
  const log = await (await page.request.get('/api/admin/log', { headers: { 'x-admin-token': 'e2e-admin' } })).json();
  expect(log.entries.length).toBeGreaterThan(0);
  expect(log.entries.some((e: { outcome: string }) => e.outcome === 'skipped')).toBe(true);

  // The event log recorded this session's funnel, and no Spotify track id or library song.
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect((await page.request.get('/api/admin/events')).status()).toBe(403);
  await expect
    .poll(async () => {
      const ev = await (await page.request.get('/api/admin/events', { headers: { 'x-admin-token': 'e2e-admin' } })).json();
      return Object.fromEntries(ev.funnel.map((f: { name: string; devices: number }) => [f.name, f.devices]));
    })
    .toMatchObject({ results_viewed: 1, song_opened: 1, spotify_connect_pressed: 1 });
  const ev = await (await page.request.get('/api/admin/events', { headers: { 'x-admin-token': 'e2e-admin' } })).json();
  const stored = JSON.stringify(ev.sessions);
  expect(stored).not.toMatch(/mock-\d+-/);
  for (const m of recs.matches) expect(stored).not.toContain(m.track.title);

  await context.close();
});
