// The Setlist tuner's acceptance tests: spec section 9, tests 1 to 21 (docs/setlist-round5/setlist-round5-spec.md), at
// 390x844, plus the ticket's other criteria: a drag on the handle does not scroll the page, the sheet does not cover
// the list's last row, the row opens the song page and the play button does not, short phones, long titles.
//
// The spec's expectations are for its mock defaults (Difficulty 30, History 65, Popularity 80, Tempo 45, everything on,
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
// `[data-parked]`, `#app.is-compact` is `#sheet[data-compact]`.

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AppEvent, EventsRequest, MeResponse, SetlistRequest, VocalRange } from '../../src/lib/contracts';
import { easeProgress, SLIDE_MS } from '../../src/components/setlist/flip';
import { DEFAULTS } from '../../src/lib/setlist/defaults';
import type { GearId, TunerPart, TunerState } from '../../src/lib/setlist/types';
import { setlistAnswer } from '../helpers/setlistServer';
import { MOCK_SONGS, mockPage, titlesOf, type MockSong } from '../fixtures/setlist';

const SCREENS = path.resolve('test-results/screens');
test.beforeAll(() => mkdirSync(SCREENS, { recursive: true }));

// A 390x844 touch phone. Motion is off unless a test is about motion (the Continue arrow and the list would never be
// "stable" for Playwright otherwise).
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });


/** The 25 songs ranked for the real defaults, signed out (see the header). */
const DEFAULT_RANKING = [
  'Mr. Brightside',
  "Don't Stop Believin'",
  'Dancing Queen',
  'Bohemian Rhapsody',
  'Sweet Caroline',
  'Rolling in the Deep',
  "Livin' on a Prayer",
  'Stand by Me',
  'I Will Always Love You',
  'I Want It That Way',
];
/** Test 18: every gear reset. The engine has nothing to rank by, so the songs come most popular first. */
const ALL_RESET_RANKING = [
  "Don't Stop Believin'", 'Bohemian Rhapsody', 'Mr. Brightside', 'Dancing Queen', 'Rolling in the Deep', "Livin' on a Prayer", 'I Will Always Love You',
  'Sweet Caroline', 'I Want It That Way', 'Africa', 'I Will Survive', 'good 4 u', 'Shallow', 'Stand by Me', 'Levitating', 'Wannabe',
  "Can't Help Falling in Love", 'Respect', 'Since U Been Gone', 'Valerie', "These Boots Are Made for Walkin'", 'Bizarre Love Triangle', 'Harvest Moon',
  'Motion Sickness', 'A Case of You',
];
/** Test 6: only the 80s, for the real defaults. */
const ONLY_80S = ["Don't Stop Believin'", "Livin' on a Prayer", 'Africa', 'Bizarre Love Triangle'];

const RANGE: VocalRange = { low: 45, high: 72, source: 'test' };
const ME: MeResponse = { userId: 'u1', displayName: 'Quinn', range: RANGE };

// ---- the mocked API and a way in ----

interface Opened {
  events: AppEvent[];
}

async function mockApi(context: BrowserContext, opts: { loggedIn: boolean; extra?: MockSong[]; events: AppEvent[] }) {
  const page = mockPage({ idPrefix: opts.loggedIn ? '' : 'cat:', extra: opts.extra });
  await context.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    switch (`${req.method()} ${url.pathname}`) {
      case 'GET /api/me':
        return opts.loggedIn ? json(ME) : json({ error: 'signed out' }, 401);
      case 'GET /api/recommendations':
      case 'GET /api/catalogue/recommendations':
        return json(page);
      case 'POST /api/setlist':
        return json(setlistAnswer(page, req.postDataJSON() as SetlistRequest, opts.loggedIn));
      case 'POST /api/events':
        opts.events.push(...(JSON.parse(req.postData() ?? '{"events":[]}') as EventsRequest).events);
        return route.fulfill({ status: 204 });
      case 'PUT /api/me/range':
      case 'POST /api/feedback':
      case 'POST /api/catalogue/feedback':
        return json({ ok: true });
      default:
        return json({ error: 'not mocked' }, 404);
    }
  });
}

/** Opens the tuner: signed out (the range kept on the device) or signed in (a saved range), mini when asked. */
async function open(page: Page, opts: { loggedIn?: boolean; mini?: boolean; extra?: MockSong[]; range?: { low: number; high: number } } = {}): Promise<Opened> {
  const { loggedIn = false, mini = false, extra, range = { low: 45, high: 72 } } = opts;
  const events: AppEvent[] = [];
  await mockApi(page.context(), { loggedIn, extra, events });
  if (!loggedIn) await page.context().addInitScript((saved) => localStorage.setItem('kd.range', JSON.stringify(saved)), range);
  await page.goto(mini ? '/?mini=1' : '/');
  await expect(page.locator('#app [data-row]').first()).toBeVisible({ timeout: 20_000 });
  return { events };
}

// ---- small readers ----

const rows = (page: Page) => page.locator('[data-row]');
const titles = (page: Page) => page.locator('[data-row-title]').allTextContents();
const strip = (page: Page, gear: GearId) => page.locator(`[data-strip][data-gear="${gear}"]`);
const tab = (page: Page, gear: TunerPart) => page.locator(`[data-tab][data-gear="${gear}"]`);
const eraButton = (page: Page, era: string) => page.locator(`button[data-era="${era}"]`);
const resetButton = (page: Page, gear: TunerPart) => page.locator(`button[data-reset="${gear}"]`);
const slider = (page: Page, gear: GearId) => page.locator(`#slider-${gear}`);
const handle = (page: Page) => page.locator('#handle');
const tuner = (page: Page) => page.evaluate(() => (window as unknown as { setlist: { getState(): TunerState } }).setlist.getState());
const rack = (page: Page) => page.locator('#rack').evaluate((el) => ({ height: el.clientHeight, scroll: el.scrollHeight }));
const value = async (page: Page, gear: GearId) => Number(await slider(page, gear).inputValue());

/** Where on a gear's track a fraction (0 to 1) is, in page pixels. The invisible slider starts 9 px before the track and ends 9 px after it. */
async function onTrack(page: Page, gear: GearId, fraction: number) {
  const box = (await slider(page, gear).boundingBox())!;
  return { x: box.x + 9 + (box.width - 18) * fraction, y: box.y + box.height / 2 };
}

async function pressKey(page: Page, gear: GearId, key: string, times = 1) {
  await slider(page, gear).focus();
  for (let i = 0; i < times; i++) await page.keyboard.press(key);
}

/** A mouse drag of the handle: down on it, up by `dy` px (negative = up) in a few steps; `during` runs before the button goes up. */
async function dragHandle(page: Page, dy: number, during?: () => Promise<void>) {
  const box = (await handle(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy / 2, { steps: 4 });
  await page.mouse.move(x, y + dy, { steps: 4 });
  await during?.();
  await page.mouse.up();
}

/** A touch drag through Chromium's DevTools, which raises the same touch and pointer events a finger does. */
async function touchDrag(page: Page, from: { x: number; y: number }, dy: number) {
  const cdp = await page.context().newCDPSession(page);
  const at = (y: number) => [{ x: from.x, y }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from.y) });
  for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(from.y + (dy * i) / 10) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const centre = async (loc: ReturnType<Page['locator']>) => {
  const b = (await loc.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

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

test('5. deselecting every era by hand leaves Era on with an empty list, the prompt and the reset button', async ({ page }) => {
  await open(page);
  // Era starts off with no picks. The first tap turns it on with just that era; tapping it again leaves nothing picked.
  await eraButton(page, 's90').click();
  expect((await tuner(page)).eras).toEqual(['s90']);
  expect(await rows(page).count()).toBeGreaterThan(0);
  await eraButton(page, 's90').click();
  await expect(page.locator('#empty')).toHaveText('Pick an era to see songs.');
  expect(await rows(page).count()).toBe(0);
  await expect(resetButton(page, 'era')).toBeVisible();
  expect((await tuner(page)).off).not.toContain('era');
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

  test('a gear that is off holds its art still', async ({ page }) => {
    await open(page);
    const animations = await strip(page, 'tempo').evaluate((el) =>
      el
        .getAnimations({ subtree: true })
        .filter((a): a is CSSAnimation => a instanceof CSSAnimation)
        .map((a) => a.playState),
    );
    expect(animations.length).toBeGreaterThan(0);
    expect(animations.every((s) => s === 'paused')).toBe(true);
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

test('13b. signed in, History starts off too, but it can be switched on', async ({ page }) => {
  await open(page, { loggedIn: true });
  await expect(page.locator('button[data-reset]:visible')).toHaveCount(2);
  await expect(strip(page, 'history')).toHaveAttribute('data-off', 'true');
  await expect(slider(page, 'history')).toBeEnabled();
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
  await expect(strip(page, 'history').locator('label')).toContainText('· OFF');
  const connect = page.getByRole('button', { name: 'Connect to Spotify' }).first();
  const box = (await connect.boundingBox())!;
  const heading = (await page.getByRole('heading', { name: 'Tune your setlist' }).boundingBox())!;
  expect(box.x).toBeGreaterThan(390 / 2); // the right half
  expect(box.y).toBeLessThan(heading.y + heading.height);
  // The tab is still there in mini, dimmed.
  await handle(page).click();
  await expect(tab(page, 'history')).toHaveAttribute('data-off', 'true');
});

test('the screen fills the viewport: no TV frame, no footer label, and the page itself never scrolls', async ({ page }) => {
  await open(page);
  const m = await page.evaluate(() => {
    const app = document.getElementById('app')!.getBoundingClientRect();
    return { w: Math.round(app.width), h: Math.round(app.height), docH: document.documentElement.scrollHeight, innerH: innerHeight, text: document.body.innerText };
  });
  expect(m.w).toBe(390);
  expect(m.h).toBe(844);
  expect(m.docH).toBe(m.innerH);
  expect(m.text.toLowerCase()).not.toContain('karaoke-dokie');
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
    // The last row and the credits link, at the very end, are above the handle's touch area (it reaches 11 px above the sheet) and receive their own taps.
    for (const target of [rows(page).last().locator('button').first(), page.getByRole('link', { name: 'Sources and credits' })]) {
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

  await rows(page).first().getByRole('button').first().click();
  await expect(page.getByRole('button', { name: 'Back to songs' })).toBeVisible();
  await expect(page.locator('#app')).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to songs' }).click();
  await expect(page.locator('#app')).toBeVisible();
  expect(await value(page, 'tempo')).toBe(55);
  await expect.poll(() => titles(page)).toEqual(before);
});

test('the list is in rank order in the DOM, with ranks 1 to n, however it was re-ranked', async ({ page }) => {
  await open(page);
  const check = async () => {
    const ranks = await rows(page).evaluateAll((els) => els.map((el) => [el.getAttribute('data-rank'), el.querySelector('[aria-hidden]')?.textContent]));
    expect(ranks).toEqual(ranks.map((_, i) => [String(i + 1), String(i + 1)]));
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
        if (was !== undefined && was >= view.top - 58 && was <= view.bottom) off.push(Math.abs(startsAt - was));
      }
      return { reRanked: order() !== orderBefore, slides: off.length, off: Math.max(0, ...off) };
    });
    expect(result.reRanked).toBe(true);
    expect(result.slides).toBeGreaterThan(3);
    // Exactly where it was seen: a row that forgot its slide in flight would start from where it was laid out, tens of px away.
    expect(result.off).toBeLessThan(1);
  });
});

test('a long title is cut with an ellipsis and never pushes the lane or the play button out of the row', async ({ page }) => {
  const extra: MockSong[] = [
    { title: 'Girls Just Want to Have Fun (2022 Remastered Deluxe Anniversary Edition)', artist: 'Cyndi Lauper and Her Very Long Named Friends', era: 's80', difficulty: 20, history: 50, popularity: 100, tempo: 50 },
  ];
  await open(page, { extra });
  const long = rows(page).filter({ hasText: 'Girls Just Want to Have Fun' });
  await expect(long).toHaveCount(1);
  const m = await long.evaluate((li) => {
    const row = li.getBoundingClientRect();
    const title = li.querySelector('[data-row-title]') as HTMLElement;
    const play = li.querySelector('[data-play-slot]')!.getBoundingClientRect();
    return { rowRight: row.right, rowW: li.clientWidth, rowScroll: li.scrollWidth, titleCut: title.scrollWidth > title.clientWidth, playRight: play.right, playW: play.width };
  });
  expect(m.titleCut).toBe(true);
  expect(m.rowScroll).toBeLessThanOrEqual(m.rowW);
  expect(m.playRight).toBeLessThanOrEqual(m.rowRight + 0.5);
  expect(m.playW).toBe(44);
  await long.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SCREENS, 'setlist-long-title.png') });
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

// ---- short phones (the review guide asks for these numbers) ----

test.describe('a short phone, 375x667', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('the sheet fits in both modes and the rows that are fully visible are counted', async ({ page }) => {
    await open(page);
    const visibleRows = () =>
      page.evaluate(() => {
        const box = document.getElementById('list-scroll')!.getBoundingClientRect();
        const whole = [...document.querySelectorAll('[data-row]')].filter((r) => {
          const b = r.getBoundingClientRect();
          return b.top >= box.top - 0.5 && b.bottom <= box.bottom + 0.5;
        }).length;
        return { listHeight: Math.round(box.height), whole };
      });
    expect(await rack(page)).toEqual({ height: 416, scroll: 416 });
    const expanded = await visibleRows();
    await page.screenshot({ path: path.join(SCREENS, 'setlist-375x667-expanded.png') });
    await handle(page).click();
    expect(await rack(page)).toEqual({ height: 164, scroll: 164 });
    const mini = await visibleRows();
    await page.screenshot({ path: path.join(SCREENS, 'setlist-375x667-mini.png') });
    console.log(`375x667: expanded leaves ${expanded.listHeight} px, ${expanded.whole} whole rows; mini leaves ${mini.listHeight} px, ${mini.whole} whole rows`);
    expect(mini.whole).toBeGreaterThan(expanded.whole);
    expect(mini.whole).toBeGreaterThanOrEqual(6);
    // The page itself never scrolls.
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(667);
  });
});

// ---- narrow phones ----

// The heading is the spec's 28 px from 375 px wide (an iPhone SE) up, and 24 px below that, where the range, "redo" and
// the Connect button beside it would cut it. A range of sharps (D#2 to D#5) has the longest note names.
for (const [width, size] of [
  [360, '24px'],
  [375, '28px'],
  [390, '28px'],
] as const) {
  test(`${width} px wide: the heading is ${size} and is not cut, even with a range of sharps`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    await open(page, { range: { low: 39, high: 75 } });
    await expect(page.locator('#app header')).toContainText('D#2');
    const title = page.getByRole('heading', { name: 'Tune your setlist' });
    const { cut, fontSize } = await title.evaluate((el) => ({ cut: el.scrollWidth > el.clientWidth, fontSize: getComputedStyle(el).fontSize }));
    expect({ cut, fontSize }).toEqual({ cut: false, fontSize: size });
  });
}

test('screenshots of the sheet in mini with the first gears off, for the review', async ({ page }) => {
  await open(page, { mini: true });
  await tab(page, 'popularity').click();
  await page.screenshot({ path: path.join(SCREENS, 'setlist-mini-popularity.png') });
  await resetButton(page, 'popularity').click();
  await page.screenshot({ path: path.join(SCREENS, 'setlist-mini-popularity-off.png') });
});
