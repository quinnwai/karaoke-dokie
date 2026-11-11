// Review items R3, R12 and R13 of QWW-57 (Quinn-Wai's review of the 6A preview, 11 Nov), the song list's rows, one check each as
// the ticket asks:
//   R3   the rank number is back in the row's slot; hovering the row, or focusing its ▶ with the keyboard, swaps it for the ▶
//        glyph alone (no ring or circle in any state); a ▶ that cannot play is the faded pink; a loading, playing or paused
//        preview keeps its glyph without hover; on a touch screen, which cannot hover, the ▶ stands in the number's place
//        (the last describes below run it again with QWW-48's real button: a song with a Deezer preview, and one without)
//   R12  each title fills in once, left to right, when its row scrolls into view, and ends in its normal white; not again on
//        scrolling back or on a re-rank; with reduced motion the titles simply show; each title's text is in the page once
//   R13  a song that fits only an octave away says "Shifted down/up to fit range" and nothing else in its reason line, in place of "In
//        your sweet spot"; its badge stays (QWW-58's wording; the rule is `whyOf` in src/lib/setlist/rows.ts)
// The tuner is reached the way tests/e2e/setlist.spec.ts reaches it (tests/helpers/tunerE2e.ts). The slot holds QWW-48's real play
// button (src/components/PreviewButton.tsx, from #28); the fixture songs have no Deezer id, so it is the disabled one. Where a test
// needs a button in a state the real player reaches only with audio (loading, playing, paused), or one that can play, it mounts a
// button of the same shape by hand (mountPreview). tests/e2e/preview.spec.ts has the real player, with audio, in these rows.
//
// "Hover" is for pointer devices only (@media (hover: hover)): the pointer describes below turn touch off, and the rest of the file
// is the touch phone every tuner spec starts from.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { launchWithMic, writeTone } from './fakeMic';
import { centre, css, DEFAULT_RANKING, eraButton, mockApi, open, openButton, pressKey, resetButton, rgb, rows, TEXT_3, titles } from '../helpers/tunerE2e';
import type { MockSong } from '../fixtures/setlist';

const SCREENS = path.resolve('test-results/screens');
test.beforeAll(() => mkdirSync(SCREENS, { recursive: true }));

// A 390x844 touch phone. Motion is off unless a describe below turns it on (the list would never be "stable" for Playwright otherwise).
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

const POINTER = { hasTouch: false, isMobile: false } as const;
const PINK_TEXT = rgb('#FF6FB1');
const TEXT = rgb('#F3EFF7');
const RANK_GREY = rgb('#7C7887');

// ---- small readers ----

const slotOf = (row: Locator) => row.locator('[data-play-slot]');
const numberOf = (row: Locator) => row.locator('[data-rank-number]');
/** The ▶'s glyph: the last svg in the slot (QWW-48's button has its ring first and the glyph after it). */
const glyphOf = (row: Locator) => row.locator('[data-play-slot] button svg').last();
/** The ▶ that is live: the last button in the slot (a hand-mounted one comes after the real button it hides). */
const playOf = (row: Locator) => row.locator('[data-play-slot] button').last();
/** The title's box, which carries the fill (data-fill-text, data-filled). */
const boxOf = (row: Locator) => row.locator('[data-fill-text]');
const titleOf = (row: Locator) => row.locator('[data-row-title]');
/** A computed style of the copy the fill draws over the title: the ::after of the title's box. */
const copyStyle = (row: Locator, prop: string) => boxOf(row).evaluate((el, p) => getComputedStyle(el, '::after').getPropertyValue(p), prop);
const scroller = (page: Page) => page.locator('#list-scroll');
const away = (page: Page) => page.mouse.move(2, 400); // off every row (and off the phone-shaped frame on a desktop)

type Preview = 'idle' | 'loading' | 'playing' | 'paused' | 'unavailable';

/**
 * Puts into a row's slot a button of the shape QWW-48's play button has (src/components/PreviewButton.tsx): `data-preview`, a ring of
 * two circles as its first svg, then the glyph (a pause while it sounds), in a state the real player reaches only with audio. The
 * real button it replaces is put away.
 */
async function mountPreview(row: Locator, state: Preview = 'idle') {
  await row.evaluate((li, st) => {
    const slot = li.querySelector('[data-play-slot]')!;
    for (const old of slot.querySelectorAll('button')) {
      old.hidden = true;
      old.style.display = 'none';
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.disabled = st === 'unavailable';
    button.setAttribute('data-preview', st);
    button.setAttribute('aria-label', st === 'unavailable' ? 'No preview' : `Play ${li.querySelector('[data-row-title]')?.textContent ?? ''}`);
    const sounding = st === 'loading' || st === 'playing';
    const glyph = sounding ? '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"></path>' : '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"></path>';
    button.innerHTML =
      '<svg viewBox="0 0 36 36" aria-hidden="true" focusable="false"><circle cx="18" cy="18" r="16.5" fill="none" stroke="currentColor"></circle><circle cx="18" cy="18" r="16.5" fill="none" stroke="currentColor"></circle></svg>' +
      `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">${glyph}</svg>`;
    slot.appendChild(button);
  }, state);
}

/**
 * What in a row's slot draws a ring: a visible circle or ellipse, or a visible border, shadow, background or outline on any of its
 * elements. Empty when there is none. (A glow on the playing glyph is a `filter`, which is not any of these.)
 */
function ringsIn(row: Locator): Promise<string[]> {
  return slotOf(row).evaluate((slot) => {
    const found: string[] = [];
    for (const n of [slot, ...Array.from(slot.querySelectorAll('*'))]) {
      const s = getComputedStyle(n);
      const box = n.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || s.visibility === 'hidden' || s.display === 'none') continue;
      const tag = n.tagName.toLowerCase();
      if (tag === 'circle' || tag === 'ellipse') found.push(tag);
      if (['top', 'right', 'bottom', 'left'].some((side) => s.getPropertyValue(`border-${side}-style`) !== 'none' && Number.parseFloat(s.getPropertyValue(`border-${side}-width`)) > 0)) found.push(`${tag} border`);
      if (s.boxShadow !== 'none') found.push(`${tag} box-shadow`);
      if (s.outlineStyle !== 'none' && Number.parseFloat(s.outlineWidth) > 0) found.push(`${tag} outline`);
      if (s.backgroundImage !== 'none') found.push(`${tag} background-image`);
      if (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') found.push(`${tag} background`);
    }
    return found;
  });
}

/** Nothing happened to the page: still the list, no song page. */
async function expectNoSongPage(page: Page) {
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to songs' })).toHaveCount(0);
}

// ============================================================================================================
// R3: the rank number comes back; the ▶ replaces it on hover, glyph only
// ============================================================================================================

test.describe('R3, with a pointer', () => {
  test.use({ viewport: { width: 1280, height: 800 }, ...POINTER });

  test('R3. at rest every row shows its rank number in 6A\'s rank style, centred in the 44 px slot, and no ▶', async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(true);
    // Every row has its number in order (the number is in the page whether or not it is drawn)...
    const numbers = await page.locator('[data-rank-number]').allTextContents();
    expect(numbers).toEqual(numbers.map((_, i) => String(i + 1)));
    expect(await rows(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-rank')))).toEqual(numbers);
    // ...and the rows in view draw it, and no ▶.
    for (const i of [0, 1]) {
      const row = rows(page).nth(i);
      await expect(numberOf(row)).toBeVisible();
      await expect(numberOf(row)).toHaveText(String(i + 1));
      await expect(numberOf(row)).toHaveAttribute('aria-hidden', 'true');
      await expect(glyphOf(row)).toBeHidden();
      expect(await css(numberOf(row), 'font-size')).toBe('13px');
      expect(await css(numberOf(row), 'font-weight')).toBe('600');
      expect(await css(numberOf(row), 'color')).toBe(RANK_GREY);
      const slot = await centre(slotOf(row));
      const at = await centre(numberOf(row));
      expect(Math.abs(at.x - slot.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(at.y - slot.y)).toBeLessThanOrEqual(1);
      const box = (await slotOf(row).boundingBox())!;
      expect([box.width, box.height]).toEqual([44, 44]);
    }
    await page.screenshot({ path: path.join(SCREENS, 'setlist-R3-rest.png') });
  });

  test('R3. hovering a row swaps its number for the ▶ glyph, in --pink-text, and moving away swaps it back', async ({ page }) => {
    await open(page);
    const row = rows(page).nth(1);
    await row.hover();
    await expect(numberOf(row)).toBeHidden();
    await expect(glyphOf(row)).toBeVisible();
    expect(await css(playOf(row), 'color')).toBe(PINK_TEXT);
    // Only the hovered row: the others still show their numbers.
    await expect(numberOf(rows(page).first())).toBeVisible();
    await expect(glyphOf(rows(page).first())).toBeHidden();
    await page.screenshot({ path: path.join(SCREENS, 'setlist-R3-hover.png') });
    await away(page);
    await expect(numberOf(row)).toBeVisible();
    await expect(glyphOf(row)).toBeHidden();
  });

  test('R3. the swap is the same whichever part of the row is hovered, the ▶\'s own 44 px target included', async ({ page }) => {
    await open(page);
    const row = rows(page).first();
    for (const part of [slotOf(row), row.locator('[data-badge]'), row.locator('[data-row-why]')]) {
      await part.hover();
      await expect(numberOf(row)).toBeHidden();
      await expect(glyphOf(row)).toBeVisible();
      await away(page);
      await expect(numberOf(row)).toBeVisible();
    }
    // The corner of the slot belongs to the ▶'s 44 px target, not to the row's own button.
    const box = (await slotOf(row).boundingBox())!;
    expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-play-slot]'), { x: box.x + 2, y: box.y + 2 })).toBe(true);
  });

  test('R3. hovering moves nothing: the row is 66 px, the slot 44 px and the text starts 10 px after it, at rest and hovered', async ({ page }) => {
    await open(page);
    const row = rows(page).nth(1);
    const measure = () =>
      row.evaluate((li) => {
        const r = li.getBoundingClientRect();
        const slot = li.querySelector('[data-play-slot]')!.getBoundingClientRect();
        const text = li.querySelector('[data-row-text]')!.getBoundingClientRect();
        const badge = li.querySelector('[data-badge]')?.getBoundingClientRect();
        return { h: r.height, slotW: slot.width, slotH: slot.height, gap: text.left - slot.right, textW: text.width, badgeLeft: badge ? badge.left - r.left : null };
      });
    const rest = await measure();
    expect(rest).toMatchObject({ h: 66, slotW: 44, slotH: 44 });
    expect(rest.gap).toBeCloseTo(10, 0);
    await row.hover();
    await expect(numberOf(row)).toBeHidden();
    expect(await measure()).toEqual(rest);
  });

  test('R3. the slot draws no ring or circle in any state: at rest, hovered, or with a button of QWW-48\'s shape in it', async ({ page }) => {
    await open(page);
    // A song with no Deezer id has QWW-48's real button, disabled. It draws a ring (two circles in its first svg), which the slot
    // does not draw, so the glyph is the only thing on screen.
    const noPreview = rows(page).nth(0);
    expect(await ringsIn(noPreview)).toEqual([]);
    await noPreview.hover();
    await expect(glyphOf(noPreview)).toBeVisible();
    expect(await ringsIn(noPreview)).toEqual([]);
    expect(await css(slotOf(noPreview).locator('[data-preview] > svg').first(), 'display')).toBe('none');
    expect(await slotOf(noPreview).locator('circle:visible, ellipse:visible').count()).toBe(0);
    expect(await slotOf(noPreview).locator('svg:visible').count()).toBe(1);

    const mounted = rows(page).nth(2);
    await mountPreview(mounted, 'idle');
    await expect(slotOf(mounted).locator('[data-preview] > svg').first()).toBeHidden(); // QWW-48's ring: hidden, so QWW-48 needs no change
    expect(await css(slotOf(mounted).locator('[data-preview] > svg').first(), 'display')).toBe('none');
    expect(await ringsIn(mounted)).toEqual([]);
    await mounted.hover();
    await expect(glyphOf(mounted)).toBeVisible();
    expect(await ringsIn(mounted)).toEqual([]);
    // Its glyph is the pink one and its button keeps the 44 px target, flush with the slot.
    expect(await css(playOf(mounted), 'color')).toBe(PINK_TEXT);
    const slot = (await slotOf(mounted).boundingBox())!;
    const button = (await playOf(mounted).boundingBox())!;
    expect([button.width, button.height]).toEqual([44, 44]);
    expect(button.x).toBeCloseTo(slot.x, 0);
  });

  for (const state of ['loading', 'playing', 'paused'] as const) {
    test(`R3. a ${state} preview keeps its glyph in the number's place without hover, so the row that sounds shows`, async ({ page }) => {
      await open(page);
      const row = rows(page).nth(1);
      await mountPreview(row, 'idle');
      // At rest, before it sounds, it is a row like the others: number, no ▶.
      await expect(numberOf(row)).toBeVisible();
      await expect(glyphOf(row)).toBeHidden();
      await playOf(row).evaluate((b, s) => b.setAttribute('data-preview', s), state);
      await away(page);
      await expect(numberOf(row)).toBeHidden();
      await expect(glyphOf(row)).toBeVisible();
      // QWW-48's progress ring (its first svg, two circles) is not drawn: no circle in any state.
      await expect(slotOf(row).locator('[data-preview] > svg').first()).toBeHidden();
      expect(await ringsIn(row)).toEqual([]);
      // The others still show their numbers, and the playing glyph glows (a drop-shadow on the glyph, not a ring).
      await expect(numberOf(rows(page).first())).toBeVisible();
      if (state === 'playing') expect(await css(playOf(row), 'filter')).toContain('drop-shadow');
      // And it goes back to the number when it stops.
      await playOf(row).evaluate((b) => b.setAttribute('data-preview', 'idle'));
      await expect(numberOf(row)).toBeVisible();
      await expect(glyphOf(row)).toBeHidden();
    });
  }

  test('R3. Tab to the ▶ shows it in the number\'s place, with a square outline and no circle, and Tab on to the row hides it again', async ({ page }) => {
    await open(page);
    const row = rows(page).nth(1);
    await mountPreview(row, 'idle'); // a song with no preview has a disabled button, which is not in the Tab order: a button that can play is
    await openButton(rows(page).first()).focus();
    await page.keyboard.press('Tab');
    await expect(playOf(row)).toBeFocused();
    await expect(numberOf(row)).toBeHidden();
    await expect(glyphOf(row)).toBeVisible();
    // The focus outline is a rounded square drawn inside the 44 px (a circle on this box would have a 22 px radius), so it is
    // not the ring R3 took away, and the list's scroller does not cut it off at the row's edge.
    expect(Number.parseFloat(await css(playOf(row), 'border-top-left-radius'))).toBeLessThan(22);
    expect(await css(playOf(row), 'outline-style')).toBe('solid');
    expect(await css(playOf(row), 'outline-offset')).toBe('-2px');
    expect((await ringsIn(row)).filter((found) => !found.endsWith('outline'))).toEqual([]);
    await page.keyboard.press('Tab');
    await expect(openButton(row)).toBeFocused();
    await expect(numberOf(row)).toBeVisible();
    await expect(glyphOf(row)).toBeHidden();
  });

  test('R3. a ▶ that cannot play is the faded pink, disabled, with the same swap on hover; one that can play is not faded', async ({ page }) => {
    await open(page);
    const row = rows(page).nth(1);
    await row.hover();
    await expect(glyphOf(row)).toBeVisible();
    // A song with no Deezer id has QWW-48's real button, disabled.
    await expect(playOf(row)).toBeDisabled();
    expect(Number(await css(playOf(row), 'opacity'))).toBeLessThan(1);
    expect(Number(await css(playOf(row), 'opacity'))).toBeCloseTo(0.4, 1);
    expect(await css(playOf(row), 'color')).toBe(PINK_TEXT);
    expect(await css(row.locator('[data-play-slot] path'), 'fill')).toBe(PINK_TEXT);
    // A song with no preview (QWW-48's disabled button) is the same faded pink, whatever its own CSS says.
    const none = rows(page).nth(2);
    await mountPreview(none, 'unavailable');
    await none.hover();
    await expect(glyphOf(none)).toBeVisible();
    await expect(playOf(none)).toBeDisabled();
    expect(Number(await css(playOf(none), 'opacity'))).toBeCloseTo(0.4, 1);
    expect(await css(playOf(none), 'color')).toBe(PINK_TEXT);
    // One that can play is the full pink.
    const ok = rows(page).nth(3);
    await mountPreview(ok, 'idle');
    await ok.hover();
    await expect(glyphOf(ok)).toBeVisible();
    await expect(playOf(ok)).toBeEnabled();
    expect(await css(playOf(ok), 'opacity')).toBe('1');
    expect(await css(playOf(ok), 'color')).toBe(PINK_TEXT);
  });

  test('R3. a click on the ▶ opens nothing, a disabled one or a button that can play, and the row\'s own button still opens the song', async ({ page }) => {
    await open(page);
    const row = rows(page).nth(1);
    await row.hover();
    const at = await centre(slotOf(row));
    await page.mouse.click(at.x, at.y); // the disabled button of a song with no preview
    await expectNoSongPage(page);
    await mountPreview(row, 'idle');
    await playOf(row).click(); // a button that can play: the slot is beside the row's button, not inside it
    await expectNoSongPage(page);
    await openButton(row).click();
    await expect(page.getByRole('button', { name: 'Back to songs' })).toBeVisible();
  });
});

test.describe('R3, on a touch screen', () => {
  test('R3. there is no hover, so the ▶ glyph stands in the number\'s place without it, faded while it cannot play, and the number is not drawn', async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
    expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(false);
    for (const i of [0, 1, 2]) {
      const row = rows(page).nth(i);
      await expect(glyphOf(row)).toBeVisible();
      await expect(numberOf(row)).toBeHidden();
      await expect(playOf(row)).toBeDisabled();
      expect(Number(await css(playOf(row), 'opacity'))).toBeCloseTo(0.4, 1);
      expect(await css(playOf(row), 'color')).toBe(PINK_TEXT);
      expect(await ringsIn(row)).toEqual([]);
    }
    // The number is still in the row, for data-rank's sake and a pointer device.
    expect(await page.locator('[data-rank-number]').first().textContent()).toBe('1');
  });

  test('R3. a ▶ that can play shows in the full pink without hover, draws no ring, and a tap on it opens nothing and leaves nothing stuck', async ({ page }) => {
    await open(page);
    const row = rows(page).nth(1);
    await mountPreview(row, 'idle');
    await expect(glyphOf(row)).toBeVisible();
    await expect(numberOf(row)).toBeHidden();
    await expect(slotOf(row).locator('[data-preview] > svg').first()).toBeHidden(); // QWW-48's ring
    expect(await ringsIn(row)).toEqual([]);
    expect(await css(playOf(row), 'opacity')).toBe('1');
    await playOf(row).tap();
    await expectNoSongPage(page);
    // After the tap nothing has changed: this row is as it was, and so are the others (a hover would have stuck here).
    await expect(glyphOf(row)).toBeVisible();
    await expect(numberOf(row)).toBeHidden();
    await expect(glyphOf(rows(page).first())).toBeVisible();
    await expect(numberOf(rows(page).first())).toBeHidden();
  });

  test('R3. a tap on a disabled ▶ opens nothing either, and the 44 px slot is the ▶\'s, not the row button\'s', async ({ page }) => {
    await open(page);
    const row = rows(page).first();
    const at = await centre(slotOf(row));
    await page.touchscreen.tap(at.x, at.y);
    await expectNoSongPage(page);
    const box = (await slotOf(row).boundingBox())!;
    expect([box.width, box.height]).toEqual([44, 44]);
    expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-play-slot]'), { x: box.x + 3, y: box.y + box.height - 3 })).toBe(true);
  });
});

// ============================================================================================================
// R12: the titles fill in as they scroll into view, instead of the #1 wipe
// ============================================================================================================

/** One title's fill: a transition of clip-path on the ::after of its box. */
interface Fill {
  id: string | null;
  /** performance.now() when it was made, and when it ended (null while it runs). */
  run: number;
  end: number | null;
  /** The transition's own length in seconds, from its end event (the wait before it starts is not in it). */
  elapsed: number | null;
  /** The copy's clip-path in every frame it ran, as the browser writes it. */
  clips: string[];
}

/** Starts recording every fill from the first frame of the page, so the rows that fill as the list loads are seen too. */
const watchFills = (page: Page) =>
  page.addInitScript(() => {
    const runs: unknown[] = [];
    (window as unknown as { __fills: unknown[] }).__fills = runs;
    const live = new Map<Element, { id: string | null; run: number; end: number | null; elapsed: number | null; clips: string[] }>();
    const isFill = (e: TransitionEvent) => e.propertyName === 'clip-path' && e.pseudoElement === '::after';
    document.addEventListener(
      'transitionrun',
      (e) => {
        if (!isFill(e)) return;
        const box = e.target as HTMLElement;
        const rec = { id: box.closest('[data-row]')?.getAttribute('data-id') ?? null, run: performance.now(), end: null as number | null, elapsed: null as number | null, clips: [] as string[] };
        live.set(box, rec);
        runs.push(rec);
        const sample = () => {
          if (rec.end !== null || !box.isConnected) return;
          rec.clips.push(getComputedStyle(box, '::after').clipPath);
          requestAnimationFrame(sample);
        };
        sample();
      },
      true,
    );
    const finished = (e: TransitionEvent) => {
      if (!isFill(e)) return;
      const rec = live.get(e.target as Element);
      if (!rec) return;
      rec.end = performance.now();
      rec.elapsed = e.elapsedTime;
      live.delete(e.target as Element);
    };
    document.addEventListener('transitionend', finished, true);
    document.addEventListener('transitioncancel', finished, true);
  });

const fills = (page: Page) => page.evaluate(() => (window as unknown as { __fills: Fill[] }).__fills.map((f) => ({ ...f })));
const fillsOf = async (page: Page, id: string) => (await fills(page)).filter((f) => f.id === id);
/** How many fills each row has had, by track id. */
const fillCounts = async (page: Page) => {
  const counts = new Map<string, number>();
  for (const f of await fills(page)) if (f.id) counts.set(f.id, (counts.get(f.id) ?? 0) + 1);
  return counts;
};

/** The four insets of a computed `inset(...)` clip-path, as numbers (% or px, as the browser wrote them); null for anything else. */
function insetOf(clip: string) {
  const m = /^inset\(([^)]*)\)$/.exec(clip.trim());
  if (!m) return null;
  const parts = m[1]!.trim().split(/\s+/).map((p) => Number.parseFloat(p));
  if (parts.length === 0 || parts.some(Number.isNaN)) return null;
  const [top = 0, rightRaw, bottomRaw, leftRaw] = parts;
  const right = rightRaw ?? top;
  return { top, right, bottom: bottomRaw ?? top, left: leftRaw ?? right };
}

/** Each of the first rows' title text is in the page exactly once (a screen reader, find-in-page and a copy see one title). */
async function expectEachTitleOnce(page: Page) {
  await expect.poll(async () => (await titles(page)).slice(0, 5)).toEqual(DEFAULT_RANKING.slice(0, 5));
  for (const title of DEFAULT_RANKING.slice(0, 5)) await expect(page.getByText(title, { exact: true }), title).toHaveCount(1);
  // The copy the fill draws is made by CSS from an attribute, so the box holds the title's own text and nothing more.
  const first = rows(page).first();
  expect(await boxOf(first).getAttribute('data-fill-text')).toBe(DEFAULT_RANKING[0]);
  expect(await boxOf(first).evaluate((el) => el.textContent)).toBe(DEFAULT_RANKING[0]);
  expect(await page.locator('[data-wipe]').count()).toBe(0);
}

test.describe('R12, with motion allowed', () => {
  test.use({ contextOptions: { reducedMotion: 'no-preference' } });

  test('R12. a row below the fold has not played its fill until it scrolls into view; then it plays once, left to right in 0.6 s, from dim to white', async ({ page }) => {
    await watchFills(page);
    await open(page);
    const near = rows(page).first();
    const far = rows(page).nth(12);
    const farId = (await far.getAttribute('data-id'))!;

    // The rows on screen when the list loaded have filled in.
    await expect(boxOf(near)).toHaveAttribute('data-filled', '');
    // The row below the fold has not: its title is dim, the white copy is clipped to nothing, and no fill has run for it.
    await expect(boxOf(far)).not.toHaveAttribute('data-filled', '');
    expect(await css(titleOf(far), 'color')).toBe(TEXT_3);
    expect(insetOf(await copyStyle(far, 'clip-path'))).toMatchObject({ right: 100, left: 0 });
    expect(await fillsOf(page, farId)).toHaveLength(0);

    // Scrolled into view, it fills in, once.
    await far.scrollIntoViewIfNeeded();
    await expect(boxOf(far)).toHaveAttribute('data-filled', '');
    await expect.poll(async () => (await fillsOf(page, farId)).length).toBe(1);
    await expect.poll(async () => (await fillsOf(page, farId))[0]?.end ?? null, { timeout: 5000 }).not.toBeNull();
    const run = (await fillsOf(page, farId))[0]!;
    // It lasts 0.6 s, and the copy's clip opened from the left: the right inset ran from 100% down to nothing, the left stayed at 0,
    // and it never went back. It swept (it was seen part-way) and did not jump.
    expect(run.elapsed).toBeCloseTo(0.6, 2);
    const insets = run.clips.map(insetOf);
    expect(insets.every((i) => i !== null)).toBe(true);
    const rights = insets.map((i) => i!.right);
    expect(rights[0]!).toBeGreaterThan(95);
    expect(rights.at(-1)!).toBeLessThan(25);
    expect(rights.some((r) => r > 5 && r < 95)).toBe(true);
    for (let i = 1; i < rights.length; i++) expect(rights[i]!).toBeLessThanOrEqual(rights[i - 1]! + 0.01);
    expect(insets.every((i) => i!.left === 0 && i!.top === 0 && i!.bottom === 0)).toBe(true);
    // It ends in its normal white, and the copy is put away: the title itself is white, as one crisp line.
    await expect.poll(() => css(titleOf(far), 'color')).toBe(TEXT);
    expect(await copyStyle(far, 'visibility')).toBe('hidden');
    await page.screenshot({ path: path.join(SCREENS, 'setlist-R12-filled.png') });
  });

  test('R12. scrolling away and back does not play it again, and nothing loops', async ({ page }) => {
    await watchFills(page);
    await open(page);
    const far = rows(page).nth(12);
    const farId = (await far.getAttribute('data-id'))!;
    await far.scrollIntoViewIfNeeded();
    await expect.poll(async () => (await fillsOf(page, farId)).length).toBe(1);
    await expect.poll(() => css(titleOf(far), 'color')).toBe(TEXT);
    const before = await fillCounts(page);
    for (let i = 0; i < 2; i++) {
      await scroller(page).evaluate((el) => el.scrollTo(0, 0));
      await page.waitForTimeout(350);
      await far.scrollIntoViewIfNeeded();
      await page.waitForTimeout(350);
    }
    expect(await fillsOf(page, farId)).toHaveLength(1);
    await expect(boxOf(far)).toHaveAttribute('data-filled', '');
    expect(await css(titleOf(far), 'color')).toBe(TEXT);
    // The rows in view before and after it did not play again either.
    const after = await fillCounts(page);
    for (const [id, n] of before) expect(after.get(id), id).toBe(n);

    // Nothing loops: once the last fill is over, nothing in the list animates, and no animation is endless (the #1 wipe was).
    await expect.poll(() => scroller(page).evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length), { timeout: 5000 }).toBe(0);
    expect(await scroller(page).evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.effect?.getComputedTiming().iterations === Infinity).length)).toBe(0);
    expect(await page.evaluate(() => document.getAnimations().some((a) => (a as CSSAnimation).animationName === 'wipe'))).toBe(false);
    const settled = (await fills(page)).length;
    await page.waitForTimeout(1500);
    expect((await fills(page)).length).toBe(settled);
  });

  test('R12. a re-rank, which moves the rows\' DOM nodes, and an era change that takes rows away and brings them back, do not play any fill again', async ({ page }) => {
    await watchFills(page);
    await open(page);
    // Some rows have filled: the ones in view at load, and a few further down.
    await expect.poll(async () => (await fills(page)).length).toBeGreaterThanOrEqual(2);
    await rows(page).nth(8).scrollIntoViewIfNeeded();
    await expect.poll(() => css(titleOf(rows(page).nth(8)), 'color')).toBe(TEXT);
    await scroller(page).evaluate((el) => el.scrollTo(0, 0));
    await page.waitForTimeout(1000); // whatever was going to play has played
    const before = await fillCounts(page);
    expect(before.size).toBeGreaterThanOrEqual(3);
    const order = await titles(page);

    // A re-rank: React moves the rows' nodes, which would restart a CSS animation. They are filled, and stay filled.
    await pressKey(page, 'tempo', 'ArrowRight', 7);
    await expect.poll(async () => (await titles(page)).slice(0, 3)).not.toEqual(order.slice(0, 3));
    await page.waitForTimeout(1200);
    let after = await fillCounts(page);
    for (const [id, n] of before) expect(after.get(id), `after the re-rank: ${id}`).toBe(n);
    const filledIds = await page.locator('[data-row]:has([data-filled])').evaluateAll((els) => els.map((el) => el.getAttribute('data-id')));
    for (const id of before.keys()) expect(filledIds, id).toContain(id);

    // An era takes rows off the list and brings them back: the ones that come back are drawn filled, not played.
    await eraButton(page, 's80').click();
    await expect(rows(page)).toHaveCount(4);
    await resetButton(page, 'era').click();
    await expect(rows(page)).toHaveCount(25);
    await page.waitForTimeout(1200);
    after = await fillCounts(page);
    for (const [id, n] of before) expect(after.get(id), `after the era change: ${id}`).toBe(n);
  });

  test('R12. a list that empties and fills again (an era picked, untapped and picked again) does not play any fill again: a visit lasts until the range changes', async ({ page }) => {
    await watchFills(page);
    await open(page);
    await expect.poll(async () => (await fills(page)).length).toBeGreaterThanOrEqual(2);
    // The 80s: four rows, which fill as they come into view (some had filled already).
    await eraButton(page, 's80').click();
    await expect(rows(page)).toHaveCount(4);
    await expect(page.locator('[data-row]:has([data-filled])')).toHaveCount(4);
    await page.waitForTimeout(1200); // whatever was going to play has played
    const before = [...(await fillCounts(page)).entries()].sort();
    expect(before.length).toBeGreaterThanOrEqual(4);

    // Untapped, Era is on with nothing picked, so the list is empty and the rows go. Picked again, they come back.
    await eraButton(page, 's80').click();
    await expect(rows(page)).toHaveCount(0);
    await eraButton(page, 's80').click();
    await expect(rows(page)).toHaveCount(4);
    // They are drawn filled, not played: every box has it at once, the titles are white, and no new fill runs.
    await expect(page.locator('[data-row]:has([data-filled])')).toHaveCount(4);
    for (const row of await rows(page).all()) expect(await css(titleOf(row), 'color')).toBe(TEXT);
    await page.waitForTimeout(1500);
    expect([...(await fillCounts(page)).entries()].sort()).toEqual(before);
  });

  test('R12. a song page and Back do not play any fill again', async ({ page }) => {
    await watchFills(page);
    await open(page);
    await expect.poll(async () => (await fills(page)).length).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(1200);
    const before = [...(await fillCounts(page)).entries()].sort();
    const filledBefore = await page.locator('[data-row]:has([data-filled])').evaluateAll((els) => els.map((el) => el.getAttribute('data-id')));
    expect(filledBefore.length).toBeGreaterThanOrEqual(2);

    await openButton(rows(page).first()).click();
    await expect(page.getByRole('button', { name: 'Back to songs' })).toBeVisible();
    await expect(page.locator('#app')).toHaveCount(0); // the whole tuner is gone, and its list with it
    await page.getByRole('button', { name: 'Back to songs' }).click();
    await expect(rows(page).first()).toBeVisible();
    // What had filled is drawn filled at once, and nothing plays.
    const filledAfter = await page.locator('[data-row]:has([data-filled])').evaluateAll((els) => els.map((el) => el.getAttribute('data-id')));
    for (const id of filledBefore) expect(filledAfter, String(id)).toContain(id);
    await page.waitForTimeout(1500);
    expect([...(await fillCounts(page)).entries()].sort()).toEqual(before);
  });

  test('R12. a new range fills the titles again: a visit lasts until the range changes (re-singing the high note)', async ({ baseURL }) => {
    test.setTimeout(90_000);
    // A fake microphone that sings E4 (330 Hz), so the high note comes out lower than the C5 it was.
    const browser = await launchWithMic(writeTone('r12-330.wav', 330));
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL, reducedMotion: 'no-preference' });
      await mockApi(context, { loggedIn: false, events: [] });
      await context.addInitScript(() => localStorage.setItem('kd.range', JSON.stringify({ low: 45, high: 72 })));
      const page = await context.newPage();
      await watchFills(page);
      await page.goto('/');
      await expect(rows(page).first()).toBeVisible({ timeout: 20_000 });
      await expect.poll(async () => (await fills(page)).length).toBeGreaterThanOrEqual(2);
      await page.waitForTimeout(1200);
      const first = await fillCounts(page);
      const filledIds = [...first.keys()];

      // Re-sing the high note: the mic steps, then the tuner again with a new range.
      await page.getByRole('button', { name: 'Redo your high note, C5' }).click();
      const turnOn = page.getByRole('button', { name: 'Turn on microphone', exact: true });
      const record = page.getByRole('button', { name: 'Hold to record your highest note' });
      // Our own mic screen first, where the browser has not said yes to this page yet; the note step otherwise.
      await expect(turnOn.or(record)).toBeVisible();
      if (await turnOn.isVisible()) await turnOn.click();
      await expect(record).toBeVisible();
      const at = (await record.boundingBox())!;
      await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(1600);
      await page.mouse.up();
      // "That's your range": A2 to E4. The arrow carries on to the list. It bounces for ever with motion allowed, so it is never "stable".
      await page.getByRole('button', { name: 'Continue' }).click({ force: true });
      await expect(rows(page).first()).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('#app header [role="group"]')).toContainText('E4');

      // The new visit fills its titles again: the rows that were on screen before play a second time.
      await expect.poll(async () => (await fillCounts(page)).get(filledIds[0]!) ?? 0, { timeout: 10_000 }).toBe((first.get(filledIds[0]!) ?? 0) + 1);
      await context.close();
    } finally {
      await browser.close();
    }
  });

  test('R12. the rows on screen when the list loads fill in once, one after another: 60 ms apart down the list', async ({ page }) => {
    await watchFills(page);
    await open(page, { mini: true }); // seven rows in view
    await expect.poll(async () => (await fills(page)).length).toBeGreaterThanOrEqual(5);
    const delays = await rows(page).evaluateAll((els) => els.slice(0, 5).map((el) => getComputedStyle(el.querySelector('[data-fill-text]')!).getPropertyValue('--fill-delay').trim()));
    expect(delays).toEqual(['0ms', '60ms', '120ms', '180ms', '240ms']);
    // The copy's own transition waits that long before it starts (its second transition, the put-away, waits the fill out too).
    const waits = await rows(page).evaluateAll((els) => els.slice(0, 3).map((el) => getComputedStyle(el.querySelector('[data-fill-text]')!, '::after').transitionDelay));
    expect(waits.map((w) => Number.parseFloat(w))).toEqual([0, 0.06, 0.12]);
    // Each ran once.
    const ids = (await fills(page)).map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('R12. each title\'s text is in the page once while its fill is waiting, running and done', async ({ page }) => {
    await open(page);
    await expectEachTitleOnce(page);
    const far = rows(page).nth(12);
    const farTitle = (await titleOf(far).textContent())!;
    await expect(page.getByText(farTitle, { exact: true })).toHaveCount(1); // waiting, dim
    await far.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300); // part-way through its fill
    await expect(page.getByText(farTitle, { exact: true })).toHaveCount(1);
    await page.waitForTimeout(1200); // done
    await expect(page.getByText(farTitle, { exact: true })).toHaveCount(1);
    await expectEachTitleOnce(page);
  });
});

test.describe('R12, with reduced motion', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('R12. the titles simply show: white from the first frame, no copy drawn over them, no transition and no animation', async ({ page }) => {
    await watchFills(page);
    await open(page);
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    // Even a row below the fold, which has never been in view: white, with nothing over it.
    const far = rows(page).nth(12);
    expect(await css(titleOf(far), 'color')).toBe(TEXT);
    // There is no copy: where the browser has no ::after to describe it says "none", "normal" or nothing, never the title.
    expect(await copyStyle(far, 'content')).toMatch(/^(none|normal)?$/);
    await far.scrollIntoViewIfNeeded();
    await page.waitForTimeout(900);
    expect(await fills(page)).toHaveLength(0);
    expect(await scroller(page).evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
    const colours = await page.locator('[data-row-title]').evaluateAll((els) => [...new Set(els.map((el) => getComputedStyle(el).color))]);
    expect(colours).toEqual([TEXT]);
  });

  test('R12. each title\'s text is in the page once', async ({ page }) => {
    await open(page);
    await expectEachTitleOnce(page);
  });
});

// ============================================================================================================
// R13: a song that fits only an octave away says so in its reason line
// ============================================================================================================

/**
 * Three songs the 25 do not have, all easy and among the best known, so they lead the list under the defaults (Difficulty 0 and
 * Popularity 100): one that fits an octave lower, one an octave higher, and one sung as written.
 */
const OCTAVE_SONGS: MockSong[] = [
  { title: 'Low Road', artist: 'Down Under', era: 's90', difficulty: 3, history: 50, popularity: 100, tempo: 50, octave: 'down' },
  { title: 'High Road', artist: 'Up Above', era: 's90', difficulty: 4, history: 50, popularity: 99, tempo: 50, octave: 'up' },
  { title: 'Plain Road', artist: 'As Written', era: 's90', difficulty: 2, history: 50, popularity: 98, tempo: 50 },
];
const rowOf = (page: Page, title: string) => rows(page).filter({ hasText: title });
const whyLine = (page: Page, title: string) => rowOf(page, title).locator('[data-row-why]');

test('R13. a shifted row\'s reason line is the shift reason and nothing else, never "In your sweet spot"; a song sung as written still says it; the badge stays', async ({ page }) => {
  await open(page, { extra: OCTAVE_SONGS });
  await expect(whyLine(page, 'Low Road')).toHaveText('Shifted down to fit range');
  await expect(whyLine(page, 'High Road')).toHaveText('Shifted up to fit range');
  await expect(whyLine(page, 'Plain Road')).toHaveText('In your sweet spot · Crowd favourite');
  for (const title of ['Low Road', 'High Road']) {
    const line = (await whyLine(page, title).textContent()) ?? '';
    expect(line.startsWith('Shifted '), `${title} starts with the shift`).toBe(true);
    expect(line, `${title} is the shift alone`).not.toContain(' · ');
    expect(line, `${title} does not claim a sweet spot`).not.toContain('In your sweet spot');
  }
  // Only the two shifted songs say it: the 25 songs sung as written do not.
  await expect(page.locator('[data-row-why]', { hasText: 'Shifted' })).toHaveCount(2);
  // The badge is the song's own label as for any song, and the reason line is the row button's description, as for any row.
  await expect(rowOf(page, 'Low Road').locator('[data-badge]')).toHaveText('Easy');
  await expect(page.getByRole('button', { name: /^Low Road by Down Under/ })).toHaveAccessibleDescription('Shifted down to fit range');
  // Nothing about the row's size changes: it is the 66 px row of any song.
  expect((await rowOf(page, 'Low Road').boundingBox())!.height).toBe(66);
  // The row at 390 px, for the review. (The octave jumps follow every song sung as written, QWW-58, so scroll to them.)
  await rowOf(page, 'High Road').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SCREENS, 'setlist-r13-shifted-rows.png') });
});

test('R13. the shift stays on its song when the tuner moves, and the song sung as written loses its sweet spot', async ({ page }) => {
  await open(page, { extra: OCTAVE_SONGS });
  await expect(whyLine(page, 'Plain Road')).toContainText('In your sweet spot');
  await page.evaluate(() => (window as unknown as { setlist: { setState(p: object): void } }).setlist.setState({ difficulty: 100 }));
  await expect(whyLine(page, 'Plain Road')).not.toContainText('In your sweet spot');
  await expect(whyLine(page, 'Low Road')).toHaveText('Shifted down to fit range');
  await expect(whyLine(page, 'High Road')).toHaveText('Shifted up to fit range');
  await expect(page.locator('[data-row-why]', { hasText: 'Shifted' })).toHaveCount(2);
});

/** A Medium and a Hard song that are shifted too: their badges are the widest, so they leave the reason line the least room. */
const WIDE_BADGES: MockSong[] = [
  { title: 'Mid Road', artist: 'Halfway', era: 's90', difficulty: 50, history: 50, popularity: 60, tempo: 50, octave: 'down' },
  { title: 'Hard Road', artist: 'Steep', era: 's90', difficulty: 90, history: 50, popularity: 60, tempo: 50, octave: 'up' },
];

for (const width of [360, 375, 390]) {
  test(`R13. at ${width} px a shifted row's reason line is the shift reason whole, uncut, beside an Easy, a Medium or a Hard badge`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page, { extra: [...OCTAVE_SONGS, ...WIDE_BADGES] });
    const lines = await page.evaluate(() =>
      [...document.querySelectorAll('[data-row]')]
        .map((row) => ({ row, why: row.querySelector('[data-row-why]') as HTMLElement, badge: row.querySelector('[data-badge]')?.textContent ?? null }))
        .filter(({ why }) => (why.textContent ?? '').startsWith('Shifted '))
        .map(({ why, badge }) => ({ text: why.textContent, badge, scroll: why.scrollWidth, client: why.clientWidth, ellipsis: getComputedStyle(why).textOverflow })),
    );
    expect(lines.map((l) => l.text).sort()).toEqual(['Shifted down to fit range', 'Shifted down to fit range', 'Shifted up to fit range', 'Shifted up to fit range']);
    expect(lines.map((l) => l.badge).sort()).toEqual(['Easy', 'Easy', 'Hard', 'Medium']);
    // Whole: nothing of the line is clipped, so the ellipsis has nothing to hide.
    for (const l of lines) expect(l.scroll, `${l.text} beside ${l.badge}: the line is not wider than its box`).toBeLessThanOrEqual(l.client);
  });
}

// ============================================================================================================
// R3 with QWW-48's real button (src/components/PreviewButton.tsx): a song with a Deezer preview, and one without
// ============================================================================================================

/** Two songs that lead the list under the defaults (easy, and the best known): one with a Deezer track, and one without. */
const WITH_AND_WITHOUT: MockSong[] = [
  { title: 'Can Play', artist: 'Has Preview', era: 's90', difficulty: 3, history: 50, popularity: 100, tempo: 50, deezerId: 4242 },
  { title: 'No Preview', artist: 'Has None', era: 's90', difficulty: 4, history: 50, popularity: 99, tempo: 50 },
];
const PAUSE_PATH = 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z';
const PLAY_PATH = 'M8 5.5v13l10.5-6.5z';
const byTitle = (page: Page, title: string) => rows(page).filter({ hasText: title });
/** The d of the glyph's path: the pause or the play. */
const glyphPath = (row: Locator) => glyphOf(row).locator('path').getAttribute('d');

test.describe('R3 with the real play button, with a pointer', () => {
  test.use({ viewport: { width: 1280, height: 800 }, ...POINTER });

  test('R3. a song with a preview shows its number at rest and the bare ▶ in the full --pink-text on hover; one without shows the ▶ faded and disabled; no ring either way', async ({ page }) => {
    await open(page, { extra: WITH_AND_WITHOUT });
    const can = byTitle(page, 'Can Play');
    const none = byTitle(page, 'No Preview');
    // At rest: both show their rank numbers and no ▶, and the button's state is the player's.
    for (const row of [can, none]) {
      await expect(numberOf(row)).toBeVisible();
      await expect(glyphOf(row)).toBeHidden();
    }
    await expect(playOf(can)).toBeEnabled();
    await expect(playOf(can)).toHaveAttribute('data-preview', 'idle');
    await expect(playOf(none)).toBeDisabled();
    await expect(playOf(none)).toHaveAttribute('data-preview', 'unavailable');

    // Hovered, the playable one swaps its number for the ▶ glyph, in the full pink.
    await can.hover();
    await expect(numberOf(can)).toBeHidden();
    await expect(glyphOf(can)).toBeVisible();
    expect(await glyphPath(can)).toBe(PLAY_PATH);
    expect(await css(playOf(can), 'color')).toBe(PINK_TEXT);
    expect(await css(can.locator('[data-play-slot] path'), 'fill')).toBe(PINK_TEXT);
    expect(await css(playOf(can), 'opacity')).toBe('1');
    // The one without a preview swaps the same way, in today's faded pink, and stays disabled.
    await none.hover();
    await expect(numberOf(none)).toBeHidden();
    await expect(glyphOf(none)).toBeVisible();
    expect(Number(await css(playOf(none), 'opacity'))).toBeCloseTo(0.4, 1);
    expect(await css(playOf(none), 'color')).toBe(PINK_TEXT);
    await expect(playOf(none)).toBeDisabled();

    // No ring or circle, hovered or not: the button draws one (its first svg), and the slot does not.
    for (const row of [can, none]) {
      expect(await css(slotOf(row).locator('[data-preview] > svg').first(), 'display')).toBe('none');
      expect(await ringsIn(row)).toEqual([]);
    }
    await away(page);
    for (const row of [can, none]) expect(await ringsIn(row)).toEqual([]);
  });

  test('R3. tapping the ▶ plays it: pause stands in the number\'s place while it loads and while it plays, with the pointer away; the song page does not open; the other row keeps its number', async ({ page }) => {
    await open(page, { extra: WITH_AND_WITHOUT });
    const can = byTitle(page, 'Can Play');
    const none = byTitle(page, 'No Preview');
    await can.hover();
    await playOf(can).click();
    await expectNoSongPage(page);
    await away(page);

    // Loading (the preview route answers after a moment): the pause glyph where the number was.
    await expect(playOf(can)).toHaveAttribute('data-preview', 'loading');
    await expect(numberOf(can)).toBeHidden();
    await expect(glyphOf(can)).toBeVisible();
    expect(await glyphPath(can)).toBe(PAUSE_PATH);
    expect(await ringsIn(can)).toEqual([]);
    // Playing: still pause, in the full pink, with no ring, and the row that cannot play still shows its number.
    await expect(playOf(can)).toHaveAttribute('data-preview', 'playing');
    await expect(glyphOf(can)).toBeVisible();
    expect(await glyphPath(can)).toBe(PAUSE_PATH);
    expect(await css(playOf(can), 'color')).toBe(PINK_TEXT);
    expect(await ringsIn(can)).toEqual([]);
    await expect(numberOf(none)).toBeVisible();
    await expect(glyphOf(none)).toBeHidden();

    // A tap pauses it: the ▶ glyph stays where the number was, so the row that sounds still shows.
    await playOf(can).click();
    await expect(playOf(can)).toHaveAttribute('data-preview', 'paused');
    await away(page);
    await expect(numberOf(can)).toBeHidden();
    await expect(glyphOf(can)).toBeVisible();
    expect(await glyphPath(can)).toBe(PLAY_PATH);
    await expectNoSongPage(page);
    // The row's own button still opens the song page, which stops the preview.
    await openButton(can).click();
    await expect(page.getByRole('button', { name: 'Back to songs' })).toBeVisible();
  });
});

test('R3. on a phone the ▶ always shows: the full pink when it can play, faded and disabled when it cannot; a tap plays it and shows pause; no ring; the song page does not open', async ({ page }) => {
  await open(page, { extra: WITH_AND_WITHOUT });
  expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
  const can = byTitle(page, 'Can Play');
  const none = byTitle(page, 'No Preview');
  for (const row of [can, none]) {
    await expect(numberOf(row)).toBeHidden();
    await expect(glyphOf(row)).toBeVisible();
    expect(await css(playOf(row), 'color')).toBe(PINK_TEXT);
    expect(await ringsIn(row)).toEqual([]);
  }
  expect(await css(playOf(can), 'opacity')).toBe('1');
  await expect(playOf(can)).toBeEnabled();
  expect(Number(await css(playOf(none), 'opacity'))).toBeCloseTo(0.4, 1);
  await expect(playOf(none)).toBeDisabled();
  expect(await glyphPath(can)).toBe(PLAY_PATH);

  await playOf(can).tap();
  await expectNoSongPage(page);
  await expect(playOf(can)).toHaveAttribute('data-preview', 'loading');
  expect(await glyphPath(can)).toBe(PAUSE_PATH);
  await expect(playOf(can)).toHaveAttribute('data-preview', 'playing');
  expect(await glyphPath(can)).toBe(PAUSE_PATH);
  expect(await css(playOf(can), 'color')).toBe(PINK_TEXT);
  expect(await ringsIn(can)).toEqual([]);
  // A tap on the one that cannot play opens nothing either.
  const at = await centre(slotOf(none));
  await page.touchscreen.tap(at.x, at.y);
  await expectNoSongPage(page);
});
