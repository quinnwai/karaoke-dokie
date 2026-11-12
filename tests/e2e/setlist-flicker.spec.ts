// QWW-57, adversarial review of PR #38: the strip art's 0.7 s turn-on flicker (`neonOn`) plays on first load and each time a gear goes from off
// to on (Round 6A §7), and at no other time. It used to play whenever a strip was SHOWN: on a switch to a mini tab whose gear was already on,
// on every strip the sheet expanded to, and when the singer came back from a song. The sheet does not draw its strips again for the first
// two (it keeps all four and hides three: `display: none`), and a browser plays a CSS animation again each time its element goes from
// `display: none` to shown, so the art asks for the animation only while the flicker is due (GearArt.tsx, StripSvg). In a real browser:
//   1. first load, in mini: the strip on show flickers once, and nothing flickers as the singer goes through the other tabs
//   2. expanding the sheet and collapsing it again flicker nothing
//   3. first load, expanded: every strip whose gear is on flickers once, and a gear that is off does not; a signed-in first load is the same,
//      and a reload is a first load again
//   4. a gear that is reset and then moved flickers its strip when it comes back on, and no other strip; so does a gear turned on from its own
//      tab in mini, which then does not flicker again when its tab is shown again
//   5. coming back from a song page (the sheet is drawn again, the one time a strip is) flickers nothing, in mini and in expanded
//   6. the art stops asking for its animation once the flicker has played
// `animationstart` bubbles, so one listener on the document, installed before the page's own scripts, records every flicker that starts
// and the gear of its strip; a 0.7 s animation is over before a slow assertion would look. The tuner is reached the way
// tests/e2e/setlist.spec.ts reaches it (tests/helpers/tunerE2e.ts).

import { expect, test, type Page } from '@playwright/test';
import type { GearId, TunerPart } from '../../src/lib/setlist/types';
import { art, css, handle, open, openButton, pressKey, resetButton, rows, slider, strip, tab } from '../helpers/tunerE2e';

// The 390x664 phone of playwright.config.ts (iPhone Safari with its bars), where the sheet opens in mini. Motion is ON: the other tuner
// specs turn it off, and `prefers-reduced-motion` switches the flicker off with it.
test.use({ viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'no-preference' }, screenshot: 'off' });

const GEARS: readonly GearId[] = ['difficulty', 'popularity', 'tempo', 'history'];

// ---- what the page did ----

interface Recorder {
  __neonStarts: string[];
}

/** Records every `neonOn` that starts, as the gear of the strip it is on. Call it before `open`, so first load is seen too. */
async function record(page: Page) {
  await page.addInitScript(() => {
    const starts: string[] = [];
    (window as unknown as Recorder).__neonStarts = starts;
    document.addEventListener(
      'animationstart',
      (e) => {
        if (e.animationName !== 'neonOn') return;
        starts.push((e.target as Element).closest('[data-strip]')?.getAttribute('data-gear') ?? 'not on a strip');
      },
      true,
    );
  });
}

/** The gears whose strips started a flicker since the last `forget`, in the order they started. */
const started = (page: Page) => page.evaluate(() => [...(window as unknown as Recorder).__neonStarts]);
const forget = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as Recorder).__neonStarts.length = 0;
  });

/** Flickers that are playing right now, whenever they started. */
const playing = (page: Page) =>
  page.evaluate(() => document.getAnimations().filter((a) => (a as CSSAnimation).animationName === 'neonOn' && a.playState === 'running').length);

/** The browser draws a few frames: a change that starts an animation has started it, and the page has been told, by then. */
const frames = (page: Page, count = 4) =>
  page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        const tick = (left: number): void => {
          if (left <= 0) resolve();
          else requestAnimationFrame(() => tick(left - 1));
        };
        tick(n);
      }),
    count,
  );

/** What every strip's art asks for, in `GEARS` order. A strip the mini sheet hides is read as well: its style is its own. */
const names = (page: Page) => Promise.all(GEARS.map((gear) => css(art(page, gear), 'animation-name')));

/**
 * Waits until every strip's art says `none`: the flickers of first load and of a turn-on are over, and so is the 0.7 s that a hidden strip was
 * armed for. It does not fail when they never are: a page that keeps asking for its animation is the fault of test 6, and the checks that follow
 * this one say what it did to the tabs.
 */
const untilOver = (page: Page) =>
  page
    .waitForFunction(() => [...document.querySelectorAll('[data-strip] > svg')].every((svg) => getComputedStyle(svg).animationName === 'none'), null, { timeout: 3000 })
    .catch(() => undefined);

const app = (page: Page) => page.locator('#app');

/** Marks each strip's svg. The sheet shows its strips again, it does not draw them again, and `unchanged` says so afterwards. */
const mark = (page: Page) =>
  page.evaluate(() => {
    document.querySelectorAll('[data-strip] > svg').forEach((svg, i) => {
      (svg as unknown as { __mark: number }).__mark = i;
    });
  });
const unchanged = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('[data-strip] > svg')].map((svg) => (svg as unknown as { __mark?: number }).__mark));

async function showMode(page: Page, mode: 'expanded' | 'mini') {
  if ((await app(page).getAttribute('data-mode')) !== mode) await handle(page).click();
  await expect(app(page)).toHaveAttribute('data-mode', mode);
}

// ============================================================================================================
// 1. First load in mini, and the tabs
// ============================================================================================================

test('flicker: first load in mini plays the strip on show once, and going through the other tabs plays nothing', async ({ page }) => {
  await record(page);
  await open(page, { mini: true });
  await expect(app(page)).toHaveAttribute('data-mode', 'mini');
  await untilOver(page);
  // Difficulty is on show and on. Popularity is on too, but the mini sheet hides it, so no one sees it flicker.
  expect(await started(page), 'first load').toEqual(['difficulty']);

  await mark(page);
  await forget(page);
  // Each tab, the Era tab and Difficulty's again included. Popularity's gear is on; the others are off, and an off strip has nothing to play.
  for (const gear of ['popularity', 'tempo', 'history', 'era', 'difficulty', 'popularity'] as TunerPart[]) {
    await tab(page, gear).click();
    await expect(app(page)).toHaveAttribute('data-open', gear);
    await frames(page);
    expect(await started(page), `the ${gear} tab`).toEqual([]);
    expect(await playing(page), `the ${gear} tab`).toBe(0);
  }
  expect(await unchanged(page), 'the same four svgs throughout: shown again, not drawn again').toEqual([0, 1, 2, 3]);
});

test('flicker: a phone that opens in mini by itself plays the strip on show once, and the tabs nothing', async ({ page }) => {
  await record(page);
  await open(page);
  await expect(app(page)).toHaveAttribute('data-mode', 'mini');
  await untilOver(page);
  expect(await started(page), 'first load').toEqual(['difficulty']);
  await forget(page);
  await tab(page, 'popularity').click();
  await expect(app(page)).toHaveAttribute('data-open', 'popularity');
  await frames(page);
  expect(await started(page), 'the popularity tab').toEqual([]);
  expect(await playing(page)).toBe(0);
});

// ============================================================================================================
// 2. Expanding and collapsing
// ============================================================================================================

test('flicker: expanding the sheet and collapsing it again play nothing, however often', async ({ page }) => {
  await record(page);
  await open(page, { mini: true });
  await untilOver(page);
  await mark(page);
  await forget(page);
  for (const mode of ['expanded', 'mini', 'expanded', 'mini'] as const) {
    await showMode(page, mode);
    await frames(page);
    expect(await started(page), `to ${mode}`).toEqual([]);
    expect(await playing(page), `to ${mode}`).toBe(0);
  }
  expect(await unchanged(page), 'the same four svgs throughout: shown again, not drawn again').toEqual([0, 1, 2, 3]);
});

// ============================================================================================================
// 3. First load, expanded (a 390x844 phone opens expanded)
// ============================================================================================================

test.describe('a phone tall enough to open expanded', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('flicker: first load in expanded plays every strip whose gear is on, once, and not one that is off', async ({ page }) => {
    await record(page);
    await open(page);
    await expect(app(page)).toHaveAttribute('data-mode', 'expanded');
    for (const gear of GEARS) await expect(strip(page, gear)).toBeVisible();
    await untilOver(page);
    // As first load leaves the gears, signed out: Difficulty and Popularity on; Tempo and History off.
    expect([...(await started(page))].sort(), 'first load').toEqual(['difficulty', 'popularity']);
    await forget(page);
    for (const mode of ['mini', 'expanded'] as const) {
      await showMode(page, mode);
      await frames(page);
      expect(await started(page), `to ${mode}`).toEqual([]);
    }
  });

  test('flicker: first load signed in plays the three strips that are on, History among them (R31), and a reload is a first load again', async ({ page }) => {
    await record(page);
    await open(page, { loggedIn: true });
    // Signed in, History is usable and starts on (R31), so the app got here by another road than a signed-out singer's.
    await expect(slider(page, 'history')).toBeEnabled();
    await untilOver(page);
    expect([...(await started(page))].sort(), 'first load').toEqual(['difficulty', 'history', 'popularity']);
    // The page's memory is the page's own: a new page flickers its strips again.
    await page.reload();
    await expect(rows(page).first()).toBeVisible();
    await untilOver(page);
    expect([...(await started(page))].sort(), 'after a reload').toEqual(['difficulty', 'history', 'popularity']);
  });
});

// ============================================================================================================
// 4. A gear that goes from off to on
// ============================================================================================================

test('flicker: reset a gear and move its slider in expanded: that strip plays, once, and no other does', async ({ page }) => {
  await record(page);
  await open(page, { mini: true });
  await showMode(page, 'expanded');
  await untilOver(page);
  await forget(page);

  await resetButton(page, 'popularity').click();
  await expect(strip(page, 'popularity')).toHaveAttribute('data-off', 'true');
  await frames(page);
  expect(await started(page), 'reset').toEqual([]);

  await pressKey(page, 'popularity', 'ArrowLeft');
  await expect(strip(page, 'popularity')).not.toHaveAttribute('data-off', 'true');
  await expect.poll(() => started(page), { message: 'the strip that came back on plays' }).toEqual(['popularity']);
  await frames(page);
  expect(await started(page), 'once, and no other strip').toEqual(['popularity']);
  expect(await css(art(page, 'popularity'), 'animation-name')).toBe('neonOn');
  expect(await css(art(page, 'popularity'), 'animation-duration')).toBe('0.7s');
  expect(await css(art(page, 'popularity'), 'animation-iteration-count')).toBe('1');

  // It is over in 0.7 s, and moving a gear that is on plays nothing, on any strip.
  await untilOver(page);
  await forget(page);
  await pressKey(page, 'popularity', 'ArrowLeft', 3);
  await pressKey(page, 'difficulty', 'ArrowRight', 3);
  await frames(page);
  expect(await started(page), 'a nudge of a gear that is on').toEqual([]);
});

test('flicker: turn a gear on from its own tab in mini: its strip plays, and showing the tab again does not play it again', async ({ page }) => {
  await record(page);
  await open(page, { mini: true });
  await untilOver(page);
  await forget(page);

  await tab(page, 'tempo').click();
  await expect(app(page)).toHaveAttribute('data-open', 'tempo');
  await frames(page);
  expect(await started(page), 'the Tempo tab, Tempo off').toEqual([]);
  await pressKey(page, 'tempo', 'ArrowRight');
  await expect.poll(() => started(page)).toEqual(['tempo']);
  await untilOver(page);

  await forget(page);
  for (const gear of ['difficulty', 'tempo', 'popularity', 'tempo'] as TunerPart[]) {
    await tab(page, gear).click();
    await expect(app(page)).toHaveAttribute('data-open', gear);
    await frames(page);
    expect(await started(page), `the ${gear} tab`).toEqual([]);
  }
  // Expanded and back: Tempo, which is on now, has been shown again with the rest.
  await showMode(page, 'expanded');
  await showMode(page, 'mini');
  await frames(page);
  expect(await started(page), 'expanded and back').toEqual([]);
  expect(await playing(page)).toBe(0);
});

test('flicker: a gear reset in mini and turned on again plays its strip, which is the one on show', async ({ page }) => {
  await record(page);
  await open(page, { mini: true });
  await untilOver(page);
  await forget(page);
  await resetButton(page, 'difficulty').click();
  await expect(strip(page, 'difficulty')).toHaveAttribute('data-off', 'true');
  await frames(page);
  expect(await started(page), 'reset').toEqual([]);
  await pressKey(page, 'difficulty', 'ArrowRight');
  await expect.poll(() => started(page)).toEqual(['difficulty']);
});

// ============================================================================================================
// 5. Coming back from a song
// ============================================================================================================

test('flicker: coming back from a song page plays nothing in mini either', async ({ page }) => {
  await record(page);
  await open(page, { mini: true });
  await untilOver(page);
  await forget(page);
  await openButton(rows(page).first()).click();
  await expect(page.getByRole('button', { name: 'Back to songs' })).toBeVisible();
  await expect(app(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to songs' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'mini');
  await frames(page);
  expect(await started(page), 'back from the song').toEqual([]);
  expect(await playing(page)).toBe(0);
});

test.describe('a phone tall enough to open expanded, coming back from a song', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('flicker: coming back from a song page plays nothing, the sheet expanded as the singer left it', async ({ page }) => {
    await record(page);
    await open(page);
    await untilOver(page);
    expect([...(await started(page))].sort(), 'first load').toEqual(['difficulty', 'popularity']);
    await forget(page);
    await openButton(rows(page).first()).click();
    await expect(page.getByRole('button', { name: 'Back to songs' })).toBeVisible();
    await expect(app(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to songs' }).click();
    await expect(app(page)).toHaveAttribute('data-mode', 'expanded');
    await frames(page);
    expect(await started(page), 'back from the song').toEqual([]);
    expect(await playing(page)).toBe(0);
    // The sheet is a new one, and a gear that is turned on in it still plays: the page remembers its first load, not what is armed.
    await resetButton(page, 'popularity').click();
    await pressKey(page, 'popularity', 'ArrowLeft');
    await expect.poll(() => started(page)).toEqual(['popularity']);
  });
});

// ============================================================================================================
// 6. The art stops asking for its animation
// ============================================================================================================

test('flicker: once it has played, the art asks for no animation: every strip says none within 3 s of first load, hidden ones included', async ({ page }) => {
  await record(page);
  await open(page, { mini: true });
  // Difficulty plays, so there was something to stop; Popularity is on and hidden, and is not due once its 0.7 s are up.
  await expect.poll(() => names(page), { timeout: 3000, message: 'every strip, in the order difficulty, popularity, tempo, history' }).toEqual(['none', 'none', 'none', 'none']);
  expect(await started(page)).toEqual(['difficulty']);
});
