// The Setlist tuner's acceptance tests: Round 6A's README §12 (docs/setlist-round6a/setlist-round6a-README.md) at 390x844 --
// Round 5's tests 1 to 21 (docs/setlist-round5/setlist-round5-spec.md §9) with 6A's adjustments, and the new tests 22 to 32 --
// plus the ticket's other criteria: a drag on the handle does not scroll the page, the sheet does not cover the list's last
// row, the row opens the song page and the play button does not, the TV frame, which mode a phone opens in (QWW-57, decision 1)
// at 390x664, 375x553 and 412x780, long titles, the header.
//
// The README's expectations are for its mock defaults (Difficulty 30, History 65, Popularity 80, Tempo 45, everything on,
// Era 90s/00s/10s picked). The real defaults (src/lib/setlist/defaults.ts, QWW-47's decision) differ: Difficulty 0 and
// Popularity 100 on (Popularity weighs double), History, Tempo and Era off, and Era has no default picks. So the expected
// rankings below are for those, for the 25 mock songs of the spec (tests/fixtures/setlist.ts) as QWW-47's engine
// (src/lib/songs/setlist.ts) ranks them. They are literals on purpose, so a change to the engine's order is read before it
// ships. Ranking maths is covered by tests/songs/setlist.test.ts; here the point is what the screen does with the list it
// gets. The list comes back from the server a moment after each change, so the specs poll for it.
//
// The API is mocked with contract-shaped fixtures, as in the other e2e specs; POST /api/setlist answers with the server's own
// ranking of them (tests/helpers/setlistServer.ts). `window.setlist` (the spec's test hook,
// built only into this e2e build, see NEXT_PUBLIC_SETLIST_TEST_HOOK in playwright.config.ts) reads the state back.
//
// Selector map from the spec's reference to this build: `.strip[data-gear]` is `[data-strip][data-gear]`, `.tab` is
// `[data-tab]`, `.era-btn[data-era]` is `button[data-era]` (the Era tab's dots carry data-era too), `.reset-btn[data-reset]`
// is `button[data-reset]`, `.row[data-rank]` is `[data-row][data-rank]`, `.is-off` is `[data-off]`, `.is-parked` is
// `[data-parked]`, `#app.is-compact` is `#sheet[data-compact]`. Wherever 6A reads a row's visible rank number, these read
// `data-rank`: the ▶ took the number's place (decision 3).

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AppEvent, EventsRequest, MeResponse, SetlistRequest, VocalRange } from '../../src/lib/contracts';
import { easeProgress, SLIDE_MS } from '../../src/components/setlist/flip';
import { DEFAULTS } from '../../src/lib/setlist/defaults';
import type { GearId, TunerPart, TunerState } from '../../src/lib/setlist/types';
import { setlistAnswer } from '../helpers/setlistServer';
import { MOCK_SONGS, mockPage, titlesOf, type MockSong } from '../fixtures/setlist';
import { DEFAULT_RANKING, ALL_RESET_RANKING, ONLY_80S, RANGE, ME, Opened, mockApi, open, rows, openButton, titles, strip, tab, eraButton, resetButton, slider, handle, tuner, rack, value, onTrack, pressKey, dragHandle, touchDrag, centre, rgb, UNLIT, PINK, AMBER, VIOLET, OFF_TEXT, TEXT_3, css, art, tabArt } from '../helpers/tunerE2e';

const SCREENS = path.resolve('test-results/screens');
test.beforeAll(() => mkdirSync(SCREENS, { recursive: true }));

// A 390x844 touch phone. Motion is off unless a test is about motion (the Continue arrow and the list would never be
// "stable" for Playwright otherwise).
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });


// ============================================================================================================
// Spec section 9
// ============================================================================================================

test('1. default load: expanded, rack 416 px, four strips and the era panel, no tabs, the ranking for the real defaults', async ({ page }) => {
  await open(page);
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'expanded');
  expect((await rack(page)).height).toBe(416);
  for (const g of ['difficulty', 'history', 'popularity', 'tempo'] as GearId[]) await expect(strip(page, g)).toBeVisible();
  await expect(page.locator('#era-panel')).toBeVisible();
  await expect(page.locator('#tabs')).toBeHidden();
  await expect.poll(async () => (await titles(page)).slice(0, 10)).toEqual(DEFAULT_RANKING);
  expect(await rows(page).count()).toBe(25);
  await page.screenshot({ path: path.join(SCREENS, 'setlist-01-expanded.png') });
});

test('2. ?mini=1: mini mode, rack 164 px, only the open gear (Difficulty) and the tabs', async ({ page }) => {
  await open(page, { mini: true });
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
  expect((await rack(page)).height).toBe(164);
  await expect(page.locator('#sheet')).toHaveAttribute('data-compact', 'true');
  await expect(strip(page, 'difficulty')).toBeVisible();
  for (const g of ['history', 'popularity', 'tempo'] as GearId[]) await expect(strip(page, g)).toBeHidden();
  await expect(page.locator('#era-panel')).toBeHidden();
  await expect(page.locator('#tabs')).toBeVisible();
  await page.screenshot({ path: path.join(SCREENS, 'setlist-02-mini.png') });
});

test('2b. ?mini=1 signed in: the mini sheet opens on Difficulty too (the spec opens on History, which now starts off)', async ({ page }) => {
  await open(page, { mini: true, loggedIn: true });
  await expect(page.locator('#app')).toHaveAttribute('data-open', 'difficulty');
  await expect(strip(page, 'difficulty')).toBeVisible();
  await expect(strip(page, 'history')).toBeHidden();
  expect((await rack(page)).height).toBe(164);
});

test('3. tapping the handle goes expanded to mini and back', async ({ page }) => {
  await open(page);
  await expect(handle(page)).toHaveAttribute('aria-label', 'Show one gear');
  await expect(handle(page)).toHaveAttribute('aria-expanded', 'true');
  await handle(page).click();
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
  await expect(handle(page)).toHaveAttribute('aria-label', 'Show all gears');
  await expect(handle(page)).toHaveAttribute('aria-expanded', 'false');
  await handle(page).click();
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'expanded');
});

test('3b. Enter and Space on the handle switch modes, like a tap', async ({ page }) => {
  await open(page);
  await handle(page).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
  await page.keyboard.press('Space');
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'expanded');
});

test('4. in mini, the Era tab shows only the era panel and the tabs; Era is the open gear', async ({ page }) => {
  await open(page, { mini: true });
  await tab(page, 'era').click();
  await expect(page.locator('#app')).toHaveAttribute('data-open', 'era');
  await expect(page.locator('#era-panel')).toBeVisible();
  await expect(page.locator('#strips')).toBeHidden();
  await expect(page.locator('#tabs')).toBeVisible();
  await expect(tab(page, 'era')).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: path.join(SCREENS, 'setlist-04-mini-era.png') });
});

test('5. unpicking the last era by hand turns Era off: every song is back, no prompt, nothing pressed, no turn-off button (R23, which replaces round 5\'s empty list)', async ({ page }) => {
  await open(page);
  // Era starts off with no picks. The first tap turns it on with just that era; tapping it again leaves nothing picked, which is Era off.
  await eraButton(page, 's90').click();
  expect((await tuner(page)).eras).toEqual(['s90']);
  await expect(rows(page)).toHaveCount(4);
  await eraButton(page, 's90').click();
  await expect(rows(page)).toHaveCount(25);
  await expect.poll(async () => (await titles(page)).slice(0, 10)).toEqual(DEFAULT_RANKING);
  await expect(page.locator('#empty')).toHaveCount(0);
  const t = await tuner(page);
  expect(t.eras).toEqual([]);
  expect(t.off).toContain('era');
  await expect(page.locator('#era-panel')).toHaveAttribute('data-off', 'true');
  await expect(resetButton(page, 'era')).toBeHidden();
  for (const era of ['pre', 's70', 's80', 's90', 's00', 's10', 's20']) await expect(eraButton(page, era)).toHaveAttribute('aria-pressed', 'false');
});

test('6. only the 80s picked ranks the four 80s songs, for the real defaults', async ({ page }) => {
  await open(page);
  // Era starts off with no picks, so the first tap picks just the 80s.
  await eraButton(page, 's80').click();
  expect(await tuner(page).then((t) => t.eras)).toEqual(['s80']);
  await expect.poll(() => titles(page)).toEqual(ONLY_80S);
});

test('7. moving a slider sets its value, makes it the open gear and re-ranks the list', async ({ page }) => {
  await open(page);
  expect((await tuner(page)).off).toContain('tempo');
  await pressKey(page, 'tempo', 'ArrowRight', 5);
  expect(await value(page, 'tempo')).toBe(DEFAULTS.tempo + 5);
  await expect(page.locator('#app')).toHaveAttribute('data-open', 'tempo');
  await expect(strip(page, 'tempo')).not.toHaveAttribute('data-off', /.*/);
  expect((await tuner(page)).off).not.toContain('tempo');
  // Tempo now counts, so the order is not the default one.
  await expect.poll(async () => (await titles(page)).slice(0, 3)).not.toEqual(DEFAULT_RANKING.slice(0, 3));
});

test('7b. a tap on a slider track sets that value and opens the gear', async ({ page }) => {
  await open(page);
  const p = await onTrack(page, 'difficulty', 0.8);
  await page.mouse.click(p.x, p.y);
  expect(Math.abs((await value(page, 'difficulty')) - 80)).toBeLessThanOrEqual(2);
  await expect(page.locator('#app')).toHaveAttribute('data-open', 'difficulty');
});

test('8. from mini, dragging the handle up 80 px grows the rack and leaves the compact layout while dragging; releasing expands', async ({ page }) => {
  await open(page, { mini: true });
  await dragHandle(page, -80, async () => {
    await expect(page.locator('#sheet')).not.toHaveAttribute('data-compact', /.*/);
    expect((await page.locator('#rack').boundingBox())!.height).toBeGreaterThan(164);
    await expect(page.locator('#rack')).toHaveAttribute('data-dragging', 'true');
  });
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'expanded');
  expect((await rack(page)).height).toBe(416);
});

test('9. from expanded, 30 px down stays expanded and 80 px down goes mini', async ({ page }) => {
  await open(page);
  await dragHandle(page, 30);
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'expanded');
  expect((await rack(page)).height).toBe(416);
  await dragHandle(page, 80);
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
  expect((await rack(page)).height).toBe(164);
});

test('10. a drag does not also toggle the mode through the click that follows it', async ({ page }) => {
  await open(page);
  await dragHandle(page, 80); // expanded -> mini
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
  await page.waitForTimeout(100);
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini'); // not toggled back by the click
  await dragHandle(page, -80); // mini -> expanded
  await page.waitForTimeout(100);
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'expanded');
  // The press after a drag is a tap again.
  await handle(page).click();
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
});

test('11. rack content never overflows: expanded, mini and mini-era', async ({ page }) => {
  await open(page);
  expect(await rack(page)).toEqual({ height: 416, scroll: 416 });
  await handle(page).click();
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
  expect(await rack(page)).toEqual({ height: 164, scroll: 164 });
  await tab(page, 'era').click();
  expect(await rack(page)).toEqual({ height: 164, scroll: 164 });
});

test.describe('12. the metronome', () => {
  test.use({ contextOptions: { reducedMotion: 'no-preference' } });

  test('Tempo 55 swings with the swing14 keyframes and a 0.45 s half-swing', async ({ page }) => {
    await open(page);
    await pressKey(page, 'tempo', 'ArrowRight', 5);
    expect(await value(page, 'tempo')).toBe(55);
    const animations = await strip(page, 'tempo').evaluate((el) =>
      el
        .getAnimations({ subtree: true })
        .filter((a): a is CSSAnimation => a instanceof CSSAnimation)
        .map((a) => ({ name: a.animationName, duration: a.effect?.getTiming().duration, paused: a.playState === 'paused' })),
    );
    expect(animations).toContainEqual({ name: 'swing14', duration: 450, paused: false });
  });

  test('a gear that is off holds its art still: the metronome has no animation at all (6A §7: a switched-off sign)', async ({ page }) => {
    await open(page);
    // Tempo starts off. 6A draws the off state as unlit tubes and sets the pendulum to `animation: none`, rather than pausing it.
    const animations = await strip(page, 'tempo').evaluate((el) =>
      el
        .getAnimations({ subtree: true })
        .filter((a): a is CSSAnimation => a instanceof CSSAnimation)
        .map((a) => a.animationName),
    );
    expect(animations).toEqual([]);
  });
});

test('12b. with reduced motion nothing in the sheet animates', async ({ page }) => {
  await open(page);
  await pressKey(page, 'tempo', 'ArrowRight', 5);
  const running = await page.locator('#sheet').evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length);
  expect(running).toBe(0);
});

test('13. the reset buttons: five exist, and only those of the gears that are on are shown', async ({ page }) => {
  await open(page);
  await expect(page.locator('button[data-reset]')).toHaveCount(5);
  // Signed out: Difficulty and Popularity are on; History, Tempo and Era start off, and an off gear has nothing to reset.
  await expect(page.locator('button[data-reset]:visible')).toHaveCount(2);
  await expect(resetButton(page, 'difficulty')).toBeVisible();
  await expect(resetButton(page, 'popularity')).toBeVisible();
});

test('13b. signed in, History starts on at 100 (R31), its ✕ turns it off, and a nudge turns it on again from its default', async ({ page }) => {
  await open(page, { loggedIn: true });
  // Signed in it starts on, "that's the purpose of logging in": Difficulty, Popularity and History show their ✕, Tempo and Era do not.
  await expect(page.locator('button[data-reset]:visible')).toHaveCount(3);
  await expect(strip(page, 'history')).not.toHaveAttribute('data-off', /.*/);
  await expect(slider(page, 'history')).toBeEnabled();
  expect(await value(page, 'history')).toBe(DEFAULTS.history);
  expect((await tuner(page)).off).toEqual(['tempo', 'era']);
  // Its ✕ is "Turn off", as every gear's is (R21): back at 100 and off.
  await resetButton(page, 'history').click();
  await expect(strip(page, 'history')).toHaveAttribute('data-off', 'true');
  expect(await value(page, 'history')).toBe(DEFAULTS.history);
  // Signed out it cannot be switched on; signed in a nudge turns it on from its default.
  await pressKey(page, 'history', 'ArrowLeft');
  await expect(strip(page, 'history')).not.toHaveAttribute('data-off', /.*/);
  expect(await value(page, 'history')).toBe(DEFAULTS.history - 1);
  await expect(resetButton(page, 'history')).toBeVisible();
});

test('14. Tempo to 90, then reset: back to the default, off, hollow thumb, focus on the slider, the default ranking', async ({ page }) => {
  await open(page);
  await slider(page, 'tempo').fill('90');
  expect(await value(page, 'tempo')).toBe(90);
  await expect.poll(async () => (await titles(page)).slice(0, 10)).not.toEqual(DEFAULT_RANKING);
  await resetButton(page, 'tempo').click();
  const t = await tuner(page);
  expect(t.tempo).toBe(DEFAULTS.tempo);
  expect(t.off).toContain('tempo');
  await expect(strip(page, 'tempo')).toHaveAttribute('data-off', 'true');
  await expect(strip(page, 'tempo').locator('label')).toContainText('· OFF');
  await expect(resetButton(page, 'tempo')).toBeHidden();
  await expect(slider(page, 'tempo')).toBeFocused();
  await expect(slider(page, 'tempo')).toHaveAttribute('aria-valuetext', 'Off');
  // The hollow thumb sits at the default value.
  const pct = await slider(page, 'tempo').locator('xpath=..').evaluate((el) => getComputedStyle(el).getPropertyValue('--pct').trim());
  expect(pct).toBe(`${DEFAULTS.tempo}%`);
  // Tempo counts for nothing again: the list is the default one.
  await expect.poll(async () => (await titles(page)).slice(0, 10)).toEqual(DEFAULT_RANKING);
});

test('15. changing the eras, then resetting Era: the default picks (none), off, every song, none outlined, none pressed', async ({ page }) => {
  await open(page);
  await eraButton(page, 's80').click();
  await eraButton(page, 's70').click();
  await expect.poll(async () => (await titles(page)).length).toBeLessThan(25);
  await resetButton(page, 'era').click();
  const t = await tuner(page);
  expect(t.eras).toEqual([...DEFAULTS.eras]);
  expect(t.off).toContain('era');
  await expect(rows(page)).toHaveCount(25);
  await expect(page.locator('#era-panel')).toHaveAttribute('data-off', 'true');
  // The default has no picks, so there is nothing to outline; the outline itself (the spec's "parked" picks) is
  // covered with the screen's other states in tests/setlist/setlistScreen.test.tsx.
  await expect(page.locator('button[data-era][data-parked]')).toHaveCount(0);
  await expect(page.locator('button[data-era][aria-pressed="true"]')).toHaveCount(0);
  await expect(page.locator('#era-label')).toContainText('· OFF');
  await expect(resetButton(page, 'era')).toBeHidden();
  await expect(eraButton(page, 'pre')).toBeFocused(); // the reset button hid itself, so focus goes to the first era button
});

test('16. with Tempo reset: ArrowRight gives the default + 1 and on; tapping the hollow thumb turns it on at the default; tapping near the right end turns it on there', async ({ page }) => {
  await open(page);
  // Tempo starts off at its default.
  await expect(strip(page, 'tempo')).toHaveAttribute('data-off', 'true');
  await pressKey(page, 'tempo', 'ArrowRight');
  expect(await value(page, 'tempo')).toBe(DEFAULTS.tempo + 1);
  await expect(strip(page, 'tempo')).not.toHaveAttribute('data-off', /.*/);

  await resetButton(page, 'tempo').click();
  await expect(strip(page, 'tempo')).toHaveAttribute('data-off', 'true');
  const thumb = await onTrack(page, 'tempo', DEFAULTS.tempo / 100);
  await page.mouse.click(thumb.x, thumb.y);
  await expect(strip(page, 'tempo')).not.toHaveAttribute('data-off', /.*/);
  expect(Math.abs((await value(page, 'tempo')) - DEFAULTS.tempo)).toBeLessThanOrEqual(1);

  await resetButton(page, 'tempo').click();
  const end = await onTrack(page, 'tempo', 0.97);
  await page.mouse.click(end.x, end.y);
  await expect(strip(page, 'tempo')).not.toHaveAttribute('data-off', /.*/);
  expect(await value(page, 'tempo')).toBeGreaterThanOrEqual(95);
});

test('17. with Era reset, tapping the 80s picks just the 80s (the default picks are none) and turns Era on', async ({ page }) => {
  await open(page);
  await expect(page.locator('#era-panel')).toHaveAttribute('data-off', 'true');
  await eraButton(page, 's80').click();
  expect((await tuner(page)).eras).toEqual(['s80']);
  await expect(page.locator('#era-panel')).not.toHaveAttribute('data-off', /.*/);
  await expect(eraButton(page, 's80')).toHaveAttribute('aria-pressed', 'true');
  for (const era of ['pre', 's70', 's90', 's00', 's10', 's20']) await expect(eraButton(page, era)).toHaveAttribute('aria-pressed', 'false');
  // A second tap adds to the picks: Era is multi-select.
  await eraButton(page, 's90').click();
  expect((await tuner(page)).eras).toEqual(['s80', 's90']);
});

test('18. every gear reset: all 25 songs, most popular first, every value its default', async ({ page }) => {
  await open(page);
  await resetButton(page, 'difficulty').click();
  await resetButton(page, 'popularity').click();
  await expect.poll(() => titles(page)).toEqual(ALL_RESET_RANKING);
  const t = await tuner(page);
  expect([t.difficulty, t.history, t.popularity, t.tempo]).toEqual([DEFAULTS.difficulty, DEFAULTS.history, DEFAULTS.popularity, DEFAULTS.tempo]);
  expect(t.eras).toEqual([...DEFAULTS.eras]);
  expect([...t.off].sort()).toEqual(['difficulty', 'era', 'history', 'popularity', 'tempo']);
  await page.screenshot({ path: path.join(SCREENS, 'setlist-18-every-gear-off.png') });
});

test('19. tapping the far right end of a slider track sets 100: it is not the reset button', async ({ page }) => {
  await open(page);
  const end = await onTrack(page, 'difficulty', 1);
  await page.mouse.click(end.x - 1, end.y);
  expect(await value(page, 'difficulty')).toBeGreaterThanOrEqual(99);
  await expect(strip(page, 'difficulty')).not.toHaveAttribute('data-off', /.*/);
  expect((await tuner(page)).off).not.toContain('difficulty');
});

test('20. in mini, resetting the open gear dims its tab', async ({ page }) => {
  await open(page, { mini: true });
  await expect(tab(page, 'difficulty')).not.toHaveAttribute('data-off', /.*/);
  await resetButton(page, 'difficulty').click();
  await expect(tab(page, 'difficulty')).toHaveAttribute('data-off', 'true');
  // History and Tempo were already off.
  await expect(tab(page, 'tempo')).toHaveAttribute('data-off', 'true');
  await expect(tab(page, 'popularity')).not.toHaveAttribute('data-off', /.*/);
});

test('21. with gears off, the rack still never overflows: 416 and 164', async ({ page }) => {
  await open(page);
  await resetButton(page, 'difficulty').click();
  await resetButton(page, 'popularity').click();
  expect(await rack(page)).toEqual({ height: 416, scroll: 416 });
  await handle(page).click();
  expect(await rack(page)).toEqual({ height: 164, scroll: 164 });
  await tab(page, 'era').click();
  expect(await rack(page)).toEqual({ height: 164, scroll: 164 });
  await tab(page, 'history').click();
  expect(await rack(page)).toEqual({ height: 164, scroll: 164 });
});

// ============================================================================================================
// The ticket's other criteria
// ============================================================================================================

test('signed out, Listening history is off and disabled with its hint, and Connect to Spotify stays top right', async ({ page }) => {
  await open(page);
  await expect(strip(page, 'history')).toHaveAttribute('data-off', 'true');
  await expect(slider(page, 'history')).toBeDisabled();
  await expect(strip(page, 'history')).toContainText('Connect Spotify to use your listening history');
  // R6: the label is "LISTENING HISTORY", and a gear that cannot be used says why under its track instead of " · OFF" after its label.
  await expect(strip(page, 'history').locator('label')).toHaveText('LISTENING HISTORY');
  await expect(strip(page, 'history').locator('[data-offtag]')).toHaveCount(0);
  const connect = page.getByRole('button', { name: 'Connect to Spotify' }).first();
  const box = (await connect.boundingBox())!;
  const heading = (await page.getByRole('heading', { name: 'Tune your setlist' }).boundingBox())!;
  expect(box.x).toBeGreaterThan(390 / 2); // the right half
  expect(box.y).toBeLessThan(heading.y + heading.height);
  // The tab is still there in mini, dimmed.
  await handle(page).click();
  await expect(tab(page, 'history')).toHaveAttribute('data-off', 'true');
});

// ---- the TV frame (6A §3.3; QWW-57, decision 2: the tuner is always in the frame) ----

/** The pieces of the frame, from the tuner outwards: the tuner's root, the TV screen's inner box, the screen, the TV and the page. */
const frame = (page: Page) =>
  page.evaluate(() => {
    const app = document.getElementById('app')!;
    const inner = app.parentElement!;
    const screenEl = inner.parentElement!;
    const tv = screenEl.parentElement!;
    const stage = tv.parentElement!;
    const chin = tv.lastElementChild as HTMLElement;
    const box = (e: Element) => {
      const b = e.getBoundingClientRect();
      return { x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 };
    };
    const cs = (e: Element) => getComputedStyle(e);
    return {
      frames: document.querySelectorAll('section[aria-label="Karaoke screen"]').length,
      stage: { ...box(stage), padding: cs(stage).padding },
      tv: { ...box(tv), padding: cs(tv).padding, radius: cs(tv).borderTopLeftRadius },
      screen: { ...box(screenEl), radius: cs(screenEl).borderTopLeftRadius },
      inner: { ...box(inner), scrolls: inner.scrollHeight > inner.clientHeight },
      app: { ...box(app), padding: cs(app).padding, background: cs(app).backgroundColor },
      chin: { ...box(chin), text: chin.textContent ?? '', led: chin.lastElementChild ? box(chin.lastElementChild) : null },
      docH: document.documentElement.scrollHeight,
      innerH: innerHeight,
      text: document.body.innerText,
    };
  });

test('the tuner is in the TV frame on a phone, with 6A\'s numbers: page padding 14 10 12, bezel 9 9 0, radii 30 and 22, a 34 px chin with the LED', async ({ page }) => {
  await open(page);
  const f = await frame(page);
  expect(f.frames, 'one frame, no second bezel').toBe(1);
  expect(f.stage.padding).toBe('14px 10px 12px');
  expect(f.stage.h).toBe(844);
  expect([f.tv.x, f.tv.y, f.tv.w, f.tv.h]).toEqual([10, 14, 370, 818]);
  expect(f.tv.padding).toBe('9px 9px 0px');
  expect(f.tv.radius).toBe('30px');
  expect(f.screen.radius).toBe('22px');
  expect(f.chin.h).toBe(34);
  expect(f.chin.text.toLowerCase()).toContain('karaoke-dokie');
  expect(f.chin.led).not.toBeNull();
  // The TV fills the viewport: no height cap on a phone.
  expect(f.tv.y + f.tv.h).toBe(844 - 12);
  await page.screenshot({ path: path.join(SCREENS, 'setlist-frame.png') });
});

test('the tuner fills the TV screen and nothing scrolls as a whole: the list scrolls, the sheet stays put, the page never moves', async ({ page }) => {
  await open(page);
  const f = await frame(page);
  expect(f.app.h).toBe(f.inner.h);
  expect(f.app.w).toBe(f.inner.w);
  expect(f.inner.scrolls).toBe(false);
  expect(f.docH).toBe(f.innerH);
  // The tuner draws no background or second bezel of its own: the TV's screen is what shows.
  expect(f.app.background).toBe('rgba(0, 0, 0, 0)');
  // 6A's screen padding, 16 12 0.
  expect(f.app.padding).toBe('16px 12px 0px');
  expect(await page.evaluate(() => document.getElementById('list-scroll')!.scrollHeight > document.getElementById('list-scroll')!.clientHeight)).toBe(true);
});

test('the sheet bleeds to the TV screen\'s edges and rests on its bottom: the chin is clear below it', async ({ page }) => {
  await open(page);
  const m = await page.evaluate(() => {
    const sheet = document.getElementById('sheet')!.getBoundingClientRect();
    const inner = document.getElementById('app')!.parentElement!.getBoundingClientRect();
    return { left: sheet.left - inner.left, right: inner.right - sheet.right, bottom: inner.bottom - sheet.bottom };
  });
  expect(m).toEqual({ left: 0, right: 0, bottom: 0 });
});

test.describe('on a desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false });

  // R2 (QWW-57): the TV is phone-shaped on every screen. The title, the mic and the note steps are in tests/e2e/setlist-frame.spec.ts.
  test('the tuner is in a phone-shaped TV: 390 px wide, 768 tall (the window less 32 px), centred, with the phone\'s bezel, and no column inside it', async ({ page }) => {
    await open(page);
    const f = await frame(page);
    expect(f.frames).toBe(1);
    expect(f.tv.w).toBe(390);
    expect(f.tv.h).toBe(768);
    expect(Math.abs(f.tv.x + f.tv.w / 2 - 1280 / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(f.tv.y + f.tv.h / 2 - 800 / 2)).toBeLessThanOrEqual(1);
    // The phone's numbers (6A's bezel 9 9 0, radii 30 and 22), not the wide TV's of before (16 16 0, radius 32).
    expect(f.tv.padding).toBe('9px 9px 0px');
    expect(f.tv.radius).toBe('30px');
    expect(f.screen.radius).toBe('22px');
    // The tuner fills the TV's screen: no 480 px column in it.
    expect(f.app.w).toBe(f.inner.w);
    expect(f.app.w).toBe(372);
    expect(f.inner.scrolls).toBe(false);
  });
});

test('the sheet does not cover the last row: scrolled to the end, it and the end of the list are clear of the sheet and its handle', async ({ page }) => {
  await open(page);
  for (const mode of ['expanded', 'mini']) {
    if (mode === 'mini') await handle(page).click();
    await page.locator('#list-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const sheetTop = (await page.locator('#sheet').boundingBox())!.y;
    // The scroller ends where the sheet starts.
    const scroller = (await page.locator('#list-scroll').boundingBox())!;
    expect(Math.round(scroller.y + scroller.height)).toBeLessThanOrEqual(Math.round(sheetTop));
    // The last row and the Deezer line, at the very end when a row on screen has a preview (the credits link is in the TV's chin now, R28), are above the
    // handle's touch area (it reaches 11 px above the sheet) and receive their own taps.
    const deezer = page.getByRole('link', { name: /^Previews from Deezer/ });
    for (const target of [rows(page).last().locator('button').first(), ...((await deezer.count()) > 0 ? [deezer] : [])]) {
      const b = (await target.boundingBox())!;
      expect(b.y + b.height, `${mode}: bottom of the last thing in the list`).toBeLessThanOrEqual(sheetTop - 11 + 1);
      const c = await centre(target);
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('#sheet') !== null, c);
      expect(hit, `${mode}: the sheet is not over the last row`).toBe(false);
    }
  }
});

test('a song row opens the song page; the play button does not; back keeps what was tuned', async ({ page }) => {
  await open(page);
  await pressKey(page, 'tempo', 'ArrowRight', 5);
  // The list is re-ranked a moment after the last key press (the screen waits 120 ms for it). Read at once, `before` would be
  // the default order, and Back would be compared with a list that was already out of date.
  await expect.poll(async () => (await titles(page)).slice(0, 3)).not.toEqual(DEFAULT_RANKING.slice(0, 3));
  const before = await titles(page);
  // The play slot is beside the row's own button, and a tap on it opens nothing.
  const play = await centre(page.locator('[data-play-slot]').first());
  await page.mouse.click(play.x, play.y);
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to songs' })).toHaveCount(0);

  await openButton(rows(page).first()).click();
  await expect(page.getByRole('button', { name: 'Back to songs' })).toBeVisible();
  await expect(page.locator('#app')).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to songs' }).click();
  await expect(page.locator('#app')).toBeVisible();
  expect(await value(page, 'tempo')).toBe(55);
  await expect.poll(() => titles(page)).toEqual(before);
});

test('the list is in rank order in the DOM, with ranks 1 to n, however it was re-ranked', async ({ page }) => {
  await open(page);
  // The ▶ took the rank number's place (6A decision 3), so a row's position is data-rank; the <ol> says it to a screen reader.
  const check = async () => {
    const ranks = await rows(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-rank')));
    expect(ranks).toEqual(ranks.map((_, i) => String(i + 1)));
  };
  await check();
  await pressKey(page, 'tempo', 'ArrowRight', 7);
  await expect.poll(async () => (await titles(page)).slice(0, 3)).not.toEqual(DEFAULT_RANKING.slice(0, 3));
  await check();
  await eraButton(page, 's80').click();
  await check();
  await resetButton(page, 'popularity').click();
  await check();
});

test.describe('rows move with the list', () => {
  test.use({ contextOptions: { reducedMotion: 'no-preference' } });

  test('a re-rank slides the rows that moved', async ({ page }) => {
    await open(page);
    // Count the slides: an animation on a row that moves its transform.
    await page.evaluate(() => {
      const w = window as unknown as { slides: number };
      w.slides = 0;
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
        if (this.hasAttribute('data-row') && Array.isArray(keyframes) && keyframes[0] && 'transform' in keyframes[0]) w.slides += 1;
        return animate.call(this, keyframes, options);
      };
    });
    await pressKey(page, 'tempo', 'ArrowRight', 5);
    await expect.poll(() => page.evaluate(() => (window as unknown as { slides: number }).slides)).toBeGreaterThan(0);
    // The order is right at once; the motion is only how it gets there.
    expect((await titles(page)).length).toBe(25);
  });

  test("the slide's curve is the browser's own ease, so an interrupted slide can be resumed exactly", async ({ page }) => {
    await open(page);
    const points = [0.1, 0.25, 0.5, 0.75, 0.9];
    const browser = await page.evaluate(
      ({ ps, ms }) => {
        const el = document.createElement('div');
        document.body.appendChild(el);
        const a = el.animate([{ transform: 'translateY(100px)' }, { transform: 'translateY(0)' }], { duration: ms, easing: 'ease', fill: 'both' });
        a.pause();
        const out = ps.map((p) => {
          a.currentTime = p * ms;
          return a.effect!.getComputedTiming().progress as number;
        });
        el.remove();
        return out;
      },
      { ps: points, ms: SLIDE_MS },
    );
    points.forEach((p, i) => expect(browser[i]).toBeCloseTo(easeProgress(p), 2));
  });

  test('a slide that is interrupted starts again from where the row was seen, not from where it was laid out', async ({ page }) => {
    await open(page);
    // The slider is dragged, so the list is re-ranked again while the rows are still sliding to the last order. React
    // moves a row by moving its node, which ends any animation running on it, so each row's next slide has to start from
    // where the row was on screen, or it jumps back and slides on from there. Time is frozen to make that exact: every
    // slide is stopped 100 ms in, and the clock the screen reads is set to match, so where each row is seen is known.
    const result = await page.evaluate(async () => {
      type Hook = { getState(): { off: string[] }; setState(patch: object): void };
      const set = (window as unknown as { setlist: Hook }).setlist;
      let clock = 1000;
      performance.now = () => clock;
      const ol = document.getElementById('list')!;
      const rows = () => [...ol.querySelectorAll<HTMLElement>('[data-row]')];
      const order = () => rows().map((r) => r.dataset.id).join('|');
      const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const slides = () =>
        document.getAnimations().filter((a) => {
          const effect = a.effect as KeyframeEffect | null;
          return effect?.target instanceof HTMLElement && effect.target.hasAttribute('data-row') && 'transform' in (effect.getKeyframes()[0] ?? {});
        });

      set.setState({ off: set.getState().off.filter((p) => p !== 'tempo'), tempo: 0 }); // the first re-rank
      for (let i = 0; i < 60 && slides().length === 0; i++) await nextFrame();
      for (const a of slides()) {
        a.pause();
        a.currentTime = 100;
      }
      clock = 1100;
      const seen = new Map(rows().map((r) => [r.dataset.id!, r.getBoundingClientRect().top]));
      const orderBefore = order();
      set.setState({ tempo: 100 }); // the second, in the middle of them
      for (let i = 0; i < 60 && order() === orderBefore; i++) await nextFrame();

      const base = ol.getBoundingClientRect().top;
      const view = document.getElementById('list-scroll')!.getBoundingClientRect();
      const off: number[] = [];
      for (const a of slides()) {
        if (a.playState === 'paused') continue; // a slide the screen has not replaced
        const effect = a.effect as KeyframeEffect;
        const el = effect.target as HTMLElement;
        const start = Number(/translateY\((-?[\d.]+)px\)/.exec(String((effect.getKeyframes()[0] as { transform?: string }).transform))![1]);
        const startsAt = base + el.offsetTop + start; // where the row is on screen when its new slide begins
        const was = seen.get(el.dataset.id!);
        if (was !== undefined && was >= view.top - 66 && was <= view.bottom) off.push(Math.abs(startsAt - was));
      }
      return { reRanked: order() !== orderBefore, slides: off.length, off: Math.max(0, ...off) };
    });
    expect(result.reRanked).toBe(true);
    expect(result.slides).toBeGreaterThan(3);
    // Exactly where it was seen: a row that forgot its slide in flight would start from where it was laid out, tens of px away.
    expect(result.off).toBeLessThan(1);
  });
});

test('a long title is cut with an ellipsis and never pushes the badge or the ▶ out of the row', async ({ page }) => {
  const extra: MockSong[] = [
    { title: 'Girls Just Want to Have Fun (2022 Remastered Deluxe Anniversary Edition)', artist: 'Cyndi Lauper and Her Very Long Named Friends', era: 's80', difficulty: 20, history: 50, popularity: 100, tempo: 50 },
  ];
  await open(page, { extra });
  const long = rows(page).filter({ hasText: 'Girls Just Want to Have Fun' });
  await expect(long).toHaveCount(1);
  const m = await long.evaluate((li) => {
    const row = li.getBoundingClientRect();
    const title = li.querySelector('[data-row-title]') as HTMLElement;
    const text = li.querySelector('[data-row-text]')!.getBoundingClientRect();
    const play = li.querySelector('[data-play-slot]')!.getBoundingClientRect();
    const badge = li.querySelector('[data-badge]')!.getBoundingClientRect();
    return {
      rowLeft: row.left,
      rowRight: row.right,
      rowW: li.clientWidth,
      rowScroll: li.scrollWidth,
      titleCut: title.scrollWidth > title.clientWidth,
      play: { left: play.left, right: play.right, w: play.width },
      text: { left: text.left, right: text.right },
      badge: { left: badge.left, right: badge.right },
    };
  });
  expect(m.titleCut).toBe(true);
  expect(m.rowScroll).toBeLessThanOrEqual(m.rowW);
  // ▶ · text · badge, 10 px apart, the ▶ at the row's start and the badge at its end.
  expect(m.play.left).toBeCloseTo(m.rowLeft, 0);
  expect(m.play.w).toBe(44);
  expect(m.text.left).toBeCloseTo(m.play.right + 10, 0);
  expect(m.badge.left).toBeCloseTo(m.text.right + 10, 0);
  expect(m.badge.right).toBeLessThanOrEqual(m.rowRight + 0.5);
  await long.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SCREENS, 'setlist-long-title.png') });
});

test('there is room for "Can\'t Help Falling in Love" beside a Medium badge at 390 px: about 197 px for a 195 px title', async ({ page }) => {
  // The README measured 197 px of title room next to a Medium badge with the ▶ in the rank's place, and the title at 195 px.
  const extra: MockSong[] = [{ title: 'A Medium Song', artist: 'Someone', era: 's90', difficulty: 50, history: 50, popularity: 100, tempo: 50 }];
  await open(page, { extra });
  const m = await page.evaluate(async () => {
    await document.fonts.ready;
    const medium = [...document.querySelectorAll('[data-row]')].find((r) => r.querySelector('[data-badge]')?.textContent === 'Medium')!;
    const room = (medium.querySelector('[data-row-title]') as HTMLElement).getBoundingClientRect().width;
    const probe = document.createElement('span');
    probe.textContent = "Can't Help Falling in Love";
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:600 16px ${getComputedStyle(medium).fontFamily}`;
    document.body.appendChild(probe);
    const title = probe.getBoundingClientRect().width;
    probe.remove();
    return { room, title };
  });
  expect(m.room).toBeGreaterThanOrEqual(195);
  expect(m.room).toBeLessThanOrEqual(199);
  expect(m.title).toBeLessThanOrEqual(m.room);
});

test('events: a gear and an era are recorded when they change, with the gear and its value', async ({ page }) => {
  const { events } = await open(page);
  await pressKey(page, 'tempo', 'ArrowRight', 3);
  await resetButton(page, 'difficulty').click();
  await eraButton(page, 's80').click();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => events.map((e) => e.name)).toEqual(expect.arrayContaining(['gear_change', 'era_change']));
  const gear = events.filter((e) => e.name === 'gear_change');
  expect(gear.map((e) => e.props?.gear)).toEqual(expect.arrayContaining(['tempo', 'difficulty']));
  // Each key step is one adjustment, so three steps are three records, each on at the value it reached.
  const tempo = gear.filter((e) => e.props?.gear === 'tempo').map((e) => e.props);
  expect(tempo.map((p) => p?.value)).toEqual([DEFAULTS.tempo + 1, DEFAULTS.tempo + 2, DEFAULTS.tempo + 3]);
  expect(tempo.every((p) => p?.on === true)).toBe(true);
  expect(gear.find((e) => e.props?.gear === 'difficulty')?.props).toMatchObject({ value: DEFAULTS.difficulty, on: false });
  expect(events.find((e) => e.name === 'era_change')?.props).toMatchObject({ era: 's80', picked: true, on: true });
  // No song or Spotify id in any of them.
  expect(JSON.stringify(events)).not.toMatch(/trackId|spotify/i);
});

// ---- touch (Chromium drives touch through DevTools) ----

test('touch: a drag on the handle resizes the sheet and neither scrolls the page nor the list', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'touch is driven through Chromium DevTools');
  await open(page, { mini: true });
  await page.locator('#list-scroll').evaluate((el) => el.scrollTo(0, 120));
  const listBefore = await page.locator('#list-scroll').evaluate((el) => el.scrollTop);
  const from = await centre(handle(page));
  await touchDrag(page, from, -90);
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'expanded');
  expect((await rack(page)).height).toBe(416);
  const scrolled = await page.evaluate(() => ({ y: scrollY, doc: document.scrollingElement?.scrollTop ?? 0, app: document.getElementById('app')!.scrollTop }));
  expect(scrolled).toEqual({ y: 0, doc: 0, app: 0 });
  expect(await page.locator('#list-scroll').evaluate((el) => el.scrollTop)).toBe(listBefore);
  // And back down, the same way.
  await touchDrag(page, await centre(handle(page)), 90);
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
});

test('touch: a swipe on the list scrolls the list, not the page', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'touch is driven through Chromium DevTools');
  await open(page);
  const box = (await page.locator('#list-scroll').boundingBox())!;
  await touchDrag(page, { x: box.x + 150, y: box.y + box.height - 20 }, -200);
  await expect.poll(() => page.locator('#list-scroll').evaluate((el) => el.scrollTop)).toBeGreaterThan(50);
  expect(await page.evaluate(() => scrollY)).toBe(0);
});

test('touch: dragging along a slider moves its thumb without moving the sheet or the page', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'touch is driven through Chromium DevTools');
  await open(page);
  const cdp = await page.context().newCDPSession(page);
  const a = await onTrack(page, 'tempo', 0.3);
  const b = await onTrack(page, 'tempo', 0.75);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y }] });
  for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + ((b.x - a.x) * i) / 10, y: a.y - i * 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  expect(Math.abs((await value(page, 'tempo')) - 75)).toBeLessThanOrEqual(3);
  await expect(strip(page, 'tempo')).not.toHaveAttribute('data-off', /.*/);
  expect((await rack(page)).height).toBe(416);
  expect(await page.evaluate(() => scrollY)).toBe(0);
});

// ---- which mode a phone opens in (QWW-57, Quinn-Wai's decision 1) ----
//
// Mini whenever the expanded sheet would leave fewer than 3 whole rows; 390x844 still opens expanded. Where the expanded
// sheet cannot fit inside the screen at all (a 375x553, an iPhone SE with Safari's bars), the handle keeps it mini. The list
// heights are chief-keef's measurements of the reference with the real defaults (11 Nov): the TV frame's numbers have to add
// up to them, so they are asserted exactly (one pixel of slack).

/** The list's height and how many whole rows fit in it at the top, and whether any part of the sheet is cut off. */
const listBox = (page: Page) =>
  page.evaluate(() => {
    const list = document.getElementById('list-scroll')!.getBoundingClientRect();
    const rowEls = [...document.querySelectorAll('[data-row]')];
    const whole = rowEls.filter((r) => {
      const b = r.getBoundingClientRect();
      return b.top >= list.top - 0.5 && b.bottom <= list.bottom + 0.5;
    }).length;
    const inner = document.getElementById('app')!.parentElement!.getBoundingClientRect();
    const sheet = document.getElementById('sheet')!.getBoundingClientRect();
    const rackEl = document.getElementById('rack')!;
    return {
      list: Math.round(list.height),
      whole,
      sheetClipped: Math.max(0, Math.round(sheet.bottom - inner.bottom)),
      rackClipped: rackEl.scrollHeight > rackEl.clientHeight,
    };
  });

type ListBox = Awaited<ReturnType<typeof listBox>>;

const PHONES = [
  { w: 390, h: 844, opens: 'expanded', expanded: 226, expandedRows: 3, mini: 478, miniRows: 7 },
  { w: 390, h: 664, opens: 'mini', expanded: 46, expandedRows: 0, mini: 298, miniRows: 4 },
  { w: 412, h: 780, opens: 'mini', expanded: 162, expandedRows: 2, mini: 414, miniRows: 6 },
] as const;

for (const phone of PHONES) {
  test.describe(`a ${phone.w}x${phone.h} phone`, () => {
    test.use({ viewport: { width: phone.w, height: phone.h } });

    test(`opens in ${phone.opens}; the list is ${phone.expanded} px with the sheet expanded and ${phone.mini} px in mini, and nothing of the sheet is cut off`, async ({ page }) => {
      await open(page);
      await expect(page.locator('#app')).toHaveAttribute('data-mode', phone.opens);
      const first = await listBox(page);
      expect(first.sheetClipped, 'nothing of the sheet is clipped at first load').toBe(0);
      expect(first.rackClipped).toBe(false);
      const other = phone.opens === 'expanded' ? 'mini' : 'expanded';
      // The list in each mode, measured by switching the sheet with the handle.
      const measured: Partial<Record<'expanded' | 'mini', ListBox>> = { [phone.opens]: first };
      await page.screenshot({ path: path.join(SCREENS, `setlist-${phone.w}x${phone.h}-${phone.opens}.png`) });
      await handle(page).click();
      await expect(page.locator('#app')).toHaveAttribute('data-mode', other);
      await expect.poll(async () => (await rack(page)).height).toBe(other === 'mini' ? 164 : 416);
      measured[other] = await listBox(page);
      expect(Math.abs(measured.expanded!.list - phone.expanded), `expanded list ${measured.expanded!.list}`).toBeLessThanOrEqual(1);
      expect(Math.abs(measured.mini!.list - phone.mini), `mini list ${measured.mini!.list}`).toBeLessThanOrEqual(1);
      expect(measured.expanded!.whole).toBe(phone.expandedRows);
      expect(measured.mini!.whole).toBe(phone.miniRows);
      expect(measured.expanded!.sheetClipped, 'the expanded sheet fits').toBe(0);
      expect(measured.mini!.sheetClipped).toBe(0);
      await page.screenshot({ path: path.join(SCREENS, `setlist-${phone.w}x${phone.h}-${other}.png`) });
    });

    if (phone.opens === 'mini') {
      test('shows at least 4 whole rows at first load, which is what mini is for', async ({ page }) => {
        await open(page);
        expect((await listBox(page)).whole).toBeGreaterThanOrEqual(4);
      });
    }

    test('expanded is one drag up, and stays as the singer left it through a song and back', async ({ page }) => {
      await open(page);
      await dragHandle(page, -80);
      await expect(page.locator('#app')).toHaveAttribute('data-mode', 'expanded');
      expect((await rack(page)).height).toBe(416);
      await openButton(rows(page).first()).click();
      await expect(page.getByRole('button', { name: 'Back to songs' })).toBeVisible();
      await page.getByRole('button', { name: 'Back to songs' }).click();
      await expect(page.locator('#app')).toHaveAttribute('data-mode', 'expanded');
    });
  });
}

test.describe("a 375x553 phone (an iPhone SE with Safari's bars)", () => {
  test.use({ viewport: { width: 375, height: 553 } });

  test('opens in mini, the expanded sheet does not fit, and the handle keeps it in mini', async ({ page }) => {
    await open(page);
    await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
    const m = await listBox(page);
    expect(Math.abs(m.list - 187)).toBeLessThanOrEqual(1);
    expect(m.whole).toBe(2);
    expect(m.sheetClipped).toBe(0);
    expect(m.rackClipped).toBe(false);
    await expect(handle(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(handle(page)).toHaveAttribute('aria-expanded', 'false');
    // A tap, Enter and a drag up all leave it in mini. (aria-disabled is a state Playwright will not click through, so force it.)
    await handle(page).click({ force: true });
    await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
    await handle(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
    await dragHandle(page, -120, async () => {
      expect((await page.locator('#rack').boundingBox())!.height).toBeLessThanOrEqual(164);
    });
    await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
    expect((await rack(page)).height).toBe(164);
    expect((await listBox(page)).sheetClipped).toBe(0);
    await page.screenshot({ path: path.join(SCREENS, 'setlist-375x553-mini.png') });
  });

  test('still has every tab, and each gear can be tuned from the mini sheet', async ({ page }) => {
    await open(page);
    for (const g of ['difficulty', 'history', 'popularity', 'tempo', 'era'] as TunerPart[]) await expect(tab(page, g)).toBeVisible();
    await tab(page, 'popularity').click();
    await expect(strip(page, 'popularity')).toBeVisible();
    expect((await listBox(page)).sheetClipped).toBe(0);
  });
});

test.describe('a phone turned on its side, 844x390', () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test('keeps the sheet in mini: the expanded sheet cannot fit', async ({ page }) => {
    await open(page);
    await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
    await expect(handle(page)).toHaveAttribute('aria-disabled', 'true');
    expect((await listBox(page)).sheetClipped).toBe(0);
  });
});

test('turning a phone on its side while the sheet is expanded keeps it from being cut off: it is shown in mini', async ({ page }) => {
  await open(page);
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'expanded');
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
  expect((await listBox(page)).sheetClipped).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  // Back upright, the sheet can expand again, and the singer's own choice (expanded) is what they find.
  await expect(handle(page)).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'expanded');
});

// ---- the header (6A §3.4; QWW-57, decisions 4 and the hit areas) ----

/**
 * The header row's parts, in page pixels; the sign is null while it is hidden (R1: `visibility: hidden`, so it can be measured again), and
 * `signSize` is its font size in px (16, or less when it shrinks to keep 8 px clear). The sign is measured again when the fonts arrive, so
 * this waits for them and for the frame that measure lands in.
 */
const headerBox = (page: Page) =>
  page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const bar = document.querySelector('#app header > div') as HTMLElement;
    const box = (e: Element | null) => {
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom };
    };
    const sign = bar.querySelector('[lang="ja"]') as HTMLElement;
    const heading = document.querySelector('#app header h1') as HTMLElement;
    const signStyle = getComputedStyle(sign);
    return {
      bar: box(bar),
      range: box(bar.querySelector('[role="group"]')),
      redo: box(bar.querySelector('button[aria-label="Redo the range test"]')),
      sign: signStyle.display === 'none' || signStyle.visibility === 'hidden' ? null : box(sign),
      signSize: Number.parseFloat(signStyle.fontSize),
      spotify: box(bar.querySelector('button[aria-label="Connect to Spotify"], button[aria-label="Spotify account"]')),
      heading: { ...box(heading)!, cut: heading.scrollWidth > heading.clientWidth, fontSize: getComputedStyle(heading).fontSize },
    };
  });

// The heading is 24/30 700 at every width now (6A §3.2), and it sits below the 28 px row, so no range can cut it. A range of
// sharps (D#2 to D#5) has the longest note names.
for (const width of [360, 375, 390]) {
  test(`${width} px wide: the header row is 28 px with the range, redo, the sign and the Spotify logo in it, and the heading below is 24 px and not cut`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    await open(page, { range: { low: 39, high: 75 } });
    await expect(page.locator('#app header')).toContainText('D#2');
    const h = await headerBox(page);
    expect(h.bar!.h).toBe(28);
    expect(h.heading.fontSize).toBe('24px');
    expect(h.heading.cut).toBe(false);
    expect(h.heading.y).toBeGreaterThanOrEqual(h.bar!.b + 8 - 0.5);
    // Range, redo and the logo are whole, in order, and inside the row, whether or not the sign fits.
    expect(h.range!.r).toBeLessThanOrEqual(h.redo!.x);
    expect(h.redo!.r).toBeLessThanOrEqual(h.spotify!.x);
    expect(h.spotify!.r).toBeLessThanOrEqual(h.bar!.r + 0.5);
    expect(h.redo!.h).toBe(28);
  });
}

test('the Spotify logo is at the far right of the row, and the カラオケ sign is on the row\'s own middle, not in the room between redo and the logo (R1)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await open(page, { range: { low: 41, high: 69 } }); // F2 to A4: not the shortest range
  const h = await headerBox(page);
  expect(h.sign).not.toBeNull();
  expect(h.spotify!.r).toBeGreaterThan(h.bar!.r - 6);
  // The sign's middle is the row's middle, within a pixel: 6A centred it in the room between redo and the logo, which is not.
  const middle = h.bar!.x + h.bar!.w / 2;
  expect(Math.abs(h.sign!.x + h.sign!.w / 2 - middle)).toBeLessThanOrEqual(1);
  const room = (h.redo!.r + h.spotify!.x) / 2;
  expect(Math.abs(room - middle), 'the room between redo and the logo is not the row\'s middle, so this test tells the two apart').toBeGreaterThan(8);
  // And it still keeps 8 px clear of both neighbours.
  expect(h.sign!.x).toBeGreaterThanOrEqual(h.redo!.r + 8);
  expect(h.sign!.r).toBeLessThanOrEqual(h.spotify!.x - 8);
});

test('when the row is too tight, the sign gives way first: it shrinks to keep 8 px clear of redo and the logo, goes when even 13 px does not fit, and nothing else shrinks', async ({ page }) => {
  // The longest range, C#2 to G#5, in a 330 px window (R14's round redo gave a 360 px phone the room back): the sign at the row's
  // middle has no room even at 13 px, so it is hidden.
  await page.setViewportSize({ width: 330, height: 740 });
  await open(page, { range: { low: 37, high: 80 } });
  await expect.poll(async () => (await headerBox(page)).sign).toBeNull();
  const tight = await headerBox(page);
  expect(tight.bar!.h).toBe(28);
  expect(tight.range!.r).toBeLessThanOrEqual(tight.redo!.x);
  expect(tight.redo!.r).toBeLessThanOrEqual(tight.spotify!.x);
  // A little more room (350 px): the sign is back, smaller than 16 px, clear of both by 8 px.
  await page.setViewportSize({ width: 350, height: 740 });
  await expect.poll(async () => (await headerBox(page)).sign !== null).toBe(true);
  const snug = await headerBox(page);
  expect(snug.signSize).toBeLessThan(16);
  expect(snug.signSize).toBeGreaterThanOrEqual(13);
  expect(snug.sign!.x - snug.redo!.r).toBeGreaterThanOrEqual(8);
  expect(snug.spotify!.x - snug.sign!.r).toBeGreaterThanOrEqual(8);
  // Roomier again (a phone turned, a bigger phone): the sign is back at full size, clear of both by 8 px.
  await page.setViewportSize({ width: 430, height: 740 });
  await expect.poll(async () => (await headerBox(page)).signSize).toBe(16);
  const roomy = await headerBox(page);
  expect(roomy.sign).not.toBeNull();
  expect(roomy.sign!.x - roomy.redo!.r).toBeGreaterThanOrEqual(8);
  expect(roomy.spotify!.x - roomy.sign!.r).toBeGreaterThanOrEqual(8);
  // Through all three, redo, the range and the logo are what they were: only the sign gave way.
  const widths = (h: typeof tight) => ({ redo: h.redo!.w, range: h.range!.w, spotify: h.spotify!.w });
  expect(widths(snug)).toEqual(widths(tight));
  expect(widths(roomy)).toEqual(widths(tight));
});

test('the range notes and redo look as they did and are 44 px tall to tap', async ({ page }) => {
  await open(page);
  const targets = [
    page.getByRole('button', { name: 'Redo your low note, A2' }),
    page.getByRole('button', { name: 'Redo your high note, C5' }),
    page.getByRole('button', { name: 'Redo the range test' }),
  ];
  for (const target of targets) {
    const b = (await target.boundingBox())!;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    // 20 px above and below the centre still lands on the button: a 44 px target (22 px each way).
    const hits = await page.evaluate(
      ({ x, y }) => [-20, 20].map((dy) => document.elementFromPoint(x, y + dy)?.closest('button')?.getAttribute('aria-label') ?? null),
      { x: cx, y: cy },
    );
    const name = await target.getAttribute('aria-label');
    expect(hits, String(name)).toEqual([name, name]);
  }
  // Their look: redo is 28 px tall with a 1 px outline; the notes have a 1 px dotted underline and no box.
  expect((await targets[2]!.boundingBox())!.height).toBe(28);
  const note = page.locator('#app header [role="group"] button').first().locator('span');
  expect(await note.evaluate((el) => getComputedStyle(el).borderBottomStyle)).toBe('dotted');
});

test('signed in, the Spotify account sits where Connect does: far right, with the name and Log out', async ({ page }) => {
  await open(page, { loggedIn: true });
  const h = await headerBox(page);
  expect(h.spotify!.r).toBeGreaterThan(h.bar!.r - 6);
  await page.getByRole('button', { name: 'Spotify account' }).click();
  await expect(page.getByText('Logged in as Quinn')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
});

// ============================================================================================================
// Round 6A: README §12, new tests 22 to 32, for the real defaults and the real data
// ============================================================================================================

/** What the reference's viewModel() would draw for the real defaults, signed out: the top 4 of the 25 mock songs. */
const TOP_ROWS = [
  { title: 'Mr. Brightside', why: 'Gets the room moving', badge: 'Medium' },
  { title: "Don't Stop Believin'", why: 'Crowd favourite', badge: 'Hard' },
  { title: 'Dancing Queen', why: 'Solid pick', badge: 'Medium' },
  { title: 'Bohemian Rhapsody', why: 'Crowd favourite', badge: 'Hard' },
];

test('22. row geometry: ranks 1, 2, 3 at top 0, 66, 132; every row 66 px tall; the list as tall as its rows', async ({ page }) => {
  await open(page);
  const m = await page.evaluate(() => {
    const list = document.getElementById('list')!;
    const rowEls = [...list.querySelectorAll<HTMLElement>('[data-row]')];
    return {
      tops: rowEls.slice(0, 3).map((r) => [r.dataset.rank, r.offsetTop]),
      heights: [...new Set(rowEls.map((r) => r.getBoundingClientRect().height))],
      count: rowEls.length,
      list: list.getBoundingClientRect().height,
    };
  });
  expect(m.tops).toEqual([['1', 0], ['2', 66], ['3', 132]]);
  expect(m.heights).toEqual([66]);
  expect(m.list).toBe(m.count * 66);
  // Filtering removes rows (they do not fade out in place): the list is as tall as the rows that are left.
  await eraButton(page, 's80').click();
  await expect(rows(page)).toHaveCount(4);
  expect(await page.locator('#list').evaluate((el) => el.getBoundingClientRect().height)).toBe(4 * 66);
});

test('23. the default rows: title, reason line and badge of the top 4 for the real defaults, and no row has the lyric wipe (R12 took it away)', async ({ page }) => {
  await open(page);
  await expect.poll(async () => (await titles(page)).slice(0, 4)).toEqual(TOP_ROWS.map((r) => r.title));
  const top = await rows(page).evaluateAll((els) =>
    els.slice(0, 4).map((el) => ({
      title: el.querySelector('[data-row-title]')?.textContent,
      why: el.querySelector('[data-row-why]')?.textContent,
      badge: el.querySelector('[data-badge]')?.textContent,
    })),
  );
  expect(top).toEqual(TOP_ROWS);
  // R12 took the looping #1 wipe away: no row carries it. Each title fills in once as its row scrolls into view instead
  // (tests/e2e/setlist-rows.spec.ts). The copy that fill draws is made by CSS from data-fill-text, so the title is in the page
  // once: it is read, found and copied once.
  await expect(page.locator('[data-wipe]')).toHaveCount(0);
  expect(await page.locator('[data-row-title]').evaluateAll((els) => els.every((el) => el.closest('[data-fill-text]')?.getAttribute('data-fill-text') === el.textContent))).toBe(true);
  await expect(page.getByText(TOP_ROWS[0]!.title, { exact: true })).toHaveCount(1);
  await page.screenshot({ path: path.join(SCREENS, 'setlist-23-rows.png') });
});

test('23b. the #1 spot has no mark of its own any more (R12): when the ranking changes, still no row has a wipe, and the new #1 is just the first row', async ({ page }) => {
  await open(page);
  const first = async () => rows(page).first().locator('[data-row-title]').textContent();
  expect(await first()).toBe('Mr. Brightside');
  await expect(page.locator('[data-wipe]')).toHaveCount(0);
  await pressKey(page, 'tempo', 'ArrowLeft', 40); // Tempo on, toward Slow jams: another song comes first
  await expect.poll(first).not.toBe('Mr. Brightside');
  await expect(page.locator('[data-wipe]')).toHaveCount(0);
  expect(await rows(page).first().getAttribute('data-rank')).toBe('1');
});

test('24. the song count is the screen header\'s, not the Era panel\'s (R19): the panel says "OFF · all eras" with Era off and just "ERA" with it on, and the header counts the total, with a thousands comma', async ({ page }) => {
  // 1,200 more songs in the 90s, so the total (1,204 with the four mock ones) is far past the 200 the screen asks for.
  const extra: MockSong[] = Array.from({ length: 1200 }, (_, i) => ({
    title: `Extra song ${i}`,
    artist: `Extra artist ${i % 17}`,
    era: 's90',
    difficulty: i % 101,
    history: (i * 7) % 101,
    popularity: (i * 13) % 101,
    tempo: (i * 29) % 101,
  }));
  await open(page, { extra });
  const count = page.locator('[data-song-count]');
  await expect(page.locator('#era-label')).toHaveText('ERA · OFF · all eras');
  await expect(count).toHaveText('1,225 songs'); // Era off: every song that fits, the 25 mock songs and the 1,200
  await eraButton(page, 's90').click();
  await expect(count).toHaveText('1,204 songs');
  await expect(page.locator('#era-label')).toHaveText('ERA');
  // The list holds what was asked for, a page of 200; the count is the total, not the page.
  await expect.poll(() => rows(page).count()).toBeLessThanOrEqual(200);
  expect(await rows(page).count()).toBeLessThan(1204);
  await resetButton(page, 'era').click();
  await expect(page.locator('#era-label')).toHaveText('ERA · OFF · all eras');
  await expect(count).toHaveText('1,225 songs');
  await expect(page.locator('#era-panel')).not.toContainText('songs');
});

test('24b. one song says "1 song", in the header', async ({ page }) => {
  // For a range from 61 up only one 2020s song fits: good 4 u.
  await open(page, { range: { low: 61, high: 72 } });
  await eraButton(page, 's20').click();
  await expect(page.locator('[data-song-count]')).toHaveText('1 song');
  await expect(page.locator('#era-label')).toHaveText('ERA');
  await expect(rows(page)).toHaveCount(1);
});

test('25. Tempo, reset: its label is the raised grey, its metronome strokes are unlit, its pendulum is still; on, it is violet and swings', async ({ page }) => {
  await open(page);
  // Tempo starts off with the real defaults, so this is the reset state.
  const label = strip(page, 'tempo').locator('label');
  expect(await css(label, 'color')).toBe(OFF_TEXT);
  expect(await css(strip(page, 'tempo').locator('[data-offtag]'), 'color')).toBe(OFF_TEXT);
  expect(await css(strip(page, 'tempo').locator('svg path').first(), 'stroke')).toBe(UNLIT);
  expect(await css(strip(page, 'tempo').locator('[data-pendulum]'), 'animation-name')).toBe('none');
  // Not dimmed with opacity or a filter: an off gear looks like a switched-off sign, not a faded one.
  expect(await css(art(page, 'tempo'), 'opacity')).toBe('1');
  expect(await css(art(page, 'tempo'), 'filter')).toBe('none');
  // Turned on, it takes its colour.
  await pressKey(page, 'tempo', 'ArrowRight');
  expect(await css(label, 'color')).toBe(VIOLET);
  expect(await css(strip(page, 'tempo').locator('svg path').first(), 'stroke')).toBe(VIOLET);
  // And reset again, it goes grey again.
  await resetButton(page, 'tempo').click();
  expect(await css(label, 'color')).toBe(OFF_TEXT);
  expect(await css(strip(page, 'tempo').locator('svg path').first(), 'stroke')).toBe(UNLIT);
});

test('25b. an off gear\'s end labels are the raised grey too, and a gear that is on has its own colours', async ({ page }) => {
  await open(page);
  const ends = (gear: GearId) => strip(page, gear).locator('[data-ends]');
  expect(await css(ends('tempo'), 'color')).toBe(OFF_TEXT);
  expect(await css(ends('difficulty'), 'color')).toBe(TEXT_3);
  // Era: "ERA" itself is grey while it is off and pink on.
  expect(await css(page.locator('#era-label'), 'color')).toBe(OFF_TEXT);
  await eraButton(page, 's80').click();
  expect(await css(page.locator('#era-label'), 'color')).toBe(PINK);
});

test('26. the notes and bolts light by the thresholds: at History 65 five notes, at Popularity 80 six bolts, the rest drawn unlit and not gone (R7); at the real defaults, signed in (R31), the seven bolts and the seven notes are lit', async ({ page }) => {
  await open(page, { loggedIn: true });
  // R7: a note or bolt the value does not reach is drawn unlit at full opacity, not hidden, so all seven are always drawn (their
  // computed opacity is 1) and `data-lit` says which of them are lit. A gear that is off lights none.
  const state = (sel: string) =>
    page.locator(sel).evaluateAll((els) => ({
      drawn: els.filter((el) => getComputedStyle(el).opacity === '1').length,
      lit: els.filter((el) => el.getAttribute('data-lit') === 'true').length,
    }));
  // The real defaults, signed in, are History 100 and Popularity 100, both on (R31: History starts on when signed in): every bolt and every note is lit.
  expect(await state('[data-strip][data-gear="history"] [data-note]')).toEqual({ drawn: 7, lit: 7 });
  expect(await state('[data-strip][data-gear="popularity"] [data-bolt]')).toEqual({ drawn: 7, lit: 7 });
  await page.evaluate(() => (window as unknown as { setlist: { setState(p: object): void } }).setlist.setState({ history: 65, popularity: 80, off: ['tempo', 'era'] }));
  await expect.poll(() => state('[data-strip][data-gear="history"] [data-note]')).toEqual({ drawn: 7, lit: 5 });
  expect(await state('[data-strip][data-gear="popularity"] [data-bolt]')).toEqual({ drawn: 7, lit: 6 });
});

test('27. the Era tab\'s jukebox (R24): Era off is an unlit body with all three buttons grey; the picked eras light the left, middle and right buttons, the \'90s in the middle; the last era unpicked is Era off again', async ({ page }) => {
  await open(page, { mini: true });
  const body = tabArt(page, 'era').locator('[data-jukebox="body"]');
  const light = (i: number) => tabArt(page, 'era').locator(`[data-jukebox="button"][data-i="${i}"]`);
  const lights = async () => [await css(light(0), 'fill'), await css(light(1), 'fill'), await css(light(2), 'fill')];
  // Every gear reset (the real defaults: Era off): the body is unlit and all three buttons are the same grey, none pink.
  expect(await css(body, 'stroke')).toBe(UNLIT);
  expect(await lights()).toEqual([UNLIT, UNLIT, UNLIT]);
  // One era: the body is pink. The '80s is before the '90s, so the left button is lit, amber.
  await tab(page, 'era').click();
  await eraButton(page, 's80').click();
  expect(await css(body, 'stroke')).toBe(PINK);
  expect(await lights()).toEqual([AMBER, UNLIT, UNLIT]);
  // Two, both the '90s or earlier: left and middle.
  await eraButton(page, 's90').click();
  expect(await lights()).toEqual([AMBER, AMBER, UNLIT]);
  // Three: all three.
  await eraButton(page, 's10').click();
  expect(await lights()).toEqual([AMBER, AMBER, AMBER]);
  // Back down: the '80s and the '10s, one before and one after the '90s, light left and right; the '10s alone lights the right one.
  await eraButton(page, 's90').click();
  expect(await lights()).toEqual([AMBER, UNLIT, AMBER]);
  await eraButton(page, 's80').click();
  expect(await lights()).toEqual([UNLIT, UNLIT, AMBER]);
  // The last one unpicked is Era off (R23): the body goes unlit and all three buttons are grey, not pink.
  await eraButton(page, 's10').click();
  expect(await css(body, 'stroke')).toBe(UNLIT);
  expect(await lights()).toEqual([UNLIT, UNLIT, UNLIT]);
  // Picked again and turned off with the turn-off button: the same.
  await eraButton(page, 's90').click();
  expect(await lights()).toEqual([UNLIT, AMBER, UNLIT]);
  await resetButton(page, 'era').click();
  expect(await css(body, 'stroke')).toBe(UNLIT);
  expect(await lights()).toEqual([UNLIT, UNLIT, UNLIT]);
});

test.describe('motion', () => {
  test.use({ contextOptions: { reducedMotion: 'no-preference' } });

  test('28. Tempo 55: the tab\'s pendulum swings like the strip\'s (swing14, 0.45 s) and its weight is at y 9.9', async ({ page }) => {
    await open(page, { mini: true });
    await tab(page, 'tempo').click();
    await pressKey(page, 'tempo', 'ArrowRight', 5);
    expect(await value(page, 'tempo')).toBe(55);
    const stripPend = strip(page, 'tempo').locator('[data-pendulum]');
    const tabPend = tabArt(page, 'tempo').locator('[data-pendulum]');
    for (const pend of [stripPend, tabPend]) {
      expect(await css(pend, 'animation-name')).toBe('swing14');
      expect(await css(pend, 'animation-duration')).toBe('0.45s');
      expect(await css(pend, 'animation-iteration-count')).toBe('infinite');
      expect(await css(pend, 'animation-direction')).toBe('alternate');
    }
    expect(await tabArt(page, 'tempo').locator('[data-weight]').getAttribute('y')).toBe('9.9');
  });

  test('29. turning a reset gear back on (ArrowRight) plays the neon flicker once: neonOn, 0.7 s', async ({ page }) => {
    await open(page);
    // Tempo is off, so it does not flicker at first load (the gears that are on do, once: tests/e2e/setlist-flicker.spec.ts times that).
    expect(await css(art(page, 'tempo'), 'animation-name')).toBe('none');
    await pressKey(page, 'tempo', 'ArrowRight');
    expect(await css(art(page, 'tempo'), 'animation-name')).toBe('neonOn');
    expect(await css(art(page, 'tempo'), 'animation-duration')).toBe('0.7s');
    expect(await css(art(page, 'tempo'), 'animation-iteration-count')).toBe('1');
    // Reset puts the sign out: no animation on the art.
    await resetButton(page, 'tempo').click();
    expect(await css(art(page, 'tempo'), 'animation-name')).toBe('none');
  });

  test('29b. the flicker plays when a gear turns on, not on every nudge of a gear that is already on', async ({ page }) => {
    await open(page);
    await pressKey(page, 'tempo', 'ArrowRight');
    const animation = () => art(page, 'tempo').evaluate((el) => el.getAnimations().find((a) => (a as CSSAnimation).animationName === 'neonOn')?.currentTime ?? null);
    await page.waitForTimeout(800); // longer than the flicker: it is over
    expect(await animation()).toBeNull();
    await pressKey(page, 'tempo', 'ArrowRight', 3);
    // Nudging a gear that is on starts nothing.
    expect(await animation()).toBeNull();
  });

  test('the sign buzzes when motion is allowed, and nothing in the list loops: the #1 wipe is gone (R12; the titles\' one-time fill is tests/e2e/setlist-rows.spec.ts)', async ({ page }) => {
    await open(page);
    expect(await css(page.locator('[lang="ja"]'), 'animation-name')).not.toBe('none');
    expect(await css(page.locator('[lang="ja"]'), 'animation-duration')).toBe('3.2s');
    // The notes and bolts bob.
    expect(await css(strip(page, 'popularity').locator('[data-bolt] > *').first(), 'animation-name')).not.toBe('none');
    // The list has no looping animation of its own: no wipe, and nothing else that never ends.
    expect(await page.locator('[data-wipe]').count()).toBe(0);
    expect(await page.locator('#list-scroll').evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.effect?.getComputedTiming().iterations === Infinity).length)).toBe(0);
  });
});

test('30. with reduced motion, the pendulum, the bob, the sign\'s buzz, the titles\' fill and the art\'s flicker are all off', async ({ page }) => {
  await open(page);
  await pressKey(page, 'tempo', 'ArrowRight', 3); // so the pendulum would swing, and the flicker would play
  const names = {
    pendulum: await css(strip(page, 'tempo').locator('[data-pendulum]'), 'animation-name'),
    flicker: await css(art(page, 'tempo'), 'animation-name'),
    flickerDifficulty: await css(art(page, 'difficulty'), 'animation-name'),
    bob: await css(strip(page, 'popularity').locator('[data-bolt] > *').first(), 'animation-name'),
    noteBob: await css(strip(page, 'history').locator('[data-note] > *').first(), 'animation-name'),
    sign: await css(page.locator('[lang="ja"]'), 'animation-name'),
  };
  expect(names).toEqual({ pendulum: 'none', flicker: 'none', flickerDifficulty: 'none', bob: 'none', noteBob: 'none', sign: 'none' });
  // The titles show, white, with no fill drawn over them (R12: tests/e2e/setlist-rows.spec.ts has the rest).
  const colours = await page.locator('[data-row-title]').evaluateAll((els) => [...new Set(els.map((el) => getComputedStyle(el).color))]);
  expect(colours).toEqual([rgb('#F3EFF7')]);
  const copy = await page.locator('[data-fill-text]').first().evaluate((el) => getComputedStyle(el, '::after').content);
  expect(copy).not.toContain(await page.locator('[data-row-title]').first().innerText());
  const running = await page.locator('#app').evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length);
  expect(running).toBe(0);
});

test('31. the strip art is 120x64, and 140x75 in the mini sheet', async ({ page }) => {
  await open(page);
  const size = async (gear: GearId) => (await art(page, gear).boundingBox().then((b) => [Math.round(b!.width), Math.round(b!.height)]));
  for (const g of ['difficulty', 'history', 'popularity', 'tempo'] as GearId[]) expect(await size(g), `${g} expanded`).toEqual([120, 64]);
  await handle(page).click();
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
  expect(await size('difficulty')).toEqual([140, 75]);
  for (const g of ['history', 'popularity', 'tempo'] as GearId[]) {
    await tab(page, g).click();
    expect(await size(g), `${g} in mini`).toEqual([140, 75]);
  }
});

test('31b. the same, opened with ?mini=1', async ({ page }) => {
  await open(page, { mini: true });
  const b = (await art(page, 'difficulty').boundingBox())!;
  expect([Math.round(b.width), Math.round(b.height)]).toEqual([140, 75]);
});

test('32. no tab label has Japanese in it, and the カラオケ sign is decoration', async ({ page }) => {
  await open(page, { mini: true });
  const labels = await page.locator('[data-tab]').allTextContents();
  // R11: Listening History goes last of the four gears; its tab still says "History".
  expect(labels).toEqual(['Difficulty', 'Popularity', 'Tempo', 'History', 'Era']);
  for (const label of labels) expect(label).not.toMatch(/[぀-ヿ一-鿿]/);
  const sign = page.locator('[lang="ja"]');
  await expect(sign).toHaveText('カラオケ');
  await expect(sign).toHaveAttribute('aria-hidden', 'true');
  // One sign, and the heading is what a screen reader hears.
  await expect(page.getByText('カラオケ')).toHaveCount(1);
  expect(await page.getByRole('heading', { name: 'Tune your setlist' }).count()).toBe(1);
});

// "Pre-’70s" is 40 px wide in Inter at 6A's 10.5 px and its button is 35 to 42 px wide (a 360 px phone to the desktop frame), so the
// labels are sized to fit by the Era panel's width (sheet.module.css): the largest size that does, 9 px at 360 and 6A's own 10.5 px
// from about 405 px up. The desktop frame is in tests/e2e/setlist-sheet-fit.spec.ts.
test('the era labels fit their buttons without wrapping on every phone from 360 px, "Pre-’70s" included, as large as will fit', async ({ page }) => {
  await open(page); // 390x844 opens expanded, so the Era panel is on screen at every width below
  const sizes: number[] = [];
  for (const width of [360, 375, 390, 412, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator('#era-panel')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const fits = await page.locator('button[data-era]').evaluateAll((buttons) =>
      buttons
        .filter((b) => b.closest('#era-panel'))
        .map((b) => {
          const label = b.querySelector('span') as HTMLElement;
          const range = document.createRange();
          range.selectNodeContents(label);
          const text = range.getBoundingClientRect();
          const box = b.getBoundingClientRect();
          // Inside the button's 1 px borders, not just inside the box.
          const room = box.width - 2;
          return {
            name: label.textContent,
            lines: Math.round(text.height / parseFloat(getComputedStyle(label).lineHeight)),
            room: Math.round(room * 10) / 10,
            text: Math.round(text.width * 10) / 10,
            size: Number.parseFloat(getComputedStyle(label).fontSize),
            spills: text.left < box.left + 1 - 0.5 || text.right > box.right - 1 + 0.5,
          };
        }),
    );
    expect(fits, `${width} px`).toHaveLength(7);
    for (const f of fits) {
      expect(f.lines, `${width} px: ${f.name} wraps`).toBe(1);
      expect(f.spills, `${width} px: ${f.name}: ${f.text} px of text at ${f.size}px in a ${f.room} px button`).toBe(false);
    }
    sizes.push(fits[0]!.size);
  }
  // Never below 9 px, growing with the room, and 6A's own size where it fits.
  expect(sizes[0]).toBeGreaterThanOrEqual(9);
  expect([...sizes].sort((x, y) => x - y)).toEqual(sizes);
  expect(sizes.at(-1)).toBe(10.5);
});

test('the slot stands where the rank number was: first in the row, 44 px, 10 px before the text; on a touch screen it holds the ▶ in its circle, and the number is not drawn', async ({ page }) => {
  await open(page);
  // This context is a touch phone, which cannot hover: R3 puts the ▶ in the number's place there (tests/e2e/setlist-rows.spec.ts
  // has the pointer side, where the number shows and hovering the row swaps it for the ▶).
  expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
  const m = await rows(page).first().evaluate((li) => {
    const row = li.getBoundingClientRect();
    const slot = li.querySelector('[data-play-slot]')!.getBoundingClientRect();
    const text = li.querySelector('[data-row-text]')!.getBoundingClientRect();
    return { slotLeft: slot.left - row.left, slotW: slot.width, slotH: slot.height, gap: text.left - slot.right, firstChild: (li.firstElementChild as HTMLElement).hasAttribute('data-play-slot'), digits: /^\s*1\b/.test((li as HTMLElement).innerText) };
  });
  expect(m.firstChild).toBe(true);
  expect(m.slotLeft).toBeCloseTo(0, 0);
  expect([m.slotW, m.slotH]).toEqual([44, 44]);
  expect(m.gap).toBeCloseTo(10, 0);
  // The number is in the slot for a pointer device (and for data-rank's sake) but is not drawn here: what is read has no digit first.
  expect(m.digits).toBe(false);
  expect(await rows(page).first().locator('[data-rank-number]').textContent()).toBe('1');
  // The ▶ is in --pink-text with its thin circle round it (R17 replaced R3's "no ring or circle"; a song with no Deezer id has QWW-48's
  // button, disabled, and the circle is faded with the glyph). tests/e2e/setlist-rows.spec.ts and setlist-play.spec.ts read the circle in each state.
  expect(await css(rows(page).first().locator('[data-play-slot] button'), 'color')).toBe(rgb('#FF6FB1'));
  expect(await rows(page).first().locator('[data-play-slot] circle:visible').count()).toBeGreaterThan(0);
});

test('the badge is the song\'s own label, pink for all three, and a Maybe song has none', async ({ page }) => {
  await open(page);
  const badges = await page.locator('[data-badge]').evaluateAll((els) => els.map((el) => ({ text: el.textContent, color: getComputedStyle(el).color, border: getComputedStyle(el).borderTopColor, radius: getComputedStyle(el).borderTopLeftRadius, borderWidth: getComputedStyle(el).borderTopWidth })));
  expect(new Set(badges.map((b) => b.text))).toEqual(new Set(['Easy', 'Medium', 'Hard']));
  for (const b of badges) {
    expect(b).toMatchObject({ color: rgb('#FF6FB1'), border: rgb('#F0509A'), radius: '8px' });
    // 1.5 px in the stylesheet; a browser draws it in whole device pixels (1 px at 1x, 1.33 px at 3x).
    expect(Number.parseFloat(b.borderWidth)).toBeGreaterThanOrEqual(1);
    expect(Number.parseFloat(b.borderWidth)).toBeLessThanOrEqual(1.5);
  }
});

test('signed out, History is drawn as an off gear: unlit, no reset button, and its hint stands where the end labels would, in --text-3', async ({ page }) => {
  await open(page);
  const h = strip(page, 'history');
  await expect(h).toContainText('Connect Spotify to use your listening history');
  await expect(h).not.toContainText('Rediscover');
  await expect(h).not.toContainText('On repeat');
  await expect(resetButton(page, 'history')).toBeHidden();
  expect(await css(h.locator('[data-ends]'), 'color')).toBe(TEXT_3);
  expect(await css(h.locator('label'), 'color')).toBe(OFF_TEXT);
  expect(await css(h.locator('svg path').first(), 'stroke')).toBe(UNLIT);
  expect(await css(h.locator('[data-knob]'), 'background-color')).toBe(rgb('#1E1D24'));
  // The strip keeps its height with a two-line hint, and the rack does not overflow.
  expect(Math.round((await h.boundingBox())!.height)).toBe(76);
  expect(await rack(page)).toEqual({ height: 416, scroll: 416 });
});

test('the unreachable hint is the same: Spotify could not be reached, so listening history is off', async ({ page }) => {
  const events: AppEvent[] = [];
  await mockApi(page.context(), { loggedIn: true, events });
  // The library cannot be read: the server answers the setlist with catalogue songs and says so.
  await page.context().route('**/api/setlist', async (route) => {
    const body = setlistAnswer(mockPage({ idPrefix: 'cat:' }), route.request().postDataJSON() as SetlistRequest, false, { libraryUnavailable: true });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/');
  await expect(page.locator('#app [data-row]').first()).toBeVisible({ timeout: 20_000 });
  const h = strip(page, 'history');
  await expect(h).toContainText('Spotify could not be reached, so listening history is off');
  await expect(slider(page, 'history')).toBeDisabled();
  await expect(page.getByText('Couldn’t reach Spotify, showing popular songs.')).toBeVisible();
});

test('the other states of the list speak in 6A\'s quiet voice: 15/500 in --text-3', async ({ page }) => {
  await open(page);
  // Era on with nothing picked: unpicking the last era turns Era off now (R23), so the test hook sets it, as an old state would.
  await page.evaluate(() => (window as unknown as { setlist: { setState(p: object): void } }).setlist.setState({ off: ['history', 'tempo'], eras: [] }));
  const empty = page.locator('#empty');
  await expect(empty).toHaveText('Pick an era to see songs.');
  const style = await empty.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { size: cs.fontSize, weight: cs.fontWeight, color: cs.color, padding: `${cs.paddingTop} ${cs.paddingBottom}`, family: cs.fontFamily };
  });
  expect(style).toMatchObject({ size: '15px', weight: '500', color: TEXT_3, padding: '20px 20px' });
  expect(style.family).toContain('Inter');
});

test('the tuner is set in Inter, self-hosted, and the sign in Noto Sans JP', async ({ page }) => {
  await open(page);
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    const loaded = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family.replace(/"/g, '')} ${f.weight}`);
    return { loaded, body: getComputedStyle(document.getElementById('app')!).fontFamily, sign: getComputedStyle(document.querySelector('[lang="ja"]')!).fontFamily };
  });
  expect(fonts.body).toMatch(/^Inter/);
  expect(fonts.sign).toMatch(/Noto Sans JP/);
  expect(fonts.loaded.some((f) => f.startsWith('Inter'))).toBe(true);
  expect(fonts.loaded).toContain('Noto Sans JP 700');
  expect(fonts.loaded.some((f) => /barlow/i.test(f))).toBe(false);
  // Nothing is fetched from Google: every font is served by this origin.
  const external = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /googleapis|gstatic/.test(n)));
  expect(external).toEqual([]);
});

test('screenshots of the sheet in mini with the first gears off, for the review', async ({ page }) => {
  await open(page, { mini: true });
  await tab(page, 'popularity').click();
  await page.screenshot({ path: path.join(SCREENS, 'setlist-mini-popularity.png') });
  await resetButton(page, 'popularity').click();
  await page.screenshot({ path: path.join(SCREENS, 'setlist-mini-popularity-off.png') });
});

