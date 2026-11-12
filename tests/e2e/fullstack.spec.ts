// Full-stack walk-through: the real API routes, the memory store and the offline mock
// Spotify client (SPOTIFY_MOCK=1, set in playwright.config.ts). Nothing is mocked in the
// browser. The singing test itself is covered in screen.spec.ts with a fake mic; here the
// finished test (A2 to C5) is put in sessionStorage, as the screen does after the high note.
// The placeholder seeds (data/seed-song-ranges.json) give the catalogue every decade, three
// duets and mood labels; playwright.config.ts turns duets and moods on for this server
// (DUETS_AND_MOODS=on, QWW-43; duets-moods-off.spec.ts covers them off), lists both moods and turns
// the event log on.

import { devices, expect, test } from '@playwright/test';
import path from 'node:path';

/** A row's song button, which opens the song page (the row's play button, QWW-48, comes first). */
const SONG_BUTTON = 'button:not([data-preview])';

const SCREENS = path.resolve('test-results/screens');

test('no Spotify: catalogue songs with chips, then Connect Spotify for library songs, feedback, sources and the event log', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ ...devices['iPhone 13'], baseURL, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('kd.e2e')) {
      sessionStorage.setItem('kd.e2e', '1');
      // The test ended at 1700000000000 (QWW-66): the time goes with the range to the account, and the server keeps it as sent.
      sessionStorage.setItem('kd.test', JSON.stringify({ low: 45, high: 72, measuredAt: 1700000000000 }));
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
  await expect(page.getByRole('slider', { name: 'Light work to Locked in' })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Rediscover to On repeat' })).toHaveCount(0);
  await page.screenshot({ path: path.join(SCREENS, 'fullstack-01-catalogue.png') });
  // The end of the list: one short question with the button, and the book icon for sources.
  const credits = page.getByRole('link', { name: 'Sources and credits' });
  await credits.scrollIntoViewIfNeeded();
  await expect(page.getByText('Want personalized recommendations?')).toBeVisible();
  await expect(credits).toBeVisible();
  await page.screenshot({ path: path.join(SCREENS, 'fullstack-01b-catalogue-end.png') });

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
  await songs.first().locator(SONG_BUTTON).click();
  await expect(page.getByRole('link', { name: 'Find on Spotify' })).toBeVisible();
  const catFeedback = page.waitForResponse((r) => r.url().includes('/api/catalogue/feedback'));
  await page.getByRole('button', { name: 'It went well' }).click();
  expect((await catFeedback).status()).toBe(200);
  await page.getByRole('button', { name: 'Back to songs' }).click();

  // ---- Connect Spotify (mock): the range carries over and library songs load ----
  await page.getByRole('button', { name: 'Connect to Spotify' }).first().click();
  await expect(page.getByRole('slider', { name: 'Rediscover to On repeat' })).toBeVisible({ timeout: 20_000 });
  await expect(songs).toHaveCount(5);
  await page.screenshot({ path: path.join(SCREENS, 'fullstack-04-library.png') });

  const me = await (await page.request.get('/api/me')).json();
  // The time the range was sung went from session storage, through the sign-in and the PUT, to the account (QWW-66).
  expect(me.range).toEqual({ low: 45, high: 72, source: 'test', measuredAt: 1700000000000 });

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
  await songs.first().locator(SONG_BUTTON).click();
  // Spotify's player stands where the button was. The mock gives most songs a real track id; the few
  // without one keep the plain link.
  await expect(page.locator('iframe[src^="https://open.spotify.com/embed/track/"], a:has-text("Open in Spotify")')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Where this came from' })).toHaveCount(0);
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
  for (let i = 0; i < 10 && (await group.count()) === 0; i++) await page.getByRole('button', { name: 'Load more songs' }).click();
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
    .toMatchObject({ list_view: 1, song_open: 1, spotify_connect: 1 });
  const ev = await (await page.request.get('/api/admin/events', { headers: { 'x-admin-token': 'e2e-admin' } })).json();
  const stored = JSON.stringify(ev.sessions);
  expect(stored).not.toMatch(/mock-\d+-/);
  for (const m of recs.matches) expect(stored).not.toContain(m.track.title);

  await context.close();
});

test('Spotify (mock) account: the green logo names the singer, and Log out really ends the session', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  // A desktop browser with a mouse: the config's default device is a phone, which cannot hover.
  const context = await browser.newContext({ ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, baseURL, reducedMotion: 'reduce' });
  // The test above counts event-log devices exactly; this walk stays out of that log.
  await context.route('**/api/events', (route) => route.fulfill({ status: 204 }));
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('kd.e2e')) {
      sessionStorage.setItem('kd.e2e', '1');
      sessionStorage.setItem('kd.test', JSON.stringify({ low: 45, high: 72 }));
    }
  });
  const page = await context.newPage();
  await page.goto('/');

  // Sign in with the finished test A2 to C5 (the mock Spotify answers at once): library songs.
  await page.getByRole('button', { name: 'or use songs from your Spotify' }).click();
  const songs = page.locator('ol li');
  await expect(songs).toHaveCount(5, { timeout: 20_000 });
  await expect(page.getByRole('slider', { name: 'Rediscover to On repeat' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect to Spotify' })).toHaveCount(0);

  // The logo is green, and pointing at it says who is signed in: the name comes from the real GET /api/me.
  const logo = page.getByRole('button', { name: 'Spotify account' });
  await expect(logo).toHaveCSS('color', 'rgb(29, 185, 84)');
  await logo.hover();
  await expect(page.getByText('Logged in as Test Singer')).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SCREENS, 'fullstack-07-logged-in-as.png') });

  // Log out: the real route clears the session cookie, so the server no longer knows this browser.
  expect((await page.request.get('/api/me')).status()).toBe(200);
  const loggedOut = page.waitForResponse((r) => r.url().endsWith('/api/auth/logout') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Log out' }).click();
  expect((await loggedOut).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Connect to Spotify' }).first()).toBeVisible();
  await expect(logo).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Rediscover to On repeat' })).toHaveCount(0);
  // Catalogue songs for the same range (only catalogue results end with the invitation to connect).
  await expect(songs).toHaveCount(5, { timeout: 20_000 });
  await expect(page.getByText('Want personalized recommendations?')).toBeAttached();
  expect((await page.request.get('/api/me')).status()).toBe(401);

  // The same range stays on this device: a reload is still the catalogue, not the start screen.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Connect to Spotify' }).first()).toBeVisible();
  await expect(songs).toHaveCount(5, { timeout: 20_000 });

  // The reset icon is credited on /credits, like the book.
  await page.goto('/credits');
  await expect(page.getByText('The fast-lyrics, book and reset icons (Apache 2.0).')).toBeVisible();
  await context.close();
});
