// End-to-end checks of the microphone step (QWW-50): the screens a singer meets between "Start" and the first
// note, in the browsers older singers are likely to use. Chromium stands in for all of them. A user agent changes
// what we say, not what the browser does, so each case sets the user agent of the browser it plays, and:
//   granted         Chromium's fake permission UI says yes to the question, and its fake microphone plays a tone
//   denied          getUserMedia refuses (or, closed without an answer, "Permission dismissed")
//   already granted the permission is set before the page opens
//   already blocked the Permissions API says "denied" before anyone asks
//   waiting         getUserMedia never answers (the browser's question is up, and nobody has tapped it)
// Once the microphone is on there is no screen of ours: the singer goes straight to the note.
// What a real iPhone and a real Android phone do with the same screens is checked by hand (the PR's review guide).

import { devices, expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { launchWithMic, writeTone } from './fakeMic';

const SCREENS = path.resolve('test-results/screens');
const iPhone = devices['iPhone 13'];
const pixel = devices['Pixel 7'];
/**
 * The smallest screen the mic step must work on: an iPhone SE with Safari's toolbars showing leaves a page about 375 by
 * 553 (its 667 is the whole screen). The same screens must also work with larger text, which is why the main button
 * stays at the bottom while the words scroll under it.
 */
const SMALL = { width: 375, height: 553 };
/** The phone the screenshots for review are taken on: 390 by 844, an iPhone 12 to 14 with no browser toolbars. */
const PHONE = { width: 390, height: 844 };

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

type Answer = 'allow' | 'deny' | 'dismiss' | 'hang';

/** getUserMedia says what `answer` says (the test can change it), and every microphone it hands out is kept. */
function controlMic(context: BrowserContext, answer: Answer) {
  return context.addInitScript((initial) => {
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const w = window as unknown as { __answer: string; __streams: MediaStream[] };
    w.__answer = initial;
    w.__streams = [];
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (w.__answer === 'hang') return new Promise<MediaStream>(() => {});
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

/** A tap: down and up back to back, with no wait between, so no sound is recorded to speak of. */
async function tap(page: Page, name: RegExp) {
  const box = (await page.getByRole('button', { name }).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

const lowNote = (page: Page) => page.getByRole('button', { name: 'Hold to record your lowest note' });
const view = (page: Page) => page.locator('[data-mic-view]');

/** How a button treats a finger that lands on it, as the browser applies it: the record button is held down, so it takes over the touch. */
const pressStyle = (button: Locator) =>
  button.evaluate((el) => {
    const style = getComputedStyle(el);
    return { touchAction: style.touchAction, userSelect: style.userSelect };
  });

/** What makes a round button look the way it does, as the browser draws it. */
const roundStyle = (button: Locator) =>
  button.evaluate((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      borderRadius: style.borderTopLeftRadius,
      borderWidth: style.borderTopWidth,
      borderColor: style.borderTopColor,
      background: style.backgroundColor,
      boxShadow: style.boxShadow,
    };
  });

test('first run on an iPhone: our screen, then the browser\'s question, and straight to the note', async ({ baseURL }) => {
  const browser = await launchWithMic(tone);
  const context = await browser.newContext({ ...iPhone, viewport: PHONE, baseURL });
  const api = await mockApi(context);
  const page = await context.newPage();
  await startTest(page);

  // Our own screen comes first: a title, one line, and a round button with a microphone on it. Nothing else.
  await expect(view(page)).toHaveAttribute('data-mic-view', 'prompt');
  await expect(page.getByText('Set up your microphone')).toBeVisible();
  await expect(page.getByText('Your phone will ask to use the microphone. Tap Allow.')).toBeVisible();
  await expect(view(page).getByRole('img')).toHaveCount(0);
  await expect(page.getByText(/voice stays/)).toHaveCount(0);
  await expect(view(page).getByRole('button')).toHaveCount(1);
  const turnOn = page.getByRole('button', { name: 'Turn on microphone' });
  await expect(turnOn).toBeEnabled();
  await page.waitForTimeout(900);
  await shot(page, '19-mic-prompt-iphone');
  // Everything fits, so the button sits where it falls, and there is no dark band behind it.
  await expect(page.locator('[class*="micMain"]')).toHaveCSS('background-image', 'none');
  const micStyle = await roundStyle(turnOn);
  expect(micStyle).toMatchObject({ width: 112, height: 112 });
  const micPress = await pressStyle(turnOn);

  // One tap asks; the fake permission UI says yes; and the note is next. No meter, nothing more to tap.
  await turnOn.click();
  await expect(lowNote(page)).toBeVisible();
  await expect(page.getByText(/hear you|Listening|ahh/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
  await page.waitForTimeout(1300);
  await shot(page, '26-low-note-after-mic-iphone');

  // The microphone button looks like the record button: the same size, ring, colour and glow.
  expect(await roundStyle(lowNote(page))).toEqual(micStyle);
  // What only the record button needs, because it is held down and not tapped, is still on it and not on the other.
  expect(await pressStyle(lowNote(page))).toEqual({ touchAction: 'none', userSelect: 'none' });
  expect(micPress.touchAction).not.toBe('none');
  await expect
    .poll(() => api.micEvents(), { timeout: 8000 })
    .toEqual([
      { name: 'mic_prompt_shown', props: { browser: 'ios-safari' } },
      { name: 'mic_granted', props: { via: 'prompt', browser: 'ios-safari' } },
    ]);
  await browser.close();
});

test('on Android Chrome it reads the same, and the events say which browser it was', async ({ baseURL }) => {
  const browser = await launchWithMic(tone);
  const context = await browser.newContext({ ...pixel, viewport: PHONE, baseURL });
  const api = await mockApi(context);
  const page = await context.newPage();
  await startTest(page);
  await expect(page.getByText('Set up your microphone')).toBeVisible();
  await expect(page.getByText('Your phone will ask to use the microphone. Tap Allow.')).toBeVisible();
  await expect(view(page).getByRole('img')).toHaveCount(0);
  await page.waitForTimeout(900);
  await shot(page, '21-mic-prompt-android');
  await page.getByRole('button', { name: 'Turn on microphone' }).click();
  await expect(lowNote(page)).toBeVisible();
  await expect.poll(() => api.micEvents(), { timeout: 8000 }).toEqual([
    { name: 'mic_prompt_shown', props: { browser: 'android-chrome' } },
    { name: 'mic_granted', props: { via: 'prompt', browser: 'android-chrome' } },
  ]);
  await browser.close();
});

test('on a computer it says "browser", and there is no dark band behind the button', async ({ browser, baseURL }) => {
  // As wide as the TV gets (880px), where a band behind the button runs the whole width of the screen. The project's
  // default is an iPhone, which `newContext` would carry over, so the computer is named in full.
  const context = await browser.newContext({ ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, baseURL });
  await mockApi(context);
  const page = await context.newPage();
  await startTest(page);
  await expect(view(page)).toHaveAttribute('data-mic-view', 'prompt');
  await expect(page.getByText('Your browser will ask to use the microphone. Tap Allow.')).toBeVisible();
  await expect(page.locator('[class*="micMain"]')).toHaveCSS('background-image', 'none');
  await page.waitForTimeout(900);
  await shot(page, '29-mic-prompt-desktop');
  await context.close();
});

test('while the browser\'s question is up the round button shows it waits, and after 12 seconds a reload is offered', async ({ baseURL }) => {
  test.setTimeout(45_000);
  const browser = await launchWithMic(tone);
  const context = await browser.newContext({ ...iPhone, viewport: PHONE, baseURL });
  await mockApi(context);
  await controlMic(context, 'hang');
  const page = await context.newPage();
  await startTest(page);
  const turnOn = page.getByRole('button', { name: 'Turn on microphone' });
  await turnOn.click();

  // The question is up and nothing has answered it: the same button, lit and pulsing, not tappable, with no words on it.
  await expect(view(page)).toHaveAttribute('data-mic-view', 'asking');
  await expect(turnOn).toBeDisabled();
  await expect(turnOn).toHaveAttribute('aria-busy', 'true');
  await expect(turnOn).toHaveText('');
  // Screen readers are told what the lit button shows everyone else.
  await expect(page.getByRole('status')).toHaveText('Waiting for your phone…');
  await expect(page.getByText('Set up your microphone')).toBeVisible();
  await expect(page.getByRole('button', { name: /Reload/ })).toHaveCount(0);
  await page.waitForTimeout(900);
  await shot(page, '20-mic-waiting-iphone');

  // The way out when the question never comes. It really reloads: the new page starts at the title screen.
  const reload = page.getByRole('button', { name: 'Nothing happened? Reload this page' });
  await expect(reload).toBeVisible({ timeout: 15_000 });
  await shot(page, '27-mic-waiting-reload-iphone');
  await page.evaluate(() => ((window as unknown as { __marker: string }).__marker = 'same document'));
  await reload.click();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __marker?: string }).__marker)).toBeUndefined();
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

test('a microphone the browser already allows skips our screen: straight to the low note', async ({ baseURL }) => {
  const browser = await launchWithMic(tone);
  const context = await browser.newContext({ ...pixel, baseURL });
  await context.grantPermissions(['microphone'], { origin: baseURL });
  const api = await mockApi(context);
  const page = await context.newPage();
  await startTest(page);

  // No tap, no meter, no screen of ours: the note.
  await expect(lowNote(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on microphone' })).toHaveCount(0);
  await expect(page.getByText(/hear you|Listening|ahh/)).toHaveCount(0);
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

test('"Reload this page" really reloads the page, which is how Safari comes to ask again', async ({ baseURL }) => {
  const browser = await launchWithMic(tone);
  const context = await browser.newContext({ ...iPhone, baseURL });
  await mockApi(context);
  await alreadyBlocked(context);
  const page = await context.newPage();
  await startTest(page);
  await expect(page.getByText('The microphone is blocked')).toBeVisible();
  // A marker that only survives while this document does.
  await page.evaluate(() => ((window as unknown as { __marker: string }).__marker = 'same document'));
  await page.getByRole('button', { name: 'Reload this page' }).click();
  // The new document starts again at the title screen.
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __marker?: string }).__marker)).toBeUndefined();
  await browser.close();
});

test('a microphone that goes away during the note shows "Set up your microphone" again, though the browser still says yes', async ({ baseURL }) => {
  const browser = await launchWithMic(tone);
  const context = await browser.newContext({ ...iPhone, viewport: PHONE, baseURL });
  await context.grantPermissions(['microphone'], { origin: baseURL });
  const api = await mockApi(context);
  await controlMic(context, 'allow');
  const page = await context.newPage();
  await startTest(page);
  await expect(lowNote(page)).toBeVisible();

  // Another app takes the microphone, or the permission is withdrawn: the browser ends the stream.
  await page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.forEach((s) => s.getTracks().forEach((t) => t.stop())));
  await hold(page, /lowest note/, 300);

  // Not a note that records nothing and says "try again" for ever, and not straight back on the note with no word, which
  // is what an allowed microphone would get if it opened by itself: our screen, whose tap starts the audio.
  await expect(view(page)).toHaveAttribute('data-mic-view', 'prompt');
  await expect(page.getByText('Set up your microphone')).toBeVisible();
  await expect(lowNote(page)).toHaveCount(0);
  await page.waitForTimeout(900);
  await shot(page, '28-mic-lost-iphone');
  await page.getByRole('button', { name: 'Turn on microphone' }).click();
  await expect(lowNote(page)).toBeVisible();
  await hold(page, /lowest note/, 1500);
  await expect(page.getByTestId('low-note')).toHaveText('A3');
  // One mic_granted for each grant: by itself the first time, by the tap the second, with our screen shown before it.
  await expect.poll(() => api.micEvents().map((e) => e.name), { timeout: 8000 }).toEqual(['mic_granted', 'mic_prompt_shown', 'mic_granted']);
  expect(api.micEvents().flatMap((e) => (e.props?.via ? [e.props.via] : []))).toEqual(['already', 'prompt']);
  await browser.close();
});

test('a quick tap on the record button says to hold a little longer, and stays on the note instead of going to the mic step', async ({ baseURL }) => {
  const browser = await launchWithMic(tone);
  const context = await browser.newContext({ ...iPhone, baseURL });
  await context.grantPermissions(['microphone'], { origin: baseURL });
  await mockApi(context);
  const page = await context.newPage();
  await startTest(page);
  await expect(lowNote(page)).toBeVisible();

  for (let i = 0; i < 2; i++) {
    await tap(page, /lowest note/);
    await expect(page.getByText('Try again and hold the note a little longer')).toBeVisible();
    await expect(view(page)).toHaveCount(0);
    await expect(lowNote(page)).toBeVisible();
  }
  await browser.close();
});

test('on a small phone the backdrop is on only while the steps scroll under the pinned button', async ({ baseURL }) => {
  const browser = await launchWithMic(tone);
  const context = await browser.newContext({ ...iPhone, viewport: SMALL, baseURL });
  await mockApi(context);
  await controlMic(context, 'deny');
  const page = await context.newPage();
  await startTest(page);
  await page.getByRole('button', { name: 'Turn on microphone' }).click();
  await expect(page.getByText('The microphone is blocked')).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText(/Still not working/)).toBeVisible();

  // The steps are longer than the screen (that is why the button is pinned), so words pass under it: it needs its backdrop.
  const scroller = page.locator('[class*="screenInner"]');
  const pinned = page.locator('[class*="micMain"]');
  expect(await scroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
  await expect(pinned).toHaveCSS('background-image', /linear-gradient/);
  await page.waitForTimeout(900);
  await shot(page, '30-mic-steps-pinned-button-small');

  // Scrolled to the end, the button is back in its place with nothing under it, so the backdrop goes...
  await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(pinned).toHaveCSS('background-image', 'none');
  // ...and comes back as soon as the words move under it again.
  await scroller.evaluate((el) => el.scrollTo(0, 0));
  await expect(pinned).toHaveCSS('background-image', /linear-gradient/);
  await browser.close();
});

// "Large touch targets (at least 48 px) and at least 18 px body text on these screens", and the one thing to tap on
// each is on the screen without scrolling, on the smallest phone: for the longest screens that is the sticky button.
const SCREENS_TO_CHECK: [string, 'iphone' | 'pixel', (context: BrowserContext, page: Page) => Promise<void>, string, string][] = [
  ['the prompt on an iPhone', 'iphone', async () => {}, 'prompt', 'Turn on microphone'],
  ['the prompt on Android', 'pixel', async () => {}, 'prompt', 'Turn on microphone'],
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
      // Anything with words in it (a field holds its words in a value): the round button has none, so no type to size.
      text: [...root.querySelectorAll('p, li, button, a, input')]
        .filter((el) => el.tagName === 'INPUT' || (el.textContent ?? '').trim() !== '')
        .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 18)
        .map(label),
    };
  });
  expect(small).toEqual({ targets: [], text: [] });
  const box = (await main.boundingBox())!;
  const screen = (await page.locator('[class*="screenInner"]').boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(screen.y);
  expect(box.y + box.height).toBeLessThanOrEqual(screen.y + screen.height);
  expect(box.height).toBeGreaterThanOrEqual(56 - 0.5);
}
