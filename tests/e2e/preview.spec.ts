// The play button in each song row (QWW-48), in the Setlist tuner's first slot (QWW-57, R3), with a real browser's <audio>: Chromium as the Android phone and, where
// it is installed, WebKit as the iPhone (both emulated: neither is a real phone, so the review guide asks for one).
// The API is mocked, and /api/preview/<id> answers with a short tone after a delay, in byte ranges as Deezer's CDN does
// (Safari asks for media in ranges). The app's route answers with a redirect to Deezer's CDN instead, and that hop
// cannot be stood in for here: Playwright neither fulfils a redirect for a media request nor routes the request a
// redirect leads to (tried in Chromium and WebKit, Nov 2026: the follow-up goes to the real CDN). So the redirect is
// covered by tests/server/preview.test.ts and by `smoke:live --url`, which follows it to Deezer on a deployment.

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Match, RecommendationsResponse, SetlistRequest } from '../../src/lib/contracts';
import { allMatches, me } from '../fixtures/screen';
import { setlistAnswer } from '../helpers/setlistServer';

const SCREENS = path.resolve('test-results/screens');

/** 16-bit mono WAV: `seconds` of a quiet 440 Hz tone. */
function toneWav(seconds: number, sampleRate = 22050): Buffer {
  const n = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(0.1 * 32767 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)), i * 2);
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

const TONE = toneWav(30);

/** The fixture songs, each with a Deezer id (1000 + its index) except those in `without`. */
function songs(without: number[] = []): RecommendationsResponse {
  const all = allMatches();
  return { ...all, matches: all.matches.map((m: Match, i) => (without.includes(i) ? m : { ...m, deezerId: 1000 + i })) };
}

interface Mock {
  response: RecommendationsResponse;
  /** Preview ids that answer 404 (Deezer has none). */
  missing: Set<string>;
  /** Every /api/preview/<id> request, in order. */
  previewCalls: string[];
}

/** The tone, or the bytes a Range header asks for (206), as Deezer's CDN answers: Safari asks for media in ranges. */
function audioAnswer(rangeHeader: string | undefined): { status: number; contentType: string; headers: Record<string, string>; body: Buffer } {
  const range = /bytes=(\d+)-(\d*)/.exec(rangeHeader ?? '');
  if (!range) return { status: 200, contentType: 'audio/wav', headers: { 'accept-ranges': 'bytes' }, body: TONE };
  const start = Number(range[1]);
  const end = Math.min(range[2] ? Number(range[2]) : TONE.length - 1, TONE.length - 1);
  return {
    status: 206,
    contentType: 'audio/wav',
    headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${TONE.length}` },
    body: TONE.subarray(start, end + 1),
  };
}

async function mockApi(context: BrowserContext, mock: Mock) {
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const preview = /^\/api\/preview\/(\d+)$/.exec(url.pathname);
    if (preview) {
      const id = preview[1]!;
      mock.previewCalls.push(id);
      if (mock.missing.has(id)) return json({ error: 'no-preview' }, 404);
      // Slow enough that the taps below land while an earlier preview is still loading.
      await new Promise((r) => setTimeout(r, 250));
      return route.fulfill(audioAnswer(route.request().headers()['range']));
    }
    // The tuner asks the server's engine for its list: its own ranking of the same songs, signed in.
    if (url.pathname === '/api/setlist') return json(setlistAnswer(mock.response, route.request().postDataJSON() as SetlistRequest, true));
    switch (url.pathname) {
      case '/api/me':
        return json(me({ low: 45, high: 72, source: 'test' }));
      case '/api/recommendations':
        return json(mock.response);
      case '/api/events':
        return route.fulfill({ status: 204 });
      default:
        return json({ error: 'not mocked' }, 404);
    }
  });
  // Spotify's player on the song page, as screen.spec.ts stands it in.
  await context.route('https://open.spotify.com/embed/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Spotify stand-in</title><body style="background:#282828">player</body>' }),
  );
}

async function open(browser: Browser, baseURL: string | undefined, mock: Mock, viewport = { width: 375, height: 667 }) {
  const context = await browser.newContext({ ...devices['iPhone 13'], viewport, baseURL, reducedMotion: 'reduce' });
  await mockApi(context, mock);
  const page = await context.newPage();
  await page.goto('/');
  // The tuner lists every fixture song at once (the earlier screen showed 5 at a time).
  await expect(page.locator('[data-row]')).toHaveCount(10);
  return { context, page };
}

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SCREENS, `${name}.png`) });
const play = (page: Page, title: string) => page.getByRole('button', { name: new RegExp(`^(Play|Pause) ${title} by`) });
/** The page's one shared <audio>: what it holds and whether it is playing. */
const audio = (page: Page) =>
  page.evaluate(() => {
    const all = document.querySelectorAll('audio');
    const a = document.querySelector<HTMLAudioElement>('audio[data-preview-audio]');
    return { count: all.length, src: a?.getAttribute('src') ?? null, paused: a?.paused ?? true, time: a?.currentTime ?? 0 };
  });

// Chromium is the configured browser (the fixture); WebKit is launched here, as screen.spec.ts launches its own.
const engines: { name: string; key: 'chromium' | 'webkit'; installed: boolean }[] = [
  { name: 'Chromium (Android Chrome)', key: 'chromium', installed: true },
  { name: 'WebKit (iPhone Safari)', key: 'webkit', installed: existsSync(webkit.executablePath()) },
];

/** The fixture's Chromium, or a WebKit launched for the test (closed after it). */
async function engineBrowser(key: 'chromium' | 'webkit', fixture: Browser): Promise<{ browser: Browser; done(): Promise<void> }> {
  if (key === 'chromium') return { browser: fixture, done: async () => {} };
  const browser = await webkit.launch();
  return { browser, done: () => browser.close() };
}

test.beforeAll(() => mkdirSync(SCREENS, { recursive: true }));
test.use({ screenshot: 'off' });

for (const engine of engines) {
  test.describe(`row play button in ${engine.name}`, () => {
    test.skip(!engine.installed, 'WebKit is not installed here (CI installs Chromium only)');

    test('five taps in five seconds end with the last-tapped song playing, one song at a time', async ({ browser: fixture, baseURL }) => {
      const { browser, done } = await engineBrowser(engine.key, fixture);
      const mock: Mock = { response: songs(), missing: new Set(), previewCalls: [] };
      const { context, page } = await open(browser, baseURL, mock);
      const titles = ['Plastic Love', 'Lemon', 'Yoru ni Kakeru', 'Fly Me to the Moon', 'Dancing Queen'];

      await play(page, titles[0]!).click();
      await expect(play(page, titles[0]!)).toHaveAttribute('data-preview', 'playing');
      // In the tuner's slot (QWW-57, R3) the playing row shows the pause glyph where the rank number was, in the ring the button draws
      // (R17): the track circle and the fill that runs over it, with the glyph, and nothing else of the row's number.
      const slot = page.locator('[data-row]', { has: play(page, titles[0]!) }).locator('[data-play-slot]');
      await expect(slot.locator('[data-preview] > svg').first()).toBeVisible();
      await expect(slot.locator('circle:visible')).toHaveCount(2);
      await expect(slot.locator('svg:visible')).toHaveCount(2);
      await expect(slot.locator('[data-rank-number]')).toBeHidden();
      await shot(page, `qww-48-${engine.key}-playing-375x667`);

      // Five taps inside five seconds: each lands while the one before is still loading.
      const started = Date.now();
      for (const title of titles.slice(1)) {
        await play(page, title).click();
        await page.waitForTimeout(150);
      }
      await play(page, titles[0]!).click();
      expect(Date.now() - started).toBeLessThan(5000);

      await expect(play(page, titles[0]!)).toHaveAttribute('data-preview', 'playing');
      await expect(play(page, titles[0]!)).toHaveAttribute('aria-label', 'Pause Plastic Love by Mariya Takeuchi');
      for (const title of titles.slice(1)) await expect(play(page, title)).toHaveAttribute('data-preview', 'idle');
      await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.2);
      const a = await audio(page);
      expect(a).toMatchObject({ count: 1, src: '/api/preview/1000', paused: false });
      expect(mock.previewCalls.slice(-1)).toEqual(['1000']);
      await context.close();
      await done();
    });

    test('pause and resume; a song with no preview is disabled; the row still opens the song page, which stops the preview', async ({ browser: fixture, baseURL }) => {
      const { browser, done } = await engineBrowser(engine.key, fixture);
      // Lemon has no Deezer match; Deezer has no preview for Yoru ni Kakeru (the route answers 404).
      const mock: Mock = { response: songs([1]), missing: new Set(['1002']), previewCalls: [] };
      const { context, page } = await open(browser, baseURL, mock);

      const lemon = page.getByRole('button', { name: 'No preview of Lemon by Kenshi Yonezu' });
      await expect(lemon).toBeDisabled();

      await play(page, 'Yoru ni Kakeru').click();
      await expect(page.getByRole('button', { name: 'No preview of Yoru ni Kakeru by YOASOBI' })).toBeDisabled();

      const plastic = play(page, 'Plastic Love');
      await plastic.click();
      await expect(plastic).toHaveAttribute('data-preview', 'playing');
      await expect(page.getByRole('heading', { name: 'Plastic Love' })).toHaveCount(0); // ▶ did not open the song page
      await plastic.click();
      await expect(plastic).toHaveAttribute('data-preview', 'paused');
      expect((await audio(page)).paused).toBe(true);
      await plastic.click();
      await expect(plastic).toHaveAttribute('data-preview', 'playing');
      await shot(page, `qww-48-${engine.key}-disabled-and-playing`);

      // The row opens the song page; the preview stops, and Spotify's player is there as before.
      await page.getByRole('button', { name: /^Plastic Love by Mariya Takeuchi,/ }).click();
      await expect(page.getByRole('heading', { name: 'Plastic Love' })).toBeVisible();
      await expect(page.getByTitle('Spotify player: Plastic Love by Mariya Takeuchi')).toBeVisible();
      await expect.poll(async () => (await audio(page)).paused).toBe(true);
      expect((await audio(page)).src).toBeNull();

      // R27: the page's own ▶ ("Play 30 s") is its first action: above the fold of this 375 x 667 phone and above the range chart, while Spotify's
      // own player (an embed for this song) stays below the chart, where it was.
      await expect(page.locator('button[data-preview]')).toHaveAccessibleName('Play 30 s');
      const at = await page.evaluate(() => {
        const big = document.querySelector('button[data-preview]')!;
        const rect = (e: Element) => e.getBoundingClientRect();
        let scroller: HTMLElement | null = big.parentElement;
        while (scroller && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement;
        return {
          wordsBottom: rect(big.querySelector('span')!).bottom,
          chart: rect(document.querySelector('[role="img"][aria-label^="Song goes from"]')!),
          frameTop: rect(document.querySelector('iframe[title^="Spotify player"]')!).top,
          fold: scroller!.getBoundingClientRect().bottom,
        };
      });
      expect(at.wordsBottom).toBeLessThanOrEqual(at.fold);
      expect(at.wordsBottom).toBeLessThanOrEqual(at.chart.top);
      expect(at.frameTop).toBeGreaterThanOrEqual(at.chart.bottom);

      await page.getByRole('button', { name: 'Back to songs' }).click();
      await expect(play(page, 'Plastic Love')).toHaveAttribute('data-preview', 'idle');
      await context.close();
      await done();
    });
  });
}

test('the row and its play button fit a 375 px phone, with Deezer named under the list', async ({ browser, baseURL }) => {
  const mock: Mock = { response: songs([1]), missing: new Set(), previewCalls: [] };
  for (const viewport of [{ width: 375, height: 667 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
    const { context, page } = await open(browser, baseURL, mock, viewport);
    // Deezer is named under the list (#34's notes; it stays there: QWW-57, R29): below the last row, at the end of what scrolls.
    const credit = page.getByText('Previews from');
    await credit.scrollIntoViewIfNeeded();
    await expect(credit).toBeVisible();
    expect(
      await page.evaluate(() => {
        const line = [...document.querySelectorAll('p')].find((p) => /Previews from/.test(p.textContent ?? ''))!;
        const last = [...document.querySelectorAll('[data-row]')].at(-1)!;
        return line.getBoundingClientRect().top >= last.getBoundingClientRect().bottom;
      }),
    ).toBe(true);
    await page.locator('#list-scroll').evaluate((el) => el.scrollTo(0, 0));
    const button = (await play(page, 'Plastic Love').boundingBox())!;
    expect(button.width).toBeGreaterThanOrEqual(44);
    expect(button.height).toBeGreaterThanOrEqual(44);
    // Nothing spills sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await play(page, 'Plastic Love').click();
    await expect(play(page, 'Plastic Love')).toHaveAttribute('data-preview', 'playing');
    await page.waitForTimeout(600);
    await shot(page, `qww-48-row-${viewport.width}x${viewport.height}`);
    await context.close();
  }
});
