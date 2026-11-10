// End-to-end checks of the microphone step (QWW-50): the screens a singer meets between "Start" and the first
// note, in the browsers older singers are likely to use. Chromium stands in for all of them. A user agent changes
// what we say, not what the browser does, so each case sets the user agent of the browser it plays, and:
//   granted         Chromium's fake permission UI says yes to the question, and its fake microphone plays a tone
//   denied          getUserMedia refuses (or, closed without an answer, "Permission dismissed")
//   already granted the permission is set before the page opens
//   already blocked the Permissions API says "denied" before anyone asks
// What a real iPhone and a real Android phone do with the same screens is checked by hand (the PR's review guide).

import { devices, expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { launchWithMic, writeTone } from './fakeMic';

const SCREENS = path.resolve('test-results/screens');
const iPhone = devices['iPhone 13'];
const pixel = devices['Pixel 7'];
/** The smallest phone the screens must fit (an iPhone SE). */
const SMALL = { width: 375, height: 667 };

const INSTAGRAM_IPHONE = `${iPhone.userAgent} Instagram 336.0.0.35.121 (iPhone14,5; iOS 17_5; en_US; en-US; scale=3.00; 1170x2532; 599165981)`;
const INSTAGRAM_ANDROID = `${pixel.userAgent} Instagram 336.0.0.40.109 Android (34/14; 420dpi; 1080x2400; Google/google; Pixel 7; panther; panther; en_US; 599165981)`;

let tone: string;
test.beforeAll(() => {
  mkdirSync(SCREENS, { recursive: true });
  tone = writeTone('mic-tone-220hz.wav', 220);
});

// Named screenshots are taken by hand below; the automatic one adds nothing.
test.use({ screenshot: 'off' });

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SCREENS, `${name}.png`) });

type Sent = { name: string; props?: Record<string, unknown> };

/** Only /api/me and /api/events matter here. Every event the page sends is kept, as the server would get it. */
async function mockApi(context: BrowserContext) {
  const sent: Sent[] = [];
  await context.route('**/api/**', (route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    if (pathname === '/api/events') {
      const body = JSON.parse(req.postData() ?? '{}') as { events?: Sent[] };
      for (const e of body.events ?? []) sent.push({ name: e.name, ...(e.props ? { props: e.props } : {}) });
      return route.fulfill({ status: 204 });
    }
    if (pathname === '/api/me') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"signed out"}' });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not mocked"}' });
  });
  // The tracker sends every few seconds, so the events of a step arrive a little after it.
  return { micEvents: () => sent.filter((e) => /^(mic_|inapp_)/.test(e.name)) };
}

type Answer = 'allow' | 'deny' | 'dismiss';

/** getUserMedia says what `answer` says (the test can change it), and every microphone it hands out is kept. */
function controlMic(context: BrowserContext, answer: Answer) {
  return context.addInitScript((initial) => {
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const w = window as unknown as { __answer: string; __streams: MediaStream[] };
    w.__answer = initial;
    w.__streams = [];
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (w.__answer === 'deny') throw new DOMException('Permission denied', 'NotAllowedError');
      if (w.__answer === 'dismiss') throw new DOMException('Permission dismissed', 'NotAllowedError');
      const stream = await real(constraints);
      w.__streams.push(stream);
      return stream;
    };
  }, answer);
}
const answerMic = (page: Page, answer: Answer) => page.evaluate((a) => void ((window as unknown as { __answer: string }).__answer = a), answer);

/** The browser says "denied" when asked what it knows about the microphone, before anyone asks it for the microphone. */
const alreadyBlocked = (context: BrowserContext) =>
  context.addInitScript(() => {
    navigator.permissions.query = async () =>
      ({ state: 'denied', name: 'microphone', onchange: null, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }) as unknown as PermissionStatus;
  });

/** "Start", then past "Find a quiet spot" with a tap (the same thing it does by itself after a moment). */
async function startTest(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByRole('button', { name: /^Find a quiet spot/ }).click();
}

/** Press and hold like a finger. */
async function hold(page: Page, name: RegExp, ms: number) {
  const box = (await page.getByRole('button', { name }).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

const lowNote = (page: Page) => page.getByRole('button', { name: 'Hold to record your lowest note' });
const view = (page: Page) => page.locator('[data-mic-view]');

test('first run on an iPhone: our screen, then the browser\'s question, the level meter, and the note', async ({ baseURL }) => {
  const browser = await launchWithMic(tone);
  const context = await browser.newContext({ ...iPhone, baseURL });
  const api = await mockApi(context);
  const page = await context.newPage();
  await startTest(page);

  // Our own screen comes first, saying where the browser's question will be.
  await expect(view(page)).toHaveAttribute('data-mic-view', 'prompt');
  await expect(page.getByText('We need to hear you sing')).toBeVisible();
  await expect(page.getByRole('img', { name: /box in the middle of its screen/ })).toBeVisible();
  await page.waitForTimeout(900);
  await shot(page, '19-mic-prompt-iphone');

  // One tap asks; the fake permission UI says yes; the bar moves with the tone, and the screen says so.
  await page.getByRole('button', { name: 'Turn on microphone' }).click();
  await expect(page.getByText('We can hear you ✓')).toBeVisible();
  await expect(page.locator('[data-heard]')).toHaveAttribute('data-heard', 'true');
  const fill = await page.locator('[class*="meterFill"]').evaluate((el) => el.style.transform);
  expect(Number(/scaleX\(([\d.]+)\)/.exec(fill)![1])).toBeGreaterThan(0.5);
  await page.waitForTimeout(500);
  await shot(page, '20-mic-level-meter');

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(lowNote(page)).toBeVisible();
  await expect
    .poll(() => api.micEvents(), { timeout: 8000 })
    .toEqual([
      { name: 'mic_prompt_shown', props: { browser: 'ios-safari' } },
      { name: 'mic_granted', props: { via: 'prompt', browser: 'ios-safari' } },
    ]);
  await browser.close();
});

test('on Android Chrome the picture shows a panel from the bottom, and the events say so', async ({ baseURL }) => {
  const browser = await launchWithMic(tone);
  const context = await browser.newContext({ ...pixel, baseURL });
  const api = await mockApi(context);
  const page = await context.newPage();
  await startTest(page);
  await expect(page.getByRole('img', { name: /panel sliding up from the bottom/ })).toBeVisible();
  await page.waitForTimeout(900);
  await shot(page, '21-mic-prompt-android');
  await page.getByRole('button', { name: 'Turn on microphone' }).click();
  await expect(page.getByText('We can hear you ✓')).toBeVisible();
  await expect.poll(() => api.micEvents(), { timeout: 8000 }).toEqual([
    { name: 'mic_prompt_shown', props: { browser: 'android-chrome' } },
    { name: 'mic_granted', props: { via: 'prompt', browser: 'android-chrome' } },
  ]);
  await browser.close();
});

test('a refusal shows the iPhone steps, "Try again" says it is still blocked, and allowing at last carries on', async ({ baseURL }) => {
  const browser = await launchWithMic(tone);
  const context = await browser.newContext({ ...iPhone, baseURL });
  const api = await mockApi(context);
  await controlMic(context, 'deny');
  const page = await context.newPage();
  await startTest(page);
  await page.getByRole('button', { name: 'Turn on microphone' }).click();

  await expect(view(page)).toHaveAttribute('data-mic-view', 'recovery');
  await expect(page.getByText('The microphone is blocked')).toBeVisible();
  const steps = page.locator('ol li');
  await expect(steps).toHaveText(['Tap aA in the address bar', 'Tap Website Settings', 'Set Microphone to Allow', 'Then tap Try again']);
  await expect(page.getByText('Safari may ask again each time you open this page. That’s normal.')).toBeVisible();
  await page.waitForTimeout(900);
  await shot(page, '22-mic-recovery-iphone');

  // Nothing has changed, so trying again says so instead of looking like nothing happened.
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Still not working. Follow the steps, then tap Try again.')).toBeVisible();

  // The singer follows the steps; the microphone is allowed now.
  await answerMic(page, 'allow');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('We can hear you ✓')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(lowNote(page)).toBeVisible();

  await expect.poll(() => api.micEvents().map((e) => e.name), { timeout: 8000 }).toEqual([
    'mic_prompt_shown',
    'mic_denied',
    'mic_recovery_shown',
    'mic_denied',
    'mic_recovery_shown',
    'mic_granted',
  ]);
  expect(api.micEvents()[1]).toEqual({ name: 'mic_denied', props: { reason: 'denied', via: 'prompt', browser: 'ios-safari' } });
  expect(api.micEvents()[5]).toEqual({ name: 'mic_granted', props: { via: 'prompt', browser: 'ios-safari' } });
  await browser.close();
});

test('a question closed without an answer says so, and Android Chrome gets its own steps', async ({ baseURL }) => {
  const browser = await launchWithMic(tone);
  const context = await browser.newContext({ ...pixel, baseURL });
  const api = await mockApi(context);
  await controlMic(context, 'dismiss');
  const page = await context.newPage();
  await startTest(page);
  await page.getByRole('button', { name: 'Turn on microphone' }).click();

  await expect(page.getByText('The question was closed')).toBeVisible();
  await expect(page.locator('ol li')).toHaveText([
    'Tap the lock or settings icon by the web address',
    'Tap Permissions',
    'Turn on Microphone',
    'Then tap Try again',
  ]);
  await expect(page.getByText(/ask again each time/)).toHaveCount(0);
  await page.waitForTimeout(900);
  await shot(page, '23-mic-recovery-android');
  await expect.poll(() => api.micEvents().map((e) => e.props?.reason).filter(Boolean), { timeout: 8000 }).toEqual(['dismissed', 'dismissed']);
  await browser.close();
});

test('a microphone the browser already allows skips our screen: straight to the level meter', async ({ baseURL }) => {
  const browser = await launchWithMic(tone);
  const context = await browser.newContext({ ...pixel, baseURL });
  await context.grantPermissions(['microphone'], { origin: baseURL });
  const api = await mockApi(context);
  const page = await context.newPage();
  await startTest(page);

  await expect(page.getByText('We can hear you ✓')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on microphone' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(lowNote(page)).toBeVisible();
  await expect.poll(() => api.micEvents(), { timeout: 8000 }).toEqual([{ name: 'mic_granted', props: { via: 'already', browser: 'android-chrome' } }]);
  await browser.close();
});

test('a microphone the browser already blocks goes straight to the steps, and never asks', async ({ baseURL }) => {
  const browser = await launchWithMic(tone);
  const context = await browser.newContext({ ...iPhone, baseURL });
  const api = await mockApi(context);
  await alreadyBlocked(context);
  const page = await context.newPage();
  await startTest(page);

  await expect(page.getByText('The microphone is blocked')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on microphone' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect.poll(() => api.micEvents(), { timeout: 8000 }).toEqual([
    { name: 'mic_denied', props: { reason: 'denied', via: 'already', browser: 'ios-safari' } },
    { name: 'mic_recovery_shown', props: { reason: 'denied', browser: 'ios-safari' } },
  ]);
  await browser.close();
});

test('opened from Instagram on an iPhone: open Safari, with a copy-link button, before anything about the microphone', async ({ baseURL }) => {
  const browser = await launchWithMic(tone);
  const context = await browser.newContext({ ...iPhone, userAgent: INSTAGRAM_IPHONE, baseURL });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
  const api = await mockApi(context);
  const page = await context.newPage();
  await startTest(page);

  await expect(view(page)).toHaveAttribute('data-mic-view', 'inapp');
  await expect(page.getByText('Open this in Safari')).toBeVisible();
  await expect(page.getByText(/open inside Instagram/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on microphone' })).toHaveCount(0);
  await page.waitForTimeout(900);
  await shot(page, '24-mic-inapp-iphone');

  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByRole('button', { name: 'Link copied ✓' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
  await expect(page.getByLabel('Link to this page')).toHaveValue(page.url());

  // If the guess is wrong, the singer is not stuck.
  await page.getByRole('button', { name: 'Try here anyway' }).click();
  await expect(page.getByRole('button', { name: 'Turn on microphone' })).toBeVisible();
  await expect.poll(() => api.micEvents(), { timeout: 8000 }).toEqual([
    { name: 'inapp_browser_detected', props: { app: 'instagram', browser: 'ios-other' } },
    { name: 'mic_prompt_shown', props: { browser: 'ios-other' } },
  ]);
  await browser.close();
});

test('opened from Instagram on Android: a real "Open in Chrome" link to this page', async ({ baseURL }) => {
  const browser = await launchWithMic(tone);
  const context = await browser.newContext({ ...pixel, userAgent: INSTAGRAM_ANDROID, baseURL });
  const api = await mockApi(context);
  const page = await context.newPage();
  await startTest(page);

  await expect(page.getByText('Open this in Chrome')).toBeVisible();
  const open = page.getByRole('link', { name: 'Open in Chrome' });
  const href = (await open.getAttribute('href'))!;
  const url = new URL(page.url());
  expect(href).toBe(
    `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=http;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(page.url())};end`,
  );
  await page.waitForTimeout(900);
  await shot(page, '25-mic-inapp-android');
  await expect.poll(() => api.micEvents(), { timeout: 8000 }).toEqual([{ name: 'inapp_browser_detected', props: { app: 'instagram', browser: 'android-other' } }]);
  await browser.close();
});

for (const [app, userAgent, name] of [
  ['Messenger on an iPhone', `${iPhone.userAgent} [FBAN/MessengerForiOS;FBAV/460.0.0.37.109;FBBV/592000000]`, 'Messenger'],
  ['Facebook on Android', `${pixel.userAgent} [FB_IAB/FB4A;FBAV/464.0.0.42.114;]`, 'Facebook'],
  ['LinkedIn on an iPhone', `${iPhone.userAgent} LinkedInApp/9.30.1234`, 'LinkedIn'],
] as const) {
  test(`opened from ${app}: the same advice, naming the app`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ ...(userAgent.includes('iPhone') ? iPhone : pixel), userAgent, baseURL });
    await mockApi(context);
    const page = await context.newPage();
    await startTest(page);
    await expect(view(page)).toHaveAttribute('data-mic-view', 'inapp');
    await expect(page.getByText(new RegExp(`open inside ${name}`))).toBeVisible();
    await context.close();
  });
}

test('a microphone taken away during the note sends the singer back through the mic step, to the same note', async ({ baseURL }) => {
  const browser = await launchWithMic(tone);
  const context = await browser.newContext({ ...iPhone, baseURL });
  await context.grantPermissions(['microphone'], { origin: baseURL });
  const api = await mockApi(context);
  await controlMic(context, 'allow');
  const page = await context.newPage();
  await startTest(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(lowNote(page)).toBeVisible();

  // Another app takes the microphone, or the permission is withdrawn: the browser ends the stream.
  await page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.forEach((s) => s.getTracks().forEach((t) => t.stop())));
  await hold(page, /lowest note/, 300);

  // Not a note that records nothing and says "try again" for ever: the mic step, then the same note.
  await expect(page.getByText('We can hear you ✓')).toBeVisible();
  await expect(lowNote(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(lowNote(page)).toBeVisible();
  await hold(page, /lowest note/, 1500);
  await expect(page.getByTestId('low-note')).toHaveText('A3');
  await expect.poll(() => api.micEvents().map((e) => e.name), { timeout: 8000 }).toEqual(['mic_granted', 'mic_granted']);
  await browser.close();
});

// "Large touch targets (at least 48 px) and at least 18 px body text on these screens", and the one thing to tap on
// each is on the screen without scrolling, on the smallest phone.
const SCREENS_TO_CHECK: [string, 'iphone' | 'pixel', (context: BrowserContext, page: Page) => Promise<void>, string, string][] = [
  ['the prompt on an iPhone', 'iphone', async () => {}, 'prompt', 'Turn on microphone'],
  ['the prompt on Android', 'pixel', async () => {}, 'prompt', 'Turn on microphone'],
  [
    'the level meter',
    'iphone',
    async (_context, page) => {
      await page.getByRole('button', { name: 'Turn on microphone' }).click();
      await expect(page.getByText('We can hear you ✓')).toBeVisible();
    },
    'level',
    'Continue',
  ],
  [
    'the steps on an iPhone',
    'iphone',
    async (_context, page) => {
      await answerMic(page, 'deny');
      await page.getByRole('button', { name: 'Turn on microphone' }).click();
      await expect(page.getByText('The microphone is blocked')).toBeVisible();
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect(page.getByText(/Still not working/)).toBeVisible();
    },
    'recovery',
    'Try again',
  ],
  [
    'the steps on Android',
    'pixel',
    async (_context, page) => {
      await answerMic(page, 'deny');
      await page.getByRole('button', { name: 'Turn on microphone' }).click();
      await expect(page.getByText('The microphone is blocked')).toBeVisible();
    },
    'recovery',
    'Try again',
  ],
];

for (const [label, kind, reach, expected, primary] of SCREENS_TO_CHECK) {
  test(`${label} has big buttons and big type, and its main button is in view on a small phone`, async ({ baseURL }) => {
    const browser = await launchWithMic(tone);
    const context = await browser.newContext({ ...(kind === 'iphone' ? iPhone : pixel), viewport: SMALL, baseURL });
    await mockApi(context);
    await controlMic(context, 'allow');
    const page = await context.newPage();
    await startTest(page);
    await expect(view(page)).toHaveAttribute('data-mic-view', 'prompt');
    await reach(context, page);
    await expect(view(page)).toHaveAttribute('data-mic-view', expected);
    await expectBigAndInView(page, page.getByRole('button', { name: primary }));
    await browser.close();
  });
}

for (const [label, userAgent, device, primary] of [
  ['the in-app screen on an iPhone', INSTAGRAM_IPHONE, iPhone, 'Copy link'],
  ['the in-app screen on Android', INSTAGRAM_ANDROID, pixel, 'Open in Chrome'],
] as const) {
  test(`${label} has big buttons and big type, and its main button is in view on a small phone`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ ...device, userAgent, viewport: SMALL, baseURL });
    await mockApi(context);
    const page = await context.newPage();
    await startTest(page);
    await expect(view(page)).toHaveAttribute('data-mic-view', 'inapp');
    await expectBigAndInView(page, page.getByRole(primary === 'Open in Chrome' ? 'link' : 'button', { name: primary }));
    await context.close();
  });
}

/** Every button, link and field on the mic screen is 48 px tall or more, all its words 18 px or more, and `main` is inside the screen without scrolling. */
async function expectBigAndInView(page: Page, main: Locator) {
  const small = await page.evaluate(() => {
    const root = document.querySelector('[data-mic-view]')!;
    const label = (el: Element) => (el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().slice(0, 40);
    return {
      targets: [...root.querySelectorAll('button, a, input')].filter((el) => el.getBoundingClientRect().height < 47.5).map(label),
      text: [...root.querySelectorAll('p, li, button, a, input')].filter((el) => parseFloat(getComputedStyle(el).fontSize) < 18).map(label),
    };
  });
  expect(small).toEqual({ targets: [], text: [] });
  const box = (await main.boundingBox())!;
  const screen = (await page.locator('[class*="screenInner"]').boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(screen.y);
  expect(box.y + box.height).toBeLessThanOrEqual(screen.y + screen.height);
  expect(box.height).toBeGreaterThanOrEqual(56 - 0.5);
}
