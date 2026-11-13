// The hint on the History strip when the gear cannot be used (QWW-57, the adversarial review of #38): it must show whole, with no ellipsis and no
// clipped line, at 360, 375 and 390 px (and wider, up to the 390 px desktop frame), expanded and in mini, in both of its states:
//   signed out            "Connect Spotify to use your listening history"
//   Spotify unreachable   "Spotify could not be reached, so listening history is off"
// It used to be clamped to two lines in a strip whose height is fixed (76 px, 94 in mini), so the signed-out hint was cut off in mini at 360 px and
// the unreachable one at 360 and 375 px expanded and in mini up to 390 px. The fix sets it in 11 px on 12 px lines, so three lines (36 px) fit, and
// the expanded strip's gaps take what the hint leaves. The sheet is not made taller: the strip and the rack keep 76 and 416, 94 and 164.
//
// Everything is read from the page as laid out (boxes, and the lines of a Range over the text), never from the formulas in the stylesheet. Linux
// sets the text 2 to 4% wider than a Mac does (CI is Linux), so each case is read twice, as the browser sets it and with the hint's type 4% bigger.
// The tuner is reached the way tests/e2e/setlist.spec.ts reaches it (tests/helpers/tunerE2e.ts); the unreachable state is the one that file's
// "the unreachable hint is the same" test sets up: signed in, with /api/setlist answering `libraryUnavailable`.

import { expect, test, type Page } from '@playwright/test';
import type { AppEvent, SetlistRequest } from '../../src/lib/contracts';
import { HISTORY_HINT_LOGGED_OUT, HISTORY_HINT_UNREACHABLE } from '../../src/lib/setlist/gears';
import { mockPage } from '../fixtures/setlist';
import { setlistAnswer } from '../helpers/setlistServer';
import { handle, mockApi, open, strip, tab } from '../helpers/tunerE2e';

// A 390x844 touch phone, like the other sheet specs, and motion off.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

const DESKTOP = { hasTouch: false, isMobile: false } as const;
const PHONES = [360, 375, 390, 412, 430];
/** What Linux's wider text is stood in for by: the hint's type this much bigger. */
const LINUX = 1.04;
/** Sub-pixel layout: a box is read to a tenth, so a half pixel is not an overlap. */
const EPS = 0.5;

type Mode = 'expanded' | 'mini';

interface State {
  name: string;
  text: string;
  /** Opens the tuner (expanded unless `mini`) with the hint showing. */
  open(page: Page, mini?: boolean): Promise<void>;
}

const STATES: State[] = [
  {
    name: 'signed out',
    text: HISTORY_HINT_LOGGED_OUT,
    async open(page, mini) {
      await open(page, { mini });
    },
  },
  {
    name: 'Spotify unreachable',
    text: HISTORY_HINT_UNREACHABLE,
    async open(page, mini) {
      const events: AppEvent[] = [];
      await mockApi(page.context(), { loggedIn: true, events });
      // The library cannot be read: the server answers the setlist with catalogue songs and says so.
      await page.context().route('**/api/setlist', async (route) => {
        const body = setlistAnswer(mockPage({ idPrefix: 'cat:' }), route.request().postDataJSON() as SetlistRequest, false, { libraryUnavailable: true });
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      });
      await page.goto(mini ? '/?mini=1' : '/');
      await expect(page.locator('#app [data-row]').first()).toBeVisible({ timeout: 20_000 });
    },
  },
];

/** The fonts are loaded, so a width measured now is the one the page keeps. */
const fontsReady = (page: Page) =>
  page.evaluate(async () => {
    await document.fonts.load('500 11px Inter');
    await document.fonts.load('700 11px Inter');
    await document.fonts.ready;
  });

/** The sheet in a mode, with History's strip on show: all the strips are, expanded; in mini its tab picks it. */
async function showHistory(page: Page, mode: Mode) {
  const app = page.locator('#app');
  if ((await app.getAttribute('data-mode')) !== mode) await handle(page).click();
  await expect(app).toHaveAttribute('data-mode', mode);
  if (mode === 'mini') await tab(page, 'history').click();
  await expect(strip(page, 'history')).toBeVisible();
}

/**
 * Everything the checks read, in one trip to the page. `scale` makes the hint's type that much bigger for the moment. A box is null when it is
 * not drawn (a hidden strip, the reset button of a disabled gear, the tab bar in expanded).
 */
const measure = (page: Page, scale: number) =>
  page.evaluate((k) => {
    const rect = (el: Element | null | undefined) => {
      if (!el || el.getClientRects().length === 0) return null;
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
    };
    const history = document.querySelector<HTMLElement>('[data-strip][data-gear="history"]')!;
    const hint = history.querySelector<HTMLElement>('[data-ends="hint"]')!;
    const before = hint.style.fontSize;
    if (k !== 1) hint.style.fontSize = `${Number.parseFloat(getComputedStyle(hint).fontSize) * k}px`;
    const cs = getComputedStyle(hint);
    const range = document.createRange();
    range.selectNodeContents(hint);
    const glyphs = [...range.getClientRects()];
    const sheet = document.getElementById('sheet')!;
    const rack = document.getElementById('rack')!;
    const border = getComputedStyle(history);
    const out = {
      text: hint.textContent,
      size: Number.parseFloat(cs.fontSize),
      lineHeight: Number.parseFloat(cs.lineHeight),
      clamp: cs.getPropertyValue('-webkit-line-clamp'),
      // The lines the text is set in: the distinct tops of its line boxes.
      lines: new Set(glyphs.map((g) => Math.round(g.top))).size,
      textTop: Math.min(...glyphs.map((g) => g.top)),
      textBottom: Math.max(...glyphs.map((g) => g.bottom)),
      client: hint.clientHeight,
      scroll: hint.scrollHeight,
      hint: rect(hint),
      strip: rect(history),
      // The strip's box inside its borders.
      inner: { top: history.getBoundingClientRect().top + Number.parseFloat(border.borderTopWidth), bottom: history.getBoundingClientRect().bottom - Number.parseFloat(border.borderBottomWidth) },
      stripHeight: history.getBoundingClientRect().height,
      label: rect(history.querySelector('label')),
      // The drawn track with its knob (not the invisible slider, which lies over the whole strip body, hint included, by design).
      track: rect(history.querySelector('[data-knob]')?.parentElement),
      reset: rect(history.querySelector('[data-reset]')),
      tempo: rect(document.querySelector('[data-strip][data-gear="tempo"]')),
      era: rect(document.getElementById('era-panel')),
      tabs: rect(document.getElementById('tabs')),
      sheet: rect(sheet),
      screen: rect(document.getElementById('app')!.parentElement),
      rack: { client: rack.clientHeight, scroll: rack.scrollHeight },
      window: { width: window.innerWidth, height: window.innerHeight },
    };
    hint.style.fontSize = before;
    return out;
  }, scale);

type Measured = Awaited<ReturnType<typeof measure>>;
type Box = NonNullable<Measured['hint']>;

/** Whether two boxes share any area (touching edges is not sharing). */
const overlap = (a: Box, b: Box) => a.left < b.right - EPS && b.left < a.right - EPS && a.top < b.bottom - EPS && b.top < a.bottom - EPS;

/**
 * Checks the hint at the width and mode the page is in. It shows in full: no line clamp, every line inside the hint's own box, the box inside the
 * strip, the strip inside the sheet, the sheet inside the screen and the window. It does not touch the label, the drawn track, the reset button, the
 * neighbouring strip, the Era panel or the tab bar. And the sheet is as tall as it was (strip 76 px or 94 in mini, rack 416 or 164). Returns the lines.
 */
async function expectHintWhole(page: Page, state: State, mode: Mode, at: string, scale = 1) {
  const m = await measure(page, scale);
  const where = `${state.name}, ${at}, ${mode}${scale === 1 ? '' : `, type ${Math.round((scale - 1) * 100)}% bigger`}`;
  // Not clipped: no clamp, and the box is exactly the lines it holds (a clamp or a max-height would leave it shorter than its text).
  expect(m.text, where).toBe(state.text);
  expect(m.clamp, `${where}: -webkit-line-clamp`).toBe('none');
  expect(m.lines, `${where}: the hint takes ${m.lines} lines`).toBeLessThanOrEqual(3);
  expect(Math.abs(m.client - m.lines * m.lineHeight), `${where}: a box of ${m.client} px for ${m.lines} lines of ${m.lineHeight} px`).toBeLessThanOrEqual(1);
  // (1 px of scroll height is the glyph boxes, 13.3 px in a 12 px line: an Inter content area, not a clipped line.)
  expect(m.scroll - m.client, `${where}: ${m.scroll} px of text in a ${m.client} px box`).toBeLessThanOrEqual(1);
  expect(m.size, `${where}: the type`).toBeGreaterThanOrEqual(11);

  const { hint, strip: box, inner, label, track, sheet, screen } = m;
  expect(hint && box && label && track && sheet && screen, `${where}: the hint, strip, label, track, sheet and screen are drawn`).toBeTruthy();
  const h = hint!;
  const s = box!;
  // The hint inside the strip, to the last line.
  expect(h.top, `${where}: the hint's top is ${h.top - inner.top} px inside the strip`).toBeGreaterThanOrEqual(inner.top - EPS);
  expect(h.bottom, `${where}: the hint's bottom is ${inner.bottom - h.bottom} px inside the strip`).toBeLessThanOrEqual(inner.bottom + EPS);
  expect(m.textTop, `${where}: the first line's glyphs`).toBeGreaterThanOrEqual(s.top);
  expect(m.textBottom, `${where}: the last line's glyphs`).toBeLessThanOrEqual(s.bottom);
  expect(h.left, where).toBeGreaterThanOrEqual(s.left);
  expect(h.right, where).toBeLessThanOrEqual(s.right);
  // The label and the track above it keep clear of it, in this order, with the 2 px (or more) of a three-line hint to spare.
  expect(label!.top, `${where}: the label starts ${label!.top - inner.top} px inside the strip`).toBeGreaterThanOrEqual(inner.top - EPS);
  expect(track!.top - label!.bottom, `${where}: the track is ${track!.top - label!.bottom} px under the label`).toBeGreaterThanOrEqual(2 - EPS);
  expect(h.top - track!.bottom, `${where}: the hint is ${h.top - track!.bottom} px under the track`).toBeGreaterThanOrEqual(2 - EPS);
  if (m.reset) expect(overlap(h, m.reset), `${where}: the reset button`).toBe(false);
  // The strip in the sheet, in the screen and in the window.
  expect(s.top, where).toBeGreaterThanOrEqual(sheet!.top);
  expect(s.bottom, where).toBeLessThanOrEqual(sheet!.bottom);
  expect(sheet!.bottom, `${where}: the sheet's bottom is ${sheet!.bottom - screen!.bottom} px past the screen's`).toBeLessThanOrEqual(screen!.bottom + EPS);
  expect(sheet!.bottom, `${where}: the sheet's bottom is ${sheet!.bottom - m.window.height} px past the window's`).toBeLessThanOrEqual(m.window.height + EPS);
  // The hint itself, on all four sides: inside the screen, and so inside the window.
  expect([h.left >= screen!.left - EPS, h.right <= screen!.right + EPS, h.top >= screen!.top - EPS, h.bottom <= screen!.bottom + EPS], `${where}: the hint is inside the screen (left, right, top, bottom)`).toEqual([true, true, true, true]);
  expect(h.right, where).toBeLessThanOrEqual(m.window.width);
  expect(h.bottom, where).toBeLessThanOrEqual(m.window.height);
  // Its neighbours: Tempo's strip above and the Era panel below in expanded; the tab bar below in mini.
  if (mode === 'expanded') {
    expect(m.tempo, `${where}: Tempo's strip`).not.toBeNull();
    expect(m.tempo!.bottom, `${where}: Tempo's strip`).toBeLessThanOrEqual(s.top + EPS);
    expect(m.era!.top, `${where}: the Era panel`).toBeGreaterThanOrEqual(s.bottom - EPS);
    expect(m.tabs, `${where}: no tab bar`).toBeNull();
  } else {
    expect(m.tabs!.top, `${where}: the tab bar`).toBeGreaterThanOrEqual(s.bottom - EPS);
    expect(m.tempo, `${where}: only History's strip is on show`).toBeNull();
  }
  // The sheet is as tall as before: the hint was made to fit, the room was not made bigger.
  expect(Math.round(m.stripHeight), `${where}: the strip`).toBe(mode === 'expanded' ? 76 : 94);
  expect(m.rack, `${where}: the rack`).toEqual(mode === 'expanded' ? { client: 416, scroll: 416 } : { client: 164, scroll: 164 });
  return m.lines;
}

/** The hint at the width and mode the page is in, as the browser sets it and with Linux's wider text. Returns the lines it takes in each. */
async function expectBoth(page: Page, state: State, mode: Mode, at: string) {
  return [await expectHintWhole(page, state, mode, at), await expectHintWhole(page, state, mode, at, LINUX)];
}

for (const state of STATES) {
  test(`${state.name}: the hint shows in full at 360, 375, 390, 412 and 430 px, expanded and in mini, in a sheet as tall as before`, async ({ page }) => {
    await state.open(page);
    await expect(strip(page, 'history')).toContainText(state.text);
    const seen: number[] = [];
    for (const width of PHONES) {
      await page.setViewportSize({ width, height: 844 });
      await fontsReady(page);
      for (const mode of ['expanded', 'mini'] as const) {
        await showHistory(page, mode);
        seen.push(...(await expectBoth(page, state, mode, `${width} px`)));
      }
    }
    // The three-line case, the one the room had to be made for, is among what was checked (the long hint at 360 px), or it was never tested.
    if (state.text === HISTORY_HINT_UNREACHABLE) expect(Math.max(...seen), `the lines the hint took: ${seen}`).toBe(3);
  });

  // 360x640 and 390x664 are windows where the expanded sheet only just fits (the list has about 22 and 46 px left, and 390x664 is what iPhone Safari
  // shows): a hint of three lines must not push anything off the screen there, in either mode.
  test(`${state.name}: the hint shows in full and the sheet fits the window at 360x640 and 390x664, expanded and in mini`, async ({ page }) => {
    await state.open(page);
    await expect(strip(page, 'history')).toContainText(state.text);
    for (const [width, height] of [[360, 640], [390, 664]] as const) {
      await page.setViewportSize({ width, height });
      await fontsReady(page);
      for (const mode of ['expanded', 'mini'] as const) {
        await showHistory(page, mode);
        await expectBoth(page, state, mode, `${width}x${height}`);
      }
    }
  });
}

test.describe('on a desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, ...DESKTOP });

  // The phone-shaped frame is 390 px wide whatever the window is: a strip body of 200 px expanded and 179 in mini.
  for (const state of STATES) {
    test(`${state.name}: inside the 390 px frame at 1280x800 the hint shows in full, expanded and in mini`, async ({ page }) => {
      await state.open(page);
      await expect(strip(page, 'history')).toContainText(state.text);
      await fontsReady(page);
      for (const mode of ['expanded', 'mini'] as const) {
        await showHistory(page, mode);
        await expectBoth(page, state, mode, '1280 px');
      }
    });
  }
});
