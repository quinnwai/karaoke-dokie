// "Open in Spotify" in a real browser: the real routes, the memory store and the offline mock
// Spotify client (so the link is a search URL, which maps to spotify:search:...). Nothing is
// mocked in the app. The Spotify web player is replaced by a stand-in page so no test depends on
// the network.
//
// What a page can't see, and so these tests can't either: the browser's own "Open Spotify?"
// prompt, and whether Spotify really opens. They check the page's side: that it tries the app
// first, opens the web player only after the wait if it is still in front, and stays put when the
// app (or its prompt) takes the focus. The focus loss is simulated with a blur event.

import { devices, expect, test, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import path from 'node:path';
import { APP_WAIT_MS } from '../../src/lib/client/spotifyLink';

const SCREENS = path.resolve('test-results/screens');
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SCREENS, `spotify-link-${name}.png`) });

const WEB_PLAYER = /^https:\/\/open\.spotify\.com\/search\//;
const POINTER_QUERY = '(hover: hover) and (pointer: fine)'; // what the app calls a computer

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const standIn = (url: string) => `<!doctype html><meta charset="utf-8"><title>Spotify web player (stand-in)</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#121212;color:#fff;font:600 22px system-ui,sans-serif;text-align:center">
<div><p style="color:#1ed760;font-size:14px;letter-spacing:.1em">STAND-IN FOR THE SPOTIFY WEB PLAYER</p><p>This tab opened:</p>
<p style="font:500 18px ui-monospace,monospace;word-break:break-all;padding:0 32px">${esc(url)}</p></div>`;

type Timings = { clickAt?: number; openAt?: number };

/**
 * Signs in to the mock Spotify, opens the first recommended song and returns its Open in Spotify
 * link. Every page also notes, on its own clock, when it was last clicked and when it called
 * window.open, so the wait can be measured without racing the test runner; with blockPopups,
 * window.open returns null as if the browser had blocked the popup.
 */
async function openFirstSong(context: BrowserContext, { blockPopups = false } = {}) {
  await context.route('https://open.spotify.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: standIn(route.request().url()) }),
  );
  await context.addInitScript((block) => {
    const w = window as unknown as { __kd: Timings };
    w.__kd = {};
    document.addEventListener('click', () => (w.__kd.clickAt = performance.now()), true);
    const open = window.open.bind(window);
    window.open = (...args: Parameters<typeof window.open>) => {
      w.__kd.openAt = performance.now();
      return block ? null : open(...args);
    };
    if (!sessionStorage.getItem('kd.e2e')) {
      sessionStorage.setItem('kd.e2e', '1');
      sessionStorage.setItem('kd.test', JSON.stringify({ low: 45, high: 72 }));
    }
  }, blockPopups);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByTestId('range-low')).toHaveText('A2');
  await page.getByRole('button', { name: 'Continue' }).click();
  const songs = page.locator('ol li');
  await expect(songs).toHaveCount(5, { timeout: 20_000 });
  await songs.first().getByRole('button').first().click();
  const link = page.getByRole('link', { name: 'Open in Spotify' });
  await expect(link).toBeVisible();
  return { page, link };
}

const timings = (page: Page) => page.evaluate(() => (window as unknown as { __kd: Timings }).__kd);

/** Records every navigation the page asks for, including the ones to spotify: that the browser itself handles. */
async function watchNavigations(context: BrowserContext, page: Page) {
  const cdp: CDPSession = await context.newCDPSession(page);
  await cdp.send('Page.enable');
  const urls: string[] = [];
  cdp.on('Page.frameRequestedNavigation', (e: { url: string }) => urls.push(e.url));
  return { appRequests: () => urls.filter((u) => u.startsWith('spotify:')) };
}

type Click = { modified: boolean; defaultPrevented: boolean };

/**
 * Records, for each click, whether the app cancelled the browser's own handling of it (that is,
 * took the click over). Then cancels it anyway, so a click the app leaves alone can't open a real
 * tab that reaches the network: the browser may start that tab's first request before the test
 * can intercept it.
 */
async function watchClicks(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __clicks: Click[] };
    w.__clicks = [];
    document.addEventListener('click', (e) => {
      w.__clicks.push({ modified: e.metaKey || e.ctrlKey || e.shiftKey || e.altKey, defaultPrevented: e.defaultPrevented });
      e.preventDefault();
    });
  });
  return () => page.evaluate(() => (window as unknown as { __clicks: Click[] }).__clicks);
}

// The "Open Spotify?" prompt is a desktop browser thing, so these run as a desktop browser, not the config's iPhone.
test.use({
  userAgent: devices['Desktop Chrome'].userAgent,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
  contextOptions: { reducedMotion: 'reduce' }, // the Continue arrow bounces forever otherwise
  screenshot: 'off',
});

test('no Spotify app: the app is tried first, then the song opens on the web', async ({ context }) => {
  const { page, link } = await openFirstSong(context);
  const nav = await watchNavigations(context, page);
  const clicks = await watchClicks(page);
  expect(await page.evaluate((q) => matchMedia(q).matches, POINTER_QUERY)).toBe(true);
  await expect(link).toHaveAttribute('href', WEB_PLAYER);
  await expect(link).toHaveAttribute('target', '_blank');
  await shot(page, '01-detail');

  const opened = context.waitForEvent('page');
  await link.click();

  // The app is asked first, with the app form of the same link, and the click is the app's, not the browser's.
  await expect.poll(() => nav.appRequests().length).toBe(1);
  expect(nav.appRequests()[0]).toMatch(/^spotify:search:.+/);
  expect(await clicks()).toEqual([{ modified: false, defaultPrevented: true }]);

  // Nothing took over, so the web player opens in a new tab, and only after the wait.
  const web = await opened;
  const { clickAt, openAt } = await timings(page);
  expect(openAt! - clickAt!).toBeGreaterThanOrEqual(APP_WAIT_MS - 50);
  await web.waitForLoadState();
  expect(web.url()).toMatch(WEB_PLAYER);
  expect(web.url()).toBe(await link.getAttribute('href'));
  expect(await web.evaluate(() => window.opener)).toBeNull(); // the new tab is cut loose from the app, like rel="noreferrer"
  await expect(web.getByText('This tab opened:')).toBeVisible();
  await shot(web, '02-web-player-opened');

  // The song screen is still there behind it.
  await page.bringToFront();
  await expect(page.getByRole('link', { name: 'Open in Spotify' })).toBeVisible();
});

test('Spotify app takes over: the song screen stays and no web tab opens', async ({ context }) => {
  const { page, link } = await openFirstSong(context);
  const nav = await watchNavigations(context, page);

  await link.click();
  await expect.poll(() => nav.appRequests().length).toBe(1);
  // The app (or its prompt) takes the focus away from the page.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(APP_WAIT_MS + 1000);

  expect((await timings(page)).openAt).toBeUndefined();
  expect(context.pages()).toHaveLength(1);
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
  await shot(page, '03-app-took-over');
});

test('popup blocked: the web player loads in this tab instead', async ({ context }) => {
  const { page, link } = await openFirstSong(context, { blockPopups: true });

  await link.click();
  await page.waitForURL(WEB_PLAYER, { timeout: APP_WAIT_MS + 5000 });

  await expect(page.getByText('This tab opened:')).toBeVisible();
  expect(context.pages()).toHaveLength(1);
  await shot(page, '04-popup-blocked-same-tab');
});

test('a modified click is left to the browser: the app is not tried and nothing opens from the app', async ({ context }) => {
  const { page, link } = await openFirstSong(context);
  const nav = await watchNavigations(context, page);
  const clicks = await watchClicks(page);

  await link.click({ modifiers: ['ControlOrMeta'] });
  await page.waitForTimeout(APP_WAIT_MS + 500);

  expect(await clicks()).toEqual([{ modified: true, defaultPrevented: false }]);
  expect(nav.appRequests()).toEqual([]);
  expect((await timings(page)).openAt).toBeUndefined();
  expect(context.pages()).toHaveLength(1);
});

test('on a phone the click is left to the browser: its https link already opens the app', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ...devices['iPhone 13'], baseURL, reducedMotion: 'reduce' });
  try {
    const { page, link } = await openFirstSong(context);
    const nav = await watchNavigations(context, page);
    const clicks = await watchClicks(page);
    expect(await page.evaluate((q) => matchMedia(q).matches, POINTER_QUERY)).toBe(false);

    await link.click();
    await page.waitForTimeout(APP_WAIT_MS + 500);

    expect(await clicks()).toEqual([{ modified: false, defaultPrevented: false }]);
    expect(nav.appRequests()).toEqual([]);
    expect((await timings(page)).openAt).toBeUndefined();
    expect(context.pages()).toHaveLength(1);
  } finally {
    await context.close();
  }
});
