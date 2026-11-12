// What a tap on a row does, on the production build, in Chromium and (where it is installed) WebKit: the fourth pass on PR #38 (QWW-57).
//   3. a double tap on a row opens the song page and leaves it there: the page holds its controls (pointer-events: none on the ▶, the Spotify
//      link or player, the thumbs; not ‹) for TAP_GUARD_MS from the commit that puts it on the screen, so the second tap, on whatever the page has
//      under that spot, falls through to the screen behind: no audio plays, no tab opens, nothing is sent. A tap after the moment does what it
//      did. The second tap is always sent at raw coordinates (page.touchscreen.tap): a locator's tap waits for the element to take events, which
//      waits the hold out and would hide the bug.
//   5. ‹ on the song page brings the list back scrolled to where the singer left it, with the focus on the row that opened the page. The list is
//      a new element each time (the page and the list take turns in one screen), so its place has to be put back.
// Playwright's WebKit is desktop WebKit with an iPhone's viewport, touch and user agent. It is not iOS Safari: a pass here says WebKit's layout and
// focus rules are met, not what a phone does. CI installs Chromium only, so every test here has a Chromium run that fails without its fix.
// jsdom cannot hit-test, so tests/screen/songPage.test.tsx only checks what the page sets and when; that a tap falls through is proved here.

import { devices, expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import type { MockSong } from '../fixtures/setlist';
import { centre, open, openButton, rows, titles } from '../helpers/tunerE2e';

// The tests close the contexts they make themselves, so the runner has no page left to take a screenshot of.
test.use({ screenshot: 'off' });

/** KaraokeApp's TAP_GUARD_MS: the page's content is held this long, and a tap this soon after another one is the second of a double tap. */
const GUARD = 400;
/** A tap that is meant comes after this much quiet. */
const pastTheGuard = (page: Page) => page.waitForTimeout(GUARD + 50);
/** Milliseconds between the two taps of a double tap, first click to second (350 stays inside the 400 ms moment). */
const GAPS = [80, 150, 250, 350];

const ENGINES = [
  { name: 'Chromium', key: 'chromium', installed: true },
  { name: 'WebKit', key: 'webkit', installed: existsSync(webkit.executablePath()) },
] as const;
type Engine = (typeof ENGINES)[number];

/**
 * Runs `body` on a touch phone `width` x `height` in `engine`'s browser (the fixture's Chromium, or a WebKit launched for the test and closed after
 * it), with the page that Spotify's link opens stood in for, so a tab that opens loads nothing from the real site.
 */
async function withPhone(engine: Engine, fixture: Browser, baseURL: string | undefined, width: number, height: number, body: (page: Page) => Promise<void>) {
  const browser = engine.key === 'chromium' ? fixture : await webkit.launch();
  try {
    const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width, height }, baseURL, reducedMotion: 'reduce' });
    await context.route('https://open.spotify.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Spotify stand-in</title>' }));
    try {
      await body(await context.newPage());
    } finally {
      await context.close();
    }
  } finally {
    if (engine.key === 'webkit') await browser.close();
  }
}

/** Six songs that lead the list under the defaults (easy and the best known), each with a Deezer track, so rows 2 to 5 have a ▶ that works. */
const SONGS: MockSong[] = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'].map((name, i) => ({
  title: `${name} Play`,
  artist: `${name} Artist`,
  era: 's90',
  difficulty: 3 + i,
  history: 50,
  popularity: 100 - i,
  tempo: 50,
  deezerId: 4242 + i,
}));

// ---- what a double tap could set off ----

interface Seen {
  /** Tabs and popups that opened (a link with a new-tab target opens one, whatever its opener). */
  opened: Set<Page>;
  /** POSTs to the feedback routes. */
  feedback: string[];
  /** Requests for a preview's audio. */
  previews: string[];
}

function watch(page: Page): Seen {
  const seen: Seen = { opened: new Set(), feedback: [], previews: [] };
  page.context().on('page', (p) => seen.opened.add(p));
  page.on('popup', (p) => seen.opened.add(p));
  page.on('request', (req) => {
    const { pathname } = new URL(req.url());
    if (req.method() === 'POST' && /^\/api\/(catalogue\/)?feedback$/.test(pathname)) seen.feedback.push(pathname);
    if (/^\/api\/preview\/\d+$/.test(pathname)) seen.previews.push(pathname);
  });
  return seen;
}

const songTitle = (page: Page, title: string) => page.getByRole('heading', { level: 2, name: title, exact: true });
/** The song page's ▶, the only element with a preview state once the list has gone. */
const playButton = (page: Page) => page.locator('button[data-preview]');
const thumb = (page: Page, name: 'It went well' | "It didn't go well") => page.getByRole('button', { name });
/** The page's one <audio> element, which the first tap on a ▶ makes: whether there is one, and whether it has a song or is playing. */
const audioState = (page: Page) =>
  page.evaluate(() => {
    const a = document.querySelector<HTMLAudioElement>('audio[data-preview-audio]');
    return { exists: a !== null, src: a?.getAttribute('src') ?? null, paused: a?.paused ?? true };
  });
/**
 * What a finger at a point would press on the page: the song page's ▶, the Spotify link, a thumb, or something that is none of them. While the
 * page holds its content this says 'other' for all of them (they take no events), so ask after the moment.
 */
const underFinger = (page: Page, at: { x: number; y: number }) =>
  page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y)?.closest('button, a');
    if (!hit) return 'nothing';
    if (hit.hasAttribute('data-preview')) return 'play';
    if (hit.tagName === 'A') return 'link';
    if (/went well/.test(hit.getAttribute('aria-label') ?? '')) return 'thumb';
    return 'other';
  }, at);

const tapAt = (page: Page, at: { x: number; y: number }) => page.touchscreen.tap(at.x, at.y);

/**
 * A double tap: `first`, then `second` `gap` ms later, as a finger does it, with real touches at raw coordinates (not a locator's tap, which waits
 * for the element to take events). Returns the ms from the first tap's return to the second's: a tap's own round trip counts, so the wait is the gap
 * less one round trip, and the result is the gap whatever engine or machine this is. The test asserts it is inside the moment.
 */
async function doubleTap(page: Page, first: { x: number; y: number }, gap: number, second = first) {
  const before = Date.now();
  await tapAt(page, first);
  const t1 = Date.now();
  await page.waitForTimeout(Math.max(0, gap - (t1 - before)));
  await tapAt(page, second);
  const apart = Date.now() - t1;
  expect(apart, 'the two taps were a double tap: the second inside the moment').toBeLessThan(GUARD - 10);
  return apart;
}

/** After a second tap that was to fall through: the page is the tapped row's and still open, the ▶ was not pressed, and nothing played, opened or went out. */
async function expectNothingHappened(page: Page, seen: Seen, title: string) {
  await expect(songTitle(page, title), 'the page opened, stays open, and is the tapped row’s').toBeVisible();
  await expect(playButton(page), 'the ▶ was not pressed').toHaveAttribute('data-preview', 'idle');
  expect(await audioState(page), 'no audio was loaded or played').toEqual({ exists: false, src: null, paused: true });
  expect(seen.previews, 'no preview was asked for').toEqual([]);
  expect([...seen.opened].map((p) => p.url()), 'no tab or popup opened').toEqual([]);
  expect(seen.feedback, 'no feedback was sent').toEqual([]);
  await expect(thumb(page, 'It went well')).toHaveAttribute('aria-pressed', 'false');
  await expect(thumb(page, "It didn't go well")).toHaveAttribute('aria-pressed', 'false');
}

for (const engine of ENGINES) {
  test.describe(`3. a double tap on a row lands once (${engine.name})`, () => {
    test.skip(!engine.installed, 'WebKit is not installed here (CI installs Chromium only)');

    for (const [width, height] of [
      [360, 800],
      [390, 844],
    ] as const) {
      test(`at ${width} px wide, rows 2 to 5, the second tap ${GAPS.join(', ')} ms after the first: the song page opens and stays, nothing plays, opens or is sent`, async ({ browser, baseURL }) => {
        test.setTimeout(180_000);
        await withPhone(engine, browser, baseURL, width, height, async (page) => {
          const seen = watch(page);
          await open(page, { extra: SONGS, mini: true });
          expect((await titles(page)).slice(0, SONGS.length), 'the six songs with a preview lead the list').toEqual(SONGS.map((s) => s.title));

          // What the second tap landed on, over all the double taps: the test is only worth anything if some of them landed on a control.
          const landedOn = new Set<string>();
          for (const index of [1, 2, 3, 4]) {
            for (const gap of GAPS) {
              const row = rows(page).nth(index);
              const title = (await row.locator('[data-row-title]').textContent())!;
              const at = await centre(openButton(row));
              expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-row]')?.getAttribute('data-rank') ?? null, at), 'the tap is on the row').toBe(String(index + 1));

              await doubleTap(page, at, gap); // the song page opens, and the second tap is on whatever it has under that spot
              await pastTheGuard(page); // anything it started has started, and the page holds nothing now
              landedOn.add(await underFinger(page, at));
              await expectNothingHappened(page, seen, title);

              await page.goBack(); // the system Back is not a tap
              await expect(rows(page).first()).toBeVisible();
            }
          }
          expect([...landedOn], 'the second taps landed on the ▶ and on the link, as they do for a singer').toEqual(expect.arrayContaining(['play', 'link']));
        });
      });
    }

    /** One control: tapped on its own a moment after a tap on a row (the second tap is at the control, wherever the first was), then again after the moment. */
    const CONTROLS = [
      {
        name: 'the ▶',
        kind: 'play',
        spot: (page: Page) => playButton(page),
        works: async (page: Page, seen: Seen) => {
          await expect.poll(() => seen.previews, 'the preview was asked for').toEqual(['/api/preview/4243']);
          expect(await playButton(page).getAttribute('data-preview')).not.toBe('idle'); // loading, then playing
          expect((await audioState(page)).src, 'the audio element holds the song').toBe('/api/preview/4243');
        },
      },
      {
        name: 'Find on Spotify',
        kind: 'link',
        spot: (page: Page) => page.getByRole('link', { name: 'Find on Spotify' }),
        works: async (_page: Page, seen: Seen) => {
          await expect.poll(() => seen.opened.size, 'the link opened its tab').toBe(1);
          await expect.poll(() => [...seen.opened][0]?.url()).toMatch(/^https:\/\/open\.spotify\.com\/search\//);
        },
      },
      {
        name: 'a thumb',
        kind: 'thumb',
        spot: (page: Page) => thumb(page, 'It went well'),
        works: async (page: Page, seen: Seen) => {
          await expect.poll(() => seen.feedback, 'the feedback went out once').toEqual(['/api/catalogue/feedback']);
          await expect(thumb(page, 'It went well')).toHaveAttribute('aria-pressed', 'true');
        },
      },
    ];
    for (const control of CONTROLS) {
      test(`${control.name}, tapped ${GAPS.join(', ')} ms after a tap on a row: nothing; tapped after the moment: it works`, async ({ browser, baseURL }) => {
        test.setTimeout(120_000);
        await withPhone(engine, browser, baseURL, 390, 844, async (page) => {
          const seen = watch(page);
          await open(page, { extra: SONGS, mini: true });
          const beta = rows(page).filter({ hasText: 'Beta Play' });
          // Where the control is on Beta Play's page: a first look, after the moment, so the finger is placed where the control really is.
          await tapAt(page, await centre(openButton(beta)));
          await expect(songTitle(page, 'Beta Play')).toBeVisible();
          await pastTheGuard(page);
          const at = await centre(control.spot(page));
          expect(await underFinger(page, at), 'the finger is on the control').toBe(control.kind);
          await page.goBack();
          await expect(rows(page).first()).toBeVisible();

          for (const gap of GAPS) {
            await doubleTap(page, await centre(openButton(beta)), gap, at); // the second tap is on the control itself
            await pastTheGuard(page);
            await expectNothingHappened(page, seen, 'Beta Play');
            await page.goBack();
            await expect(rows(page).first()).toBeVisible();
          }

          // One tap on a row and then one on the control after the moment: it does what it did.
          await tapAt(page, await centre(openButton(beta)));
          await expect(songTitle(page, 'Beta Play')).toBeVisible();
          await pastTheGuard(page);
          await tapAt(page, at);
          await control.works(page, seen);
        });
      });
    }

    test('signed in: Open in Spotify and a dislike, a tap after a double tap and the moment works, and the double tap did nothing', async ({ browser, baseURL }) => {
      test.setTimeout(120_000);
      await withPhone(engine, browser, baseURL, 390, 844, async (page) => {
        const seen = watch(page);
        await open(page, { loggedIn: true, extra: SONGS, mini: true });
        const beta = rows(page).filter({ hasText: 'Beta Play' });
        const rowAt = await centre(openButton(beta));
        await tapAt(page, rowAt);
        const link = page.getByRole('link', { name: 'Open in Spotify' });
        const dislike = thumb(page, "It didn't go well");
        await expect(link).toBeVisible();
        const [linkAt, dislikeAt] = [await centre(link), await centre(dislike)];
        await page.goBack();
        await expect(rows(page).first()).toBeVisible();

        await doubleTap(page, rowAt, 120, linkAt); // the second tap of a double tap, on the link
        await tapAt(page, dislikeAt); // and a third, on a thumb
        await pastTheGuard(page);
        expect(seen.opened.size, 'the link did not open').toBe(0);
        expect(seen.feedback, 'nothing was sent').toEqual([]);

        await tapAt(page, linkAt);
        await expect.poll(() => seen.opened.size, 'the link opened its tab').toBe(1);
        await tapAt(page, dislikeAt);
        await expect.poll(() => seen.feedback, 'signed in, the feedback goes to the library route').toEqual(['/api/feedback']);
        await expect(dislike).toHaveAttribute('aria-pressed', 'true');
      });
    });
  });

  test.describe(`5. ‹ puts the list back where the singer left it (${engine.name})`, () => {
    test.skip(!engine.installed, 'WebKit is not installed here (CI installs Chromium only)');

    test('row 12 of the list, far from the top: after ‹ the scroller is where it was, the row is on screen and has the focus', async ({ browser, baseURL }) => {
      test.setTimeout(60_000);
      await withPhone(engine, browser, baseURL, 390, 844, async (page) => {
        await open(page);
        const scroller = page.locator('#list-scroll');
        // Row 12 with its centre 30% of the way down the list's box: on screen, and nowhere near the top or the middle.
        await scroller.evaluate((el) => {
          const row = el.querySelectorAll<HTMLElement>('[data-row]')[11]!;
          const box = el.getBoundingClientRect();
          const r = row.getBoundingClientRect();
          el.scrollTop += r.top + r.height / 2 - (box.top + box.height * 0.3);
        });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const before = await scroller.evaluate((el) => el.scrollTop);
        expect(before, 'the list is scrolled well down').toBeGreaterThan(400);
        const row = rows(page).nth(11);
        const id = (await row.getAttribute('data-id'))!;
        const title = (await row.locator('[data-row-title]').textContent())!;

        await tapAt(page, await centre(openButton(row)));
        await expect(songTitle(page, title)).toBeVisible();
        await page.getByRole('button', { name: 'Back to songs' }).tap();
        await expect(page.locator('#sheet')).toBeVisible();
        await page.waitForTimeout(500); // the list has settled: nothing moves it after
        const after = await page.evaluate((rowId) => {
          const list = document.querySelector<HTMLElement>('#list-scroll')!;
          const li = [...list.querySelectorAll<HTMLElement>('[data-row]')].find((r) => r.dataset.id === rowId)!;
          const box = list.getBoundingClientRect();
          const r = li.getBoundingClientRect();
          return {
            top: list.scrollTop,
            onScreen: r.top >= box.top - 1 && r.bottom <= box.bottom + 1,
            focused: document.activeElement === li.querySelector(':scope > button'),
          };
        }, id);
        expect(Math.abs(after.top - before), `the list's scrollTop was ${before} and is ${after.top}`).toBeLessThanOrEqual(3);
        expect(after.onScreen, 'the row is on screen').toBe(true);
        expect(after.focused, 'the row that opened the page has the focus').toBe(true);
      });
    });
  });
}
