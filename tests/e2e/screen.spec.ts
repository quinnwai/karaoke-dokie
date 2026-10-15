// End-to-end walk through the karaoke screen. The real API is built elsewhere,
// so every /api/* call is mocked with contract-shaped fixtures. Chromium's fake
// microphone plays a generated WAV; it takes one file per launch, so the low
// note and the high note are sung in two separate browser launches, with the
// test progress carried over in sessionStorage like after a reload.

import { chromium, devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FeedbackRequest, MeResponse, VocalRange } from '../../src/lib/contracts';
import { knownSongs, me, recommendationsPage } from '../fixtures/screen';

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
  recommendationOffsets: number[];
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
      case 'PUT /api/me/range': {
        const range = req.postDataJSON() as VocalRange;
        state.savedRanges.push(range);
        if (state.user) state.user = { ...state.user, range };
        return json({ ok: true });
      }
      case 'GET /api/recommendations': {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        state.recommendationOffsets.push(offset);
        return json(recommendationsPage(offset, Number(url.searchParams.get('limit') ?? 5)));
      }
      case 'GET /api/songs/known':
        return json(knownSongs());
      case 'POST /api/feedback':
        state.feedback.push(req.postDataJSON() as FeedbackRequest);
        return json({ ok: true });
      default:
        return json({ error: 'not mocked' }, 404);
    }
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

const freshState = (): ApiState => ({ user: null, savedRanges: [], feedback: [], recommendationOffsets: [] });

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
  await page.waitForTimeout(900);
  await shot(page, '06-sign-in-arrow');

  // ---- Sign in (mocked redirect back to /?signedIn=1) ----
  // The arrow bounces forever, so it is never "stable" for Playwright; with
  // reduced motion it stands still (which also checks that setting).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await arrow.click();
  await expect(page.getByRole('button', { name: /^Plastic Love/ })).toBeVisible();
  expect(api.savedRanges).toEqual([{ low: 45, high: 72, source: 'test' }]);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('ol li')).toHaveCount(5);
  await page.waitForTimeout(1000);
  await shot(page, '07-results');

  await page.getByRole('button', { name: 'Generate more songs' }).click();
  await expect(page.locator('ol li')).toHaveCount(10);
  expect(api.recommendationOffsets).toEqual([0, 5]);
  await expect(page.getByRole('button', { name: 'Generate more songs' })).toHaveCount(0);
  await page.locator('ol li').nth(9).scrollIntoViewIfNeeded();
  await shot(page, '08-generate-more');

  // ---- Song detail ----
  await page.getByRole('button', { name: /^Yoru ni Kakeru/ }).click();
  await expect(page.getByRole('heading', { name: 'Yoru ni Kakeru' })).toBeVisible();
  await expect(page.getByText('Fast lyrics')).toBeVisible();
  await expect(page.getByText('Sing it lower than the artist')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open in Spotify' })).toHaveAttribute('href', 'https://open.spotify.com/track/t2');
  await shot(page, '09-song-detail');

  await page.getByRole('button', { name: 'Where this came from' }).click();
  await expect(page.getByRole('tooltip')).toHaveText(/note-by-note file of this song\. Matched a note file/);
  await shot(page, '10-info-tooltip');

  await page.getByRole('button', { name: 'It went well' }).click();
  await expect(page.getByText('Thanks! That helps.')).toBeVisible();
  await expect.poll(() => api.feedback).toEqual([{ trackId: 't2', thumbs: 'up', difficulty: 'hard', octave: 'down' }]);
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
  await shot(page, '16-desktop-detail');
  await context.close();
});
