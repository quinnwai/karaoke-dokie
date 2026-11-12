// The song page's range chart and its thumbs (QWW-57, the adversarial review of #38):
//   R25  every note name of the range chart (four: the song's two ends and the singer's two, the notes of its two bars) is on screen when the
//        page opens, with no hover and no tap, at 360, 390 and 430 px, and none runs into another or off the chart: for a narrow song (the two
//        names of its bar would touch), for songs whose ends sit right next to the singer's ends, and for the usual ones
//   R20  nothing on this page waits for a hover: the one thing in the chart that waits is the legend under the names, which a tap opens and
//        closes on a phone and a pointer shows on a desktop
//   R26  a like or dislike stays: after a tap "Thanks! That helps." appears and stays, and on later visits (leaving and coming back, another
//        song and back, a reload) the picked thumb is selected and both are disabled; a different song is as it was
//
// Everything is read from the page as laid out (boxes, computed styles, what is hit at a point), never from the formulas of the stylesheet. Linux sets
// its text wider than a Mac does (CI is Linux): the geometry is read twice, as the browser sets it and with the chart's type in the widest font a page
// can fall back to (Verdana here, DejaVu Sans on Linux, which has the same widths). The tuner is reached the way the other specs reach it, with a
// mocked API (the songs are this file's own, so each can have the range a case needs).

import { devices, expect, test, type Page } from '@playwright/test';
import { midiToNoteName } from '../../src/lib/audio/notes';
import type { CatalogueFeedbackRequest, FeedbackRequest, Match, MeResponse, OctaveShift, RecommendationsResponse, SetlistRequest } from '../../src/lib/contracts';
import { MOCK_SONGS, mockMatch } from '../fixtures/setlist';
import { setlistAnswer } from '../helpers/setlistServer';
import { rgb } from '../helpers/tunerE2e';

test.use({ screenshot: 'off' });

const SCREENS = 'test-results/screens';
const shot = (page: Page, name: string) => page.screenshot({ path: `${SCREENS}/${name}.png` });

/** A2 to C5, the range the other specs sing. */
const RANGE = { low: 45, high: 72, source: 'test' } as const;
const SINGER: MeResponse = { userId: 'u1', displayName: 'Quinn', range: RANGE };
const NEON = rgb('#FF2E93'); // --pink, the thumb that was picked

// ---- the songs and the API ----

interface Song {
  title: string;
  artist: string;
  /** As recorded. */
  low: number;
  high: number;
  octave?: OctaveShift;
}

/** The song as the server sends it: the ranking engine's numbers from the shared mock, with the range a case needs. The id is the catalogue's (`cat:artist|title`) when signed out. */
function matchOf(song: Song, i: number, loggedIn: boolean): Match {
  const id = loggedIn ? `s${i}` : `cat:${song.artist.toLowerCase()}|${song.title.toLowerCase()}`;
  const m = mockMatch({ ...MOCK_SONGS[0]!, title: song.title, artist: song.artist, id }, i, '');
  return { ...m, range: { ...m.range, low: song.low, high: song.high, tessitura: (song.low + song.high) / 2 }, octave: song.octave ?? 'none' };
}

interface Posts {
  feedback: FeedbackRequest[];
  catalogueFeedback: CatalogueFeedbackRequest[];
}

async function mockSongApi(page: Page, songs: Song[], loggedIn: boolean): Promise<Posts> {
  const posts: Posts = { feedback: [], catalogueFeedback: [] };
  const list: RecommendationsResponse = { matches: songs.map((s, i) => matchOf(s, i, loggedIn)), nextOffset: null, sources: {}, complete: true };
  await page.context().route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    switch (`${req.method()} ${url.pathname}`) {
      case 'GET /api/me':
        return loggedIn ? json(SINGER) : json({ error: 'signed out' }, 401);
      case 'GET /api/recommendations':
      case 'GET /api/catalogue/recommendations':
        return json(list);
      case 'POST /api/setlist':
        return json(setlistAnswer(list, req.postDataJSON() as SetlistRequest, loggedIn));
      case 'POST /api/feedback':
        posts.feedback.push(req.postDataJSON() as FeedbackRequest);
        return json({ ok: true });
      case 'POST /api/catalogue/feedback':
        posts.catalogueFeedback.push(req.postDataJSON() as CatalogueFeedbackRequest);
        return json({ ok: true });
      case 'POST /api/events':
        return route.fulfill({ status: 204 });
      case 'PUT /api/me/range':
        return json({ ok: true });
      default:
        return json({ error: 'not mocked' }, 404);
    }
  });
  // No Spotify page is loaded: the songs here have a search link, which is the plain button, and a stand-in covers any embed.
  await page.context().route('https://open.spotify.com/embed/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  if (!loggedIn) await page.context().addInitScript((saved) => localStorage.setItem('kd.range', JSON.stringify(saved)), { low: RANGE.low, high: RANGE.high });
  return posts;
}

async function openList(page: Page) {
  await page.goto('/');
  await expect(page.locator('[data-row]').first()).toBeVisible({ timeout: 20_000 });
}

/** A phone: no hover, so a finger taps. */
const onTouch = (page: Page) => page.evaluate(() => matchMedia('(hover: none)').matches);

/** Opens a song from the list and waits for its page. The tap is a finger's on a phone and a click's with a mouse. */
async function openSong(page: Page, title: string) {
  const row = page.getByRole('button', { name: new RegExp(`^${title}`) });
  await row.scrollIntoViewIfNeeded();
  if (await onTouch(page)) await row.tap();
  else await row.click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

async function backToSongs(page: Page) {
  const back = page.getByRole('button', { name: 'Back to songs' });
  if (await onTouch(page)) await back.tap();
  else await back.click();
  await expect(page.locator('[data-row]').first()).toBeVisible();
}

// ---- the chart as laid out ----

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
interface Name extends Box {
  text: string;
  end: 'low' | 'high';
  row: 'song' | 'user';
  apart: boolean;
  /** Computed opacity times that of every ancestor: what the eye gets. 1 is fully there, 0 is not. */
  opacity: number;
  /** The name itself is what is on top at its centre: nothing covers it and no scroller clips it. */
  onTop: boolean;
}
interface Chart {
  chart: Box;
  screen: Box;
  scroll: { width: number; client: number };
  names: Name[];
  /** Everything inside the chart that is not fully visible: 'legend' for the legend and its parts, and what it is for anything else. */
  waiting: string[];
  legend: number;
}

const CHART = '[role="img"][aria-label^="Song goes from"]';

async function readChart(page: Page): Promise<Chart> {
  await page.locator(CHART).scrollIntoViewIfNeeded();
  return page.evaluate((selector) => {
    const chart = document.querySelector<HTMLElement>(selector)!;
    const box = (r: DOMRect): Box => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    const seen = (el: Element | null): number => {
      let o = 1;
      for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      return o;
    };
    const names = Array.from(chart.querySelectorAll<HTMLElement>('[data-end]')).map((n): Name => {
      const r = n.getBoundingClientRect();
      return {
        ...box(r),
        text: n.textContent ?? '',
        end: n.dataset.end as 'low' | 'high',
        row: n.className.includes('barNameSong') ? 'song' : 'user',
        apart: n.hasAttribute('data-apart'),
        opacity: seen(n),
        onTop: document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2) === n,
      };
    });
    const scroller = chart.closest<HTMLElement>('[class*="screenInner"]')!;
    const waiting = Array.from(chart.querySelectorAll<HTMLElement>('*'))
      .filter((e) => seen(e) < 1)
      .map((e) => (e.closest('[class*="barLegend"]') ? 'legend' : `${e.tagName.toLowerCase()}.${e.className}`));
    return {
      chart: box(chart.getBoundingClientRect()),
      screen: box(scroller.getBoundingClientRect()),
      scroll: { width: scroller.scrollWidth, client: scroller.clientWidth },
      names,
      waiting,
      legend: seen(chart.querySelector('[class*="barLegend"]')),
    };
  }, CHART);
}

const overlap = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const MIN_GAP = 1;

/** What the page must show for a song: four names, where they are on the singer's scale, and none touching another or past the chart. */
function expectNamesFit(c: Chart, song: Song, label: string) {
  const sung = song.octave === 'down' ? [song.low - 12, song.high - 12] : song.octave === 'up' ? [song.low + 12, song.high + 12] : [song.low, song.high];
  const want = [midiToNoteName(sung[0]!), midiToNoteName(sung[1]!), midiToNoteName(RANGE.low), midiToNoteName(RANGE.high)];
  expect(c.names.map((n) => n.text), `${label}: the names`).toEqual(want);
  expect(c.names.map((n) => `${n.row} ${n.end}`), `${label}: whose they are`).toEqual(['song low', 'song high', 'user low', 'user high']);

  // On screen: there at full strength without a hover or a tap, on top of everything near them, inside the chart and the screen.
  for (const n of c.names) {
    expect(n.opacity, `${label}: ${n.row} ${n.end} (${n.text}) is there`).toBe(1);
    expect(n.onTop, `${label}: ${n.row} ${n.end} (${n.text}) is not covered or clipped`).toBe(true);
    expect(n.right - n.left, `${label}: ${n.text} has a box`).toBeGreaterThan(5);
    expect(n.left, `${label}: ${n.text} is inside the chart's left edge`).toBeGreaterThanOrEqual(c.chart.left - 0.5);
    expect(n.right, `${label}: ${n.text} is inside the chart's right edge`).toBeLessThanOrEqual(c.chart.right + 0.5);
    expect(n.left, `${label}: ${n.text} is inside the screen's left edge`).toBeGreaterThanOrEqual(c.screen.left - 0.5);
    expect(n.right, `${label}: ${n.text} is inside the screen's right edge`).toBeLessThanOrEqual(c.screen.right + 0.5);
  }
  expect(c.scroll.width, `${label}: the screen does not scroll sideways`).toBeLessThanOrEqual(c.scroll.client);

  // Not touching: no two names share any of their box, and the two of a bar are in order with a gap between them.
  for (let i = 0; i < c.names.length; i++) {
    for (let j = i + 1; j < c.names.length; j++) {
      const [a, b] = [c.names[i]!, c.names[j]!];
      expect(overlap(a, b), `${label}: ${a.row} ${a.end} (${a.text}) and ${b.row} ${b.end} (${b.text}) do not overlap`).toBe(false);
    }
  }
  for (const row of ['song', 'user'] as const) {
    const [low, high] = c.names.filter((n) => n.row === row);
    expect(high!.left - low!.right, `${label}: the ${row}'s two names have a gap between them`).toBeGreaterThanOrEqual(MIN_GAP);
  }
  // The song's names are the first row and the singer's the second.
  expect(c.names[0]!.bottom, `${label}: the rows are one above the other`).toBeLessThanOrEqual(c.names[2]!.top);
}

// ---- R25 and R20: the chart ----

const CHART_SONGS: (Song & { apart: boolean })[] = [
  { title: 'Wide Open', artist: 'Artist One', low: 50, high: 64, apart: false },
  // The two names of a short bar would touch: 3, 2 and 1 semitones of the 31 the chart spans.
  { title: 'Narrow Three', artist: 'Artist Two', low: 60, high: 63, apart: true },
  { title: 'Narrow Two', artist: 'Artist Three', low: 60, high: 62, apart: true },
  { title: 'Drone', artist: 'Artist Four', low: 60, high: 61, apart: true },
  // Short, and at an end of the singer's range, where the chart has the least room to put a name outside.
  { title: 'Top Edge', artist: 'Artist Five', low: 70, high: 72, apart: true },
  { title: 'Bottom Edge', artist: 'Artist Six', low: 45, high: 47, apart: true },
  // Ends next to the singer's ends: a semitone inside, the same, and two past them.
  { title: 'Snug Fit', artist: 'Artist Seven', low: 46, high: 71, apart: false },
  { title: 'Same Ends', artist: 'Artist Eight', low: 45, high: 72, apart: false },
  { title: 'Wider Still', artist: 'Artist Nine', low: 43, high: 74, apart: false },
  // Recorded 3 semitones high and sung an octave lower, with the recording outlined behind it.
  { title: 'Octave Down', artist: 'Artist Ten', low: 72, high: 75, octave: 'down', apart: true },
];

/** The widest font a page falls back to: Verdana here, DejaVu Sans on Linux. The chart's names are 11 px in it, as in any other. */
const WIDEST_FONT = `${CHART} * { font-family: Verdana, 'DejaVu Sans', sans-serif !important; }`;

for (const width of [360, 390, 430]) {
  test.describe(`on a ${width} px phone`, () => {
    test.use({ viewport: { width, height: 844 } });

    for (const widest of [false, true]) {
      test(`every note name of the chart is on screen when the page opens, with no hover or tap, and none touches another${widest ? ', in the widest font' : ''}`, async ({ page }) => {
        test.setTimeout(90_000);
        await mockSongApi(page, CHART_SONGS, true);
        await openList(page);
        if (widest) await page.addStyleTag({ content: WIDEST_FONT });
        // A finger, not a mouse: `(hover: none)`, as a phone has it.
        expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);

        for (const song of CHART_SONGS) {
          await openSong(page, song.title);
          if (widest) await page.addStyleTag({ content: WIDEST_FONT });
          const chart = await readChart(page);
          expectNamesFit(chart, song, `${song.title} at ${width} px`);
          // The bars that are too short for their names to stand side by side are the ones that have them outside their ends.
          expect(chart.names.filter((n) => n.row === 'song').map((n) => n.apart), `${song.title}: the song's names outside its ends`).toEqual([song.apart, song.apart]);
          expect(chart.names.filter((n) => n.row === 'user').map((n) => n.apart), `${song.title}: the singer's names stay on their ends`).toEqual([false, false]);
          if (song.title === 'Narrow Two' || song.title === 'Top Edge' || song.title === 'Wide Open') await shot(page, `r25-${song.title.toLowerCase().replace(/ /g, '-')}-${width}${widest ? '-widest' : ''}`);
          await backToSongs(page);
        }
      });
    }

    test('the chart has nothing that waits for a hover but its legend, and a tap opens the legend and a second tap closes it (R20)', async ({ page }) => {
      await mockSongApi(page, CHART_SONGS, true);
      await openList(page);
      for (const title of ['Wide Open', 'Octave Down']) {
        await openSong(page, title);
        // On load everything in the chart is there but the legend (its text and its keys), which waits for a tap.
        const chart = await readChart(page);
        expect(chart.waiting.length, `${title}: the legend waits`).toBeGreaterThan(0);
        expect(chart.waiting.filter((w) => w !== 'legend'), `${title}: nothing else waits`).toEqual([]);
        expect(chart.legend).toBe(0);

        const bar = page.locator(CHART);
        const legend = async () => (await readChart(page)).legend;
        await bar.tap();
        await expect.poll(legend).toBe(1);
        expect((await readChart(page)).waiting, `${title}: with the legend open nothing in the chart waits`).toEqual([]);
        await bar.tap();
        await expect.poll(legend).toBe(0);
        await backToSongs(page);
      }
    });
  });
}

test.describe('on a desktop, with a pointer', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false, userAgent: devices['Desktop Chrome'].userAgent });

  test('the names are there with the pointer elsewhere, and the legend comes with a hover and goes with it', async ({ page }) => {
    test.setTimeout(60_000);
    await mockSongApi(page, CHART_SONGS, true);
    await openList(page);
    expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(true);
    for (const title of ['Wide Open', 'Narrow Two', 'Snug Fit']) {
      await openSong(page, title);
      await page.mouse.move(1, 1);
      const chart = await readChart(page);
      expectNamesFit(chart, CHART_SONGS.find((s) => s.title === title)!, `${title} on a desktop`);
      expect(chart.legend, `${title}: the legend waits for the pointer`).toBe(0);
      await page.locator(CHART).hover();
      await expect.poll(async () => (await readChart(page)).legend).toBe(1);
      await page.mouse.move(1, 1);
      await expect.poll(async () => (await readChart(page)).legend).toBe(0);
      await backToSongs(page);
    }
  });

  test('a thumb lights under the pointer until one is picked, and then neither does: a thumb that cannot be changed is not offered (R26)', async ({ page }) => {
    await mockSongApi(page, RATED, true);
    await openList(page);
    await openSong(page, 'Rated First');
    const well = page.getByRole('button', { name: 'It went well' });
    const notWell = page.getByRole('button', { name: "It didn't go well" });
    await page.mouse.move(1, 1);
    await expect(notWell).not.toHaveCSS('border-top-color', NEON);
    await notWell.hover();
    await expect(notWell).toHaveCSS('border-top-color', NEON);
    await well.click();
    await expect(well).toBeDisabled();
    await page.mouse.move(1, 1);
    await notWell.hover();
    await expect(notWell).not.toHaveCSS('border-top-color', NEON);
    await expect(well).toHaveCSS('border-top-color', NEON); // the picked one stays lit, hovered or not
  });
});

// ---- R26: a like or dislike stays ----

const RATED: Song[] = [
  { title: 'Rated First', artist: 'Singer One', low: 50, high: 64 },
  { title: 'Rated Second', artist: 'Singer Two', low: 52, high: 66 },
];

for (const loggedIn of [false, true]) {
  test.describe(loggedIn ? 'signed in (a song of the library, by its Spotify id)' : 'without Spotify (a catalogue song, by `cat:artist|title`)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    const FIRST = loggedIn ? 's0' : 'cat:singer one|rated first';
    const posts = (p: Posts) => (loggedIn ? p.feedback : p.catalogueFeedback);

    const well = (page: Page) => page.getByRole('button', { name: 'It went well' });
    const notWell = (page: Page) => page.getByRole('button', { name: "It didn't go well" });
    const thanks = (page: Page) => page.getByText('Thanks! That helps.');
    const question = (page: Page) => page.getByText('How’d it go?');
    const stored = (page: Page, id: string) => page.evaluate((key) => localStorage.getItem(key), `kd.feedback:${id}`);

    const expectOpen = async (page: Page) => {
      for (const thumb of [well(page), notWell(page)]) {
        await expect(thumb).toBeEnabled();
        await expect(thumb).toHaveAttribute('aria-pressed', 'false');
      }
      await expect(question(page)).toBeVisible();
      await expect(thanks(page)).toHaveCount(0);
    };
    const expectPicked = async (page: Page, picked: 'up' | 'down') => {
      const [yes, no] = picked === 'up' ? [well(page), notWell(page)] : [notWell(page), well(page)];
      await expect(yes).toBeDisabled();
      await expect(no).toBeDisabled();
      await expect(yes).toHaveAttribute('aria-pressed', 'true');
      await expect(no).toHaveAttribute('aria-pressed', 'false');
      await expect(thanks(page)).toBeVisible();
      await expect(question(page)).toHaveCount(0);
      // Seen: the picked one is neon pink, the other one is faded.
      await expect(yes).toHaveCSS('border-top-color', NEON);
      await expect(yes).toHaveCSS('opacity', '1');
      expect(Number(await no.evaluate((e) => getComputedStyle(e).opacity))).toBeLessThan(0.6);
      expect(await no.evaluate((e) => getComputedStyle(e).borderTopColor)).not.toBe(NEON);
    };

    test('tap like, leave, come back, reload: the thumb is selected and disabled and the thanks line shows; another song is as it was', async ({ page }) => {
      test.setTimeout(90_000);
      const api = await mockSongApi(page, RATED, loggedIn);
      await openList(page);

      // A first visit: asked, and nothing kept.
      await openSong(page, 'Rated First');
      await expectOpen(page);
      expect(await stored(page, FIRST)).toBeNull();
      await shot(page, `r26-asking-${loggedIn ? 'library' : 'catalogue'}`);

      // The tap: the thanks takes the question's place, the thumb is picked and both are locked, one request goes, and the device keeps it.
      await well(page).tap();
      await expectPicked(page, 'up');
      await expect.poll(() => posts(api).length).toBe(1);
      expect(posts(api)[0]).toMatchObject({ trackId: FIRST, thumbs: 'up' });
      expect(await stored(page, FIRST)).toBe('up');
      await shot(page, `r26-thanks-${loggedIn ? 'library' : 'catalogue'}`);

      // Leave, open another song, come back: still picked, and the other song is as it was.
      await backToSongs(page);
      await openSong(page, 'Rated Second');
      await expectOpen(page);
      await backToSongs(page);
      await openSong(page, 'Rated First');
      await expectPicked(page, 'up');

      // A reload: the app starts over, the device does not. The page opens already showing it.
      await page.reload();
      await expect(page.locator('[data-row]').first()).toBeVisible({ timeout: 20_000 });
      await openSong(page, 'Rated First');
      await expectPicked(page, 'up');
      await backToSongs(page);
      await openSong(page, 'Rated Second');
      await expectOpen(page);

      // A tap on a thumb that cannot be changed does nothing: no request, and the answer stays.
      await backToSongs(page);
      await openSong(page, 'Rated First');
      await notWell(page).click({ force: true });
      await well(page).click({ force: true });
      await page.waitForTimeout(400);
      expect(posts(api)).toHaveLength(1);
      expect(await stored(page, FIRST)).toBe('up');
      await expectPicked(page, 'up');
      expect(loggedIn ? api.catalogueFeedback : api.feedback).toHaveLength(0);
    });

    test('a dislike stays the same way', async ({ page }) => {
      const api = await mockSongApi(page, RATED, loggedIn);
      await openList(page);
      await openSong(page, 'Rated Second');
      await notWell(page).tap();
      await expectPicked(page, 'down');
      await expect.poll(() => posts(api).length).toBe(1);
      expect(posts(api)[0]).toMatchObject({ thumbs: 'down' });
      await page.reload();
      await expect(page.locator('[data-row]').first()).toBeVisible({ timeout: 20_000 });
      await openSong(page, 'Rated Second');
      await expectPicked(page, 'down');
    });
  });
}
