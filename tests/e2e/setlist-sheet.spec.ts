// Review items R5 to R8, R10 and R11 of QWW-57 (Quinn-Wai's review of the 6A preview, 11 Nov), one check each as the ticket asks. They
// are all about the bottom sheet (src/components/setlist/Sheet.tsx and sheet.module.css):
//   R5   a strip's and the Era panel's border is the rail's grey in every state, expanded and in mini; only the selected tab has a gear colour
//   R6   the History strip reads "LISTENING HISTORY" and is not cut off at 360, 375 and 390 px, with History on, off and disabled
//   R7   a note, bolt or ray the value does not reach is drawn unlit (#34313D, full opacity) instead of hidden
//   R8   no pink in the sheet's top border or its shadow
//   R10  on a pointer device an idle tab takes its gear colour for a border, and an unpicked era button the pink; no glow; nothing sticks after a tap
//   R11  the strips and tabs go Difficulty, Popularity, Tempo, then Listening History (and Era); mini still opens on Difficulty
// The tuner is reached the way tests/e2e/setlist.spec.ts reaches it (tests/helpers/tunerE2e.ts).

import { expect, test, type Locator, type Page } from '@playwright/test';
import type { TunerPart } from '../../src/lib/setlist/types';
import { AMBER, PINK, UNLIT, VIOLET, css, eraButton, handle, open, pressKey, rack, resetButton, rgb, slider, strip, tab, tabArt } from '../helpers/tunerE2e';

// A 390x844 touch phone, like the tuner spec. Motion is off, so a colour is read where it ends and not on its way (the notes' and
// bolts' 180 ms light-up is a transition). The pointer describes below say otherwise about the device.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

const DESKTOP = { hasTouch: false, isMobile: false } as const;

const CYAN = rgb('#4FDDE8');
const EASY = rgb('#4DE89A');
/** An unpicked era button's border at rest (sheet.module.css, .eraButton). */
const ERA_IDLE = rgb('#2A2833');
/** The notes' lit colours, and the rays' on the History tab (NOTE_PINK in src/lib/setlist/art.ts). */
const NOTE_COLOURS = [CYAN, PINK, PINK, CYAN, CYAN, PINK, CYAN];

/** The gears in the sheet's order (R11). */
const GEARS = ['difficulty', 'popularity', 'tempo', 'history'] as const;
/** Pink in any form a browser writes a colour: `rgb(255, 79, 160)`, `rgba(255, 79, 160, 0.28)`. */
const ANY_PINK = /255,\s*79,\s*160/;

// ---- a way in, and small readers ----

/**
 * `open`, and for a signed-in singer until the library's songs are in: History's slider is enabled then, as test 13b waits for.
 * Before that History is drawn disabled, and a nudge on it or a patch of the tuner would be for nothing.
 */
async function openTuner(page: Page, opts: { loggedIn?: boolean; mini?: boolean } = {}) {
  const opened = await open(page, opts);
  if (opts.loggedIn) await expect(slider(page, 'history')).toBeEnabled();
  return opened;
}

/** What `var(--sl-rail)` is, as the browser writes a colour. Read from the page, so these checks follow the token. */
const rail = (page: Page) =>
  page.locator('#app').evaluate((app) => {
    const probe = document.createElement('i');
    probe.style.color = 'var(--sl-rail)';
    app.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });

/** The colours of an element's four borders: top, right, bottom, left. */
const sides = (loc: Locator) =>
  loc.first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor];
  });

/** The four strips and the Era panel, drawn or not, with the colours of their borders. */
async function panelBorders(page: Page) {
  const out: Record<string, string[]> = {};
  for (const g of GEARS) out[g] = await sides(strip(page, g));
  out.era = await sides(page.locator('#era-panel'));
  return out;
}

/** Asserts that every strip and the Era panel have the rail's grey on all four sides. */
async function expectGreyBorders(page: Page, when: string) {
  const grey = await rail(page);
  const want: Record<string, string[]> = {};
  for (const name of [...GEARS, 'era']) want[name] = Array(4).fill(grey) as string[];
  expect(await panelBorders(page), when).toEqual(want);
}

const setState = (page: Page, patch: object) =>
  page.evaluate((p) => (window as unknown as { setlist: { setState(p: object): void } }).setlist.setState(p), patch);

/** The computed `fill` or `stroke` of each matched part, in document order. */
const paints = (loc: Locator, property: 'fill' | 'stroke') =>
  loc.evaluateAll((els, p) => els.map((el) => getComputedStyle(el).getPropertyValue(p)), property);
const opacities = (loc: Locator) => loc.evaluateAll((els) => els.map((el) => getComputedStyle(el).opacity));
const litMarks = (loc: Locator) => loc.evaluateAll((els) => els.map((el) => el.getAttribute('data-lit')));

/** The fonts are loaded, so a width measured now is the one the page keeps. */
const fontsReady = (page: Page) =>
  page.evaluate(async () => {
    await document.fonts.load('700 11px Inter');
    await document.fonts.ready;
  });

// ============================================================================================================
// R5: the strips' and the Era panel's borders are grey
// ============================================================================================================

for (const loggedIn of [false, true]) {
  test(`R5. every strip and the Era panel have the rail's grey for a border, on, off and disabled, expanded and in mini (${loggedIn ? 'signed in' : 'signed out'})`, async ({ page }) => {
    await openTuner(page, { loggedIn });
    const tabsInMini = async (when: string) => {
      await handle(page).click();
      await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
      for (const part of [...GEARS, 'era'] as TunerPart[]) {
        await tab(page, part).click();
        await expectGreyBorders(page, `${when}, mini on ${part}`);
      }
      await handle(page).click();
      await expect(page.locator('#app')).toHaveAttribute('data-mode', 'expanded');
    };

    // As first load leaves them: Difficulty and Popularity on, Tempo, Era and History off, and History disabled when signed out.
    await expect(strip(page, 'tempo')).toHaveAttribute('data-off', 'true');
    await expect(strip(page, 'history')).toHaveAttribute('data-off', 'true');
    await expect(page.locator('#era-panel')).toHaveAttribute('data-off', 'true');
    await expectGreyBorders(page, 'as first load leaves them');
    await tabsInMini('as first load leaves them');

    // Everything on that can be (History cannot be signed out): the border does not take the gear's colour.
    if (loggedIn) await pressKey(page, 'history', 'ArrowLeft');
    await pressKey(page, 'tempo', 'ArrowRight');
    await eraButton(page, 's80').click();
    for (const g of GEARS.filter((gear) => loggedIn || gear !== 'history')) await expect(strip(page, g)).not.toHaveAttribute('data-off', /.*/);
    await expect(page.locator('#era-panel')).not.toHaveAttribute('data-off', /.*/);
    await expectGreyBorders(page, 'everything on');
    await tabsInMini('everything on');

    // And everything reset again.
    for (const part of ['difficulty', 'popularity', 'tempo', ...(loggedIn ? ['history'] : []), 'era'] as TunerPart[]) await resetButton(page, part).click();
    await expect(page.locator('#era-panel')).toHaveAttribute('data-off', 'true');
    await expectGreyBorders(page, 'everything off');
    await tabsInMini('everything off');
  });
}

test('R5. in mini the selected tab keeps its gear-colour border and glow, and every other tab has the rail\'s grey and none', async ({ page }) => {
  await openTuner(page, { mini: true, loggedIn: true });
  const grey = await rail(page);
  const border = (g: TunerPart) => css(tab(page, g), 'border-top-color');
  const glow = (g: TunerPart) => css(tab(page, g), 'box-shadow');

  // Difficulty is the open gear, at its default 0: the easy green.
  expect(await border('difficulty')).toBe(EASY);
  expect(await glow('difficulty')).toMatch(/77,\s*232,\s*154/);
  for (const g of ['popularity', 'tempo', 'history', 'era'] as TunerPart[]) {
    expect(await border(g), g).toBe(grey);
    expect(await glow(g), g).toBe('none');
  }
  // Selecting another tab moves the colour and the glow to it, and gives the old one back its grey.
  for (const [g, colour, glowed] of [
    ['tempo', VIOLET, /181,\s*131,\s*255/],
    ['history', CYAN, /79,\s*221,\s*232/],
    ['era', PINK, /255,\s*79,\s*160/],
  ] as const) {
    await tab(page, g).click();
    await expect(tab(page, g)).toHaveAttribute('aria-pressed', 'true');
    expect(await border(g), g).toBe(colour);
    expect(await glow(g), g).toMatch(glowed);
    expect(await border('difficulty'), `difficulty after ${g}`).toBe(grey);
    expect(await glow('difficulty'), `difficulty after ${g}`).toBe('none');
  }
});

// ============================================================================================================
// R6: "LISTENING HISTORY" on the strip, not cut off
// ============================================================================================================

type HistoryState = 'disabled' | 'off' | 'on';
/** What the label says. The tag is only for a History that is off but usable: a disabled one says why under its track. */
const LABEL: Record<HistoryState, string> = { disabled: 'LISTENING HISTORY', off: 'LISTENING HISTORY · OFF', on: 'LISTENING HISTORY' };

const historyLabel = (page: Page) => strip(page, 'history').locator('label');

/** What the History label's box and type are now. */
const labelBox = (page: Page) =>
  historyLabel(page).evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      text: el.textContent,
      scroll: el.scrollWidth,
      client: el.clientWidth,
      lines: Math.round(el.getBoundingClientRect().height / Number.parseFloat(cs.lineHeight)),
      size: Number.parseFloat(cs.fontSize),
      tracking: Number.parseFloat(cs.letterSpacing),
    };
  });

/** The sheet in a mode, and the History strip on show: all the strips are, expanded; in mini its tab picks it. */
async function showHistory(page: Page, mode: 'expanded' | 'mini') {
  const app = page.locator('#app');
  if ((await app.getAttribute('data-mode')) !== mode) await handle(page).click();
  await expect(app).toHaveAttribute('data-mode', mode);
  if (mode === 'mini') await tab(page, 'history').click();
  await expect(strip(page, 'history')).toBeVisible();
}

/**
 * Checks the History label at the width the page is at, in a mode. It must fit its box (scrollWidth is clientWidth or less) and,
 * but for the one case below, on one line; the strip and the rack keep their heights.
 */
async function expectLabelFits(page: Page, state: HistoryState, width: number, mode: 'expanded' | 'mini') {
  await showHistory(page, mode);
  const at = `${state}, ${width} px, ${mode}`;
  const m = await labelBox(page);
  expect(m.text, at).toBe(LABEL[state]);
  expect(m.scroll, `${at}: the label is ${m.scroll} px of content in a ${m.client} px box`).toBeLessThanOrEqual(m.client);
  // One line everywhere but a mini strip at 360 px with History on: there the reset button leaves 85 px and "LISTENING HISTORY" is
  // 95 px even in 9.5 px type with no tracking, so it takes two lines (the strip is 94 px tall) instead of being cut off.
  const wraps = state === 'on' && mode === 'mini' && width === 360;
  if (wraps) expect(m.lines, at).toBeLessThanOrEqual(2);
  else expect(m.lines, `${at}: the label takes ${m.lines} lines`).toBe(1);
  expect(Math.round((await strip(page, 'history').boundingBox())!.height), at).toBe(mode === 'expanded' ? 76 : 94);
  expect(await rack(page), at).toEqual(mode === 'expanded' ? { height: 416, scroll: 416 } : { height: 164, scroll: 164 });
  return m;
}

for (const state of ['disabled', 'off', 'on'] as const) {
  test(`R6. the strip reads "${LABEL[state]}" and the label is not cut off at 360, 375 and 390 px, expanded and in mini, with History ${state}`, async ({ page }) => {
    await openTuner(page, { loggedIn: state !== 'disabled' });
    if (state === 'on') {
      await pressKey(page, 'history', 'ArrowLeft');
      await expect(strip(page, 'history')).not.toHaveAttribute('data-off', /.*/);
      await expect(resetButton(page, 'history')).toBeVisible();
    } else {
      await expect(strip(page, 'history')).toHaveAttribute('data-off', 'true');
    }
    // The tag is " · OFF" after the label for a History that is off but usable, and not at all for a disabled one.
    await expect(strip(page, 'history').locator('[data-offtag]')).toHaveCount(state === 'off' ? 1 : 0);
    if (state === 'disabled') await expect(strip(page, 'history')).toContainText('Connect Spotify to use your listening history');

    for (const width of [390, 375, 360]) {
      await page.setViewportSize({ width, height: 844 });
      await fontsReady(page);
      for (const mode of ['expanded', 'mini'] as const) {
        const m = await expectLabelFits(page, state, width, mode);
        if (width === 390 && mode === 'expanded') {
          // 390 px keeps the look 6A draws: 11 px with 0.12em of tracking.
          expect(m.size, 'the type at 390 px').toBe(11);
          expect(m.tracking, 'the tracking at 390 px').toBeCloseTo(1.32, 1);
        }
        if (mode === 'expanded') {
          // The four labels are set alike, so the strips match.
          const sizes = await page.locator('[data-strip] label').evaluateAll((els) => els.map((el) => getComputedStyle(el).fontSize));
          expect(new Set(sizes).size, `the four labels' sizes at ${width} px: ${sizes}`).toBe(1);
          expect(Number.parseFloat(sizes[0]!)).toBeGreaterThanOrEqual(9.5);
        }
      }
    }
  });
}

test('R6. the tab still says "History" and the reset button\'s name still says "listening history"', async ({ page }) => {
  await openTuner(page, { loggedIn: true });
  await expect(tab(page, 'history')).toHaveText('History');
  await expect(resetButton(page, 'history')).toHaveAttribute('aria-label', 'Reset listening history (stop factoring it in)');
  await expect(page.getByRole('slider', { name: 'LISTENING HISTORY' })).toHaveCount(1);
});

test.describe('R6 on a desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, ...DESKTOP });

  // The frame is 390 px wide whatever the window is, so the window says nothing about the room the label has.
  for (const loggedIn of [false, true]) {
    test(`R6. inside the phone-shaped frame the label is not cut off either, expanded and in mini (${loggedIn ? 'signed in' : 'signed out'})`, async ({ page }) => {
      await openTuner(page, { loggedIn });
      await fontsReady(page);
      const states: HistoryState[] = loggedIn ? ['off', 'on'] : ['disabled'];
      for (const state of states) {
        if (state === 'on') {
          // Expanded first: the slider can be focused there.
          await showHistory(page, 'expanded');
          await pressKey(page, 'history', 'ArrowLeft');
          await expect(strip(page, 'history')).not.toHaveAttribute('data-off', /.*/);
        }
        for (const mode of ['expanded', 'mini'] as const) await expectLabelFits(page, state, 1280, mode);
      }
    });
  }
});

// ============================================================================================================
// R7: unlit tubes instead of hidden ones
// ============================================================================================================

test('R7. Popularity on at 30: 2 bolts and 2 rays amber and 5 of each #34313D, all seven drawn in full opacity', async ({ page }) => {
  await open(page);
  await setState(page, { popularity: 30 });
  const bolts = strip(page, 'popularity').locator('[data-bolt] > path');
  await expect.poll(() => paints(bolts, 'fill')).toEqual([AMBER, AMBER, UNLIT, UNLIT, UNLIT, UNLIT, UNLIT]);
  expect(await litMarks(strip(page, 'popularity').locator('[data-bolt]'))).toEqual(['true', 'true', 'false', 'false', 'false', 'false', 'false']);
  expect(await opacities(strip(page, 'popularity').locator('[data-bolt]'))).toEqual(Array(7).fill('1'));
  expect(await opacities(bolts)).toEqual(Array(7).fill('1'));
  // The rays on the tab are the same seven items on the same thresholds.
  await handle(page).click();
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
  const rays = tabArt(page, 'popularity').locator('[data-ray]');
  expect(await paints(rays, 'stroke')).toEqual([AMBER, AMBER, UNLIT, UNLIT, UNLIT, UNLIT, UNLIT]);
  expect(await litMarks(rays)).toEqual(['true', 'true', 'false', 'false', 'false', 'false', 'false']);
  expect(await opacities(rays)).toEqual(Array(7).fill('1'));
});

test('R7. History on at 65, signed in: 5 notes lit in their colours and 2 unlit, and the same on the tab\'s rays', async ({ page }) => {
  await openTuner(page, { loggedIn: true });
  await setState(page, { history: 65, off: ['tempo', 'era'] });
  const notes = strip(page, 'history').locator('[data-note]');
  const lit = [true, true, true, true, true, false, false];
  const colours = NOTE_COLOURS.map((colour, i) => (lit[i] ? colour : UNLIT));
  await expect.poll(() => paints(strip(page, 'history').locator('[data-note] > g'), 'fill')).toEqual(colours);
  expect(await litMarks(notes)).toEqual(lit.map(String));
  expect(await opacities(notes)).toEqual(Array(7).fill('1'));
  await handle(page).click();
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
  const rays = tabArt(page, 'history').locator('[data-ray]');
  expect(await paints(rays, 'stroke')).toEqual(colours);
  expect(await litMarks(rays)).toEqual(lit.map(String));
  expect(await opacities(rays)).toEqual(Array(7).fill('1'));
});

test('R7. a gear that is off is all unlit, whatever the value: Popularity reset, and History before it is switched on or signed out', async ({ page }) => {
  await open(page);
  const hooks = { history: ['[data-note]', '[data-note] > g'], popularity: ['[data-bolt]', '[data-bolt] > path'] } as const;
  const stripAllUnlit = async (gear: 'history' | 'popularity') => {
    const [part, tube] = hooks[gear];
    expect(await litMarks(strip(page, gear).locator(part)), gear).toEqual(Array(7).fill('false'));
    expect(await opacities(strip(page, gear).locator(part)), gear).toEqual(Array(7).fill('1'));
    expect(await paints(strip(page, gear).locator(tube), 'fill'), gear).toEqual(Array(7).fill(UNLIT));
  };
  const raysAllUnlit = async (gear: 'history' | 'popularity') => {
    const rays = tabArt(page, gear).locator('[data-ray]');
    expect(await litMarks(rays), `${gear} rays`).toEqual(Array(7).fill('false'));
    expect(await opacities(rays), `${gear} rays`).toEqual(Array(7).fill('1'));
    expect(await paints(rays, 'stroke'), `${gear} rays`).toEqual(Array(7).fill(UNLIT));
  };
  // History is disabled signed out, and at its default 100 every note is within reach of the value: all seven are drawn and none is lit.
  await stripAllUnlit('history');
  // Popularity is on at its default 100, with all seven bolts lit; reset, it is all unlit.
  expect(await litMarks(strip(page, 'popularity').locator('[data-bolt]'))).toEqual(Array(7).fill('true'));
  await resetButton(page, 'popularity').click();
  await expect(strip(page, 'popularity')).toHaveAttribute('data-off', 'true');
  await stripAllUnlit('popularity');
  // The tab icons' rays are the same.
  await handle(page).click();
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
  await raysAllUnlit('history');
  await raysAllUnlit('popularity');
});

// ============================================================================================================
// R8: no pink at the top of the sheet
// ============================================================================================================

for (const mini of [false, true]) {
  test(`R8. #sheet's top border and shadow have no pink, ${mini ? 'in mini' : 'expanded'}: a neutral edge and the dark shadow`, async ({ page }) => {
    await open(page, { mini });
    const sheet = page.locator('#sheet');
    const edge = await css(sheet, 'border-top-color');
    const shadow = await css(sheet, 'box-shadow');
    expect(edge, 'border-top-color').not.toMatch(ANY_PINK);
    expect(shadow, 'box-shadow').not.toMatch(ANY_PINK);
    expect(edge).toBe('rgba(255, 255, 255, 0.06)');
    // The dark shadow stays.
    expect(shadow).toContain('rgba(0, 0, 0, 0.55)');
    expect(shadow).not.toBe('none');
  });
}

// ============================================================================================================
// R10: hover, on pointer devices only
// ============================================================================================================

test.describe('R10, with a pointer', () => {
  test.use({ viewport: { width: 1280, height: 800 }, ...DESKTOP });

  /** The pointer goes somewhere that is not the sheet: outside the phone-shaped frame. */
  const leave = (page: Page) => page.mouse.move(5, 400);

  test('R10. hovering an idle tab gives it a border in its gear colour and no glow; the selected tab keeps its own border and glow', async ({ page }) => {
    await open(page, { mini: true });
    expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(true);
    const grey = await rail(page);
    const border = (g: TunerPart) => css(tab(page, g), 'border-top-color');
    const glow = (g: TunerPart) => css(tab(page, g), 'box-shadow');

    const selected = { border: await border('difficulty'), glow: await glow('difficulty') };
    expect(selected.border).toBe(EASY);
    expect(selected.glow).not.toBe('none');

    for (const [g, colour] of [
      ['popularity', AMBER],
      ['tempo', VIOLET],
      ['history', CYAN],
      ['era', PINK],
    ] as const) {
      expect(await border(g), `${g} at rest`).toBe(grey);
      await tab(page, g).hover();
      await expect.poll(() => border(g), `${g} hovered`).toBe(colour);
      expect(await glow(g), `${g} hovered: no glow`).toBe('none');
      // The selected tab is as it was.
      expect({ border: await border('difficulty'), glow: await glow('difficulty') }).toEqual(selected);
      await leave(page);
      await expect.poll(() => border(g), `${g} after the pointer left`).toBe(grey);
    }

    // The selected tab, hovered, is the same too.
    await tab(page, 'difficulty').hover();
    expect({ border: await border('difficulty'), glow: await glow('difficulty') }).toEqual(selected);
    await leave(page);
  });

  test('R10. an idle tab takes its gear\'s own colour when hovered, Difficulty\'s by its tier', async ({ page }) => {
    await open(page, { mini: true });
    await tab(page, 'tempo').click(); // Difficulty is idle now
    await setState(page, { difficulty: 80 });
    await tab(page, 'difficulty').hover();
    await expect.poll(() => css(tab(page, 'difficulty'), 'border-top-color')).toBe(rgb('#FF5A8A'));
    expect(await css(tab(page, 'difficulty'), 'box-shadow')).toBe('none');
    await setState(page, { difficulty: 50 });
    await expect.poll(() => css(tab(page, 'difficulty'), 'border-top-color')).toBe(AMBER);
  });

  test('R10. hovering an unpicked era button gives it the pink border and no glow, in mini\'s Era view and in the expanded panel; a picked one keeps its lit look', async ({ page }) => {
    await open(page, { mini: true });
    await tab(page, 'era').click();
    await expect(page.locator('#era-panel')).toBeVisible();
    const border = (era: string) => css(eraButton(page, era), 'border-top-color');
    const glow = (era: string) => css(eraButton(page, era), 'box-shadow');

    // Mini's Era view.
    expect(await border('s80'), 'at rest').toBe(ERA_IDLE);
    await eraButton(page, 's80').hover();
    await expect.poll(() => border('s80'), 'hovered').toBe(PINK);
    expect(await glow('s80'), 'hovered: no glow').toBe('none');
    await leave(page);
    await expect.poll(() => border('s80'), 'after the pointer left').toBe(ERA_IDLE);

    // Picked, it is lit with its glow; another unpicked button, hovered, gets the border and no glow, and the picked one stays lit.
    await eraButton(page, 's80').click();
    await expect(eraButton(page, 's80')).toHaveAttribute('aria-pressed', 'true');
    await eraButton(page, 's90').hover();
    await expect.poll(() => border('s90')).toBe(PINK);
    expect(await glow('s90')).toBe('none');
    expect(await border('s80')).toBe(PINK);
    expect(await glow('s80')).toMatch(/255,\s*79,\s*160/);
    await eraButton(page, 's80').hover();
    expect(await border('s80'), 'a picked button, hovered').toBe(PINK);
    expect(await glow('s80'), 'a picked button, hovered').toMatch(/255,\s*79,\s*160/);
    await leave(page);
    await expect.poll(() => border('s90')).toBe(ERA_IDLE);

    // The expanded panel.
    await handle(page).click();
    await expect(page.locator('#app')).toHaveAttribute('data-mode', 'expanded');
    expect(await border('s70'), 'expanded, at rest').toBe(ERA_IDLE);
    await eraButton(page, 's70').hover();
    await expect.poll(() => border('s70'), 'expanded, hovered').toBe(PINK);
    expect(await glow('s70'), 'expanded, hovered: no glow').toBe('none');
    await leave(page);
    await expect.poll(() => border('s70'), 'expanded, after the pointer left').toBe(ERA_IDLE);
  });

  test('R10. nothing else in the sheet gets a hover border: a strip and the Era panel keep the rail\'s grey under the pointer', async ({ page }) => {
    await open(page);
    // A short window opens the sheet in mini, where the Era panel is out of sight; hovering it needs the expanded one.
    const app = page.locator('#app');
    if ((await app.getAttribute('data-mode')) === 'mini') await handle(page).click();
    await expect(app).toHaveAttribute('data-mode', 'expanded');
    const grey = await rail(page);
    await strip(page, 'difficulty').hover();
    expect(await sides(strip(page, 'difficulty'))).toEqual(Array(4).fill(grey));
    await page.locator('#era-panel').hover({ position: { x: 6, y: 6 } });
    expect(await sides(page.locator('#era-panel'))).toEqual(Array(4).fill(grey));
  });
});

test('R10. in a touch context there is no hover, so no hover border appears and none stays after a tap', async ({ page }) => {
  await open(page, { mini: true });
  expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(false);
  const grey = await rail(page);
  const border = (g: TunerPart) => css(tab(page, g), 'border-top-color');

  // A tab: tapped it is the selected one (a gear-colour border and a glow); when another takes over it goes back to the grey and stays.
  await tab(page, 'tempo').tap();
  await expect(tab(page, 'tempo')).toHaveAttribute('aria-pressed', 'true');
  expect(await border('tempo')).toBe(VIOLET);
  await setState(page, { open: 'difficulty' });
  await expect(tab(page, 'tempo')).toHaveAttribute('aria-pressed', 'false');
  await page.waitForTimeout(150);
  expect(await border('tempo'), 'the tab that was tapped last, no longer selected').toBe(grey);
  expect(await css(tab(page, 'tempo'), 'box-shadow')).toBe('none');

  // A pointer over an idle tab does nothing here either (Playwright's hover is a mouse move on a device that has no hover).
  await tab(page, 'popularity').hover();
  await page.waitForTimeout(150);
  expect(await border('popularity')).toBe(grey);

  // An era button: picked and then unpicked by two taps, it is the one the finger touched last and it has its resting border.
  await tab(page, 'era').tap();
  await eraButton(page, 's80').tap();
  await expect(eraButton(page, 's80')).toHaveAttribute('aria-pressed', 'true');
  await eraButton(page, 's80').tap();
  await expect(eraButton(page, 's80')).toHaveAttribute('aria-pressed', 'false');
  expect(await css(eraButton(page, 's80'), 'border-top-color')).toBe(ERA_IDLE);
  expect(await css(eraButton(page, 's80'), 'box-shadow')).toBe('none');
  await eraButton(page, 's90').hover();
  await page.waitForTimeout(150);
  expect(await css(eraButton(page, 's90'), 'border-top-color')).toBe(ERA_IDLE);
});

// ============================================================================================================
// R11: Listening History goes last
// ============================================================================================================

test('R11. the strips are Difficulty, Popularity, Tempo, Listening History, in the DOM and on screen top to bottom', async ({ page }) => {
  await open(page);
  const strips = await page.locator('[data-strip]').evaluateAll((els) =>
    els.map((el) => ({ gear: (el as HTMLElement).dataset.gear, y: el.getBoundingClientRect().y, label: el.querySelector('label')?.firstChild?.textContent })),
  );
  expect(strips.map((s) => s.gear)).toEqual(['difficulty', 'popularity', 'tempo', 'history']);
  expect(strips.map((s) => s.label)).toEqual(['DIFFICULTY', 'POPULARITY', 'TEMPO', 'LISTENING HISTORY']);
  expect(strips.map((s) => s.y)).toEqual([...strips.map((s) => s.y)].sort((a, b) => a - b));
  // Listening History is the last of them, directly above the Era panel.
  const era = (await page.locator('#era-panel').boundingBox())!;
  const history = (await strip(page, 'history').boundingBox())!;
  expect(history.y + history.height).toBeLessThanOrEqual(era.y);
  // The sliders are in that order for the keyboard too: Tab goes down the strips.
  const sliders = await page.locator('#strips input[type="range"]').evaluateAll((els) => els.map((el) => el.id));
  expect(sliders).toEqual(['slider-difficulty', 'slider-popularity', 'slider-tempo', 'slider-history']);
});

test('R11. the tabs are Difficulty, Popularity, Tempo, History, Era, in the DOM and on screen left to right, and mini opens on Difficulty', async ({ page }) => {
  await open(page, { mini: true });
  const tabs = await page.locator('[data-tab]').evaluateAll((els) =>
    els.map((el) => ({ gear: (el as HTMLElement).dataset.gear, x: el.getBoundingClientRect().x, text: el.textContent })),
  );
  expect(tabs.map((t) => t.gear)).toEqual(['difficulty', 'popularity', 'tempo', 'history', 'era']);
  expect(tabs.map((t) => t.text)).toEqual(['Difficulty', 'Popularity', 'Tempo', 'History', 'Era']);
  expect(tabs.map((t) => t.x)).toEqual([...tabs.map((t) => t.x)].sort((a, b) => a - b));
  // Mini opens on the first of them, Difficulty, and on no other, signed in or out.
  await expect(page.locator('#app')).toHaveAttribute('data-open', 'difficulty');
  await expect(tab(page, 'difficulty')).toHaveAttribute('aria-pressed', 'true');
  await expect(strip(page, 'difficulty')).toBeVisible();
  for (const g of ['popularity', 'tempo', 'history'] as const) await expect(strip(page, g)).toBeHidden();
});

test('R11. signed in, mini still opens on Difficulty, and the order is the same', async ({ page }) => {
  await openTuner(page, { mini: true, loggedIn: true });
  await expect(page.locator('#app')).toHaveAttribute('data-open', 'difficulty');
  expect(await page.locator('[data-tab]').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.gear))).toEqual(['difficulty', 'popularity', 'tempo', 'history', 'era']);
  expect(await page.locator('[data-strip]').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.gear))).toEqual(['difficulty', 'popularity', 'tempo', 'history']);
});
