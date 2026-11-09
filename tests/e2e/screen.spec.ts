// End-to-end walk through the karaoke screen. The real API is built elsewhere,
// so every /api/* call is mocked with contract-shaped fixtures. Chromium's fake
// microphone plays a generated WAV; it takes one file per launch, so the low
// note and the high note are sung in two separate browser launches, with the
// test progress carried over in sessionStorage like after a reload.

import { chromium, devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CatalogueFeedbackRequest, FeedbackRequest, Match, MeResponse, RecommendationsResponse, SongRange, VocalRange } from '../../src/lib/contracts';
import { matchSong, toMatch } from '../../src/lib/songs/match';
import { correctOctave, type OctaveEvidence } from '../../src/lib/songs/octave';
import { allMatches, allMatchesWithFacts, knownSongs, longList, match, me } from '../fixtures/screen';

const SCREENS = path.resolve('test-results/screens');
const AUDIO = path.resolve('test-results/audio');
const iPhone = devices['iPhone 13'];

/** 16-bit mono WAV of a sung-vowel-like tone (fundamental plus falling harmonics). */
function toneWav(hz: number, seconds: number, sampleRate = 48000): Buffer {
  const n = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(n * 2);
  const amps = [1, 0.6, 0.4, 0.25, 0.15];
  for (let i = 0; i < n; i++) {
    let v = 0;
    amps.forEach((a, k) => (v += a * Math.sin((2 * Math.PI * hz * (k + 1) * i) / sampleRate)));
    data.writeInt16LE(Math.round(v * 0.22 * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const LOW_WAV = path.join(AUDIO, 'a2-110hz.wav');
const HIGH_WAV = path.join(AUDIO, 'c5-523hz.wav');

test.beforeAll(() => {
  mkdirSync(SCREENS, { recursive: true });
  mkdirSync(AUDIO, { recursive: true });
  writeFileSync(LOW_WAV, toneWav(110, 2.5));
  writeFileSync(HIGH_WAV, toneWav(523.25, 2.5));
});

// Named screenshots are taken by hand below; the automatic one adds nothing.
test.use({ screenshot: 'off' });

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SCREENS, `${name}.png`) });

/** Mocks the whole HTTP API. `state` is shared so a sign-in in one step shows up in the next. */
interface ApiState {
  user: MeResponse | null;
  savedRanges: VocalRange[];
  feedback: FeedbackRequest[];
  catalogueFeedback: CatalogueFeedbackRequest[];
  /** Query strings of every recommendations request, library and catalogue. */
  recommendationCalls: string[];
  /** How many times the session was ended (POST /api/auth/logout). */
  logouts: number;
  /** Serve songs with years, genres and known popularity. */
  facts?: boolean;
  /** Serve a long list whose difficulty scores bunch low, as a wide range makes them (QWW-33). */
  long?: boolean;
  /** Serve exactly this list instead of the fixture songs. */
  response?: RecommendationsResponse;
}

async function mockApi(context: BrowserContext, state: ApiState) {
  await context.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    switch (`${req.method()} ${url.pathname}`) {
      case 'GET /api/auth/login':
        state.user = me(state.user?.range ?? null);
        return route.fulfill({ status: 302, headers: { location: '/?signedIn=1' } });
      case 'GET /api/me':
        return state.user ? json(state.user) : json({ error: 'signed out' }, 401);
      case 'POST /api/auth/logout':
        state.logouts++;
        state.user = null;
        return json({ ok: true });
      case 'PUT /api/me/range': {
        const range = req.postDataJSON() as VocalRange;
        state.savedRanges.push(range);
        if (state.user) state.user = { ...state.user, range };
        return json({ ok: true });
      }
      case 'GET /api/recommendations':
        state.recommendationCalls.push(`library ${url.search}`);
        return json(state.response ?? (state.long ? longList() : state.facts ? allMatchesWithFacts() : allMatches()));
      case 'GET /api/catalogue/recommendations':
        state.recommendationCalls.push(`catalogue ${url.search}`);
        return json(state.long ? longList() : state.facts ? allMatchesWithFacts() : allMatches());
      case 'POST /api/catalogue/feedback':
        state.catalogueFeedback.push(req.postDataJSON() as CatalogueFeedbackRequest);
        return json({ ok: true });
      case 'POST /api/events':
        return route.fulfill({ status: 204 });
      case 'GET /api/songs/known':
        return json(knownSongs());
      case 'POST /api/feedback':
        state.feedback.push(req.postDataJSON() as FeedbackRequest);
        return json({ ok: true });
      default:
        return json({ error: 'not mocked' }, 404);
    }
  });
  // Spotify's player is another site's page, so the tests never load it: this stand-in says which track
  // it was asked for. What the real player does (plays, and its logo opens the song in Spotify) was
  // checked by hand against open.spotify.com, not here.
  await context.route('https://open.spotify.com/embed/**', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop();
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><body style="margin:0;height:152px;box-sizing:border-box;padding:16px;font:600 15px system-ui;color:#fff;background:#282828">
        Spotify player (stand-in)<br><small style="font-weight:400;color:#b3b3b3">track ${id}</small></body>`,
    });
  });
}

async function launchWithMic(wav: string): Promise<Browser> {
  return chromium.launch({
    executablePath: process.env.PW_CHROMIUM_PATH,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`],
  });
}

/** Press and hold the record button like a finger would. */
async function holdButton(page: Page, name: RegExp, ms: number, midway?: () => Promise<void>) {
  const box = (await page.getByRole('button', { name }).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms / 2);
  await midway?.();
  await page.waitForTimeout(ms / 2);
  await page.mouse.up();
}

const freshState = (): ApiState => ({ user: null, savedRanges: [], feedback: [], catalogueFeedback: [], recommendationCalls: [], logouts: 0 });
const DEFAULT_VIEW = { difficulty: null, familiarity: null, popularity: null, tempo: null, decade: null, mood: null, duetsOnly: false };

test('full flow: test, sign in, results, song detail, feedback', async ({ baseURL }) => {
  test.setTimeout(120_000);
  const api = freshState();

  // ---- Browser 1: the mic hears A2 ----
  const lowBrowser = await launchWithMic(LOW_WAV);
  const lowContext = await lowBrowser.newContext({ ...iPhone, baseURL });
  await mockApi(lowContext, api);
  const page1 = await lowContext.newPage();

  await page1.goto('/');
  await expect(page1.getByRole('button', { name: 'Start' })).toBeVisible();
  await page1.waitForTimeout(400);
  await shot(page1, '01-landing');

  await page1.getByRole('button', { name: 'Start' }).click();
  await expect(page1.getByText('Find a quiet spot')).toBeVisible();
  await page1.waitForTimeout(1100);
  await shot(page1, '02-quiet-spot');

  const lowButton = page1.getByRole('button', { name: 'Hold to record your lowest note' });
  await expect(lowButton).toBeVisible({ timeout: 5000 });
  await page1.waitForTimeout(1300);
  await shot(page1, '03-lowest-note');

  await holdButton(page1, /lowest note/, 1600, async () => {
    await expect(page1.getByTestId('live-pitch')).toHaveText('A2', { timeout: 1000 });
    await shot(page1, '04-lowest-note-holding');
  });
  await expect(page1.getByTestId('low-note')).toHaveText('A2');
  await page1.waitForTimeout(1300);
  await shot(page1, '05-highest-note');

  const progress = await page1.evaluate(() => sessionStorage.getItem('kd.test'));
  expect(JSON.parse(progress!)).toEqual({ low: 45, high: null });
  await lowBrowser.close();

  // ---- Browser 2: the mic hears C5; progress carried over ----
  const highBrowser = await launchWithMic(HIGH_WAV);
  const context = await highBrowser.newContext({ ...iPhone, baseURL });
  await mockApi(context, api);
  await context.addInitScript((saved) => {
    if (!sessionStorage.getItem('kd.e2e')) {
      sessionStorage.setItem('kd.e2e', '1');
      sessionStorage.setItem('kd.test', saved);
    }
  }, progress!);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByTestId('low-note')).toHaveText('A2');

  await holdButton(page, /highest note/, 1600);
  const arrow = page.getByRole('button', { name: 'Continue' });
  await expect(arrow).toBeVisible();
  // The arrow sits in the bottom-right corner of the viewport.
  const box = (await arrow.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x + box.width / 2).toBeGreaterThan(view.width / 2);
  expect(box.y + box.height / 2).toBeGreaterThan(view.height / 2);
  await expect(page.getByTestId('range-low')).toHaveText('A2');
  await expect(page.getByTestId('range-high')).toHaveText('C5');
  await expect(page.getByRole('button', { name: 'or use songs from your Spotify' })).toBeVisible();
  await page.waitForTimeout(900);
  await shot(page, '06-range-arrow');

  // ---- No Spotify: the arrow goes straight to catalogue songs ----
  // The arrow bounces forever, so it is never "stable" for Playwright; with
  // reduced motion it stands still (which also checks that setting).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await arrow.click();
  await expect(page.getByRole('button', { name: /^Plastic Love/ })).toBeVisible();
  expect(api.recommendationCalls).toEqual(['catalogue ?low=45&high=72&all=1']);
  expect(api.savedRanges).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('kd.range'))).toBe(JSON.stringify({ low: 45, high: 72 }));
  // Catalogue songs are nobody's library: a difficulty slider, but no on-repeat one.
  await expect(page.getByRole('slider', { name: 'Light work to Locked in' })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Rediscover to On repeat' })).toHaveCount(0);
  await page.waitForTimeout(800);
  await shot(page, '07-catalogue-results');

  // ---- Connect Spotify (mocked redirect back to /?signedIn=1): the range carries over ----
  await page.getByRole('button', { name: 'Connect to Spotify' }).first().click();
  await expect(page.getByRole('slider', { name: 'Rediscover to On repeat' })).toBeVisible();
  expect(api.savedRanges).toEqual([{ low: 45, high: 72, source: 'test' }]);
  expect(api.recommendationCalls.at(-1)).toBe('library ?all=1');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('ol li')).toHaveCount(5);
  await page.waitForTimeout(1000);
  await shot(page, '07-results');

  // Ranking v2: octave and fast-lyrics icons beside the label, reasons under the artist.
  const dancing = page.locator('ol li').filter({ hasText: 'Dancing Queen' });
  await expect(dancing.getByRole('img', { name: 'Sing it an octave higher than the artist' })).toBeVisible();
  await expect(dancing.getByText('In your sweet spot')).toBeVisible();
  const yoru = page.locator('ol li').filter({ hasText: 'Yoru ni Kakeru' });
  await expect(yoru.getByRole('img', { name: 'Fast lyrics' })).toBeVisible();
  await expect(yoru.getByRole('img', { name: 'Sing it an octave lower than the artist' })).toBeVisible();
  await expect(page.locator('ol li').filter({ hasText: 'Plastic Love' }).getByText('In your sweet spot · Top songs this month')).toBeVisible();
  await expect(page.locator('ol li').filter({ hasText: 'Plastic Love' }).getByRole('img')).toHaveCount(0);
  await shot(page, '07b-results-icons');

  await page.getByRole('button', { name: 'Load more songs' }).click();
  await expect(page.locator('ol li')).toHaveCount(10);
  // More songs come from memory: still one library request.
  expect(api.recommendationCalls.filter((c) => c.startsWith('library'))).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Load more songs' })).toHaveCount(0);
  // Low-confidence songs come last, under Maybe, without a difficulty label.
  const maybe = page.getByRole('region', { name: 'Maybe' });
  await expect(maybe.locator('li')).toHaveCount(2);
  await expect(maybe.getByRole('button', { name: 'Sukiyaki by Kyu Sakamoto, Maybe' })).toBeVisible();
  await expect(maybe.locator('[data-difficulty]')).toHaveCount(0);
  await page.locator('ol li').nth(9).scrollIntoViewIfNeeded();
  await shot(page, '08-load-more');

  // ---- Song detail ----
  await page.getByRole('button', { name: /^Yoru ni Kakeru/ }).click();
  await expect(page.getByRole('heading', { name: 'Yoru ni Kakeru' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Fast lyrics' })).toBeVisible();
  await expect(page.getByText('Fast lyrics', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('Sing it lower than the artist')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Sing it an octave lower than the artist' })).toBeVisible();
  await expect(page.getByText('Played recently')).toBeVisible();
  // Spotify's player stands where the "Open in Spotify" button used to be.
  const player = page.getByTitle('Spotify player: Yoru ni Kakeru by YOASOBI');
  await expect(player).toHaveAttribute('src', 'https://open.spotify.com/embed/track/t2');
  await expect(page.frameLocator('iframe[title^="Spotify player"]').getByText('track t2')).toBeVisible();
  await expect(player).toHaveCSS('height', '152px');
  await expect(page.getByRole('link', { name: 'Open in Spotify' })).toHaveCount(0);
  await shot(page, '09-song-detail');

  await expect(page.getByRole('button', { name: 'Where this came from' })).toHaveCount(0);
  const bar = page.getByRole('img', { name: /Song goes from/ });
  const legend = page.getByText('song range');
  expect(await legend.evaluate((e) => getComputedStyle(e.parentElement!).opacity)).toBe('0');
  const before = await page.getByRole('button', { name: 'It went well' }).boundingBox();
  await bar.hover();
  await expect.poll(() => legend.evaluate((e) => getComputedStyle(e.parentElement!).opacity)).toBe('1');
  await expect(page.getByText('your range')).toBeVisible();
  expect(await page.getByRole('button', { name: 'It went well' }).boundingBox()).toEqual(before);
  await shot(page, '10-range-legend');

  await page.getByRole('button', { name: 'It went well' }).click();
  await expect(page.getByText('Thanks! That helps.')).toBeVisible();
  await expect.poll(() => api.feedback).toEqual([{ trackId: 't2', thumbs: 'up', difficulty: 'hard', octave: 'down', view: DEFAULT_VIEW }]);
  await shot(page, '11-feedback-thanks');

  await highBrowser.close();
});

test('returning user goes straight to results, and redo restarts the test', async ({ browser, baseURL }) => {
  const api = freshState();
  api.user = me({ low: 45, high: 72, source: 'test' });
  const context = await browser.newContext({ ...iPhone, baseURL });
  await mockApi(context, api);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('ol li')).toHaveCount(5);
  expect(api.savedRanges).toEqual([]);
  await page.waitForTimeout(1000);
  await shot(page, '12-returning-user');

  await page.getByRole('button', { name: 'Redo the singing test' }).click();
  await expect(page.getByText('Find a quiet spot')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hold to record your lowest note' })).toBeVisible({ timeout: 5000 });
  await context.close();
});

test("on a 360px phone Spotify's player gets the 280px it wants and the TV stays on the page", async ({ browser, baseURL }) => {
  const api = freshState();
  api.user = me({ low: 45, high: 72, source: 'test' });
  const context = await browser.newContext({ ...iPhone, viewport: { width: 360, height: 740 }, baseURL, reducedMotion: 'reduce' });
  await mockApi(context, api);
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: /^Plastic Love/ }).click();
  const player = page.getByTitle('Spotify player: Plastic Love by Mariya Takeuchi');
  await expect(player).toBeVisible();
  expect((await player.boundingBox())!.width).toBeGreaterThanOrEqual(280);
  // A player that is too wide for its screen pushes the whole TV past the page edge.
  const tv = (await page.getByRole('region', { name: 'Karaoke screen' }).boundingBox())!;
  expect(tv.x + tv.width).toBeLessThanOrEqual(360 - 16 + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await player.scrollIntoViewIfNeeded();
  await shot(page, '13-player-360px');
  await context.close();
});

test('a Maybe song has no difficulty, and its info says the range is an estimate', async ({ browser, baseURL }) => {
  const api = freshState();
  api.user = me({ low: 45, high: 72, source: 'test' });
  const context = await browser.newContext({ ...iPhone, baseURL, reducedMotion: 'reduce' });
  await mockApi(context, api);
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Load more songs' }).click();
  const maybe = page.getByRole('region', { name: 'Maybe' });
  await expect(maybe.getByText('We only have an estimate of these songs’ range.', { exact: false })).toBeVisible();
  await maybe.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await shot(page, '17-maybe-group');

  await maybe.getByRole('button', { name: /^Sukiyaki/ }).click();
  await expect(page.getByRole('heading', { name: 'Sukiyaki' })).toBeVisible();
  await expect(page.getByText('Maybe', { exact: true })).toBeVisible();
  await expect(page.getByText(/^(Easy|Medium|Hard)$/)).toHaveCount(0);
  await shot(page, '18-maybe-detail');

  await page.getByRole('button', { name: "It didn't go well" }).click();
  await expect.poll(() => api.feedback).toEqual([{ trackId: 't9', thumbs: 'down', difficulty: 'maybe', octave: 'none', view: DEFAULT_VIEW }]);
  await context.close();
});

test('pick songs you sing well', async ({ browser, baseURL }) => {
  const api = freshState();
  const context = await browser.newContext({ ...iPhone, baseURL });
  await mockApi(context, api);
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'or pick songs you sing well' }).click();
  // Mocked sign-in sends us back signed in, straight to picking.
  for (const title of ['Plastic Love', 'Dancing Queen']) await page.getByRole('button', { name: new RegExp(title) }).click();
  await page.waitForTimeout(1000);
  await shot(page, '13-pick-songs');
  await page.getByRole('button', { name: 'Use 2 songs' }).click();
  await expect(page.locator('ol li')).toHaveCount(5);
  expect(api.savedRanges).toEqual([{ low: 40, high: 64, source: 'songs' }]);
  await context.close();
});

test('mic permission denied shows a lyric line', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ...iPhone, baseURL });
  await mockApi(context, freshState());
  await context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
  });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await holdButton(page, /lowest note/, 300);
  await expect(page.getByText('We need your mic to hear you')).toBeVisible();
  await page.waitForTimeout(1200);
  await shot(page, '14-mic-denied');
  await context.close();
});

test('desktop layout', async ({ browser, baseURL }) => {
  const api = freshState();
  api.user = me({ low: 45, high: 72, source: 'test' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL });
  await mockApi(context, api);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('ol li')).toHaveCount(5);
  await page.waitForTimeout(1000);
  await shot(page, '15-desktop-results');
  await page.getByRole('button', { name: /^Lemon/ }).click();
  // On a wide screen the player stops at 460px instead of stretching across the TV.
  await expect(page.frameLocator('iframe[title^="Spotify player"]').getByText('track t1')).toBeVisible();
  expect((await page.getByTitle('Spotify player: Lemon by Kenshi Yonezu').boundingBox())!.width).toBe(460);
  await shot(page, '16-desktop-detail');
  await context.close();
});

test('sliders and decade chips: sliders reorder, chips filter with counts, all on a small phone', async ({ browser, baseURL }) => {
  const api = freshState();
  api.user = me({ low: 45, high: 72, source: 'test' });
  api.facts = true;
  // iPhone SE size: the smallest screen the controls must fit on with songs visible.
  const context = await browser.newContext({ ...iPhone, viewport: { width: 375, height: 667 }, baseURL, reducedMotion: 'reduce' });
  await mockApi(context, api);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('ol li')).toHaveCount(5);

  // The range bar, both control panels and at least three songs fit on screen together.
  const view = page.viewportSize()!;
  const inView = async (locator: ReturnType<Page['locator']>) => {
    const b = (await locator.boundingBox())!;
    return b.y >= 0 && b.y + b.height <= view.height;
  };
  expect(await inView(page.getByRole('region', { name: 'Tune' }))).toBe(true);
  expect(await inView(page.getByRole('group', { name: 'Filter songs' }))).toBe(true);
  for (let i = 0; i < 3; i++) expect(await inView(page.locator('ol li').nth(i))).toBe(true);
  // Nothing scrolls sideways: not the page, and not the chips, which wrap onto new lines instead.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const chipRows = page.getByRole('group', { name: 'Filter songs' }).locator('> div');
  expect(await chipRows.count()).toBeGreaterThan(0);
  for (const row of await chipRows.all()) expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.waitForTimeout(300);
  await shot(page, '19-controls');

  const titles = () => page.locator('ol li [class*="songTitle"]').allTextContents();
  const before = await titles();
  // No title line over the list; each song's reasons are sung in instead, once its row is on screen.
  await expect(page.locator('[data-lyric]')).toHaveCount(0);
  await expect(page.locator('ol li').first().locator('[data-reasons]')).toHaveAttribute('data-sing', 'singing');

  // A real drag: the thumb starts in the middle; pulling it to the right end switches the slider on.
  const difficulty = page.getByRole('slider', { name: 'Light work to Locked in' });
  await expect(difficulty).toHaveAttribute('aria-valuetext', 'not set');
  const box = (await difficulty.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(difficulty).toHaveAttribute('aria-valuetext', 'towards Locked in');
  await page.waitForTimeout(300);
  await shot(page, '20-slider-locked-in');

  // Each slider, from the keyboard, to each end; every move reorders the songs.
  const orders = new Set([JSON.stringify(before)]);
  for (const [left, right] of [
    ['Light work', 'Locked in'],
    ['Rediscover', 'On repeat'],
    ['Deep cuts', 'Pop hits'],
    ['Slow jams', 'Upbeat tracks'],
  ] as const) {
    const slider = page.getByRole('slider', { name: `${left} to ${right}` });
    await slider.press('Home');
    await expect(slider).toHaveAttribute('aria-valuetext', `towards ${left}`);
    orders.add(JSON.stringify(await titles()));
    if (left === 'Slow jams') await shot(page, '22-tempo-slow-jams');
    await slider.press('End');
    await expect(slider).toHaveAttribute('aria-valuetext', `towards ${right}`);
    orders.add(JSON.stringify(await titles()));
    if (left === 'Slow jams') await shot(page, '22-tempo-upbeat-tracks');
  }
  expect(orders.size).toBeGreaterThan(2);
  await page.waitForTimeout(300);
  await shot(page, '21-sliders-set');

  // Reset unsets every slider and brings back the first order.
  await page.getByRole('button', { name: 'Reset sliders' }).click();
  for (const s of await page.getByRole('slider').all()) await expect(s).toHaveAttribute('aria-valuetext', 'not set');
  expect(await titles()).toEqual(before);
  expect(api.recommendationCalls).toHaveLength(1);

  // Decade chips: counts, a disabled empty decade, filtering, and clearing.
  await expect(page.getByRole('button', { name: '80s, 3 songs' })).toBeVisible();
  await expect(page.getByRole('button', { name: '90s, 0 songs' })).toBeDisabled();
  await page.getByRole('button', { name: '80s, 3 songs' }).click();
  await expect(page.locator('ol li')).toHaveCount(3);
  await expect(page.locator('ol li').first()).toContainText('1984');
  await page.waitForTimeout(300);
  await shot(page, '24-decade-80s');
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('ol li')).toHaveCount(5);
  await context.close();
});

// ---- Reason wording (QWW-30) ----

/** Songs in the order shown, with the reasons their label can get: every new wording, and the widest pairs. */
const REASON_SHOWCASE: [song: number, reasons: string[]][] = [
  [0, ['In your sweet spot', 'Top songs this month']],
  [1, ['Some high notes', 'Top songs this past year']],
  [2, ['Lots of high notes', 'Top songs, past 6 months']],
  [4, ['Some low notes', 'Played recently']],
  [5, ['Lots of low notes', 'Top songs, past 6 months']],
];

for (const width of [375, 1280]) {
  test(`reasons read short, and a card wraps only between reasons, at ${width} px`, async ({ browser, baseURL }) => {
    const api = freshState();
    api.user = me({ low: 45, high: 72, source: 'test' });
    const phone = width < 600;
    const context = await browser.newContext({
      ...(phone ? iPhone : {}),
      viewport: { width, height: phone ? 812 : 800 },
      deviceScaleFactor: 2,
      baseURL,
      reducedMotion: 'reduce',
    });
    await mockApi(context, api);
    // The route added last is tried first: it serves the showcase instead of the plain fixture.
    const showcase = allMatches();
    showcase.matches = REASON_SHOWCASE.map(([song, reasons]) => ({ ...match(song), reasons }));
    await context.route('**/api/recommendations*', (route) => route.fulfill({ json: showcase }));
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('ol li')).toHaveCount(REASON_SHOWCASE.length);

    // Each card reads as its reasons joined by a dot (the words of one reason are joined by no-break spaces).
    const lines = page.locator('ol li [data-reasons]');
    expect((await lines.allTextContents()).map((t) => t.replace(/\s/g, ' '))).toEqual(REASON_SHOWCASE.map(([, r]) => r.join(' · ')));

    // The height of every word on a card, grouped by reason: a reason broken over two lines has two heights.
    const heights = await lines.evaluateAll((els) =>
      els.map((el) => {
        const reasons: number[][] = [[]];
        for (const w of el.querySelectorAll<HTMLElement>('[class*="reasonWord"]')) {
          if (w.textContent === '·') reasons.push([]);
          else reasons[reasons.length - 1]!.push(Math.round(w.getBoundingClientRect().top));
        }
        return reasons;
      }),
    );
    for (const card of heights) {
      for (const reason of card) expect(new Set(reason).size, `a reason is split across lines: ${JSON.stringify(card)}`).toBe(1);
    }
    // On a phone the cards are narrow enough to wrap, so the check above has something to catch.
    if (phone) expect(heights.some(([first, second]) => second![0]! > first![0]!)).toBe(true);
    await page.waitForTimeout(300);
    await shot(page, `reasons-${width}-results`);
    if (phone) {
      // The TV screen scrolls: the last card sits under the fold.
      await page.locator('ol li').last().scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await shot(page, `reasons-${width}-results-end`);
    }

    // The song page says the same.
    await page.getByRole('button', { name: /^Mr\. Brightside/ }).click();
    await expect(page.getByRole('heading', { name: 'Mr. Brightside' })).toBeVisible();
    await expect(page.locator('[class*="detailReasons"]')).toHaveText('Lots of low notes · Top songs, past 6 months');
    await page.waitForTimeout(300);
    await shot(page, `reasons-${width}-song`);
    await context.close();
  });
}

// QWW-33: the difficulty slider changes the list along its whole length, and its position means the
// label the song shows: Easy songs towards Light work, Medium in the middle, Hard towards Locked in.
// The long list has a few Hard, some Medium and mostly Easy songs. On a phone (375 px) and a desktop
// (1280 px), the slider goes to 25, 50, 75 and 100%, and every step shows other songs first.
for (const viewport of [{ width: 375, height: 667 }, { width: 1280, height: 800 }]) {
  test(`the difficulty slider changes the list along its whole length, at ${viewport.width} px`, async ({ browser, baseURL }) => {
    const api = freshState();
    api.user = me({ low: 45, high: 72, source: 'test' });
    api.long = true;
    // The phone is an iPhone SE; the desktop has no touch, like the desktop layout test.
    const context = await browser.newContext({ ...(viewport.width < 600 ? iPhone : {}), viewport, baseURL, reducedMotion: 'reduce' });
    await mockApi(context, api);
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('ol li')).toHaveCount(5);

    const titles = () => page.locator('ol li [class*="songTitle"]').allTextContents();
    const labels = () => page.locator('ol li [class*="pill"]').allTextContents();
    const slider = page.getByRole('slider', { name: 'Light work to Locked in' });
    const lists: string[][] = [];
    const firstLabels: string[] = [];
    for (const percent of [25, 50, 75, 100]) {
      const before = await titles();
      await slider.fill(String(percent));
      await expect.poll(titles, { message: `the list at ${percent}% is the list before it` }).not.toEqual(before);
      await page.waitForTimeout(300);
      lists.push(await titles());
      firstLabels.push((await labels())[0]!);
      await shot(page, `qww33-difficulty-${percent}-${viewport.width}px`);
    }
    // The label leads where the thumb is: Easy at 25%, Medium at 50%, Hard at 100%.
    expect([firstLabels[0], firstLabels[1], firstLabels[3]]).toEqual(['Easy', 'Medium', 'Hard']);

    // The ends keep their meaning: Light work lists Easy songs first, Locked in Hard ones; each end lists a different song first.
    await slider.press('Home');
    await expect.poll(async () => (await labels())[0]).toBe('Easy');
    const easiest = (await titles())[0];
    await slider.press('End');
    await expect.poll(async () => (await labels())[0]).toBe('Hard');
    expect((await titles())[0]).not.toBe(easiest);
    await context.close();
  });
}

// QWW-33: the song page shows where the song's singing time sits across your range, so "Easy" is
// explainable (a song that spans most of your range but sits in the middle), and a song sung an octave
// away is drawn as you would sing it, with the recording as a dashed outline.
for (const viewport of [{ width: 375, height: 667 }, { width: 1280, height: 800 }]) {
  test(`the song page shows time in your range and the octave shift, at ${viewport.width} px`, async ({ browser, baseURL }) => {
    const api = freshState();
    // D#2 to D#4, the range in the feedback that asked for this.
    api.user = me({ low: 39, high: 63, source: 'test' });
    const track = (id: string, title: string, artist: string, playRank: number) => ({
      id,
      title,
      artist,
      artistId: `a${id}`,
      spotifyUrl: `https://open.spotify.com/track/${id}`,
      playRank,
    });
    const easy: Match = {
      track: track('b1', 'Song Sung Blue', 'Neil Diamond', 0),
      range: { low: 43, high: 60, tessitura: 52, source: 'note-file', confidence: 'high', fastLyrics: false },
      difficulty: 'easy',
      octave: 'none',
      parts: { comfort: 0.9, familiarity: 1, popularity: 0.8, popularityKnown: true, penalty: 0 },
      reasons: ['In your sweet spot', 'Crowd favourite'],
      strain: 0.1,
      shape: [0, 4, 12, 24, 30, 20, 8, 2, 0, 0, 0, 0],
    };
    // Rasputin as the catalogue serves it (the real numbers): a duet matched on part 2, which sings B3 to B4
    // (part 1 sings F#4 to D6, out of reach). The range sent is the matched part's, so sung an octave down it
    // is B2 to B3, inside D#2 to D#4; with the whole song's range (part 1's) the bar ran past D5.
    const octave: Match = {
      track: track('b2', 'Rasputin [DUET]', 'Boney M.', 1),
      range: {
        low: 59,
        high: 71,
        tessitura: 64.8,
        source: 'note-file',
        confidence: 'high',
        fastLyrics: false,
        duet: true,
        parts: [
          { low: 66, high: 86, tessitura: 71.5, fastLyrics: false },
          { low: 59, high: 71, tessitura: 64.8, fastLyrics: false },
        ],
      },
      part: 2,
      difficulty: 'easy',
      octave: 'down',
      parts: { comfort: 0.9, familiarity: 1, popularity: 0.8, popularityKnown: true, penalty: 0 },
      reasons: ['In your sweet spot'],
      strain: 0.06,
      shape: [0, 0, 0, 1, 10, 21, 15, 25, 13, 9, 6, 0],
    };
    api.response = { matches: [easy, octave], nextOffset: null, sources: {}, complete: true } as RecommendationsResponse;
    const context = await browser.newContext({ ...(viewport.width < 600 ? iPhone : {}), viewport, baseURL, reducedMotion: 'reduce' });
    await mockApi(context, api);
    const page = await context.newPage();
    await page.goto('/');

    await page.getByRole('button', { name: /^Song Sung Blue/ }).click();
    await expect(page.getByRole('heading', { name: 'Song Sung Blue' })).toBeVisible();
    await expect(page.locator('[class*="barShape"] i')).toHaveCount(12);
    await expect(page.locator('[class*="barOriginal"]')).toHaveCount(0);
    await page.waitForTimeout(300);
    await shot(page, `qww33-bar-density-${viewport.width}px`);

    await page.getByRole('button', { name: 'Back to songs' }).click();
    await page.getByRole('button', { name: /^Rasputin/ }).click();
    await expect(page.getByRole('heading', { name: 'Rasputin [DUET]' })).toBeVisible();
    await expect(page.getByText('Duet: take part 2')).toBeVisible();
    await expect(page.locator('[class*="barOriginal"]')).toHaveCount(1);
    // The song as sung never passes the end of your range, so nothing looks like an overflow.
    const user = (await page.locator('[class*="barUser"]').boundingBox())!;
    const song = (await page.locator('[class*="barSong"]').boundingBox())!;
    expect(song.x + song.width).toBeLessThanOrEqual(user.x + user.width + 0.5);
    expect(song.x).toBeGreaterThanOrEqual(user.x - 0.5);
    await page.waitForTimeout(300);
    await shot(page, `qww33-bar-octave-${viewport.width}px`);
    await context.close();
  });
}

// ---- The Spotify logo (grey, or green with "Logged in as" and Log out) and the Reset icon ----

const SPOTIFY_GREEN = 'rgb(29, 185, 84)';
const LOGO_GREY = 'rgba(244, 241, 246, 0.4)';
const ICON_GREY = 'rgba(244, 241, 246, 0.56)';
const PINK = 'rgb(255, 46, 147)';

interface Walk {
  size: { width: number; height: number };
  /** A finger taps the logo to open its box; otherwise a mouse points at it. */
  finger: boolean;
  /** Real transitions and sung reasons, instead of reduced motion. */
  motion?: boolean;
  /** Take the screenshots that look the same for a finger and a mouse. */
  rest?: boolean;
}

/**
 * One walk at one size, starting signed in: the green logo and its box, the Reset icon (no layout
 * jump, grey, pink under a mouse), then Log out and the catalogue for the same range. Screenshots go
 * to test-results/screens, named after the size.
 */
async function walkLogoAndReset(browser: Browser, baseURL: string | undefined, { size, finger, motion = false, rest = true }: Walk) {
  const api = freshState();
  api.user = me({ low: 45, high: 72, source: 'test' });
  // The config's default device is a phone, which cannot hover and would carry over to a context that
  // only sets a viewport; a mouse walk must say it is a desktop browser.
  const context = await browser.newContext({
    ...(finger ? iPhone : devices['Desktop Chrome']),
    viewport: size,
    baseURL,
    reducedMotion: motion ? 'no-preference' : 'reduce',
  });
  await mockApi(context, api);
  const page = await context.newPage();
  const w = size.width;
  const shotRest = async (name: string) => {
    if (rest) await shot(page, `${name}-${w}`);
  };
  const logo = page.getByRole('button', { name: 'Spotify account' });
  const who = page.getByText('Logged in as Quinn');
  const logOut = page.getByRole('button', { name: 'Log out' });
  const connect = page.getByRole('button', { name: 'Connect to Spotify' }).first();
  const tune = page.getByRole('region', { name: 'Tune' });
  const reset = page.getByRole('button', { name: 'Reset sliders' });
  // A finger taps; a mouse points at the logo and clicks.
  const open = () => (finger ? logo.tap() : logo.hover());
  const press = (target: typeof logo) => (finger ? target.tap() : target.click());
  // Somewhere neutral: a tap on the Tune title, or the pointer over a song near the bottom.
  const away = () => (finger ? page.getByRole('heading', { name: 'Tune' }).tap() : page.mouse.move(w / 2, size.height - 40));

  await page.goto('/');
  await expect(page.locator('ol li')).toHaveCount(5);
  await page.waitForTimeout(motion ? 2000 : 300);

  // ---- Signed in: a green logo that says nothing until asked ----
  await expect(page.getByRole('button', { name: 'Connect to Spotify' })).toHaveCount(0);
  await expect(logo).toHaveCSS('color', SPOTIFY_GREEN);
  await expect(who).toBeHidden();
  await shotRest('25-logo-signed-in');

  // ---- The box: a tap opens it on a phone; pointing at the logo shows it on a desktop ----
  await open();
  await expect(who).toBeVisible();
  await expect(logOut).toBeVisible();
  if (finger) await expect(logo).toHaveAttribute('aria-expanded', 'true');
  await page.waitForTimeout(300);
  await shot(page, `26-box-${finger ? 'tapped' : 'hover'}-${w}`);
  if (!finger) {
    // From the logo to the box a pixel at a time, the box is never lost on the way: nothing sits between them.
    const from = (await logo.boundingBox())!;
    const to = (await who.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 30 });
    await expect(who).toBeVisible();
  }
  await away();
  await expect(who).toBeHidden();
  if (finger) await expect(logo).toHaveAttribute('aria-expanded', 'false');

  // ---- Reset: a circular-arrow icon in the header's own height, where the word used to be ----
  await expect(reset).toHaveCount(0);
  const heightBefore = (await tune.boundingBox())!.height;
  await page.getByRole('slider', { name: 'Light work to Locked in' }).press('End');
  // Let go of the slider, so its keyboard focus ring is not in the Reset screenshots.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(reset).toBeVisible();
  await expect(page.getByText('Reset', { exact: true })).toHaveCount(0);
  await expect(reset.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  expect(Math.abs((await tune.boundingBox())!.height - heightBefore)).toBeLessThan(0.5);
  await expect(reset).toHaveCSS('color', ICON_GREY);
  await shotRest('27-reset-rest');
  if (finger) {
    // A phone cannot hover, so pink-on-hover can never get stuck after a tap.
    expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(false);
  } else {
    await reset.hover();
    await expect(reset).toHaveCSS('color', PINK);
    await page.waitForTimeout(200);
    await shot(page, `28-reset-hover-${w}`);
    await away();
  }
  await press(reset);
  for (const s of await page.getByRole('slider').all()) await expect(s).toHaveAttribute('aria-valuetext', 'not set');
  await expect(reset).toHaveCount(0);
  expect(Math.abs((await tune.boundingBox())!.height - heightBefore)).toBeLessThan(0.5);

  // ---- Log out: the session ends, the library goes, the catalogue answers for the same range ----
  await open();
  await expect(who).toBeVisible();
  await press(logOut);
  await expect.poll(() => api.logouts).toBe(1);
  await expect(connect).toBeVisible();
  await expect(logo).toHaveCount(0);
  await expect(who).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Rediscover to On repeat' })).toHaveCount(0);
  await expect(page.locator('ol li')).toHaveCount(5);
  expect(api.recommendationCalls).toEqual(['library ?all=1', 'catalogue ?low=45&high=72&all=1']);
  expect(await page.evaluate(() => localStorage.getItem('kd.range'))).toBe(JSON.stringify({ low: 45, high: 72 }));

  // ---- Signed out again: the grey logo, green only under a mouse, as before ----
  if (!finger) await page.mouse.move(w / 2, size.height - 40);
  await expect(connect).toHaveCSS('color', LOGO_GREY);
  // Playwright scrolls a button into view before it taps it; the screenshot should start at the top.
  await page.evaluate(() => document.querySelector('[class*="screenInner"]')?.scrollTo(0, 0));
  // The catalogue rows sing their reasons in again; wait it out so the screenshot is the settled screen.
  await page.waitForTimeout(motion ? 2200 : 300);
  await shotRest('29-logo-signed-out');
  if (!finger) {
    await connect.hover();
    await expect(connect).toHaveCSS('color', SPOTIFY_GREEN);
  }

  // The session is gone for good: a reload is still the catalogue for the same range.
  await page.reload();
  await expect(connect).toBeVisible();
  await expect(page.locator('ol li')).toHaveCount(5);
  expect(api.recommendationCalls.at(-1)).toBe('catalogue ?low=45&high=72&all=1');
  expect(api.logouts).toBe(1);
  await context.close();
}

test('Spotify logo and Reset icon on a 375 px phone: a tap opens the box', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  await walkLogoAndReset(browser, baseURL, { size: { width: 375, height: 667 }, finger: true });
});

test('Spotify logo and Reset icon with a mouse at 375 px: pointing opens the box', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  await walkLogoAndReset(browser, baseURL, { size: { width: 375, height: 667 }, finger: false, rest: false });
});

test('Spotify logo and Reset icon on a 1280 px desktop, with real transitions', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  await walkLogoAndReset(browser, baseURL, { size: { width: 1280, height: 800 }, finger: false, motion: true });
});

// QWW-31: Easy (Commodores) is stored from a note file written an octave above Lionel Richie's recording.
// Its stored range goes through the real octave fix and matcher, then to the screen, for a singer who
// sings F2 to C5 and sings Easy in Lionel Richie's octave.
test('Easy by the Commodores shows no octave mark for F2 to C5', async ({ browser, baseURL }) => {
  const evidence = JSON.parse(readFileSync(path.resolve('data/octave-evidence.json'), 'utf8')) as OctaveEvidence;
  const user = { low: 41, high: 72, source: 'test' } as const;
  const stored: SongRange = { low: 65, high: 78, tessitura: 71.15, source: 'note-file', confidence: 'high', fastLyrics: false };
  const range = correctOctave('commodores|easy', stored, evidence);
  const fit = matchSong(user, range)!;
  const track = { id: 'easy', title: 'Easy', artist: 'Commodores', artistId: 'a-easy', spotifyUrl: 'https://open.spotify.com/track/easy', playRank: 0 };
  const api = freshState();
  api.user = me(user);
  api.response = { matches: [toMatch(track, range, fit)], nextOffset: null, sources: {}, complete: true };
  expect(fit.octave).toBe('none');

  for (const [name, viewport] of [['375', { width: 375, height: 812 }], ['1280', { width: 1280, height: 800 }]] as const) {
    const context = await browser.newContext({ ...iPhone, viewport, baseURL, reducedMotion: 'reduce' });
    await mockApi(context, api);
    const page = await context.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: /^Easy/ }).click();
    await expect(page.getByRole('heading', { name: 'Easy' })).toBeVisible();
    await expect(page.getByRole('img', { name: /octave/ })).toHaveCount(0);
    await expect(page.getByText(/lower than the artist|higher than the artist/)).toHaveCount(0);
    await shot(page, `qww-31-easy-${name}`);
    await context.close();
  }
});
