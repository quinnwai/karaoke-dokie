// What a tap on a row does, on the production build, in Chromium and (where it is installed) WebKit: the fourth pass on PR #38 (QWW-57).
//   3. a double tap on a row opens the song page and leaves it there: the page holds its controls (pointer-events: none on the ▶, the Spotify
//      link or player, the thumbs; not ‹) for TAP_GUARD_MS from the commit that puts it on the screen, so the second tap, on whatever the page has
//      under that spot, falls through to the screen behind: no audio plays, no tab opens, nothing is sent. A tap after the moment does what it
//      did. The second tap is always sent at raw coordinates (page.touchscreen.tap): a locator's tap waits for the element to take events, which
//      waits the hold out and would hide the bug.
//   5. ‹ on the song page brings the list back scrolled to where the singer left it, with the focus on the row that opened the page. The list is
//      a new element each time (the page and the list take turns in one screen), so its place has to be put back.
// and of the gate on 1ee41b4:
//   4a. the hold is not a fixed 400 ms: a tap it swallows puts its end off by another 400 ms (a third tap 250 ms after the second, 500 ms after the first,
//       found the controls live), and a finger that went down in the hold keeps it up until it lifts (a touch's click is aimed at the lift, so a finger
//       that went down on a held control and lifted 450 ms after the row's tap pressed it; Chromium only, through two touch points)
//   4b. a double tap on "Load more": the rows it brings come up under the finger, and a tap on a row in the moment opens nothing
//   4c. a double tap on the round redo button: the quiet step's full-screen button comes up under the finger and a tap on it in the moment is ignored,
//       so "Find a quiet spot" stays for its own time and a triple tap never reaches "Back to songs" (the redo is not cancelled); a double tap on a
//       range note was already held, and is checked here in both engines
//   8.  a double tap on the header's Spotify button (a touch screen shows its tooltip on the first tap and connects on the second) shows the
//       tooltip and starts no sign-in; the keyboard still connects at once
//   9.  keys are not held: Enter and Space on the ▶, the link and a thumb, inside the 400 ms, do what they do (the clock is paused, so the moment
//       cannot run out under the test). It passes on the code as it is and fails when a control is held with `inert`, `disabled` or a skipped handler.
// Playwright's WebKit is desktop WebKit with an iPhone's viewport, touch and user agent. It is not iOS Safari: a pass here says WebKit's layout and
// focus rules are met, not what a phone does. CI installs Chromium only, so every test here has a Chromium run that fails without its fix (the
// two that guard what already held, the range notes of 4c and 9, fail when that is broken).
// jsdom cannot hit-test, so tests/screen/songPage.test.tsx only checks what the page sets and when; that a tap falls through is proved here.

import { devices, expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import type { MockSong } from '../fixtures/setlist';
import { centre, css, open, openButton, rows, titles } from '../helpers/tunerE2e';

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
 * page holds its content this says neither of them (they take no events: the finger is on the page itself), so ask after the moment.
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

/** One control of Beta Play's page: where it is, and what it does when it works (kind: what `underFinger` calls it). */
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

/**
 * A run of taps with real touches at raw coordinates: `spots[0]`, then each next one `gaps[i]` ms after the one before (a tap's own round trip counts, as in
 * `doubleTap`). Returns the ms from the first tap's return to the last one's, and when the last returned. Every gap is inside the moment of the tap before it.
 */
async function tapRun(page: Page, spots: Array<{ x: number; y: number }>, gaps: number[]) {
  let tookMs = 0;
  let firstEnd = 0;
  let lastEnd = 0;
  for (const [i, spot] of spots.entries()) {
    if (i > 0) await page.waitForTimeout(Math.max(0, gaps[i - 1]! - tookMs));
    const began = Date.now();
    await tapAt(page, spot);
    const ended = Date.now();
    tookMs = ended - began;
    if (i === 0) firstEnd = ended;
    else expect(ended - lastEnd, `tap ${i + 1} came inside the moment of tap ${i}`).toBeLessThan(GUARD - 10);
    lastEnd = ended;
  }
  return { sinceFirst: lastEnd - firstEnd, lastEnd };
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

  test.describe(`4a. the song page's hold lasts as long as the taps on it do (${engine.name})`, () => {
    test.skip(!engine.installed, 'WebKit is not installed here (CI installs Chromium only)');

    /** The gaps between the taps of a run, the first tap being the row's. Each is inside the moment; the last tap comes more than a moment after the first. */
    const RUNS = [
      [250, 200],
      [250, 250],
      [250, 300],
      [250, 250, 250, 250, 250], // a run that goes on for 1.25 s keeps the page held all through it
    ];
    for (const control of CONTROLS) {
      test(`${control.name}, tapped as the last of a run of taps ${RUNS.map((r) => r.join('+')).join(' / ')} ms apart: nothing; tapped 450 ms after the last: it works`, async ({ browser, baseURL }) => {
        test.setTimeout(180_000);
        await withPhone(engine, browser, baseURL, 390, 844, async (page) => {
          const seen = watch(page);
          await open(page, { extra: SONGS, mini: true });
          const rowAt = () => centre(openButton(rows(page).filter({ hasText: 'Beta Play' })));
          // Where the control is on Beta Play's page: a first look, after the moment.
          await tapAt(page, await rowAt());
          await expect(songTitle(page, 'Beta Play')).toBeVisible();
          await pastTheGuard(page);
          const at = await centre(control.spot(page));
          expect(await underFinger(page, at), 'the finger is on the control').toBe(control.kind);
          await page.goBack();
          await expect(rows(page).first()).toBeVisible();

          for (const gaps of RUNS) {
            // The row, then the control's spot again and again. The last tap is more than a moment after the first: the fixed 400 ms hold would be over.
            const run = await tapRun(page, [await rowAt(), ...gaps.map(() => at)], gaps);
            expect(run.sinceFirst, 'the last tap came after the first tap’s own moment').toBeGreaterThan(GUARD);
            await expectNothingHappened(page, seen, 'Beta Play');
            await page.goBack();
            await expect(rows(page).first()).toBeVisible();
          }

          // 450 ms after the last swallowed tap the control does what it did.
          const run = await tapRun(page, [await rowAt(), at, at], [250, 250]);
          await page.waitForTimeout(Math.max(0, GUARD + 50 - (Date.now() - run.lastEnd)));
          await tapAt(page, at);
          await control.works(page, seen);
        });
      });
    }
  });

  test.describe(`4b. a double tap on "Load more" opens no song (${engine.name})`, () => {
    test.skip(!engine.installed, 'WebKit is not installed here (CI installs Chromium only)');

    /** The 25 songs of the mock and 30 more: 55, so 40 are shown at first and 15 come up behind "Load more". */
    const FILLER: MockSong[] = Array.from({ length: 30 }, (_, i) => ({
      title: `Filler ${i + 1}`,
      artist: `Filler Artist ${i + 1}`,
      era: 's90',
      difficulty: 40 + (i % 5),
      history: 20,
      popularity: 20,
      tempo: 50,
    }));
    for (const gap of GAPS) {
      test(`at 390 px, the second tap ${gap} ms after the first: the rest of the list is shown and no song page opens; a tap on that row after the moment opens it`, async ({ browser, baseURL }) => {
        test.setTimeout(90_000);
        await withPhone(engine, browser, baseURL, 390, 844, async (page) => {
          await open(page, { extra: FILLER, mini: true });
          await expect(rows(page), 'a page of rows, and the rest behind Load more').toHaveCount(40);
          const more = page.getByRole('button', { name: 'Load more songs' });
          await more.scrollIntoViewIfNeeded();
          const at = await centre(more);
          expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') ?? null, at), 'the finger is on Load more').toBe('Load more songs');

          await doubleTap(page, at, gap);
          await pastTheGuard(page); // anything it started has started
          await expect(rows(page), 'the rest of the list is shown').toHaveCount(55);
          // The second tap came down on a row (the test can see the bug), and that row has not opened.
          const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-row]')?.getAttribute('data-rank') ?? null, at);
          expect(Number(under), 'a new row is under the finger now').toBeGreaterThan(40);
          await expect(page.getByRole('heading', { level: 2 }), 'no song page opened').toHaveCount(0);
          await expect(page.locator('#sheet')).toBeVisible();

          // A tap on that row after the moment is a choice.
          await tapAt(page, at);
          await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
        });
      });
    }
  });

  test.describe(`4c. a double tap on redo does not skip "Find a quiet spot" (${engine.name})`, () => {
    test.skip(!engine.installed, 'WebKit is not installed here (CI installs Chromium only)');

    const quiet = (page: Page) => page.getByRole('button', { name: /Find a quiet spot/ });
    const micStep = (page: Page) => page.getByRole('button', { name: 'Turn on microphone' });
    const backToSongs = (page: Page) => page.getByRole('button', { name: 'Back to songs' });
    /** KaraokeApp's default quietMs: how long "Find a quiet spot" stays up by itself. */
    const QUIET_MS = 2600;

    for (const gap of GAPS) {
      test(`at 390 px, the second tap ${gap} ms after the first: "Find a quiet spot" stays for its own time, and the mic step is not up early`, async ({ browser, baseURL }) => {
        test.setTimeout(90_000);
        await withPhone(engine, browser, baseURL, 390, 844, async (page) => {
          await open(page);
          const at = await centre(page.getByRole('button', { name: 'Redo the range test' }));
          const began = Date.now();
          await doubleTap(page, at, gap); // the second tap lands on the quiet step's full-screen button
          await page.waitForTimeout(300); // anything it started has started
          await expect(quiet(page), 'still on the quiet step').toBeVisible();
          await expect(micStep(page), 'the mic step is not up early').toHaveCount(0);
          await expect(page.locator('#sheet')).toHaveCount(0);

          // It goes on by itself when its time is up, and not before.
          await expect(micStep(page)).toBeVisible({ timeout: 6000 });
          expect(Date.now() - began, 'the quiet step stayed for its own time').toBeGreaterThan(QUIET_MS - 200);
        });
      });
    }

    test('at 390 px, a triple tap 150 ms apart: the redo is still on its quiet step, "Back to songs" was never reached; a tap on the quiet step 450 ms after the last goes on', async ({ browser, baseURL }) => {
      test.setTimeout(90_000);
      await withPhone(engine, browser, baseURL, 390, 844, async (page) => {
        await open(page);
        const at = await centre(page.getByRole('button', { name: 'Redo the range test' }));
        const run = await tapRun(page, [at, at, at], [150, 150]);
        await page.waitForTimeout(250);
        await expect(quiet(page), 'still on the quiet step').toBeVisible();
        await expect(micStep(page)).toHaveCount(0);
        await expect(backToSongs(page), 'Back to songs was not there to be reached').toHaveCount(0);
        await expect(page.locator('#sheet'), 'the redo was not cancelled').toHaveCount(0);

        // 450 ms after the last tap, a tap anywhere on the quiet step goes on as before: the mic step of the redo, with its way back.
        await page.waitForTimeout(Math.max(0, GUARD + 50 - (Date.now() - run.lastEnd)));
        await tapAt(page, { x: 195, y: 420 });
        await expect(micStep(page)).toBeVisible();
        await expect(backToSongs(page), 'the redo is still running').toBeVisible();
      });
    });

    for (const gap of GAPS) {
      test(`at 390 px, a range note, the second tap ${gap} ms after the first: the mic step stays and "Back to songs" under the finger does not cancel the redo; a tap after the moment leaves it`, async ({ browser, baseURL }) => {
        test.setTimeout(90_000);
        await withPhone(engine, browser, baseURL, 390, 844, async (page) => {
          await open(page);
          const at = await centre(page.getByRole('button', { name: /^Redo your low note/ }));
          await doubleTap(page, at, gap);
          await page.waitForTimeout(200);
          await expect(micStep(page)).toBeVisible();
          await expect(page.locator('#sheet')).toHaveCount(0);
          expect(await page.evaluate(() => (history.state as { kdOverlay?: string } | null)?.kdOverlay ?? null), 'the redo is still open').toBe('redo');

          await pastTheGuard(page);
          await tapAt(page, await centre(backToSongs(page)));
          await expect(page.locator('#sheet')).toBeVisible();
        });
      });
    }
  });

  test.describe(`8. a double tap on the header's Spotify button shows the tooltip and does not sign in (${engine.name})`, () => {
    test.skip(!engine.installed, 'WebKit is not installed here (CI installs Chromium only)');

    const connect = (page: Page) => page.getByRole('button', { name: 'Connect to Spotify' });
    const login = (page: Page) => page.waitForRequest((r) => /\/api\/auth\/login/.test(r.url()), { timeout: 10_000 });
    /** The sign-in requests so far: the button leaves the page for /api/auth/login. */
    const logins = (page: Page) => {
      const seen: string[] = [];
      page.on('request', (r) => {
        if (/\/api\/auth\/login/.test(r.url())) seen.push(r.url());
      });
      return seen;
    };

    for (const gap of GAPS) {
      test(`at 390 px, the second tap ${gap} ms after the first: the tooltip stays open and no sign-in starts; a tap 450 ms after the last signs in`, async ({ browser, baseURL }) => {
        test.setTimeout(60_000);
        await withPhone(engine, browser, baseURL, 390, 844, async (page) => {
          const seen = logins(page);
          await open(page);
          const at = await centre(connect(page));
          await doubleTap(page, at, gap);
          await pastTheGuard(page); // a sign-in starts straight away if it is going to
          await expect(connect(page), 'the tooltip is up to be read').toHaveAttribute('data-tip', 'open');
          await expect.poll(() => css(connect(page).locator('span'), 'opacity'), 'and drawn').toBe('1');
          expect(seen, 'no sign-in started').toEqual([]);
          expect(new URL(page.url()).pathname, 'and the page did not leave').toBe('/');

          const started = login(page);
          await tapAt(page, at); // 450 ms after the last tap: a choice
          await started;
        });
      });
    }

    test('at 390 px, four taps 150 ms apart never sign in; the keyboard, right after a tap that showed the tooltip, signs in at once', async ({ browser, baseURL }) => {
      test.setTimeout(60_000);
      await withPhone(engine, browser, baseURL, 390, 844, async (page) => {
        const seen = logins(page);
        await open(page);
        const at = await centre(connect(page));
        const run = await tapRun(page, [at, at, at, at], [150, 150, 150]);
        expect(run.sinceFirst, 'the last tap is more than a moment after the first').toBeGreaterThan(GUARD);
        await pastTheGuard(page);
        expect(seen, 'a run of quick taps never signs in').toEqual([]);
        await expect(connect(page)).toHaveAttribute('data-tip', 'open');

        // Elsewhere hides the tooltip; a tap on the button shows it again; Enter, in its moment, signs in at once (it has the name and no tooltip to read).
        await tapAt(page, await centre(page.getByRole('heading', { name: 'Tune your setlist' })));
        await expect(connect(page)).not.toHaveAttribute('data-tip', 'open');
        await tapAt(page, at);
        await expect(connect(page)).toHaveAttribute('data-tip', 'open');
        const started = login(page);
        await connect(page).focus();
        await page.keyboard.press('Enter');
        await started;
      });
    });
  });

  test.describe(`9. keys are not held (${engine.name})`, () => {
    test.skip(!engine.installed, 'WebKit is not installed here (CI installs Chromium only)');

    test('Space on a thumb, Enter on the ▶ and on the link, pressed while the page is still holding its controls, do what they do', async ({ browser, baseURL }) => {
      test.setTimeout(90_000);
      await withPhone(engine, browser, baseURL, 390, 844, async (page) => {
        // The page's clock is paused once the list is up, so the 400 ms hold cannot run out while the test presses keys: the hold is
        // then still on at every key press, which the test checks each time.
        await page.clock.install();
        const seen = watch(page);
        await open(page, { extra: SONGS, mini: true });
        const beta = rows(page).filter({ hasText: 'Beta Play' });
        await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
        await tapAt(page, await centre(openButton(beta)));
        await expect(songTitle(page, 'Beta Play')).toBeVisible();
        const holding = page.locator('[data-hold]');
        await expect(holding, 'the page holds its controls').toHaveCount(1);
        expect(await underFinger(page, await centre(playButton(page))), 'a touch cannot reach the ▶ now: it is held').not.toBe('play');

        await thumb(page, 'It went well').focus();
        await page.keyboard.press('Space');
        await expect.poll(() => seen.feedback, 'a key press on a thumb sent the feedback').toEqual(['/api/catalogue/feedback']);
        await expect(thumb(page, 'It went well')).toHaveAttribute('aria-pressed', 'true');
        await expect(holding, 'still holding').toHaveCount(1);

        await playButton(page).focus();
        await page.keyboard.press('Enter');
        await expect.poll(() => seen.previews, 'a key press on the ▶ asked for the preview').toEqual(['/api/preview/4243']);
        await expect(playButton(page)).not.toHaveAttribute('data-preview', 'idle');
        await expect(holding, 'still holding').toHaveCount(1);

        await page.getByRole('link', { name: 'Find on Spotify' }).focus();
        await page.keyboard.press('Enter');
        await expect.poll(() => seen.opened.size, 'a key press on the link opened its tab').toBe(1);
        await expect(holding, 'still holding').toHaveCount(1);

        // The moment is over when the clock runs on.
        await page.clock.runFor(GUARD);
        await expect(holding).toHaveCount(0);
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

// 4a (ii) needs two touch points, which only Chromium's DevTools protocol can send: Playwright's own touchscreen has one finger and taps.
test.describe('4a. a finger that goes down in the hold and lifts after it presses nothing (Chromium)', () => {
  /**
   * Two fingers: the first taps the row and lifts (the page opens), and the second goes down on `at` `downAfter` ms later and lifts `heldFor` ms after that. Returns when
   * the second went down and lifted, in ms from the first's lift, and when the second lifted.
   */
  async function secondFinger(page: Page, rowAt: { x: number; y: number }, at: { x: number; y: number }, downAfter: number, heldFor: number) {
    const cdp = await page.context().newCDPSession(page);
    const send = (type: 'touchStart' | 'touchEnd', touchPoints: Array<{ x: number; y: number; id: number }>) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    try {
      await send('touchStart', [{ ...rowAt, id: 1 }]);
      await send('touchEnd', []);
      const lifted = Date.now();
      await page.waitForTimeout(downAfter);
      await send('touchStart', [{ ...at, id: 2 }]);
      const down = Date.now() - lifted;
      await page.waitForTimeout(heldFor);
      await send('touchEnd', []);
      return { down, lift: Date.now() - lifted, liftedAt: Date.now() };
    } finally {
      await cdp.detach();
    }
  }

  for (const control of CONTROLS) {
    test(`${control.name}: a second finger down 100 ms after the row's tap and up 450 ms after it: nothing; a tap 450 ms after the lift works`, async ({ browser, baseURL }) => {
      test.setTimeout(90_000);
      await withPhone(ENGINES[0], browser, baseURL, 390, 844, async (page) => {
        const seen = watch(page);
        await open(page, { extra: SONGS, mini: true });
        const beta = rows(page).filter({ hasText: 'Beta Play' });
        const rowAt = await centre(openButton(beta));
        await tapAt(page, rowAt);
        await expect(songTitle(page, 'Beta Play')).toBeVisible();
        await pastTheGuard(page);
        const at = await centre(control.spot(page));
        expect(await underFinger(page, at), 'the finger is on the control').toBe(control.kind);
        await page.goBack();
        await expect(rows(page).first()).toBeVisible();

        const touch = await secondFinger(page, rowAt, at, 100, 350);
        expect(touch.down, 'the second finger went down inside the moment').toBeLessThan(GUARD - 10);
        expect(touch.lift, 'and lifted after it: its click is aimed at the lift').toBeGreaterThan(GUARD + 20);
        await page.waitForTimeout(150); // anything it started has started
        await expectNothingHappened(page, seen, 'Beta Play');

        await page.waitForTimeout(Math.max(0, GUARD + 50 - (Date.now() - touch.liftedAt)));
        await tapAt(page, at);
        await control.works(page, seen);
      });
    });
  }
});
