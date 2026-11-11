// Shared by the tuner's Playwright specs (tests/e2e/setlist*.spec.ts): the mocked API, a way into the tuner, the small readers,
// and the colours the 6A tests read. Moved out of setlist.spec.ts (QWW-57) so the specs that follow it share one set.

import { expect, type BrowserContext, type Page } from '@playwright/test';
import type { AppEvent, EventsRequest, MeResponse, SetlistRequest, VocalRange } from '../../src/lib/contracts';
import type { GearId, TunerPart, TunerState } from '../../src/lib/setlist/types';
import { mockPage, type MockSong } from '../fixtures/setlist';
import { setlistAnswer } from './setlistServer';

/** The 25 songs ranked for the real defaults, signed out (see the header). */
export const DEFAULT_RANKING = [
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
export const ALL_RESET_RANKING = [
  "Don't Stop Believin'", 'Bohemian Rhapsody', 'Mr. Brightside', 'Dancing Queen', 'Rolling in the Deep', "Livin' on a Prayer", 'I Will Always Love You',
  'Sweet Caroline', 'I Want It That Way', 'Africa', 'I Will Survive', 'good 4 u', 'Shallow', 'Stand by Me', 'Levitating', 'Wannabe',
  "Can't Help Falling in Love", 'Respect', 'Since U Been Gone', 'Valerie', "These Boots Are Made for Walkin'", 'Bizarre Love Triangle', 'Harvest Moon',
  'Motion Sickness', 'A Case of You',
];
/** Test 6: only the 80s, for the real defaults. */
export const ONLY_80S = ["Don't Stop Believin'", "Livin' on a Prayer", 'Africa', 'Bizarre Love Triangle'];

export const RANGE: VocalRange = { low: 45, high: 72, source: 'test' };
export const ME: MeResponse = { userId: 'u1', displayName: 'Quinn', range: RANGE };

// ---- the mocked API and a way in ----

/** 16-bit mono WAV: `seconds` of a quiet 440 Hz tone, so a preview has something to play. */
function toneWav(seconds: number, sampleRate = 22050): Buffer {
  const n = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(0.1 * 32767 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const TONE = toneWav(30);

/** How long /api/preview/<id> takes to answer, so a test can look at the button while it loads. */
export const PREVIEW_DELAY_MS = 1200;

/** The tone, or the bytes a Range header asks for (206), as Deezer's CDN answers (Safari asks for media in ranges). */
function previewAnswer(rangeHeader: string | undefined): { status: number; contentType: string; headers: Record<string, string>; body: Buffer } {
  const range = /bytes=(\d+)-(\d*)/.exec(rangeHeader ?? '');
  if (!range) return { status: 200, contentType: 'audio/wav', headers: { 'accept-ranges': 'bytes' }, body: TONE };
  const start = Number(range[1]);
  const end = Math.min(range[2] ? Number(range[2]) : TONE.length - 1, TONE.length - 1);
  return { status: 206, contentType: 'audio/wav', headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${TONE.length}` }, body: TONE.subarray(start, end + 1) };
}

export interface Opened {
  events: AppEvent[];
}

export async function mockApi(context: BrowserContext, opts: { loggedIn: boolean; extra?: MockSong[]; events: AppEvent[] }) {
  const page = mockPage({ idPrefix: opts.loggedIn ? '' : 'cat:', extra: opts.extra });
  await context.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    // A song's 30 s preview (QWW-48): the route answers with a tone after a moment.
    if (/^\/api\/preview\/\d+$/.test(url.pathname)) {
      await new Promise((resolve) => setTimeout(resolve, PREVIEW_DELAY_MS));
      return route.fulfill(previewAnswer(req.headers()['range']));
    }
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
export async function open(page: Page, opts: { loggedIn?: boolean; mini?: boolean; extra?: MockSong[]; range?: { low: number; high: number } } = {}): Promise<Opened> {
  const { loggedIn = false, mini = false, extra, range = { low: 45, high: 72 } } = opts;
  const events: AppEvent[] = [];
  await mockApi(page.context(), { loggedIn, extra, events });
  if (!loggedIn) await page.context().addInitScript((saved) => localStorage.setItem('kd.range', JSON.stringify(saved)), range);
  await page.goto(mini ? '/?mini=1' : '/');
  await expect(page.locator('#app [data-row]').first()).toBeVisible({ timeout: 20_000 });
  return { events };
}

// ---- small readers ----

export const rows = (page: Page) => page.locator('[data-row]');
/** The button that opens a row's song: a direct child of the row (the ▶ is in the slot beside it). */
export const openButton = (row: ReturnType<Page['locator']>) => row.locator(':scope > button');
export const titles = (page: Page) => page.locator('[data-row-title]').allTextContents();
export const strip = (page: Page, gear: GearId) => page.locator(`[data-strip][data-gear="${gear}"]`);
export const tab = (page: Page, gear: TunerPart) => page.locator(`[data-tab][data-gear="${gear}"]`);
export const eraButton = (page: Page, era: string) => page.locator(`button[data-era="${era}"]`);
export const resetButton = (page: Page, gear: TunerPart) => page.locator(`button[data-reset="${gear}"]`);
export const slider = (page: Page, gear: GearId) => page.locator(`#slider-${gear}`);
export const handle = (page: Page) => page.locator('#handle');
export const tuner = (page: Page) => page.evaluate(() => (window as unknown as { setlist: { getState(): TunerState } }).setlist.getState());
export const rack = (page: Page) => page.locator('#rack').evaluate((el) => ({ height: el.clientHeight, scroll: el.scrollHeight }));
export const value = async (page: Page, gear: GearId) => Number(await slider(page, gear).inputValue());

/** Where on a gear's track a fraction (0 to 1) is, in page pixels. The invisible slider starts 7 px before the track and ends 7 px after it (its thumb is the 14 px fader cap). */
export async function onTrack(page: Page, gear: GearId, fraction: number) {
  const box = (await slider(page, gear).boundingBox())!;
  return { x: box.x + 7 + (box.width - 14) * fraction, y: box.y + box.height / 2 };
}

export async function pressKey(page: Page, gear: GearId, key: string, times = 1) {
  await slider(page, gear).focus();
  for (let i = 0; i < times; i++) await page.keyboard.press(key);
}

/** A mouse drag of the handle: down on it, up by `dy` px (negative = up) in a few steps; `during` runs before the button goes up. */
export async function dragHandle(page: Page, dy: number, during?: () => Promise<void>) {
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
export async function touchDrag(page: Page, from: { x: number; y: number }, dy: number) {
  const cdp = await page.context().newCDPSession(page);
  const at = (y: number) => [{ x: from.x, y }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from.y) });
  for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(from.y + (dy * i) / 10) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

export const centre = async (loc: ReturnType<Page['locator']>) => {
  const b = (await loc.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};


/** A computed colour as the browser writes it. */
export const rgb = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
};
export const UNLIT = rgb('#34313D');
export const PINK = rgb('#FF4FA0');
export const AMBER = rgb('#FFC24A');
export const VIOLET = rgb('#B583FF');
export const OFF_TEXT = rgb('#8E8A99'); // decision 5: raised from 6A's #6E6A78 and #5E5A68
export const TEXT_3 = rgb('#9E99AA');


export const css = (loc: ReturnType<Page['locator']>, prop: string) => loc.first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
export const art = (page: Page, gear: GearId) => strip(page, gear).locator('svg').first();
export const tabArt = (page: Page, gear: TunerPart) => tab(page, gear).locator('svg').first();
