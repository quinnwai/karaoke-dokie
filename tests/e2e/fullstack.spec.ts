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
import type { SetlistRequest } from '../../src/lib/contracts';

/** A row's song button, which opens the song page (the row's play button, QWW-48, comes first). */
const SONG_BUTTON = 'button:not([data-preview])';

const SCREENS = path.resolve('test-results/screens');

test('no Spotify: catalogue songs on the Setlist tuner, then Connect Spotify for library songs, feedback, sources and the event log', async ({ browser, baseURL }) => {
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

  // ---- No Spotify: the arrow goes straight to real catalogue matches, on the Setlist tuner ----
  await page.getByRole('button', { name: 'Continue' }).click();
  const songs = page.locator('[data-row]');
  await expect(songs.first()).toBeVisible({ timeout: 20_000 });
  // Every match for the range, up to the 40 a screen shows at first.
  const catAll = await (await page.request.get('/api/catalogue/recommendations?low=45&high=72&all=1')).json();
  await expect(songs).toHaveCount(Math.min(catAll.matches.length, 40));
  await expect(page.locator('#slider-difficulty')).toBeVisible();
  // Catalogue songs are nobody's library: there is no listening history to tune by.
  await expect(page.locator('#slider-history')).toBeDisabled();
  await page.screenshot({ path: path.join(SCREENS, 'fullstack-01-catalogue.png') });
  // The end of the list: Sources and credits is the book in the TV's chin now (R28), not at the end of the list, and it is there with the list at its end.
  const credits = page.getByRole('button', { name: 'Sources and credits' });
  await page.locator('#list-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  // R18 took the "Want personalized recommendations?" block away: the header's Spotify button is the one way to connect.
  await expect(page.getByText('Want personalized recommendations?')).toHaveCount(0);
  await expect(credits).toBeVisible();
  await expect(page.locator('#list-scroll').getByRole('link', { name: 'Sources and credits' })).toHaveCount(0);
  await page.screenshot({ path: path.join(SCREENS, 'fullstack-01b-catalogue-end.png') });
  // It opens inside the TV, on the same page, and names Deezer and who else the songs and the know-how come from (R28).
  await credits.click();
  const panel = page.getByRole('dialog', { name: 'Sources and credits' });
  await expect(panel.getByRole('link', { name: 'Deezer' })).toBeVisible();
  await expect(panel.getByRole('link', { name: 'USDB (UltraStar DataBase)' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
  await page.screenshot({ path: path.join(SCREENS, 'fullstack-01c-credits.png') });
  await panel.getByRole('button', { name: 'Close sources and credits' }).click();
  await expect(panel).toHaveCount(0);
  await expect(songs.first()).toBeVisible();

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

  // Every row says its era, from the real years (the song's USDB year, or its chart year).
  await expect(songs.first()).toContainText(/· (Pre-’70s|’[0-9]0s)/);

  // Era is a multi-select on real data: with it off every song counts, and the first tap picks just the 80s (Era has no
  // default picks), which leaves only their songs.
  const era = (id: string) => page.locator(`button[data-era="${id}"]`);
  // A phone this short opens the tuner's sheet in mini (QWW-57), which shows the Era panel from its tab.
  await page.locator('[data-tab][data-gear="era"]').click();
  await era('s80').click();
  await expect(era('s80')).toHaveAttribute('aria-pressed', 'true');
  await expect(songs.first()).toBeVisible();
  // The list is re-ranked by the server a moment after the tap: wait until every row on screen is of the 80s.
  await expect.poll(async () => (await songs.allTextContents()).every((t) => t.includes('’80s'))).toBe(true);
  await page.screenshot({ path: path.join(SCREENS, 'fullstack-03-80s.png') });
  await page.locator('button[data-reset="era"]').click();
  await expect(songs).toHaveCount(Math.min(catAll.matches.length, 40));

  // Feedback without an account goes to the catalogue route with this device's id.
  await songs.first().locator(SONG_BUTTON).click();
  await expect(page.getByRole('link', { name: 'Find on Spotify' })).toBeVisible();
  const catFeedback = page.waitForResponse((r) => r.url().includes('/api/catalogue/feedback'));
  await page.getByRole('button', { name: 'It went well' }).click();
  expect((await catFeedback).status()).toBe(200);
  await page.getByRole('button', { name: 'Back to songs' }).click();

  // ---- Connect Spotify (mock): the range carries over and library songs load; History is on now ----
  // On a phone the first tap on the header's Spotify button shows its tooltip (R30) and the second connects.
  const asked: SetlistRequest[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/setlist') asked.push(r.postDataJSON() as SetlistRequest);
  });
  const connect = page.getByRole('button', { name: 'Connect to Spotify' });
  await connect.click();
  await page.waitForTimeout(450); // the second tap must not come inside the moment (400 ms) in which the tooltip is read
  await connect.click();
  await expect(page.locator('#slider-history')).toBeEnabled({ timeout: 20_000 });
  await expect(songs.first()).toBeVisible();
  // R31: signed in, the tuner starts with History on, at 100 ("that's the purpose of logging in"), and the first request after the round trip said so.
  await expect(page.locator('[data-strip][data-gear="history"]')).not.toHaveAttribute('data-off', /.*/);
  expect(await page.locator('#slider-history').inputValue()).toBe('100');
  expect(asked.length).toBeGreaterThan(0);
  expect(asked.at(-1)!.gears.history).toBe(100);
  expect(asked.at(-1)!.off).toEqual(['tempo', 'era']);
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

  // Open the first song of the singer's own library (the list also holds catalogue songs, whose id starts with cat:), check
  // the info line, leave feedback.
  await page.locator('[data-row]:not([data-id^="cat:"])').first().locator(SONG_BUTTON).click();
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
  // On the list they are the last rows, and the row says Maybe instead of a difficulty.
  await page.getByRole('button', { name: 'Back to songs' }).click();
  const more = page.getByRole('button', { name: 'Load more songs' });
  for (let i = 0; i < 10 && (await more.count()) > 0; i++) await more.click();
  const maybeRows = page.locator('[data-row]:has(button[aria-label$=", Maybe"])');
  await expect(maybeRows).toHaveCount(3);
  const total = await songs.count();
  expect(await maybeRows.evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-rank'))))).toEqual([total - 2, total - 1, total]);
  await maybeRows.last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SCREENS, 'fullstack-06-maybe.png') });

  // The hidden admin log lists where each song's data came from, and is locked without the token.
  expect((await page.request.get('/api/admin/log')).status()).toBe(403);
  const log = await (await page.request.get('/api/admin/log', { headers: { 'x-admin-token': 'e2e-admin' } })).json();
  expect(log.entries.length).toBeGreaterThan(0);
  expect(log.entries.some((e: { outcome: string }) => e.outcome === 'skipped')).toBe(true);

  // The event log recorded this session's funnel, and no Spotify track id or library song. The log is the server's, which every spec that
  // runs against it shares, and a page that leaves its document sends what it has by beacon, which a spec's mocked API does not catch:
  // another device's list_view can be in it. So the funnel is read for this device alone, by the id its page kept.
  const anonId = await page.evaluate(() => localStorage.getItem('kd.anonId'));
  expect(anonId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect((await page.request.get('/api/admin/events')).status()).toBe(403);
  const events = async () => (await page.request.get('/api/admin/events', { headers: { 'x-admin-token': 'e2e-admin' } })).json();
  await expect
    .poll(async () => {
      const session = (await events()).sessions.find((s: { anonId: string }) => s.anonId === anonId);
      const steps = new Set<string>((session?.events ?? []).map((e: { name: string }) => e.name));
      return ['list_view', 'song_open', 'spotify_connect'].map((name) => steps.has(name));
    })
    .toEqual([true, true, true]);
  const ev = await events();
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
  const songs = page.locator('[data-row]');
  await expect(songs.first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#slider-history')).toBeEnabled();
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
  await expect(page.locator('#slider-history')).toBeDisabled();
  // Catalogue songs for the same range, and the header's Spotify button to connect again (nothing under the list invites it now, R18).
  await expect(songs.first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Want personalized recommendations?')).toHaveCount(0);
  expect((await page.request.get('/api/me')).status()).toBe(401);

  // The same range stays on this device: a reload is still the catalogue, not the start screen.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Connect to Spotify' }).first()).toBeVisible();
  await expect(songs.first()).toBeVisible({ timeout: 20_000 });

  // The reset icon is credited on /credits, like the book.
  await page.goto('/credits');
  await expect(page.getByText('The fast-lyrics, book and reset icons (Apache 2.0).')).toBeVisible();
  await context.close();
});
