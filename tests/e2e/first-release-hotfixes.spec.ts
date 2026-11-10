// QWW-55: three things found testing PR #4's preview on 10 Nov 2026, at 375 px wide, the narrowest phone the first
// release is for. playwright.config.ts runs two servers from one build: the default one has the title screen's
// pick-songs link on (so the pick flow stays covered), and the second, on E2E_OFF_PORT, is the app as it ships.
// What the server does when Spotify answers 429 is tested in tests/server (the real client on a fake Web API); here
// is what the phone shows, and the range bar in real pixels.

import { devices, expect, test, type BrowserContext } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Match, RecommendationsResponse } from '../../src/lib/contracts';
import { shapeOf } from '../../src/lib/songs/score';
import { areYouWithMe, USER_D2_TO_D5 } from '../songs/rangeBarFixture';

const SCREENS = path.resolve('test-results/screens');
// The same expressions as in playwright.config.ts.
const port = Number(process.env.E2E_PORT ?? 3000);
const offPort = Number(process.env.E2E_OFF_PORT ?? port + 1);
const ON = `http://127.0.0.1:${port}`;
const OFF = `http://127.0.0.1:${offPort}`;
const PHONE_375 = { ...devices['iPhone 13'], viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 };

test.use({ screenshot: 'off' });
test.beforeAll(() => mkdirSync(SCREENS, { recursive: true }));

/** Puts a finished singing test (a range) in sessionStorage once, as the screen does after the high note. */
async function withRange(context: BrowserContext, low: number, high: number) {
  await context.addInitScript(
    ([lo, hi]) => {
      if (!sessionStorage.getItem('kd.e2e')) {
        sessionStorage.setItem('kd.e2e', '1');
        sessionStorage.setItem('kd.test', JSON.stringify({ low: lo, high: hi }));
      }
    },
    [low, high],
  );
}

test('title screen: no "or pick songs you sing well" as the app ships, and the switch brings it back', async ({ browser }) => {
  for (const [name, baseURL, links] of [['off', OFF, 0], ['on', ON, 1]] as const) {
    const context = await browser.newContext({ ...PHONE_375, baseURL, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'or pick songs you sing well' })).toHaveCount(links);
    await expect(page.getByText(/pick songs/i)).toHaveCount(links);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENS, `qww55-title-switch-${name}-375px.png`) });
    await context.close();
  }
});

// The range screen ("That's your range") has its own link into Spotify; the same PICK_SONGS switch hides it, so the app
// has one onboarding flow and the Spotify logo on the list is the one way to sign in.
test('range screen: no "or use songs from your Spotify" as the app ships, and the switch brings it back', async ({ browser }) => {
  for (const [name, baseURL, links] of [['off', OFF, 0], ['on', ON, 1]] as const) {
    const context = await browser.newContext({ ...PHONE_375, baseURL, reducedMotion: 'reduce' });
    await withRange(context, 39, 72); // D#2 to C5
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await expect(page.getByTestId('range-low')).toHaveText('D#2');
    await expect(page.getByRole('button', { name: 'or use songs from your Spotify' })).toHaveCount(links);
    await expect(page.getByText(/songs from your Spotify/i)).toHaveCount(links);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENS, `qww55-range-switch-${name}-375px.png`) });
    await context.close();
  }
});

// What a failed sign-in looks like: the callback sends the browser to /?authError=<reason> (Spotify says wait, one of
// its calls fails, the sign-in cookie is gone, ...), and the range, kept for the round trip, is on screen.
test('a refused sign-in says so under the range and under the list, and Cancel on Spotify says nothing', async ({ browser }) => {
  const context = await browser.newContext({ ...PHONE_375, baseURL: OFF, reducedMotion: 'reduce' });
  await withRange(context, 39, 72);
  const page = await context.newPage();
  await page.goto('/?authError=spotify');
  await expect(page.getByRole('status')).toHaveText('Couldn’t sign in to Spotify.');
  expect(new URL(page.url()).search).toBe('');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SCREENS, 'qww55-sign-in-refused-range-375px.png') });

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('ol li').first()).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Couldn’t sign in to Spotify.');
  // Still the plain list, with both ways to try again.
  await expect(page.getByRole('button', { name: 'Connect to Spotify' })).toHaveCount(2);
  await expect(page.getByText('Couldn’t load songs.')).toHaveCount(0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SCREENS, 'qww55-sign-in-refused-list-375px.png') });
  await context.close();

  const cancelled = await browser.newContext({ ...PHONE_375, baseURL: OFF, reducedMotion: 'reduce' });
  await withRange(cancelled, 39, 72);
  const cancelPage = await cancelled.newPage();
  await cancelPage.goto('/?authError=access_denied');
  await expect(cancelPage.getByRole('button', { name: 'Continue' })).toBeVisible();
  await expect(cancelPage.getByRole('status')).toHaveCount(0);
  await cancelled.close();
});

test('a signed-in singer whose Spotify library could not be read sees catalogue songs and one quiet note', async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ ...PHONE_375, baseURL: OFF, reducedMotion: 'reduce' });
  // Sign in through the real routes (the offline mock Spotify sends the browser straight back), then save a range.
  const signIn = await context.newPage();
  await signIn.goto('/api/auth/login');
  await signIn.waitForURL(/signedIn=1|\/$/);
  expect((await context.request.put('/api/me/range', { data: { low: 45, high: 72, source: 'test' } })).ok()).toBe(true);
  await signIn.close();

  // What the server answers a library it cannot read with (handlers.ts, withoutLibrary): the catalogue's list and the flag.
  const catalogue = (await (await context.request.get('/api/catalogue/recommendations?low=45&high=72&all=1')).json()) as RecommendationsResponse;
  expect(catalogue.matches.length).toBeGreaterThan(4);
  let asked = 0;
  await context.route('**/api/recommendations?all=1', (route) => {
    asked++;
    return route.fulfill({ json: { ...catalogue, libraryUnavailable: true } });
  });

  const page = await context.newPage();
  await page.goto('/');
  const note = page.getByRole('status');
  await expect(note).toHaveText('Couldn’t reach Spotify, showing popular songs.');
  await expect(page.locator('ol li')).toHaveCount(5);
  // Still signed in (the green logo), and nothing offers to connect Spotify or to retry a failed load.
  await expect(page.getByRole('button', { name: 'Spotify account' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect to Spotify' })).toHaveCount(0);
  await expect(page.getByText('Couldn’t load songs.')).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Rediscover to On repeat' })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Light work to Locked in' })).toBeVisible();
  // The note fits one line on the narrowest phone, under the bar and clear of the logo.
  const box = (await note.boundingBox())!;
  expect(box.height).toBeLessThan(24);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  expect(asked).toBe(1);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SCREENS, 'qww55-library-unavailable-375px.png') });
  await context.close();
});

test('song page: no bar for an empty bin and none outside the pink range (Are You With Me, D#2 to D5)', async ({ browser }) => {
  test.setTimeout(60_000);
  // The song as the server holds it (G4 to C#5, its notes through the real note-file parser), shaped for the singer
  // by the real shapeOf; the response drops the histogram itself, as the catalogue's all=1 does.
  const stored = areYouWithMe();
  const { pitchShare: _dropped, ...range } = stored;
  const are: Match = {
    track: { id: 'cat:lost frequencies|are you with me', title: 'Are You With Me - Radio Edit', artist: 'Lost Frequencies', artistId: '', spotifyUrl: 'https://open.spotify.com/search/x', playRank: 0, familiarity: 1, known: false },
    range,
    difficulty: 'hard',
    octave: 'none',
    parts: { comfort: 0.3, familiarity: 1, popularity: 0.9, popularityKnown: true, penalty: 0 },
    reasons: ['Lots of high notes', 'Crowd favourite'],
    strain: 1.4,
    shape: shapeOf(USER_D2_TO_D5, stored, 'none')!,
    year: 2014,
    genre: 'Pop',
  };
  const context = await browser.newContext({ ...PHONE_375, baseURL: OFF, reducedMotion: 'reduce' });
  await withRange(context, USER_D2_TO_D5.low, USER_D2_TO_D5.high);
  await context.route('**/api/catalogue/recommendations**', (route) =>
    route.fulfill({ json: { matches: [are], nextOffset: null, sources: {}, complete: true } satisfies RecommendationsResponse }),
  );
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /^Are You With Me/ }).click();
  await expect(page.getByRole('heading', { name: 'Are You With Me - Radio Edit' })).toBeVisible();

  const bars = page.locator('[class*="barShape"] i');
  // The notes sit in 3 of the 12 bins (G4 to C#5 across D#2 to D5). The 9 empty bins, which were drawn as hairlines across
  // the whole range, draw nothing.
  await expect(bars).toHaveCount(3);
  const pink = (await page.locator('[class*="barSong"]').boundingBox())!;
  const track = (await page.locator('[class*="barUser"]').boundingBox())!;
  const boxes = await bars.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as { x: number; width: number; height: number }));
  for (const b of boxes) {
    expect(b.height, 'every bar is visible').toBeGreaterThan(2);
    expect(b.x, 'no bar starts left of the pink stretch').toBeGreaterThanOrEqual(pink.x - 0.5);
    expect(b.x + b.width, 'no bar ends right of the pink stretch (it ran on to the edge of D5)').toBeLessThanOrEqual(pink.x + pink.width + 0.5);
  }
  // The pink stretch sits near the top of the singer's range, and the bars with it, not spread across the whole range.
  expect(pink.x).toBeGreaterThan(track.x + track.width * 0.7);
  expect(Math.min(...boxes.map((b) => b.x))).toBeGreaterThan(track.x + track.width * 0.7);
  // The page is otherwise as it was: the range bar, its two legend entries once opened, the difficulty and the player link.
  await page.locator('[class*="rangeBar"]').click();
  await expect(page.getByText('song range')).toBeVisible();
  await expect(page.getByText('your range')).toBeVisible();
  await expect(page.getByText('Hard', { exact: true })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SCREENS, 'qww55-song-page-are-you-with-me-375px.png') });
  await context.close();
});
