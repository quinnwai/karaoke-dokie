// Duets and moods are off as the app ships (QWW-43): no DUETS_AND_MOODS. playwright.config.ts runs two
// servers from one build, the default one with them on (so the rest of e2e keeps covering their chips) and
// a second on the next port with the switch empty and both moods still listed in MOODS_SHIPPED. This
// walks the second one the way a tester would, and holds it to the promise that matters: the same songs
// in the same order as the server with the switch on.

import { devices, expect, test } from '@playwright/test';
import path from 'node:path';

const SCREENS = path.resolve('test-results/screens');
// The same expressions as in playwright.config.ts.
const port = Number(process.env.E2E_PORT ?? 3000);
const offPort = Number(process.env.E2E_OFF_PORT ?? port + 1);
const ON = `http://127.0.0.1:${port}`;
const OFF = `http://127.0.0.1:${offPort}`;

interface ApiMatch {
  track: { id: string; title: string };
  range: { duet?: boolean; parts?: unknown[] };
  part?: number;
  partSinger?: string;
  moods?: string[];
}

const RANGES: [string, number, number][] = [
  ['A2 to C5', 45, 72],
  ['a low voice', 40, 62],
  ['a high voice', 55, 82],
  ['a narrow beginner', 50, 68],
];

test('switch off: nothing about duets or moods in the API, and the same songs in the same order as with it on', async ({ request }) => {
  for (const [who, low, high] of RANGES) {
    const q = `/api/catalogue/recommendations?low=${low}&high=${high}&all=1`;
    const on = ((await (await request.get(ON + q)).json()) as { matches: ApiMatch[] }).matches;
    const off = ((await (await request.get(OFF + q)).json()) as { matches: ApiMatch[] }).matches;
    expect(off.length, who).toBeGreaterThan(2); // the demo catalogue is small: a narrow range holds only a few songs
    expect(off.map((m) => m.track.id), who).toEqual(on.map((m) => m.track.id));
    for (const m of off) {
      expect([m.moods, m.part, m.partSinger, m.range.duet, m.range.parts].filter((v) => v !== undefined), `${who}: ${m.track.title}`).toEqual([]);
    }
  }
  // The control: with the switch on, the same request does carry duets and moods.
  const on = ((await (await request.get(`${ON}/api/catalogue/recommendations?low=45&high=72&all=1`)).json()) as { matches: ApiMatch[] }).matches;
  expect(on.some((m) => m.range.duet === true && m.part !== undefined)).toBe(true);
  expect(on.some((m) => m.moods?.includes('upbeat'))).toBe(true);
});

test('switch off: the results screen shows no duet or mood anywhere, and no duet line on a song', async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ ...devices['iPhone 13'], baseURL: OFF, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('kd.e2e')) {
      sessionStorage.setItem('kd.e2e', '1');
      sessionStorage.setItem('kd.test', JSON.stringify({ low: 45, high: 72 }));
    }
  });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue' }).click();
  const songs = page.locator('[data-row]');
  await expect(songs.first()).toBeVisible({ timeout: 20_000 });

  // The Setlist tuner has no duet or mood control (and never did with the switch off): no chip, no duet line.
  await expect(page.getByRole('button', { name: /^Duets/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Upbeat$/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Heartfelt/ })).toHaveCount(0);
  await expect(page.getByText(/Duet/)).toHaveCount(0);
  await page.screenshot({ path: path.join(SCREENS, 'duets-moods-off-01-list.png') });

  // The 80s hold a duet in the demo's catalogue (Islands in the Stream, 1983; with the switch on its song page
  // says whose part to take). Only the 80s picked (the first tap on an era picks just that era), and the whole list
  // paged through: the duet is still in it, and no row says "Duet". Opened, the song carries no duet line and no mood
  // pill either.
  const era = (id: string) => page.locator(`button[data-era="${id}"]`);
  // A phone this short opens the tuner's sheet in mini (QWW-57), which shows the Era panel from its tab.
  await page.locator('[data-tab][data-gear="era"]').click();
  await era('s80').click();
  const more = page.getByRole('button', { name: 'Load more songs' });
  for (let i = 0; i < 10 && (await more.count()) > 0; i++) await more.click();
  const duet = songs.filter({ hasText: 'Islands in the Stream' });
  await expect(duet).toHaveCount(1);
  await expect(page.getByText(/Duet/)).toHaveCount(0);
  await duet.locator(':scope > button').click();
  await expect(page.getByRole('heading', { name: 'Islands in the Stream' })).toBeVisible();
  await expect(page.getByText(/Duet|Upbeat|Heartfelt/)).toHaveCount(0);
  await page.screenshot({ path: path.join(SCREENS, 'duets-moods-off-02-song.png') });

  await context.close();
});
