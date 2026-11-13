// Review items R22 to R24 of QWW-57 (Quinn-Wai's review of #38 on an iPhone, 11 Nov), one check each as the ticket asks. They are about Era:
//   R22  with Era off no era filter applies: the request names no era, and the count and the list are those of a request with no era filter
//   R23  pick one era, then unpick it: Era is off and the list shows every era (it was the empty "Pick an era" screen)
//   R24  the Era tab's jukebox has three buttons, left, middle and right, lit (amber) by the picked eras with the '90s in the middle; with
//        Era off all three are grey, not pink. A screenshot of Era off and of each two-pick row of the table is in test-results/screens/.
// The tuner is reached the way tests/e2e/setlist.spec.ts reaches it (tests/helpers/tunerE2e.ts). The 25 mock songs are the list.

import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { SetlistRequest, SetlistResponse } from '../../src/lib/contracts';
import type { EraId } from '../../src/lib/setlist/types';
import { AMBER, PINK, UNLIT, css, eraButton, open, resetButton, rows, tab, tabArt, titles, tuner } from '../helpers/tunerE2e';

const SCREENS = path.resolve('test-results/screens');
test.beforeAll(() => mkdirSync(SCREENS, { recursive: true }));

// A 390x844 touch phone, like the tuner specs. Motion is off, so a colour is read where it ends.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

// ---- small readers ----

/** Every POST /api/setlist the page sends, as the body it sent. Start it before `open`, so the first load's is in it. */
function watchRequests(page: Page): SetlistRequest[] {
  const seen: SetlistRequest[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/setlist') seen.push(request.postDataJSON() as SetlistRequest);
  });
  return seen;
}

type Hook = { setState(patch: object): void; songs(): Array<{ id: string; title: string; era: EraId | null }> };
const setState = (page: Page, patch: object) => page.evaluate((p) => (window as unknown as { setlist: Hook }).setlist.setState(p), patch);
const listedSongs = (page: Page) => page.evaluate(() => (window as unknown as { setlist: Hook }).setlist.songs());

const count = (page: Page) => page.locator('[data-song-count]');

// ============================================================================================================
// R22 and R23
// ============================================================================================================

test('R22. Era off asks for no era filter: the request names no era, and the count and the list are those of a request with no era filter', async ({ page }) => {
  const requests = watchRequests(page);
  await open(page);
  const first = requests.at(-1)!;
  expect(first.off).toContain('era');
  expect(first.eras).toEqual([]);
  await expect(count(page)).toHaveText('25 songs');
  const shown = await titles(page);
  expect(shown).toHaveLength(25);

  // The same mocked server, asked for the same state with no era named: its count and its list are what the screen shows.
  const answer = await page.evaluate(async (body) => {
    const res = await fetch('/api/setlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return (await res.json()) as SetlistResponse;
  }, first);
  expect(answer.total).toBe(25);
  expect(answer.songs.map((s) => s.match.track.title)).toEqual(shown);

  // A state that still holds picks while Era is off (the test hook, an old state) asks for the same, and nothing on screen changes.
  const asked = requests.length;
  await setState(page, { eras: ['s70', 's80'] });
  expect((await tuner(page)).off).toContain('era');
  await page.waitForTimeout(400);
  expect(requests.length).toBe(asked);
  await expect(count(page)).toHaveText('25 songs');
  expect(await titles(page)).toEqual(shown);
});

test('R23. pick one era, then unpick it: Era is off and the list shows every era', async ({ page }) => {
  const requests = watchRequests(page);
  await open(page);
  const first = requests.at(-1)!;
  const shown = await titles(page);
  expect(shown).toHaveLength(25);

  await eraButton(page, 's80').click();
  await expect(count(page)).toHaveText('4 songs');
  expect(requests.at(-1)).toMatchObject({ eras: ['s80'] });
  expect(requests.at(-1)!.off).not.toContain('era');
  expect((await listedSongs(page)).map((s) => s.era)).toEqual(['s80', 's80', 's80', 's80']);

  await eraButton(page, 's80').click();
  await expect(rows(page)).toHaveCount(25);
  await expect(count(page)).toHaveText('25 songs');
  // Era is off, with nothing picked and nothing pressed, and the screen has not said "Pick an era".
  const state = await tuner(page);
  expect(state.eras).toEqual([]);
  expect(state.off).toContain('era');
  await expect(page.locator('#era-panel')).toHaveAttribute('data-off', 'true');
  await expect(page.locator('button[data-era][aria-pressed="true"]')).toHaveCount(0);
  await expect(page.locator('#empty')).toHaveCount(0);
  // Every era is in the list, in the order first load gave, and what was asked is what first load asked.
  expect(new Set((await listedSongs(page)).map((s) => s.era))).toEqual(new Set(['pre', 's70', 's80', 's90', 's00', 's10', 's20']));
  expect(await titles(page)).toEqual(shown);
  expect(requests.at(-1)).toEqual(first);
});

// ============================================================================================================
// R24: the jukebox
// ============================================================================================================

type Lit = [left: boolean, middle: boolean, right: boolean];
const NONE: Lit = [false, false, false];

/** The table of R24, a case for each row. `shot` names the screenshot of the rows the ticket asks one of (Era off, each two-pick row). */
const TABLE: Array<{ row: string; picks: EraId[]; lit: Lit; shot?: string }> = [
  { row: 'none (Era off): none lit, all grey', picks: [], lit: NONE, shot: 'era-off' },
  { row: "1: the '90s: the middle", picks: ['s90'], lit: [false, true, false], shot: 'one-90s' },
  { row: "1: before the '90s ('80s): the left", picks: ['s80'], lit: [true, false, false] },
  { row: "1: after the '90s ('10s): the right", picks: ['s10'], lit: [false, false, true] },
  { row: "2: one before and one after the '90s ('70s, '00s): left and right", picks: ['s70', 's00'], lit: [true, false, true], shot: 'two-before-and-after' },
  { row: "2: both the '90s or earlier ('80s, '90s): left and middle", picks: ['s80', 's90'], lit: [true, true, false], shot: 'two-90s-or-earlier' },
  { row: "2: both before the '90s ('70s, '80s): left and middle", picks: ['s70', 's80'], lit: [true, true, false] },
  { row: "2: both the '90s or later ('90s, '00s): middle and right", picks: ['s90', 's00'], lit: [false, true, true], shot: 'two-90s-or-later' },
  { row: "2: both after the '90s ('10s, '20s): middle and right", picks: ['s10', 's20'], lit: [false, true, true] },
  { row: "3: ('70s, '90s, '20s): all three", picks: ['s70', 's90', 's20'], lit: [true, true, true], shot: 'three' },
  { row: 'all seven: all three', picks: ['pre', 's70', 's80', 's90', 's00', 's10', 's20'], lit: [true, true, true] },
];

test('R24. the jukebox lights its left, middle and right buttons by the picked eras, the \'90s in the middle; Era off is all three grey, not pink', async ({ page }) => {
  await open(page, { mini: true });
  await tab(page, 'era').click();
  const body = tabArt(page, 'era').locator('[data-jukebox="body"]');
  const button = (i: number) => tabArt(page, 'era').locator(`[data-jukebox="button"][data-i="${i}"]`);
  const lights = async () => [await css(button(0), 'fill'), await css(button(1), 'fill'), await css(button(2), 'fill')];

  for (const { row, picks, lit, shot } of TABLE) {
    // The picks go in as the tuner holds them; none is Era off, which is how first load and the last unpick leave it.
    await setState(page, { eras: picks, off: picks.length ? ['history', 'tempo'] : ['history', 'tempo', 'era'] });
    await expect.poll(lights, { message: row }).toEqual(lit.map((on) => (on ? AMBER : UNLIT)));
    expect(await css(body, 'stroke'), `${row}: the body`).toBe(picks.length ? PINK : UNLIT);
    if (shot) await page.locator('#sheet').screenshot({ path: path.join(SCREENS, `era-jukebox-${shot}.png`) });
  }
});

test('R24. with Era off all three buttons are grey whatever picks are parked, and none of them is pink', async ({ page }) => {
  await open(page, { mini: true });
  await setState(page, { eras: ['s80', 's90', 's00'], off: ['history', 'tempo', 'era'] });
  await expect(page.locator('button[data-era][data-parked]')).toHaveCount(3);
  const fills = await tabArt(page, 'era').locator('[data-jukebox="button"]').evaluateAll((els) => els.map((el) => getComputedStyle(el).fill));
  expect(fills).toEqual([UNLIT, UNLIT, UNLIT]);
  expect(await css(tabArt(page, 'era').locator('[data-jukebox="body"]'), 'stroke')).toBe(UNLIT);
  // The tab's own glow is off with it.
  expect(await css(tabArt(page, 'era'), 'filter')).toBe('none');
});

test('R24. the three buttons sit in a row, evenly spaced and centred on the jukebox, inside its window, in a real browser', async ({ page }) => {
  await open(page, { mini: true });
  const box = async (selector: string) => (await tabArt(page, 'era').locator(selector).boundingBox())!;
  const buttons = [await box('[data-jukebox="button"][data-i="0"]'), await box('[data-jukebox="button"][data-i="1"]'), await box('[data-jukebox="button"][data-i="2"]')];
  const body = await box('[data-jukebox="body"]');
  const middle = (b: { x: number; width: number }) => b.x + b.width / 2;
  const y = (b: { y: number; height: number }) => b.y + b.height / 2;
  // 6 units apart on a grid of 34 / 28 px a unit, level with each other, the middle one on the body's middle.
  const step = 6 * (34 / 28);
  expect(middle(buttons[1]!) - middle(buttons[0]!)).toBeCloseTo(step, 0);
  expect(middle(buttons[2]!) - middle(buttons[1]!)).toBeCloseTo(step, 0);
  expect(Math.abs(y(buttons[0]!) - y(buttons[1]!))).toBeLessThan(0.3);
  expect(Math.abs(y(buttons[2]!) - y(buttons[1]!))).toBeLessThan(0.3);
  expect(Math.abs(middle(buttons[1]!) - middle(body))).toBeLessThan(0.5);
  // Each is a round button of the reference's size (r 1.7: about 4.1 px across) and none touches its neighbour.
  for (const b of buttons) expect(b.width).toBeCloseTo(3.4 * (34 / 28), 0);
  expect(middle(buttons[1]!) - buttons[1]!.width / 2 - (middle(buttons[0]!) + buttons[0]!.width / 2)).toBeGreaterThan(2);
});

test('R24. the turn-off button and the last unpick both put the jukebox back to grey', async ({ page }) => {
  await open(page, { mini: true });
  await tab(page, 'era').click();
  const fills = () => tabArt(page, 'era').locator('[data-jukebox="button"]').evaluateAll((els) => els.map((el) => getComputedStyle(el).fill));
  const lit = (...on: boolean[]) => on.map((v) => (v ? AMBER : UNLIT));
  await eraButton(page, 's00').click();
  expect(await fills()).toEqual(lit(false, false, true));
  await eraButton(page, 's00').click();
  expect(await fills()).toEqual(lit(false, false, false));
  await eraButton(page, 's90').click();
  expect(await fills()).toEqual(lit(false, true, false));
  await resetButton(page, 'era').click();
  expect(await fills()).toEqual(lit(false, false, false));
});
