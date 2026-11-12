// End-to-end walk through the karaoke screen. The real API is built elsewhere,
// so every /api/* call is mocked with contract-shaped fixtures. Chromium's fake
// microphone plays a generated WAV; it takes one file per launch, so the low
// note and the high note are sung in two separate browser launches, with the
// test progress carried over in sessionStorage like after a reload.

import { chromium, devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CatalogueFeedbackRequest, FeedbackRequest, Match, MeResponse, RecommendationsResponse, SetlistRequest, SongRange, VocalRange } from '../../src/lib/contracts';
import { matchSong, toMatch } from '../../src/lib/songs/match';
import { correctOctave, type OctaveEvidence } from '../../src/lib/songs/octave';
import { DEFAULTS } from '../../src/lib/setlist/defaults';
import { allMatches, knownSongs, longList, match, me } from '../fixtures/screen';
import { setlistAnswer } from '../helpers/setlistServer';

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
        return json(state.response ?? (state.long ? longList() : allMatches()));
      case 'GET /api/catalogue/recommendations':
        state.recommendationCalls.push(`catalogue ${url.search}`);
        return json(state.long ? longList() : allMatches());
      case 'POST /api/setlist':
        return json(setlistAnswer(state.response ?? (state.long ? longList() : allMatches()), req.postDataJSON() as SetlistRequest, state.user !== null));
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
/**
 * The `view` a feedback request carries when nothing on the Setlist tuner was touched: its defaults, as feedbackView
 * (src/lib/client/funnel.ts) lists them. Difficulty and Popularity are on; History, Tempo and Era start off.
 */
const DEFAULT_VIEW = {
  difficulty: DEFAULTS.difficulty / 100,
  familiarity: null,
  popularity: DEFAULTS.popularity / 100,
  tempo: null,
  decade: null,
  mood: null,
  duetsOnly: false,
};

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

  // The mic step (QWW-50): our own screen, then the browser's question (the fake UI says yes), then the note. Its
  // screens are checked in mic-permission.spec.ts; here the flow just has to pass through it.
  await page1.getByRole('button', { name: 'Turn on microphone', exact: true }).click({ timeout: 5000 });

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
  // A reload let go of the microphone, so the half-done test goes by way of the mic step to the high note.
  await page.getByRole('button', { name: 'Turn on microphone', exact: true }).click();
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
  // The results are the Setlist tuner, on the one TV every step is on. Catalogue songs are nobody's library, so
  // there is no listening history to tune by.
  await expect(page.getByRole('heading', { name: 'Tune your setlist' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Karaoke screen' })).toHaveCount(1);
  await expect(page.locator('#slider-history')).toBeDisabled();
  await page.waitForTimeout(800);
  await shot(page, '07-catalogue-results');

  // ---- Connect Spotify (mocked redirect back to /?signedIn=1): the range carries over ----
  // The first tap on a phone shows the button's tooltip (R30); the second connects.
  const connect = page.getByRole('button', { name: 'Connect to Spotify' });
  await connect.click();
  await connect.click();
  await expect(page.locator('#slider-history')).toBeEnabled();
  expect(api.savedRanges).toEqual([{ low: 45, high: 72, source: 'test' }]);
  expect(api.recommendationCalls.at(-1)).toBe('library ?all=1');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('[data-row]')).toHaveCount(10);
  await page.waitForTimeout(1000);
  await shot(page, '07-results');

  // Every song is on the list at once (no paging), from the one library request. Songs whose range is only an
  // estimate come last, and their row says Maybe.
  await expect(page.getByRole('button', { name: 'Load more songs' })).toHaveCount(0);
  expect(api.recommendationCalls.filter((c) => c.startsWith('library'))).toHaveLength(1);
  const maybeRows = page.locator('[data-row]:has(button[aria-label$=", Maybe"])');
  await expect(maybeRows).toHaveCount(2);
  expect(await maybeRows.evaluateAll((els) => els.map((el) => el.getAttribute('data-rank')))).toEqual(['9', '10']);
  await expect(page.getByRole('button', { name: 'Sukiyaki by Kyu Sakamoto, Maybe' })).toBeVisible();
  await page.locator('[data-row]').last().scrollIntoViewIfNeeded();
  await shot(page, '08-all-songs');

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
  // The pointer is where the row was clicked, which depends on where the ranking put it (QWW-58 moved the octave jumps down the
  // list), and can be over the bar on the song page. Off it, the legend goes to rest (it fades, so it is waited for).
  await page.mouse.move(1, 1);
  await expect.poll(() => legend.evaluate((e) => getComputedStyle(e.parentElement!).opacity)).toBe('0');
  const before = await page.getByRole('button', { name: 'It went well' }).boundingBox();
  // A phone has no hover (R20): a tap on the chart opens its legend. The note names need no tap (R25); setlist-song.spec.ts has both, and the pointer's hover.
  await bar.tap();
  await expect.poll(() => legend.evaluate((e) => getComputedStyle(e.parentElement!).opacity)).toBe('1');
  await expect(page.getByText('your range')).toBeVisible();
  expect(await page.getByRole('button', { name: 'It went well' }).boundingBox()).toEqual(before);
  await shot(page, '10-range-legend');

  await page.getByRole('button', { name: 'It went well' }).click();
  await expect(page.getByText('Thanks! That helps.')).toBeVisible();
  // It stays (R26): the picked thumb is selected, and neither can be tapped again.
  await expect(page.getByRole('button', { name: 'It went well' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'It went well' })).toBeDisabled();
  await expect(page.getByRole('button', { name: "It didn't go well" })).toBeDisabled();
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
  await expect(page.locator('[data-row]')).toHaveCount(10);
  expect(api.savedRanges).toEqual([]);
  await page.waitForTimeout(1000);
  await shot(page, '12-returning-user');

  await page.getByRole('button', { name: 'Redo the range test' }).click();
  await expect(page.getByText('Find a quiet spot')).toBeVisible();
  // The microphone was let go at the results, so the test starts again at the mic step.
  await expect(page.getByRole('button', { name: 'Turn on microphone', exact: true })).toBeVisible({ timeout: 5000 });
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
  // On a phone the TV has the page's 10 px of padding (Round 6A §3.3), so it ends at 350.
  expect(tv.x + tv.width).toBeLessThanOrEqual(360 - 10 + 1);
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
  // The tuner's list has no Maybe section: a song whose range is only an estimate comes last, and its row says Maybe.
  const maybe = page.getByRole('button', { name: 'Sukiyaki by Kyu Sakamoto, Maybe' });
  await expect(maybe).toBeVisible();
  await maybe.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await shot(page, '17-maybe-row');

  await maybe.click();
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
  await expect(page.locator('[data-row]')).toHaveCount(10);
  expect(api.savedRanges).toEqual([{ low: 40, high: 64, source: 'songs' }]);
  await context.close();
});

test('mic permission denied shows what to do, for this browser (more in mic-permission.spec.ts)', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ...iPhone, baseURL });
  await mockApi(context, freshState());
  await context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
  });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByRole('button', { name: 'Turn on microphone', exact: true }).click({ timeout: 5000 });
  await expect(page.getByText('The microphone is blocked')).toBeVisible();
  await expect(page.getByText('Website Settings')).toBeVisible();
  await page.waitForTimeout(1200);
  await shot(page, '14-mic-denied');
  await context.close();
});

test('desktop layout: the TV is phone-shaped, and the song page fits it', async ({ browser, baseURL }) => {
  const api = freshState();
  api.user = me({ low: 45, high: 72, source: 'test' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL });
  await mockApi(context, api);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('[data-row]')).toHaveCount(10);
  await page.waitForTimeout(1000);
  await shot(page, '15-desktop-results');
  await page.getByRole('button', { name: /^Lemon/ }).click();
  // On a wide screen the TV is phone-shaped (R2, QWW-57: 390 px wide), so the player is the width it is on a phone: the 280
  // px Spotify wants at least, and inside the frame.
  await expect(page.frameLocator('iframe[title^="Spotify player"]').getByText('track t1')).toBeVisible();
  const player = (await page.getByTitle('Spotify player: Lemon by Kenshi Yonezu').boundingBox())!;
  const frame = (await page.getByRole('region', { name: 'Karaoke screen' }).boundingBox())!;
  expect(frame.width).toBeCloseTo(390, 0);
  expect(player.width).toBeGreaterThanOrEqual(280);
  expect(player.x).toBeGreaterThanOrEqual(frame.x);
  expect(player.x + player.width).toBeLessThanOrEqual(frame.x + frame.width);
  await shot(page, '16-desktop-detail');
  await context.close();
});

// ---- Reason wording (QWW-30) ----
// The reasons used to be sung under each row. The tuner's rows do not show them (spec section 5), so the song page is
// where they read.

/** Songs in the order shown, with the reasons their label can get: every new wording, and the widest pairs. */
const REASON_SHOWCASE: [song: number, reasons: string[]][] = [
  [0, ['In your sweet spot', 'Top songs this month']],
  [1, ['Some high notes', 'Top songs this past year']],
  [2, ['Lots of high notes', 'Top songs, past 6 months']],
  [4, ['Some low notes', 'Played recently']],
  [5, ['Lots of low notes', 'Top songs, past 6 months']],
];

for (const width of [375, 1280]) {
  test(`the song page's reasons read short, at ${width} px`, async ({ browser, baseURL }) => {
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
    await context.route('**/api/setlist', (route) => route.fulfill({ json: setlistAnswer(showcase, route.request().postDataJSON() as SetlistRequest, true) }));
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('[data-row]')).toHaveCount(REASON_SHOWCASE.length);
    await page.waitForTimeout(300);
    await shot(page, `reasons-${width}-results`);

    await page.getByRole('button', { name: /^Mr\. Brightside/ }).click();
    await expect(page.getByRole('heading', { name: 'Mr. Brightside' })).toBeVisible();
    await expect(page.locator('[class*="detailReasons"]')).toHaveText('Lots of low notes · Top songs, past 6 months');
    await page.waitForTimeout(300);
    await shot(page, `reasons-${width}-song`);
    await context.close();
  });
}

// QWW-33: the Difficulty control changes the list, and its position means the label the song shows: Easy songs towards
// Light work, Medium in the middle, Hard towards Locked in. The long list has a few Hard, some Medium and mostly Easy
// songs. On a phone (375 px) and a desktop (1280 px) the Difficulty gear of the Setlist tuner goes to 0, 25, 50, 75 and 100.
// (Under the spec's model a song sits on the gear by its difficulty score, not by its rank in the list, so two targets
// that both lie beyond the last Medium song can list the Hard songs alike: what is held is the label that leads, and
// that the Easy, Medium and Hard ends each lead with their own songs.)
for (const viewport of [{ width: 375, height: 667 }, { width: 1280, height: 800 }]) {
  test(`the Difficulty gear leads with Easy, Medium and Hard songs along its length, at ${viewport.width} px`, async ({ browser, baseURL }) => {
    const api = freshState();
    api.user = me({ low: 45, high: 72, source: 'test' });
    api.long = true;
    // The phone is an iPhone SE; the desktop has no touch, like the desktop layout test.
    const context = await browser.newContext({ ...(viewport.width < 600 ? iPhone : {}), viewport, baseURL, reducedMotion: 'reduce' });
    await mockApi(context, api);
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('[data-row]')).toHaveCount(40);
    // Both of these open the sheet in mini (the expanded sheet leaves fewer than 3 rows, QWW-57); this walk needs every gear.
    if ((await page.locator('#app').getAttribute('data-mode')) === 'mini') await page.locator('#handle').click();
    await expect(page.locator('#app')).toHaveAttribute('data-mode', 'expanded');

    const titles = () => page.locator('[data-row-title]').allTextContents();
    // A row's button ends its name with the song's label: "..., Easy". (The ▶ in the slot beside it is not that button.)
    const leadLabel = async () => ((await page.locator('[data-row] > button').first().getAttribute('aria-label')) ?? '').split(', ').at(-1);
    // The list is re-ranked a moment after the thumb moves: read it once it has stopped changing.
    const settled = async () => {
      let before = JSON.stringify(await titles());
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(60);
        const now = JSON.stringify(await titles());
        if (now === before) return now;
        before = now;
      }
      return before;
    };
    // Difficulty alone: Popularity, on by default, counts double and would lead with its own songs.
    await page.locator('button[data-reset="popularity"]').click();
    const slider = page.locator('#slider-difficulty');
    const lists: string[] = [];
    const labels: (string | undefined)[] = [];
    for (const percent of [0, 25, 50, 75, 100]) {
      await slider.fill(String(percent));
      expect(await slider.inputValue()).toBe(String(percent));
      lists.push(await settled());
      labels.push(await leadLabel());
      await shot(page, `qww33-difficulty-${percent}-${viewport.width}px`);
    }
    // The label leads where the target is: Easy at the low end and Hard at the top. QWW-47's ranking leans easy (a song
    // easier than the target costs little), so the middle may still lead with an Easy song or a Medium one.
    expect([labels[0], labels[4]]).toEqual(['Easy', 'Hard']);
    expect(['Easy', 'Medium']).toContain(labels[2]);
    expect(['Easy', 'Medium', 'Hard']).toContain(labels[3]);
    // The ends lead with different songs, and the control changes the list more than once along its length.
    expect(new Set([lists[0], lists[4]]).size).toBe(2);
    expect(new Set(lists).size).toBeGreaterThanOrEqual(4);

    // The keys keep the ends' meaning: Home is Light work, End is Locked in.
    await slider.press('Home');
    await expect.poll(leadLabel).toBe('Easy');
    const easiest = (await titles())[0];
    await slider.press('End');
    await expect.poll(leadLabel).toBe('Hard');
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
    // One bar for each bin that has singing in it and room inside the song's pink stretch (43 to 60): bins 2 to 7 of the
    // mock's shape. Empty bins draw nothing (QWW-55), and bin 1 (4%) lies wholly below the song, so it draws nothing too.
    await expect(page.locator('[class*="barShape"] i')).toHaveCount(6);
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

// ---- The Spotify logo (grey, or green with "Logged in as" and Log out) ----

const SPOTIFY_GREEN = 'rgb(29, 185, 84)';
const LOGO_GREY = 'rgba(244, 241, 246, 0.4)';

interface Walk {
  size: { width: number; height: number };
  /** A finger taps the logo to open its box; otherwise a mouse points at it. */
  finger: boolean;
  /** Real transitions, instead of reduced motion. */
  motion?: boolean;
  /** Take the screenshots that look the same for a finger and a mouse. */
  rest?: boolean;
}

/**
 * One walk at one size, starting signed in: the green logo and its box, then Log out and the catalogue for the same
 * range. Screenshots go to test-results/screens, named after the size.
 */
async function walkLogo(browser: Browser, baseURL: string | undefined, { size, finger, motion = false, rest = true }: Walk) {
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
  // A finger taps; a mouse points at the logo and clicks.
  const open = () => (finger ? logo.tap() : logo.hover());
  const press = (target: typeof logo) => (finger ? target.tap() : target.click());
  // Somewhere neutral: a tap on the page's padding below the TV (the open box covers the heading now that it sits under the
  // row of the logo), or the pointer over the sheet near the bottom.
  const away = () => (finger ? page.touchscreen.tap(w / 2, size.height - 5) : page.mouse.move(w / 2, size.height - 40));

  await page.goto('/');
  await expect(page.locator('[data-row]')).toHaveCount(10);
  await page.waitForTimeout(motion ? 1000 : 300);

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

  // ---- Log out: the session ends, the library goes, the catalogue answers for the same range ----
  await open();
  await expect(who).toBeVisible();
  await press(logOut);
  await expect.poll(() => api.logouts).toBe(1);
  await expect(connect).toBeVisible();
  await expect(logo).toHaveCount(0);
  await expect(who).toHaveCount(0);
  // The catalogue has no listening history, so the History gear is off and cannot be used.
  await expect(page.locator('#slider-history')).toBeDisabled();
  await expect(page.locator('[data-row]')).toHaveCount(10);
  expect(api.recommendationCalls).toEqual(['library ?all=1', 'catalogue ?low=45&high=72&all=1']);
  expect(await page.evaluate(() => localStorage.getItem('kd.range'))).toBe(JSON.stringify({ low: 45, high: 72 }));

  // ---- Signed out again: the grey logo, green only under a mouse, as before ----
  if (!finger) await page.mouse.move(w / 2, size.height - 40);
  await expect(connect).toHaveCSS('color', LOGO_GREY);
  await page.waitForTimeout(motion ? 500 : 300);
  await shotRest('29-logo-signed-out');
  if (!finger) {
    await connect.hover();
    await expect(connect).toHaveCSS('color', SPOTIFY_GREEN);
  }

  // The session is gone for good: a reload is still the catalogue for the same range.
  await page.reload();
  await expect(connect).toBeVisible();
  await expect(page.locator('[data-row]')).toHaveCount(10);
  expect(api.recommendationCalls.at(-1)).toBe('catalogue ?low=45&high=72&all=1');
  expect(api.logouts).toBe(1);
  await context.close();
}

test('Spotify logo on a 375 px phone: a tap opens the box', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  await walkLogo(browser, baseURL, { size: { width: 375, height: 667 }, finger: true });
});

test('Spotify logo with a mouse at 375 px: pointing opens the box', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  await walkLogo(browser, baseURL, { size: { width: 375, height: 667 }, finger: false, rest: false });
});

test('Spotify logo on a 1280 px desktop, with real transitions', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  await walkLogo(browser, baseURL, { size: { width: 1280, height: 800 }, finger: false, motion: true });
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

// QWW-31, second round: Are You With Me (no recording, no artist evidence: the pitch rule) and Talk Dirty (a recording
// flagged mostly-rap). Their stored rows, as imported, go through the real fix and matcher for D#2 to D5, the range
// they were reported with, and the song page shows no octave mark and the label the published range gives.
const knownCases = (JSON.parse(readFileSync(path.resolve('tests/fixtures/octave-known-cases.json'), 'utf8')) as {
  songs: { key: string; stored: Pick<SongRange, 'low' | 'high' | 'tessitura' | 'pitchShare' | 'fastLyrics'> }[];
}).songs;

for (const song of [
  { key: 'lost frequencies|are you with me', title: 'Are You With Me - Radio Edit', artist: 'Lost Frequencies', label: 'Easy', slug: 'are-you-with-me' },
  { key: 'jason derulo|talk dirty', title: 'Talk Dirty (feat. 2 Chainz)', artist: 'Jason Derulo', label: 'Easy', slug: 'talk-dirty' },
] as const) {
  test(`${song.title} shows no octave mark and ${song.label} for D#2 to D5`, async ({ browser, baseURL }) => {
    const evidence = JSON.parse(readFileSync(path.resolve('data/octave-evidence.json'), 'utf8')) as OctaveEvidence;
    const user = { low: 39, high: 74, source: 'test' } as const;
    const row = knownCases.find((c) => c.key === song.key)!.stored;
    const stored: SongRange = { ...row, source: 'note-file', confidence: 'high', fastLyrics: row.fastLyrics ?? false };
    const range = correctOctave(song.key, stored, evidence);
    const fit = matchSong(user, range)!;
    const track = { id: song.slug, title: song.title, artist: song.artist, artistId: `a-${song.slug}`, spotifyUrl: `https://open.spotify.com/track/${song.slug}`, playRank: 0 };
    const api = freshState();
    api.user = me(user);
    api.response = { matches: [toMatch(track, range, fit)], nextOffset: null, sources: {}, complete: true };
    expect(range.octaveFrom).toBeDefined();
    expect(fit).toMatchObject({ octave: 'none', difficulty: song.label.toLowerCase() });

    for (const [name, viewport] of [['375', { width: 375, height: 812 }], ['1280', { width: 1280, height: 800 }]] as const) {
      const context = await browser.newContext({ ...iPhone, viewport, baseURL, reducedMotion: 'reduce' });
      await mockApi(context, api);
      const page = await context.newPage();
      await page.goto('/');
      await page.getByRole('button', { name: new RegExp(`^${song.title.replace(/[()]/g, '\\$&')}`) }).click();
      await expect(page.getByRole('heading', { name: song.title })).toBeVisible();
      await expect(page.getByText(song.label, { exact: true })).toBeVisible();
      await expect(page.getByRole('img', { name: /octave/ })).toHaveCount(0);
      await expect(page.getByText(/lower than the artist|higher than the artist/)).toHaveCount(0);
      await shot(page, `qww-31-${song.slug}-${name}`);
      await context.close();
    }
  });
}
