// Review items R16, R17 and R27 of QWW-57 (Quinn-Wai's review of #38 on an iPhone, 11 Nov), one check each as the ticket asks:
//   R16  while a preview plays the row's title fills left to right in the pink neon sweep, over the preview's length; it resets when the
//        preview stops or another row plays
//   R17  a thin circle surrounds the ▶ wherever it shows (always on a touch screen; on a pointer device with the ▶, on hover or focus);
//        while it plays the ⏸ sits in a ring that fills over the preview and is full as the preview ends; a disabled ▶ has a faded circle
//        and glyph. This replaces R3's "no ring or circle in any state" (tests/e2e/setlist-rows.spec.ts has the rest of R3)
//   R27  the song page's own ▶, larger and labelled "Play 30 s", right under the title and above the range chart: above the fold on a
//        phone, before Find on Spotify in the Tab order, on the list's one player, stopped when the page goes; Find on Spotify is the
//        secondary, outlined button under it
// R20 (nothing needs hover on a touch screen) is checked here for the row's ▶ and the song page's.
//
// The tuner is reached as tests/e2e/setlist.spec.ts reaches it (tests/helpers/tunerE2e.ts), with songs that have a Deezer track, and
// /api/preview/<id> answers with a few seconds of silence (tests/helpers/silentWav.ts), so a real <audio> plays a preview from its tap to its end. The unit tests
// (tests/screen/previewPlay.test.tsx) have what is written to the DOM and when; here is what a browser draws. The WebKit test runs where
// WebKit is installed (CI installs Chromium only), as tests/e2e/preview.spec.ts does.

import { devices, expect, test, webkit, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { open, openButton, rgb, rows } from '../helpers/tunerE2e';
import type { MockSong } from '../fixtures/setlist';
import { silentWav } from '../helpers/silentWav';

const SCREENS = path.resolve('test-results/screens');
test.beforeAll(() => mkdirSync(SCREENS, { recursive: true }));

// A 390x844 touch phone, with motion: the sweep and the ring are what is looked at. The describes below say otherwise.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'no-preference' }, screenshot: 'off' });

const POINTER = { hasTouch: false, isMobile: false } as const;
const PINK_TEXT = rgb('#FF6FB1');
const PINK = rgb('#FF2E93'); // the app's --pink, the song page's

/** Three songs that lead the list under the defaults (easy and the best known): two with a Deezer track, one without. */
const SONGS: MockSong[] = [
  { title: 'Alpha Play', artist: 'First Artist', era: 's90', difficulty: 3, history: 50, popularity: 100, tempo: 50, deezerId: 4242 },
  { title: 'Beta Play', artist: 'Second Artist', era: 's90', difficulty: 4, history: 50, popularity: 99, tempo: 50, deezerId: 4243 },
  { title: 'Gamma None', artist: 'No Preview', era: 's90', difficulty: 5, history: 50, popularity: 98, tempo: 50 },
];

// ---- the preview route: a short silence, so a test can watch a preview to its end ----

/**
 * Every /api/preview/<id> answers with `seconds` of silence (tests/helpers/silentWav.ts: WebKit plays page audio out of the speakers) after `delay` ms, in byte ranges as Deezer's CDN does (Safari asks for media in
 * ranges). A page route, which wins over the one open() puts on the context (30 s of silence after 1.2 s).
 */
async function shortPreviews(page: Page, seconds: number, delay = 150) {
  const silence = silentWav(seconds);
  await page.route(/\/api\/preview\/\d+$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers()['range'] ?? '');
    if (!range) return route.fulfill({ status: 200, contentType: 'audio/wav', headers: { 'accept-ranges': 'bytes' }, body: silence });
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : silence.length - 1, silence.length - 1);
    return route.fulfill({
      status: 206,
      contentType: 'audio/wav',
      headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${silence.length}` },
      body: silence.subarray(start, end + 1),
    });
  });
}

// ---- small readers ----

const rowOf = (page: Page, title: string) => rows(page).filter({ hasText: title });
const slotOf = (row: Locator) => row.locator('[data-play-slot]');
const playOf = (row: Locator) => row.locator('[data-play-slot] button');
/** The ▶'s picture, in its order: the ring (a track circle, and the fill that runs over it), then the glyph. */
const ringOf = (row: Locator) => playOf(row).locator('svg').first();
const trackOf = (row: Locator) => ringOf(row).locator('circle').first();
const fillOf = (row: Locator) => ringOf(row).locator('circle').nth(1);
const glyphOf = (row: Locator) => playOf(row).locator('svg').last();
const numberOf = (row: Locator) => row.locator('[data-rank-number]');
const boxOf = (row: Locator) => row.locator('[data-fill-text]');
const away = (page: Page) => page.mouse.move(2, 400); // off every row, and off the phone-shaped frame on a desktop
const css = (loc: Locator, prop: string) => loc.first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
const stateOf = (loc: Locator) => loc.getAttribute('data-preview');

/** How strongly something is drawn: its own opacity times every ancestor's (the faded ▶ is faded on its button). */
const drawnOpacity = (loc: Locator) =>
  loc.first().evaluate((el) => {
    let o = 1;
    for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return o;
  });

/** A rgb() or rgba() colour as numbers. */
const parts = (colour: string) => {
  const m = /^rgba?\(([^)]*)\)$/.exec(colour.trim());
  const [r = 0, g = 0, b = 0, a = 1] = (m?.[1] ?? '').split(/[,/]\s*|\s+/).filter(Boolean).map(Number);
  return { r, g, b, a };
};

/** The page's one shared <audio>: how many there are, what it holds, and whether it plays. */
const audio = (page: Page) =>
  page.evaluate(() => {
    const a = document.querySelector<HTMLAudioElement>('audio[data-preview-audio]');
    return { count: document.querySelectorAll('audio').length, src: a?.getAttribute('src') ?? null, paused: a?.paused ?? true, time: a?.currentTime ?? 0, duration: a?.duration ?? NaN };
  });

/**
 * The pink copy over a row's title, as the browser computes it (the ::before of the title's box): whether there is one, how much of it is
 * shown (0 to 1: the clip's right inset is what is still to come), and its colour.
 */
const sweepOf = (row: Locator) =>
  boxOf(row).evaluate((box) => {
    const s = getComputedStyle(box, '::before');
    if (s.content === 'none' || s.content === 'normal' || s.content === '') return { copy: false as const, shown: null, color: null, text: null };
    const inset = /^inset\((\S+) ([\d.]+)% (\S+) (\S+)\)$/.exec(s.clipPath);
    const shown = s.clipPath === 'none' ? 1 : inset ? 1 - Number.parseFloat(inset[2]!) / 100 : Number.NaN;
    return { copy: true as const, shown, color: s.color, text: s.content };
  });

/** What a row's element says of its preview's progress (the property R16's sweep reads). */
const progressVar = (row: Locator) => row.evaluate((li) => (li as HTMLElement).style.getPropertyValue('--preview-progress'));

interface Sample {
  /** ms since the watch began. */
  t: number;
  state: string | null;
  /** The audio's own position and length, s. */
  time: number;
  duration: number;
  /** How much of the ring is filled, 0 to 1 (from its dash offset), and whether the fill is drawn at all: it has an opacity, and its ring is on the screen (not hidden or taken away). */
  ring: number;
  ringDrawn: boolean;
  /** The pink copy over the title (rows only): there or not, how much is shown, what colour, and what its clip leaves on the other three sides. */
  copy: boolean;
  shown: number | null;
  color: string | null;
  sides: string | null;
}

/**
 * Records, a frame at a time, what a ▶ and its title show, from now until its preview has played to its end (the ▶ back to idle after it
 * made a sound) or `limit` ms have passed. `id` is a row's track id; without it the watch is of the song page's ▶. Start it before the tap
 * and await it after: `const seen = watch(page, id); await tap; await seen`.
 */
function watch(page: Page, id: string | undefined, limit = 15_000): Promise<Sample[]> {
  return page.evaluate(
    ({ id, limit }) =>
      new Promise<Sample[]>((resolve) => {
        const li = id === undefined ? null : ([...document.querySelectorAll<HTMLElement>('[data-row]')].find((r) => r.dataset.id === id) ?? null);
        const button = (li ? li.querySelector('[data-play-slot] button') : document.querySelector('button[data-preview]')) as HTMLElement;
        const fill = button.querySelectorAll('circle')[1] as SVGCircleElement;
        const box = li?.querySelector<HTMLElement>('[data-fill-text]') ?? null;
        const RING = 2 * Math.PI * 16.5;
        const out: Sample[] = [];
        const began = performance.now();
        let sounded = false;
        const frame = () => {
          const a = document.querySelector<HTMLAudioElement>('audio[data-preview-audio]');
          const state = button.getAttribute('data-preview');
          const s = box ? getComputedStyle(box, '::before') : null;
          const there = !!s && s.content !== 'none' && s.content !== 'normal' && s.content !== '';
          const inset = s ? /^inset\((\S+) ([\d.]+)% (\S+) (\S+)\)$/.exec(s.clipPath) : null;
          out.push({
            t: performance.now() - began,
            state,
            time: a?.currentTime ?? 0,
            duration: a?.duration ?? Number.NaN,
            ring: 1 - Number.parseFloat(fill.style.strokeDashoffset) / RING,
            ringDrawn: getComputedStyle(fill).opacity !== '0' && fill.ownerSVGElement!.getBoundingClientRect().width > 0 && getComputedStyle(fill).visibility !== 'hidden',
            copy: there,
            shown: !there ? null : s!.clipPath === 'none' ? 1 : inset ? 1 - Number.parseFloat(inset[2]!) / 100 : Number.NaN,
            color: there ? s!.color : null,
            sides: inset ? `${inset[1]} ${inset[3]} ${inset[4]}` : null,
          });
          if (state === 'playing') sounded = true;
          if ((sounded && state === 'idle') || performance.now() - began > limit) return resolve(out);
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
    { id, limit },
  );
}

/** Every sample is not below the one before it (within `slack`: a clock that reads a hair back is not a ring that shrinks). */
function expectGrowing(values: number[], what: string, slack = 0.005) {
  for (let i = 1; i < values.length; i++) expect(values[i]!, `${what} at frame ${i}`).toBeGreaterThanOrEqual(values[i - 1]! - slack);
}

// ============================================================================================================
// R17: the circle round the ▶, and the ring that fills over the preview
// ============================================================================================================

test('R17. on a phone a thin circle surrounds the ▶ of every row: the full pink round one that can play, a faded one round one that cannot', async ({ page }) => {
  await shortPreviews(page, 4);
  await open(page, { extra: SONGS });
  expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
  for (const [title, canPlay] of [['Alpha Play', true], ['Beta Play', true], ['Gamma None', false]] as const) {
    const row = rowOf(page, title);
    // No hover on a phone: the ▶ is there, the rank number is not drawn, and the circle is drawn round the glyph.
    await expect(glyphOf(row), title).toBeVisible();
    await expect(numberOf(row), title).toBeHidden();
    await expect(ringOf(row), title).toBeVisible();
    await expect(trackOf(row), title).toBeVisible();
    const slot = (await slotOf(row).boundingBox())!;
    const ring = (await ringOf(row).boundingBox())!;
    const glyph = (await glyphOf(row).boundingBox())!;
    const track = (await trackOf(row).boundingBox())!;
    expect([slot.width, slot.height], `${title}: the slot is the 44 px target it was`).toEqual([44, 44]);
    // A 36 px box in the 44 px slot, with a circle of radius 16.5 in it: round the glyph, concentric with it and with the slot.
    expect(ring.width).toBeCloseTo(36, 0);
    expect(ring.height).toBeCloseTo(36, 0);
    // (A circle's box is its 33 px, and the stroke on it when the browser counts that in: 34.5 px in Chromium.)
    for (const side of [track.width, track.height]) {
      expect(side).toBeGreaterThanOrEqual(33);
      expect(side).toBeLessThanOrEqual(35);
    }
    for (const [what, a, b] of [['ring and glyph', ring, glyph], ['ring and slot', ring, slot], ['circle and glyph', track, glyph]] as const) {
      expect(Math.abs(a.x + a.width / 2 - (b.x + b.width / 2)), `${title}: ${what} share their centre in x`).toBeLessThanOrEqual(1);
      expect(Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)), `${title}: ${what} share their centre in y`).toBeLessThanOrEqual(1);
    }
    // Thin: drawn 1.5 px wide, in a pink (the badge's line colour, a little dimmer, so the fill reads over it).
    expect(Number.parseFloat(await css(trackOf(row), 'stroke-width'))).toBeLessThanOrEqual(2);
    const stroke = parts(await css(trackOf(row), 'stroke'));
    expect(stroke.r, `${title}: a pink circle`).toBeGreaterThan(200);
    expect(stroke.g).toBeLessThan(120);
    expect(stroke.b).toBeGreaterThan(100);
    expect(stroke.a).toBeGreaterThan(0.3);
    expect(await css(trackOf(row), 'fill')).toBe('none');
    // At rest the fill is not drawn: there is only the circle.
    expect(await css(fillOf(row), 'opacity')).toBe('0');

    if (canPlay) {
      await expect(playOf(row)).toBeEnabled();
      expect(await drawnOpacity(trackOf(row)), `${title}: the circle in full`).toBe(1);
      expect(await drawnOpacity(glyphOf(row))).toBe(1);
      expect(await css(glyphOf(row).locator('path'), 'fill')).toBe(PINK_TEXT);
    } else {
      // Disabled: the circle and the glyph both faded (the whole button is), and still there.
      await expect(playOf(row)).toBeDisabled();
      for (const [what, part] of [['circle', trackOf(row)], ['glyph', glyphOf(row)]] as const) {
        const drawn = await drawnOpacity(part);
        expect(drawn, `${title}: the ${what} is faded`).toBeLessThan(0.6);
        expect(drawn, `${title}: the ${what} is still drawn`).toBeGreaterThan(0.2);
      }
    }
  }
  await rowOf(page, 'Alpha Play').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SCREENS, 'setlist-R17-circles-390x844.png') });
});

test('R17. while a preview plays the ⏸ sits in a ring that fills over it, a frame at a time, and is full as the preview ends; empty before and after', async ({ page }) => {
  await shortPreviews(page, 4);
  await open(page, { extra: SONGS });
  const row = rowOf(page, 'Alpha Play');
  const id = (await row.getAttribute('data-id'))!;
  await expect(playOf(row)).toHaveAttribute('data-preview', 'idle');
  expect(await css(fillOf(row), 'opacity'), 'before: nothing is filled').toBe('0');

  const seen = watch(page, id);
  await playOf(row).tap();
  const samples = await seen;
  const playing = samples.filter((s) => s.state === 'playing');
  expect(samples.at(-1)!.state, 'the watch ended on the preview ending').toBe('idle');
  expect(playing.length, 'a frame at a time').toBeGreaterThan(30);
  expect(playing[0]!.duration).toBeCloseTo(4, 1);
  // The fill is drawn while it loads and plays, and not after.
  expect(samples.filter((s) => s.state === 'loading' || s.state === 'playing').every((s) => s.ringDrawn)).toBe(true);
  expect(samples.at(-1)!.ringDrawn).toBe(false);
  // It grows, from nothing to the whole circle, with the sound.
  const ring = playing.map((s) => s.ring);
  expectGrowing(ring, 'the ring');
  expect(ring[0]!, 'it starts empty').toBeLessThan(0.15);
  expect(Math.max(...ring), 'it is full as the preview ends').toBeGreaterThan(0.9);
  expect(ring[Math.floor(ring.length / 2)]!, 'half way through it is about half').toBeGreaterThan(0.3);
  expect(ring[Math.floor(ring.length / 2)]!).toBeLessThan(0.7);
  for (const s of playing) expect(Math.abs(s.ring - s.time / s.duration), `the ring follows the sound at ${Math.round(s.t)} ms`).toBeLessThan(0.05);
  // After the end it is back to ▶ with an empty ring.
  await expect(playOf(row)).toHaveAttribute('data-preview', 'idle');
  expect(await css(fillOf(row), 'opacity')).toBe('0');
  expect(Number.parseFloat(await fillOf(row).evaluate((c) => (c as SVGCircleElement).style.strokeDashoffset))).toBeCloseTo(2 * Math.PI * 16.5, 1);
});

test('R17. a paused preview keeps its ring where it stopped, and carries on from there; the ▶ it shows is the ▶, in its circle', async ({ page }) => {
  await shortPreviews(page, 6);
  await open(page, { extra: SONGS });
  const row = rowOf(page, 'Alpha Play');
  const filled = async () => 1 - Number.parseFloat(await fillOf(row).evaluate((c) => (c as SVGCircleElement).style.strokeDashoffset)) / (2 * Math.PI * 16.5);
  await playOf(row).tap();
  await expect(playOf(row)).toHaveAttribute('data-preview', 'playing');
  await expect.poll(filled).toBeGreaterThan(0.2);
  await playOf(row).tap();
  await expect(playOf(row)).toHaveAttribute('data-preview', 'paused');
  // Paused: the ▶ glyph in its circle, the ring where it stopped, and it does not move.
  await expect(ringOf(row)).toBeVisible();
  await expect(glyphOf(row)).toBeVisible();
  const held = await filled();
  expect(held).toBeGreaterThan(0.2);
  await page.waitForTimeout(700);
  expect(await filled()).toBeCloseTo(held, 3);
  expect(await css(fillOf(row), 'opacity'), 'the fill stays drawn').toBe('1');
  // Resumed, it carries on from there.
  await playOf(row).tap();
  await expect(playOf(row)).toHaveAttribute('data-preview', 'playing');
  await expect.poll(filled).toBeGreaterThan(held + 0.05);
  expect(await filled()).toBeGreaterThanOrEqual(held - 0.01);
});

test.describe('R17, with a pointer', () => {
  test.use({ viewport: { width: 1280, height: 800 }, ...POINTER });

  test('R17. the circle comes and goes with the ▶: not drawn at rest (the rank number is), drawn on hover and on keyboard focus, and drawn without hover while a preview plays', async ({ page }) => {
    await shortPreviews(page, 4);
    await open(page, { extra: SONGS });
    expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(true);
    const row = rowOf(page, 'Alpha Play');
    const other = rowOf(page, 'Beta Play');

    // At rest: the number, and neither the circle nor the glyph.
    await away(page);
    await expect(numberOf(row)).toBeVisible();
    await expect(ringOf(row)).toBeHidden();
    await expect(glyphOf(row)).toBeHidden();

    // Hovered: the number goes and the ▶ comes with its circle, round the glyph; only on the hovered row.
    await row.hover();
    await expect(numberOf(row)).toBeHidden();
    await expect(ringOf(row)).toBeVisible();
    await expect(glyphOf(row)).toBeVisible();
    await expect(ringOf(other)).toBeHidden();
    const ring = (await ringOf(row).boundingBox())!;
    const glyph = (await glyphOf(row).boundingBox())!;
    expect([Math.round(ring.width), Math.round(ring.height)]).toEqual([36, 36]);
    expect(Math.abs(ring.x + ring.width / 2 - (glyph.x + glyph.width / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(ring.y + ring.height / 2 - (glyph.y + glyph.height / 2))).toBeLessThanOrEqual(1);
    await page.screenshot({ path: path.join(SCREENS, 'setlist-R17-hover-1280x800.png') });
    await away(page);
    await expect(ringOf(row)).toBeHidden();
    await expect(numberOf(row)).toBeVisible();

    // Keyboard focus: the ▶ and its circle, with a round focus outline (the button is round now), and Tab on takes them away again.
    await playOf(row).focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(playOf(row)).toBeFocused();
    await expect(numberOf(row)).toBeHidden();
    await expect(ringOf(row)).toBeVisible();
    expect(await css(playOf(row), 'border-top-left-radius')).toBe('50%');
    expect(await css(playOf(row), 'outline-style')).toBe('solid');
    await page.keyboard.press('Tab'); // the row's own button
    await expect(openButton(row)).toBeFocused();
    await expect(ringOf(row)).toBeHidden();
    await expect(numberOf(row)).toBeVisible();

    // Playing, with the pointer away: the ⏸ in its ring, where the number was.
    await playOf(row).click();
    await away(page);
    await expect(playOf(row)).toHaveAttribute('data-preview', 'playing');
    await expect(numberOf(row)).toBeHidden();
    await expect(ringOf(row)).toBeVisible();
    await expect(glyphOf(row)).toBeVisible();
    expect(await css(fillOf(row), 'opacity')).toBe('1');
    await expect(ringOf(other)).toBeHidden();
    await expect(numberOf(other)).toBeVisible();
  });
});

// ============================================================================================================
// R16: the playing row's title fills in pink over the preview's length
// ============================================================================================================

test('R16. while a preview plays the title fills in pink from the left, over the preview\'s length: nothing before it plays, a growing fill while it does, the whole title as it ends, nothing after', async ({ page }) => {
  await shortPreviews(page, 4);
  await open(page, { extra: SONGS });
  const row = rowOf(page, 'Alpha Play');
  const id = (await row.getAttribute('data-id'))!;
  // Before: no copy over any title, and no progress on the row.
  expect(await sweepOf(row)).toMatchObject({ copy: false });
  expect(await sweepOf(rowOf(page, 'Beta Play'))).toMatchObject({ copy: false });
  expect(await progressVar(row)).toBe('');

  const seen = watch(page, id);
  await playOf(row).tap();
  const samples = await seen;
  const playing = samples.filter((s) => s.state === 'playing');
  expect(samples.at(-1)!.state).toBe('idle');
  expect(playing.length).toBeGreaterThan(30);
  // The copy is there from the tap (while it loads it shows none of the title), in the pink of the badge, and its clip opens from the left only.
  expect(samples.filter((s) => s.state === 'loading' || s.state === 'playing').every((s) => s.copy)).toBe(true);
  expect(samples.filter((s) => s.state === 'loading').every((s) => s.shown === 0)).toBe(true);
  expect(new Set(playing.map((s) => s.color))).toEqual(new Set([PINK_TEXT]));
  expect(new Set(playing.map((s) => s.sides)), 'only the right edge of the clip moves').toEqual(new Set(['0px 0px 0px']));
  // It fills: from nothing, growing, to the whole title as the preview ends, following the sound.
  const shown = playing.map((s) => s.shown!);
  expect(shown.every((v) => Number.isFinite(v))).toBe(true);
  expectGrowing(shown, 'the sweep');
  expect(shown[0]!, 'it starts at the left').toBeLessThan(0.15);
  expect(Math.max(...shown), 'it has filled the title by the end').toBeGreaterThan(0.9);
  expect(new Set(shown.map((v) => Math.round(v * 10))).size, 'it swept: it was seen part-way, not jumped').toBeGreaterThan(5);
  for (const s of playing) expect(Math.abs(s.shown! - s.time / s.duration), `the sweep follows the sound at ${Math.round(s.t)} ms`).toBeLessThan(0.05);
  // After the end it is gone, and the row has no progress: it starts over the next time.
  expect(samples.at(-1)!.copy).toBe(false);
  expect(await sweepOf(row)).toMatchObject({ copy: false });
  expect(await progressVar(row)).toBe('');
});

test('R16. the title is in the page once while it sweeps, and nothing else about the row changes colour or place', async ({ page }) => {
  await shortPreviews(page, 5);
  await open(page, { extra: SONGS });
  const row = rowOf(page, 'Alpha Play');
  const before = await row.evaluate((li) => ({
    h: li.getBoundingClientRect().height,
    sub: getComputedStyle(li.querySelector('[data-row-text] > :nth-child(2)')!).color,
    why: getComputedStyle(li.querySelector('[data-row-why]')!).color,
    badge: getComputedStyle(li.querySelector('[data-badge]')!).color,
    title: li.querySelector('[data-row-title]')!.getBoundingClientRect().toJSON(),
  }));
  await playOf(row).tap();
  await expect(playOf(row)).toHaveAttribute('data-preview', 'playing');
  await expect.poll(async () => (await sweepOf(row)).shown).toBeGreaterThan(0.15);
  // The copy is made by CSS from an attribute: the page holds the title once (a screen reader, find-in-page and a copy see one).
  await expect(page.getByText('Alpha Play', { exact: true })).toHaveCount(1);
  expect(await boxOf(row).evaluate((box) => box.textContent)).toBe('Alpha Play');
  expect((await sweepOf(row)).text).toContain('Alpha Play');
  const during = await row.evaluate((li) => ({
    h: li.getBoundingClientRect().height,
    sub: getComputedStyle(li.querySelector('[data-row-text] > :nth-child(2)')!).color,
    why: getComputedStyle(li.querySelector('[data-row-why]')!).color,
    badge: getComputedStyle(li.querySelector('[data-badge]')!).color,
    title: li.querySelector('[data-row-title]')!.getBoundingClientRect().toJSON(),
  }));
  expect(during).toEqual(before);
  // The copy covers the title exactly: the same box as the title's own text (the title is clipped by the same ellipsis).
  const copyBox = await boxOf(row).evaluate((box) => {
    const s = getComputedStyle(box, '::before');
    return { left: s.left, top: s.top, w: Number.parseFloat(s.width), h: Number.parseFloat(s.height) };
  });
  expect(copyBox.left).toBe('0px');
  expect(copyBox.top).toBe('0px');
  expect(copyBox.h).toBe(20);
  const titleText = await row.locator('[data-row-title]').evaluate((t) => {
    const range = document.createRange();
    range.selectNodeContents(t);
    return range.getBoundingClientRect().width;
  });
  expect(Math.abs(copyBox.w - titleText), 'as wide as the title\'s text').toBeLessThanOrEqual(1);
  await page.screenshot({ path: path.join(SCREENS, 'setlist-R16-sweeping-390x844.png') });
});

test('R16. another row playing resets the first row\'s sweep and starts its own from nothing; a pause holds the sweep; the end resets it', async ({ page }) => {
  await shortPreviews(page, 6);
  await open(page, { extra: SONGS });
  const a = rowOf(page, 'Alpha Play');
  const b = rowOf(page, 'Beta Play');
  await playOf(a).tap();
  await expect(playOf(a)).toHaveAttribute('data-preview', 'playing');
  await expect.poll(async () => (await sweepOf(a)).shown).toBeGreaterThan(0.12);
  expect(await progressVar(a)).not.toBe('');

  // The second row plays: the first one resets at once, its copy gone and its progress taken away.
  await playOf(b).tap();
  await expect.poll(async () => (await sweepOf(a)).copy).toBe(false);
  expect(await progressVar(a)).toBe('');
  await expect(playOf(a)).toHaveAttribute('data-preview', 'idle');
  // The second starts from nothing: nothing of its title is filled while it loads, and a little when it first sounds.
  await expect(playOf(b)).toHaveAttribute('data-preview', 'playing');
  const first = (await sweepOf(b)).shown!;
  expect(first).toBeLessThan(0.4);
  await expect.poll(async () => (await sweepOf(b)).shown!).toBeGreaterThan(first + 0.1);
  expect((await sweepOf(a)).copy, 'the first stays reset while the second plays').toBe(false);

  // Paused, the sweep holds where it stopped.
  await playOf(b).tap();
  await expect(playOf(b)).toHaveAttribute('data-preview', 'paused');
  const held = (await sweepOf(b)).shown!;
  expect((await sweepOf(b)).copy).toBe(true);
  await page.waitForTimeout(700);
  expect((await sweepOf(b)).shown!).toBeCloseTo(held, 2);
  // Resumed, it carries on, and when the preview ends the copy is gone.
  await playOf(b).tap();
  await expect.poll(async () => (await sweepOf(b)).shown!).toBeGreaterThan(held + 0.05);
  await expect.poll(async () => (await sweepOf(b)).copy, { timeout: 12_000 }).toBe(false);
  expect(await progressVar(b)).toBe('');
  await expect(playOf(b)).toHaveAttribute('data-preview', 'idle');
});

test('R16. a tick of the preview writes a style on the row and on the ring and nothing else: the list is not redrawn', async ({ page }) => {
  await shortPreviews(page, 5);
  await open(page, { extra: SONGS });
  const row = rowOf(page, 'Alpha Play');
  await playOf(row).tap();
  await expect(playOf(row)).toHaveAttribute('data-preview', 'playing');
  await page.evaluate(() => {
    const seen: { type: string; attr: string | null; target: string }[] = [];
    (window as unknown as { __mutations: typeof seen }).__mutations = seen;
    const name = (n: Node) => {
      const el = n as Element;
      if (el.matches?.('[data-row]')) return 'row';
      if (el.matches?.('circle')) return 'circle';
      return `${el.nodeName.toLowerCase()}`;
    };
    new MutationObserver((records) => {
      for (const r of records) seen.push({ type: r.type, attr: r.attributeName, target: name(r.target) });
    }).observe(document.querySelector('#list')!, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await page.waitForTimeout(1500);
  const muts = await page.evaluate(() => (window as unknown as { __mutations: { type: string; attr: string | null; target: string }[] }).__mutations);
  expect(muts.length, 'it was ticking').toBeGreaterThan(10);
  expect(new Set(muts.map((m) => `${m.type} ${m.attr} ${m.target}`))).toEqual(new Set(['attributes style row', 'attributes style circle']));
});

test.describe('R16, with reduced motion', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('R16. there is no sweep: the title of the row that sounds is pink, whole, with nothing animated, and plain again when it stops', async ({ page }) => {
    await shortPreviews(page, 4);
    await open(page, { extra: SONGS });
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    const row = rowOf(page, 'Alpha Play');
    expect(await sweepOf(row)).toMatchObject({ copy: false });
    await playOf(row).tap();
    await expect(playOf(row)).toHaveAttribute('data-preview', 'playing');
    // Whole from the first frame it sounds, in the same pink, and it does not move.
    expect(await sweepOf(row)).toMatchObject({ copy: true, shown: 1, color: PINK_TEXT });
    await page.waitForTimeout(500);
    expect(await sweepOf(row)).toMatchObject({ copy: true, shown: 1 });
    expect(await row.evaluate((li) => li.getAnimations({ subtree: true }).length)).toBe(0);
    // The others are as they were, and the ring still fills: it is the progress, not a decoration.
    expect(await sweepOf(rowOf(page, 'Beta Play'))).toMatchObject({ copy: false });
    await expect.poll(async () => 1 - Number.parseFloat(await fillOf(row).evaluate((c) => (c as SVGCircleElement).style.strokeDashoffset)) / (2 * Math.PI * 16.5)).toBeGreaterThan(0.1);
    // When it ends, the title is plain.
    await expect.poll(async () => (await sweepOf(row)).copy, { timeout: 10_000 }).toBe(false);
  });
});

// ============================================================================================================
// R27: the Deezer ▶ on the song page
// ============================================================================================================

async function openSong(page: Page, title: string) {
  await openButton(rowOf(page, title)).click();
  await expect(page.getByRole('button', { name: 'Back to songs' })).toBeVisible();
}

/** The song page's parts, in page pixels, and where its scroller's visible part ends (the fold). */
const pageBoxes = (page: Page, title: string) =>
  page.evaluate((title) => {
    const box = (e: Element | null) => {
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom };
    };
    const heading = [...document.querySelectorAll('h2')].find((h) => h.textContent === title)!;
    const big = document.querySelector('button[data-preview]') as HTMLElement;
    const words = big.querySelector('span');
    const link = [...document.querySelectorAll('a')].find((a) => /Spotify$/.test(a.textContent ?? ''));
    const chart = document.querySelector('[role="img"][aria-label^="Song goes from"]');
    let scroller: HTMLElement | null = big.parentElement;
    while (scroller && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement;
    return { title: box(heading), big: box(big), words: box(words), link: box(link ?? null), chart: box(chart), fold: scroller!.getBoundingClientRect().bottom, scrolled: scroller!.scrollTop };
  }, title);

for (const [signedIn, link] of [[false, 'Find on Spotify'], [true, 'Open in Spotify']] as const) {
  test(`R27. the song page has a 64 px round ▶ labelled "Play 30 s" right under the title and above the range chart, with "${link}" right under it, all above the fold of a 390 x 664 phone`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 664 });
    await shortPreviews(page, 4);
    await open(page, { extra: SONGS, loggedIn: signedIn });
    await openSong(page, 'Alpha Play');
    const big = page.locator('button[data-preview]');
    await expect(big).toHaveCount(1);
    await expect(big).toBeVisible(); // R20: on a phone, with no hover
    await expect(big).toBeEnabled();
    await expect(big).toHaveAccessibleName('Play 30 s');
    await expect(big.locator('span')).toHaveText('Play 30 s'); // the label is on the screen, and is the name
    await expect(page.getByRole('link', { name: link, exact: true })).toBeVisible();

    const m = await pageBoxes(page, 'Alpha Play');
    // 64 px and round, with the circle and the ⏸/▶ in it.
    expect([Math.round(m.big!.w), Math.round(m.big!.h)]).toEqual([64, 64]);
    expect(await css(big, 'border-top-left-radius')).toBe('50%');
    expect(await css(big, 'color'), 'pink, the app\'s accent').toBe(PINK);
    await expect(big.locator('svg').first()).toBeVisible();
    const ring = (await big.locator('svg').first().boundingBox())!;
    const glyph = (await big.locator('svg').last().boundingBox())!;
    expect(ring.width).toBeGreaterThan(56);
    expect(ring.width).toBeLessThanOrEqual(64);
    expect(glyph.width).toBeCloseTo(28, 0);
    expect(Math.abs(ring.x + ring.width / 2 - (glyph.x + glyph.width / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(ring.y + ring.height / 2 - (glyph.y + glyph.height / 2))).toBeLessThanOrEqual(1);
    // Right under the title and above the range chart, centred; its words under the circle; then the secondary action; then the chart.
    expect(m.big!.y).toBeGreaterThanOrEqual(m.title!.b);
    expect(m.words!.y).toBeGreaterThanOrEqual(m.big!.b);
    expect(m.link!.y).toBeGreaterThanOrEqual(m.words!.b);
    expect(m.chart!.y).toBeGreaterThanOrEqual(m.link!.b);
    expect(Math.abs(m.big!.x + m.big!.w / 2 - 195), 'centred on the page').toBeLessThanOrEqual(2);
    expect(Math.abs(m.words!.x + m.words!.w / 2 - 195)).toBeLessThanOrEqual(2);
    // Above the fold: the ▶, its words and the link are all on the first screen of the page, which opened at its top.
    expect(m.scrolled).toBe(0);
    expect(m.words!.b, 'the ▶ and its words are above the fold').toBeLessThanOrEqual(m.fold);
    expect(m.link!.b, `${link} is above the fold`).toBeLessThanOrEqual(m.fold);
    await page.screenshot({ path: path.join(SCREENS, `setlist-R27-song-page-${signedIn ? 'open' : 'find'}-390x664.png`) });
  });
}

test('R27. the ▶ comes before Find on Spotify in the Tab order: Back, the ▶, Find on Spotify, then the thumbs', async ({ page }) => {
  await shortPreviews(page, 4);
  await open(page, { extra: SONGS });
  await openSong(page, 'Alpha Play');
  await page.getByRole('button', { name: 'Back to songs' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('button[data-preview]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Find on Spotify', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'It went well' })).toBeFocused();
  // And on the page itself, the ▶ is before the link in the DOM.
  expect(
    await page.evaluate(() => {
      const play = document.querySelector('button[data-preview]')!;
      const link = [...document.querySelectorAll('a')].find((a) => /Find on Spotify/.test(a.textContent ?? ''))!;
      return !!(play.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING);
    }),
  ).toBe(true);
});

test('R27. it plays on the list\'s one player and shows the ring: the ⏸ in a ring that fills over the preview, full as it ends, and a tap on its words plays too', async ({ page }) => {
  await shortPreviews(page, 4);
  await open(page, { extra: SONGS });
  await openSong(page, 'Alpha Play');
  const big = page.locator('button[data-preview]');
  await expect(big).toHaveAttribute('data-preview', 'idle');
  expect(await css(big.locator('circle').nth(1), 'opacity'), 'before: nothing filled').toBe('0');

  const seen = watch(page, undefined);
  // A tap on the words under the circle is a tap on the button.
  await big.locator('span').tap();
  const samples = await seen;
  const playing = samples.filter((s) => s.state === 'playing');
  expect(samples.at(-1)!.state, 'it played to its end').toBe('idle');
  expect(playing.length).toBeGreaterThan(30);
  const ring = playing.map((s) => s.ring);
  expectGrowing(ring, 'the ring');
  expect(ring[0]!).toBeLessThan(0.15);
  expect(Math.max(...ring), 'full as the preview ends').toBeGreaterThan(0.9);
  for (const s of playing) expect(Math.abs(s.ring - s.time / s.duration)).toBeLessThan(0.05);
  // After it: ▶ again, "Play 30 s", an empty ring.
  await expect(big).toHaveAttribute('data-preview', 'idle');
  await expect(big.locator('span')).toHaveText('Play 30 s');
  expect(await css(big.locator('circle').nth(1), 'opacity')).toBe('0');

  // While it plays: the page's ▶ says Pause, shows the ⏸ in its ring, and the words follow. One <audio>, holding this song's preview.
  await shortPreviews(page, 6);
  await big.tap();
  await expect(big).toHaveAttribute('data-preview', 'playing');
  await expect(big).toHaveAccessibleName('Pause');
  await expect(big.locator('span')).toHaveText('Pause');
  expect(await css(big.locator('circle').nth(1), 'opacity')).toBe('1');
  expect(await audio(page)).toMatchObject({ count: 1, src: '/api/preview/4242', paused: false });
  await page.screenshot({ path: path.join(SCREENS, 'setlist-R27-song-page-playing-390x844.png') });
  await big.tap();
  await expect(big).toHaveAttribute('data-preview', 'paused');
  await expect(big).toHaveAccessibleName('Play 30 s');
});

test('R27. leaving the page stops it (‹ Back, and the browser\'s Back), and a row\'s preview and the page\'s are never both playing', async ({ page }) => {
  await shortPreviews(page, 6);
  await open(page, { extra: SONGS });
  const alpha = rowOf(page, 'Alpha Play');
  const beta = rowOf(page, 'Beta Play');

  // A row is playing; opening its song page stops it (the list goes), and the page's ▶ plays on the same player.
  await playOf(alpha).tap();
  await expect(playOf(alpha)).toHaveAttribute('data-preview', 'playing');
  await openSong(page, 'Alpha Play');
  await expect.poll(async () => (await audio(page)).paused).toBe(true);
  const big = page.locator('button[data-preview]');
  await expect(big).toHaveAttribute('data-preview', 'idle');
  await big.tap();
  await expect(big).toHaveAttribute('data-preview', 'playing');
  expect(await audio(page)).toMatchObject({ count: 1, src: '/api/preview/4242', paused: false });

  // ‹ Back to songs: it stops, and no row shows it playing.
  await page.getByRole('button', { name: 'Back to songs' }).tap();
  await expect(rows(page).first()).toBeVisible();
  await expect.poll(async () => (await audio(page)).paused).toBe(true);
  expect((await audio(page)).src).toBeNull();
  for (const row of [alpha, beta]) await expect(playOf(row)).toHaveAttribute('data-preview', 'idle');
  expect(await sweepOf(alpha)).toMatchObject({ copy: false });

  // The browser's Back does the same.
  await openSong(page, 'Beta Play');
  await page.locator('button[data-preview]').tap();
  await expect(page.locator('button[data-preview]')).toHaveAttribute('data-preview', 'playing');
  await page.goBack();
  await expect(rows(page).first()).toBeVisible();
  await expect.poll(async () => (await audio(page)).paused).toBe(true);
  expect((await audio(page)).src).toBeNull();
  await expect(playOf(beta)).toHaveAttribute('data-preview', 'idle');

  // And the other way round: a row plays after the page's was stopped, on the same one <audio>.
  await playOf(alpha).tap();
  await expect(playOf(alpha)).toHaveAttribute('data-preview', 'playing');
  expect(await audio(page)).toMatchObject({ count: 1, src: '/api/preview/4242', paused: false });
  await playOf(beta).tap();
  await expect(playOf(beta)).toHaveAttribute('data-preview', 'playing');
  await expect(playOf(alpha)).toHaveAttribute('data-preview', 'idle');
  expect(await audio(page)).toMatchObject({ count: 1, src: '/api/preview/4243', paused: false });
});

test('R27. "Find on Spotify" is the secondary action, an outlined button: a clear line, no fill, 44 px tall, under the pink ▶', async ({ page }) => {
  await shortPreviews(page, 4);
  await open(page, { extra: SONGS });
  await openSong(page, 'Alpha Play');
  const link = page.getByRole('link', { name: 'Find on Spotify', exact: true });
  const big = page.locator('button[data-preview]');
  const l = await link.evaluate((a) => {
    const s = getComputedStyle(a);
    return { style: s.borderTopStyle, width: s.borderTopWidth, colour: s.borderTopColor, fill: s.backgroundColor, image: s.backgroundImage, h: a.getBoundingClientRect().height, text: s.color };
  });
  expect(l.style).toBe('solid');
  expect(Number.parseFloat(l.width)).toBeGreaterThanOrEqual(1);
  expect(parts(l.colour).a, 'a clear line (the old one was 14% white)').toBeGreaterThanOrEqual(0.4);
  expect(parts(l.fill).a, 'no fill: it is outlined').toBe(0);
  expect(l.image).toBe('none');
  expect(l.h).toBeGreaterThanOrEqual(44);
  expect(l.text, 'its text is the page\'s ink, not the accent: the ▶ is the primary one').not.toBe(PINK);
  // The ▶ is the primary one: the accent colour and a glow, which the outlined link has none of.
  expect(await css(big, 'color')).toBe(PINK);
  expect(await css(big, 'box-shadow')).toContain('255, 46, 147');
  expect(await css(link, 'box-shadow')).toBe('none');
  // It still opens Spotify in a new tab, and ends with the external-link icon (R4).
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link.locator('svg')).toHaveCount(1);
});

test('R27. a song with no Deezer preview has the ▶ disabled and faded, saying "No preview", and the page under it is where it is for a song that has one', async ({ page }) => {
  await shortPreviews(page, 4);
  await open(page, { extra: SONGS });
  await openSong(page, 'Alpha Play');
  const withPreview = await pageBoxes(page, 'Alpha Play');
  await page.getByRole('button', { name: 'Back to songs' }).click();
  await openSong(page, 'Gamma None');
  const big = page.locator('button[data-preview]');
  await expect(big).toHaveAttribute('data-preview', 'unavailable');
  await expect(big).toBeDisabled();
  await expect(big).toHaveAccessibleName('No preview');
  await expect(big.locator('span')).toHaveText('No preview');
  await expect(big).not.toHaveAttribute('title', /./);
  // Faded: the circle, the glyph and the words together.
  expect(Number(await css(big, 'opacity'))).toBeLessThan(0.5);
  expect(Number(await css(big, 'opacity'))).toBeGreaterThan(0.1);
  await expect(big.locator('svg').first()).toBeVisible();
  const none = await pageBoxes(page, 'Gamma None');
  // The same place as for a song with a preview, so the page does not jump from song to song.
  for (const part of ['big', 'words', 'link', 'chart'] as const) expect(Math.abs(none[part]!.y - withPreview[part]!.y), part).toBeLessThanOrEqual(1);
  // A tap on it does nothing: the page is still the page, and nothing plays.
  await big.tap({ force: true });
  expect((await audio(page)).paused).toBe(true);
  await expect(page.getByRole('button', { name: 'Back to songs' })).toBeVisible();
  await page.screenshot({ path: path.join(SCREENS, 'setlist-R27-song-page-no-preview-390x844.png') });
});

test.describe('R27, with a pointer', () => {
  test.use({ viewport: { width: 1280, height: 800 }, ...POINTER });

  test('R27. the ▶ needs no hover: it is there, in the same place, before the pointer comes near it', async ({ page }) => {
    await shortPreviews(page, 4);
    await open(page, { extra: SONGS });
    await openSong(page, 'Alpha Play');
    await away(page);
    const big = page.locator('button[data-preview]');
    await expect(big).toBeVisible();
    await expect(big.locator('span')).toBeVisible();
    const rest = await big.boundingBox();
    expect([Math.round(rest!.width), Math.round(rest!.height)]).toEqual([64, 64]);
    await big.hover();
    expect(await big.boundingBox()).toEqual(rest);
    await big.click();
    await expect(big).toHaveAttribute('data-preview', 'playing');
  });
});

// ============================================================================================================
// WebKit, the engine of an iPhone: the sweep (clip-path with a calc of a custom property, on a pseudo-element chosen by :has) and the ring
// ============================================================================================================

test.describe('in WebKit (iPhone Safari)', () => {
  test.skip(!existsSync(webkit.executablePath()), 'WebKit is not installed here (CI installs Chromium only)');

  test('R16, R17. the ring and the pink sweep fill over the preview, and the ▶ has its circle', async ({ baseURL }) => {
    const browser = await webkit.launch();
    try {
      const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, baseURL, reducedMotion: 'no-preference' });
      const page = await context.newPage();
      await shortPreviews(page, 4);
      await open(page, { extra: SONGS });
      const row = rowOf(page, 'Alpha Play');
      const id = (await row.getAttribute('data-id'))!;
      await expect(ringOf(row)).toBeVisible();
      await expect(trackOf(row)).toBeVisible();
      const seen = watch(page, id);
      await playOf(row).tap();
      const samples = await seen;
      const playing = samples.filter((s) => s.state === 'playing');
      expect(samples.at(-1)!.state).toBe('idle');
      expect(playing.length).toBeGreaterThan(20);
      const ring = playing.map((s) => s.ring);
      const shown = playing.map((s) => s.shown!);
      expectGrowing(ring, 'the ring', 0.01);
      expectGrowing(shown, 'the sweep', 0.01);
      expect(Math.max(...ring)).toBeGreaterThan(0.85);
      expect(Math.max(...shown)).toBeGreaterThan(0.85);
      expect(new Set(playing.map((s) => s.color))).toEqual(new Set([PINK_TEXT]));
      expect(samples.at(-1)!.copy).toBe(false);
      await context.close();
    } finally {
      await browser.close();
    }
  });
});
