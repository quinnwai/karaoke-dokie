// QWW-66: the range the singer sang last wins, signed in and signed out. The signed-in list used the range stored on the
// account and the signed-out list the one kept on the device, so one singer got two lists (the account held F2 to C4
// while the device and its header said F#2 to C5). Here the built app runs in a real browser against a stand-in account
// (the API is mocked, as in screen.spec.ts, so each test has its own account and none shares the real server's): what
// the singer sees in the header, what each list was built on, what was saved to the account, and what the device keeps.
// The checks go through the API's own signals and the header's accessible name, not the list's layout.

import { devices, expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { MeResponse, VocalRange } from '../../src/lib/contracts';
import { allMatches, me } from '../fixtures/screen';

test.use({ screenshot: 'off' });

const OLD = 1_700_000_000_000;
const NEW = OLD + 3_600_000; // an hour later
const F2_C4 = { low: 41, high: 60 };
const FS2_C5 = { low: 42, high: 72 };

/** The account and what the app asked of it. */
interface Server {
  user: MeResponse | null;
  /** The range the account holds once the singer signs in. */
  account: VocalRange | null;
  /** Every PUT /api/me/range body, in order. */
  puts: VocalRange[];
  /** The account's range at the moment each library list was asked for: what that list was built on. */
  libraryBuiltOn: (VocalRange | null)[];
  /** The query of every catalogue list request, which carries the range the signed-out list is built on. */
  catalogueFor: string[];
}

/** `signedIn`: the browser already has a session (a cookie from an earlier visit), so it is signed in from its first request. */
const freshServer = (account: VocalRange | null, { signedIn = false } = {}): Server => ({
  user: signedIn ? me(account) : null,
  account,
  puts: [],
  libraryBuiltOn: [],
  catalogueFor: [],
});

async function mockServer(context: BrowserContext, server: Server) {
  await context.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    switch (`${req.method()} ${url.pathname}`) {
      case 'GET /api/auth/login':
        server.user = me(server.account);
        return route.fulfill({ status: 302, headers: { location: '/?signedIn=1' } });
      case 'GET /api/me':
        return server.user ? json(server.user) : json({ error: 'signed-out' }, 401);
      case 'PUT /api/me/range': {
        const range = req.postDataJSON() as VocalRange;
        server.puts.push(range);
        // Like the server: the time sent, or just now when there is none.
        if (server.user) server.user = { ...server.user, range: { ...range, measuredAt: range.measuredAt ?? Date.now() } };
        return json({ ok: true });
      }
      case 'GET /api/recommendations':
        server.libraryBuiltOn.push(server.user?.range ?? null);
        return json(allMatches());
      case 'GET /api/catalogue/recommendations':
        server.catalogueFor.push(url.search);
        return json(allMatches());
      case 'POST /api/events':
        return route.fulfill({ status: 204 });
      default:
        return json({ error: 'not mocked' }, 404);
    }
  });
}

/** Puts `value` in storage before the page first loads, once, as the screen leaves it after the singing test or a visit. */
async function seed(context: BrowserContext, where: 'sessionStorage' | 'localStorage', key: string, value: unknown) {
  await context.addInitScript(
    ([area, k, v]) => {
      const flag = `kd.e2e.${k}`;
      if (!sessionStorage.getItem(flag)) {
        sessionStorage.setItem(flag, '1');
        (area === 'localStorage' ? localStorage : sessionStorage).setItem(k, JSON.stringify(v));
      }
    },
    [where, key, value] as const,
  );
}

const header = (range: string) => `Your range ${range}`;
const kept = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('kd.range') ?? 'null'));

test('a range sung logged out is carried to the account when the singer signs in: the list and the header use it, and the account stores it', async ({ browser, baseURL }) => {
  const server = freshServer({ ...F2_C4, source: 'test', measuredAt: OLD });
  const context = await browser.newContext({ ...devices['iPhone 13'], baseURL, reducedMotion: 'reduce' });
  await mockServer(context, server);
  // The singing test just ended on "That's your range": F#2 to C5, sung an hour after the account's F2 to C4.
  await seed(context, 'sessionStorage', 'kd.test', { ...FS2_C5, measuredAt: NEW });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByTestId('range-low')).toHaveText('F#2');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Signed out: the list is built on the range kept on the device, with the time it was sung.
  await expect(page.getByLabel(header('F#2 to C5'))).toBeVisible();
  expect(server.catalogueFor).toEqual(['?low=42&high=72&all=1']);
  expect(await kept(page)).toEqual({ ...FS2_C5, measuredAt: NEW });

  // Connect Spotify (the sign-in is mocked): back signed in, the account still held F2 to C4.
  await page.getByRole('button', { name: 'Connect to Spotify' }).first().click();
  await expect.poll(() => server.libraryBuiltOn.length).toBe(1);
  await expect(page.getByLabel(header('F#2 to C5'))).toBeVisible();

  // The new range was saved first, with the time it was sung, so the library list was built on it, not on F2 to C4.
  expect(server.puts).toEqual([{ ...FS2_C5, source: 'test', measuredAt: NEW }]);
  expect(server.libraryBuiltOn).toEqual([{ ...FS2_C5, source: 'test', measuredAt: NEW }]);
  expect(server.user?.range).toEqual({ ...FS2_C5, source: 'test', measuredAt: NEW });
  expect(await kept(page)).toEqual({ ...FS2_C5, measuredAt: NEW });
  expect(await page.evaluate(() => sessionStorage.getItem('kd.test'))).toBeNull();
  await context.close();
});

test('an older range on the device never overwrites a newer one on the account, and the device takes the account\'s', async ({ browser, baseURL }) => {
  const server = freshServer({ ...FS2_C5, source: 'test', measuredAt: NEW });
  const context = await browser.newContext({ ...devices['iPhone 13'], baseURL, reducedMotion: 'reduce' });
  await mockServer(context, server);
  // This device last had F2 to C4, sung an hour before the account's F#2 to C5.
  await seed(context, 'localStorage', 'kd.range', { ...F2_C4, measuredAt: OLD });
  const page = await context.newPage();
  await page.goto('/');

  // Signed out, the list is the device's.
  await expect(page.getByLabel(header('F2 to C4'))).toBeVisible();
  await expect.poll(() => server.catalogueFor).toEqual(['?low=41&high=60&all=1']);

  // Signed in, the account's newer range is the one the list is built on and the header shows, and nothing is saved.
  await page.getByRole('button', { name: 'Connect to Spotify' }).first().click();
  await expect.poll(() => server.libraryBuiltOn.length).toBe(1);
  await expect(page.getByLabel(header('F#2 to C5'))).toBeVisible();
  expect(server.puts).toEqual([]);
  expect(server.libraryBuiltOn).toEqual([{ ...FS2_C5, source: 'test', measuredAt: NEW }]);
  expect(server.user?.range).toEqual({ ...FS2_C5, source: 'test', measuredAt: NEW });

  // The device keeps the account's range from then on: when the session ends without a Log out (the cookie runs out),
  // the signed-out list on this device is built on the same range, not on the old F2 to C4 it had.
  await expect.poll(() => kept(page)).toEqual({ ...FS2_C5, measuredAt: NEW });
  server.user = null;
  await page.reload();
  await expect(page.getByLabel(header('F#2 to C5'))).toBeVisible();
  await expect.poll(() => server.catalogueFor.at(-1)).toBe('?low=42&high=72&all=1');
  expect(server.puts).toEqual([]);
  await context.close();
});

test('signed in with no test in flight, a range on the device sung after the account\'s is the one the list and the header use, and the account stores it', async ({ browser, baseURL }) => {
  // The case that started this: the account holds F2 to C4 and this device F#2 to C5, sung later, and the browser is
  // signed in already, with no test left in session storage to carry the device's range across. The list used to be
  // built on the account's F2 to C4 while the signed-out list on this device said F#2 to C5.
  const server = freshServer({ ...F2_C4, source: 'test', measuredAt: OLD }, { signedIn: true });
  const context = await browser.newContext({ ...devices['iPhone 13'], baseURL, reducedMotion: 'reduce' });
  await mockServer(context, server);
  await seed(context, 'localStorage', 'kd.range', { ...FS2_C5, measuredAt: NEW });
  const page = await context.newPage();
  await page.goto('/');

  await expect.poll(() => server.libraryBuiltOn.length).toBe(1);
  await expect(page.getByLabel(header('F#2 to C5'))).toBeVisible();
  expect(server.puts).toEqual([{ ...FS2_C5, source: 'test', measuredAt: NEW }]);
  expect(server.libraryBuiltOn).toEqual([{ ...FS2_C5, source: 'test', measuredAt: NEW }]);
  expect(server.user?.range).toEqual({ ...FS2_C5, source: 'test', measuredAt: NEW });
  expect(server.catalogueFor).toEqual([]);
  await context.close();
});

test('an account range saved before times were kept gives way to the range on the device, which is saved to it', async ({ browser, baseURL }) => {
  // Quinn-Wai\'s account as it is now: F2 to C4 with no time, and F#2 to C5 kept on the device by the earlier version
  // (no time either), signed in already. Nothing says the account\'s is newer, so the device\'s wins.
  const server = freshServer({ ...F2_C4, source: 'test' }, { signedIn: true });
  const context = await browser.newContext({ ...devices['iPhone 13'], baseURL, reducedMotion: 'reduce' });
  await mockServer(context, server);
  await seed(context, 'localStorage', 'kd.range', FS2_C5);
  const page = await context.newPage();
  await page.goto('/');

  await expect.poll(() => server.libraryBuiltOn.length).toBe(1);
  await expect(page.getByLabel(header('F#2 to C5'))).toBeVisible();
  // No time on the device's range either, so none is sent: the account stamps it with the time of the save.
  expect(server.puts).toEqual([{ ...FS2_C5, source: 'test' }]);
  expect(server.libraryBuiltOn).toEqual([expect.objectContaining({ ...FS2_C5, source: 'test', measuredAt: expect.any(Number) })]);
  await context.close();
});
