import { describe, expect, it } from 'vitest';
import { browserLabel, chromeIntentUrl, detectBrowser, type BrowserInfo } from '../../src/lib/client/browser';

// Representative user agents, written out in the shapes these browsers and apps are known to send. They are not
// captures from particular devices (apps change theirs without notice), so what really proves the detection is
// opening the link from each app on a real phone (QWW-50's review guide).
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UP1A.231105.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.6422.52 Mobile Safari/537.36';

const REAL: [string, string, Partial<BrowserInfo>][] = [
  ['Safari on iPhone', `${IOS} Version/17.5 Mobile/15E148 Safari/604.1`, { os: 'ios', browser: 'safari' }],
  ['Chrome on iPhone', `${IOS} CriOS/125.0.6422.80 Mobile/15E148 Safari/604.1`, { os: 'ios', browser: 'chrome' }],
  ['Firefox on iPhone', `${IOS} FxiOS/126.0 Mobile/15E148 Safari/605.1.15`, { os: 'ios', browser: 'other' }],
  ['Edge on iPhone', `${IOS} EdgiOS/125.0.2535.60 Version/17.0 Mobile/15E148 Safari/604.1`, { os: 'ios', browser: 'other' }],
  ['Chrome on Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.52 Mobile Safari/537.36', { os: 'android', browser: 'chrome' }],
  [
    'Samsung Internet',
    'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
    { os: 'android', browser: 'other' },
  ],
  ['Firefox on Android', 'Mozilla/5.0 (Android 14; Mobile; rv:126.0) Gecko/126.0 Firefox/126.0', { os: 'android', browser: 'other' }],
  ['Edge on Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 EdgA/125.0.0.0', { os: 'android', browser: 'other' }],
  ['Chrome on a computer', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', { os: 'other', browser: 'other' }],
];

const IN_APP: [string, string, BrowserInfo['inApp'], 'ios' | 'android'][] = [
  [
    'Instagram on iPhone',
    `${IOS} Mobile/21F90 Instagram 336.0.0.35.121 (iPhone14,5; iOS 17_5; en_US; en-US; scale=3.00; 1170x2532; 599165981)`,
    'instagram',
    'ios',
  ],
  ['Instagram on Android', `${ANDROID} Instagram 336.0.0.40.109 Android (34/14; 420dpi; 1080x2400; Google/google; Pixel 7; panther; panther; en_US; 599165981)`, 'instagram', 'android'],
  [
    'Facebook on iPhone',
    `${IOS} Mobile/15E148 [FBAN/FBIOS;FBAV/464.0.0.34.114;FBBV/596013891;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5;FBRV/0]`,
    'facebook',
    'ios',
  ],
  ['Facebook on Android', `${ANDROID} [FB_IAB/FB4A;FBAV/464.0.0.42.114;]`, 'facebook', 'android'],
  [
    'Messenger on iPhone',
    `${IOS} Mobile/15E148 [FBAN/MessengerForiOS;FBAV/460.0.0.37.109;FBBV/592000000;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]`,
    'messenger',
    'ios',
  ],
  ['Messenger on Android', `${ANDROID} [FB_IAB/Orca-Android;FBAV/460.0.0.37.109;]`, 'messenger', 'android'],
  ['LinkedIn on iPhone', `${IOS} Mobile/15E148 LinkedInApp/9.30.1234`, 'linkedin', 'ios'],
  ['LinkedIn on Android', `${ANDROID} LinkedInApp/4.1.950`, 'linkedin', 'android'],
  ['TikTok on iPhone', `${IOS} Mobile/15E148 musical_ly_35.1.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/US`, 'tiktok', 'ios'],
  ['Snapchat on iPhone', `${IOS} Mobile/15E148 Snapchat/12.89.0.45 (like Safari/8617.1.17.10.9, panda)`, 'snapchat', 'ios'],
  ['LINE on iPhone', `${IOS} Mobile/15E148 Safari Line/13.8.0`, 'line', 'ios'],
  ['WeChat on Android', `${ANDROID} MicroMessenger/8.0.47.2560 WeChat/arm64 Weixin NetType/WIFI Language/en`, 'wechat', 'android'],
  // Apps we do not know by name, still recognised as somebody's built-in browser.
  ['an unnamed iPhone webview (no "Safari" in the user agent)', `${IOS} Mobile/15E148`, 'webview', 'ios'],
  ['an unnamed Android webview ("; wv)")', ANDROID, 'webview', 'android'],
];

describe('detectBrowser', () => {
  it.each(REAL)('%s is a real browser, not an app', (_name, ua, expected) => {
    expect(detectBrowser(ua)).toEqual({ inApp: null, ...expected });
  });

  it.each(IN_APP)('%s is inside an app', (_name, ua, app, os) => {
    expect(detectBrowser(ua)).toEqual({ os, browser: 'other', inApp: app });
  });

  it('knows an iPad that sends a Mac user agent by its touch screen', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
    expect(detectBrowser(mac, { maxTouchPoints: 5 })).toEqual({ os: 'ios', browser: 'safari', inApp: null });
    expect(detectBrowser(mac, { maxTouchPoints: 0 })).toEqual({ os: 'other', browser: 'other', inApp: null });
    expect(detectBrowser(mac)).toEqual({ os: 'other', browser: 'other', inApp: null });
  });

  it('does not call a site added to the iPhone home screen an app (it has no "Safari" either)', () => {
    expect(detectBrowser(`${IOS} Mobile/15E148`, { standalone: true })).toEqual({ os: 'ios', browser: 'safari', inApp: null });
  });

  it('Messenger is not mistaken for Facebook, though it sends Facebook tokens too', () => {
    expect(detectBrowser(`${IOS} Mobile/15E148 [FBAN/MessengerForiOS;FBAV/460.0.0.37.109]`).inApp).toBe('messenger');
    expect(detectBrowser(`${ANDROID} [FB_IAB/Orca-Android;FBAV/1;FB_IAB/FB4A]`).inApp).toBe('messenger');
  });

  it('copes with an empty or odd user agent', () => {
    expect(detectBrowser('')).toEqual({ os: 'other', browser: 'other', inApp: null });
    expect(detectBrowser('curl/8.0')).toEqual({ os: 'other', browser: 'other', inApp: null });
  });
});

describe('browserLabel', () => {
  it('is one short word for the event log', () => {
    expect(browserLabel({ os: 'ios', browser: 'safari', inApp: null })).toBe('ios-safari');
    expect(browserLabel({ os: 'android', browser: 'chrome', inApp: null })).toBe('android-chrome');
    expect(browserLabel({ os: 'ios', browser: 'other', inApp: 'instagram' })).toBe('ios-other');
    expect(browserLabel({ os: 'other', browser: 'other', inApp: null })).toBe('other');
  });
});

describe('chromeIntentUrl', () => {
  it('asks Android for Chrome, and falls back to this page', () => {
    const href = 'https://karaoke-dokie.vercel.app/?utm=1';
    expect(chromeIntentUrl(href)).toBe(
      `intent://karaoke-dokie.vercel.app/?utm=1#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(href)};end`,
    );
  });

  it('keeps a port and a path (a preview or a local address)', () => {
    expect(chromeIntentUrl('http://192.168.1.5:3000/test')).toBe(
      `intent://192.168.1.5:3000/test#Intent;scheme=http;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent('http://192.168.1.5:3000/test')};end`,
    );
  });
});
