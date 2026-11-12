// PostHog through our own origin (QWW-63). A tester with an ad or privacy blocker sent nothing to PostHog from production,
// because blockers refuse *.posthog.com. Here the browser refuses it too (every request to *.posthog.com is blocked, as an
// extension would), and the title view and the replay must still arrive, through our own origin. playwright.config.ts runs
// a third server from the same build with PostHog on, forwarding to a stand-in for PostHog's cloud (posthogStub.ts) that
// writes down what it is sent: so this covers the screen, our /roadie route and what PostHog would receive, offline.

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { POSTHOG_PROXY_PATH } from '../../src/lib/postHogProxy';
import { SESSION_COOKIE } from '../../src/lib/server/session';
import type { Seen } from './posthogStub';

// The same expressions as in playwright.config.ts.
const port = Number(process.env.E2E_PORT ?? 3000);
const APP = `http://127.0.0.1:${Number(process.env.E2E_POSTHOG_PORT ?? port + 2)}`;
const STUB = `http://127.0.0.1:${Number(process.env.E2E_POSTHOG_STUB_PORT ?? port + 3)}`;
const POSTHOG_HOSTS = /^https?:\/\/([a-z0-9-]+\.)*posthog\.com(:\d+)?\//i;

// The stand-in is one process whose record is shared, so these tests run one after another, and no other spec uses it.
test.use({ baseURL: APP });
test.describe.configure({ mode: 'serial' });

interface Session {
  /** Requests the page made to PostHog's own hosts (all of which were blocked). */
  direct: string[];
  /** Answers our own origin gave to the page's PostHog traffic. */
  proxied: { method: string; path: string; status: number }[];
  /** What the library said in the console about PostHog being off or failing. */
  warnings: string[];
}

/** A browser with an ad blocker's effect: nothing reaches *.posthog.com. */
async function blockPostHog(context: BrowserContext, page: Page): Promise<Session> {
  // posthog-js drops every event from a browser that says it is automated (navigator.webdriver) or headless (a
  // "HeadlessChrome" brand in navigator.userAgentData): a person's browser says neither.
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
  });
  await context.route(POSTHOG_HOSTS, (route) => route.abort('blockedbyclient'));

  const session: Session = { direct: [], proxied: [], warnings: [] };
  page.on('request', (req) => {
    if (POSTHOG_HOSTS.test(req.url())) session.direct.push(req.url());
  });
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (url.origin === APP && url.pathname.startsWith(`${POSTHOG_PROXY_PATH}/`)) {
      session.proxied.push({ method: res.request().method(), path: url.pathname, status: res.status() });
    }
  });
  page.on('console', (msg) => {
    if (/posthog/i.test(msg.text())) session.warnings.push(`${msg.type()}: ${msg.text()}`);
  });
  return session;
}

/**
 * posthog-js holds its replay back until it sees someone using the page, once its recorder is up: a tap, as a tester's would
 * be. A tap before the recorder loads counts for nothing, so the tests keep tapping while they wait.
 */
const tap = (page: Page) => page.mouse.click(30, 300);

const seenByStub = async (page: Page): Promise<Seen[]> => (await page.request.get(`${STUB}/__requests`)).json();
const eventNames = (seen: Seen[]) => seen.flatMap((r) => r.events.map((e) => e.event));
const header = (seen: Seen[], name: string) => seen.map((r) => r.headers[name]).filter((v) => v !== undefined);

test.beforeEach(async ({ request }) => {
  await request.post(`${STUB}/__reset`);
});

test('with *.posthog.com blocked, the title view and the replay still reach PostHog, through our own origin', async ({ context, page }) => {
  test.setTimeout(90_000);
  const session = await blockPostHog(context, page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  const anonId = await page.evaluate(() => localStorage.getItem('kd.anonId'));
  expect(anonId).toMatch(/^[A-Za-z0-9-]{8,64}$/);

  // The title view, and the replay (the visitor is signed out): both got to PostHog's side.
  await expect
    .poll(
      async () => {
        await tap(page);
        return eventNames(await seenByStub(page));
      },
      { timeout: 45_000 },
    )
    .toEqual(expect.arrayContaining(['title_view', '$snapshot']));
  const seen = await seenByStub(page);

  // The browser side: it never so much as tried a PostHog host, and our origin answered each of its calls with a 200:
  // the events, the replay's data, the project's config and the recorder script.
  expect(session.direct).toEqual([]);
  const answered = (method: string, pattern: RegExp) => session.proxied.filter((r) => r.method === method && pattern.test(r.path));
  expect(answered('POST', /^\/roadie\/e\/$/).length).toBeGreaterThan(0);
  expect(answered('POST', /^\/roadie\/s\/$/).length).toBeGreaterThan(0);
  expect(answered('GET', /^\/roadie\/array\/phc_e2etestkey\/config\.js$/)).toHaveLength(1);
  // The recorder is asked for under a file name the block lists do not match (not posthog-recorder.js).
  expect(answered('GET', /^\/roadie\/static\/[^/]+\/reel\.js$/)).toHaveLength(1);
  expect(session.proxied.filter((r) => r.status !== 200)).toEqual([]);
  expect(session.proxied.map((r) => r.path).filter((p) => /posthog/i.test(p))).toEqual([]);

  // PostHog's side: the title view carries the device's own id and says where it came from; the replay data is there; and
  // the recorder was fetched from PostHog under PostHog's own name for it.
  const titleView = seen.flatMap((r) => r.events).find((e) => e.event === 'title_view')!;
  expect(titleView.properties.distinct_id).toBe(anonId);
  expect(titleView.properties.environment).toBe('local');
  expect(seen.some((r) => r.method === 'GET' && /^\/static\/[^/]+\/posthog-recorder\.js$/.test(r.path))).toBe(true);
  expect(seen.filter((r) => r.method === 'POST' && r.path.startsWith('/s/')).length).toBeGreaterThan(0);
  // What the browser sent travels on in the way it is meant to: the browser's name, a body type, and no cookie at all.
  expect(header(seen, 'user-agent').every((ua) => /iPhone/.test(String(ua)))).toBe(true);
  expect(header(seen, 'cookie')).toEqual([]);

  // And nothing PostHog says back sticks to our origin: the stand-in sets a cookie on every answer, and the route drops it.
  expect((await context.cookies()).map((c) => c.name)).not.toContain('ph_stub');
  expect(await page.evaluate(() => document.cookie)).toBe('');
  expect(session.warnings.filter((w) => /is off for this page/.test(w))).toEqual([]);
});

test('signed in, our session cookie never goes to PostHog, and the replay stays off', async ({ context, page }) => {
  test.setTimeout(90_000);
  const session = await blockPostHog(context, page);
  // The mock Spotify answers at once: this signs in as "Test Singer", with a real signed session cookie.
  await page.goto('/api/auth/login');
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  const cookies = await context.cookies();
  expect(cookies.map((c) => c.name)).toContain(SESSION_COOKIE);
  const sessionValue = cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  expect((await page.request.get('/api/me')).status()).toBe(200); // the server knows this browser as signed in

  // Events still go through our origin while signed in (it is only the replay that is off).
  await expect.poll(async () => (await seenByStub(page)).filter((r) => r.path.startsWith('/e/')).length, { timeout: 45_000 }).toBeGreaterThan(0);
  // The taps that start a replay for someone signed out, and time for it to show up, had it started.
  for (let i = 0; i < 5; i++) {
    await tap(page);
    await page.waitForTimeout(1_500);
  }
  const seen = await seenByStub(page);

  // The premise: the browser had the cookie, and sent it to our origin with every call to /roadie. The point: PostHog got none of it.
  expect(header(seen, 'cookie')).toEqual([]);
  expect(JSON.stringify(seen)).not.toContain(sessionValue);
  expect(JSON.stringify(seen)).not.toContain(SESSION_COOKIE);
  expect(session.direct).toEqual([]);
  expect(session.proxied.filter((r) => r.method === 'POST' && r.path === '/roadie/e/').length).toBeGreaterThan(0);
  expect(session.proxied.filter((r) => r.status !== 200)).toEqual([]);
  // Signed in: no replay, so no recorder and no snapshot.
  expect(eventNames(seen)).not.toContain('$snapshot');
  expect(seen.filter((r) => /^\/s\/|posthog-recorder/.test(r.path))).toEqual([]);
});
