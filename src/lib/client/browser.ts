// Which browser this is, read from its user agent, for the microphone step (QWW-50): where the browser's own
// permission box appears, which settings to point to, and whether the page sits inside another app's built-in
// browser, which often cannot use the microphone at all.
//
// A user agent is a claim, not a fact, and apps change theirs without notice, so every answer here is a best
// guess. The screens soften it: the in-app screen always has "Try here anyway".

export type Os = 'ios' | 'android' | 'other';
export type BrowserName = 'safari' | 'chrome' | 'other';
/** Apps whose built-in browser we know by name; 'webview' is one we only recognise as somebody's webview. */
export type InApp = 'instagram' | 'facebook' | 'messenger' | 'linkedin' | 'tiktok' | 'snapchat' | 'line' | 'wechat' | 'webview';

export interface BrowserInfo {
  os: Os;
  /** Safari and Chrome are told apart because their permission boxes and settings differ; 'other' is the rest, and every in-app browser. */
  browser: BrowserName;
  /** The app whose built-in browser this is, or null in a real browser. */
  inApp: InApp | null;
}

export interface BrowserHints {
  /** navigator.maxTouchPoints: an iPad asks for desktop sites and sends a Mac's user agent, so touch tells the two apart. */
  maxTouchPoints?: number;
  /** navigator.standalone: a site added to the iPhone's home screen has no "Safari" in its user agent, but it is not a webview. */
  standalone?: boolean;
}

// In order: Messenger's user agent carries Facebook's tokens too.
const IN_APPS: [Exclude<InApp, 'webview'>, RegExp][] = [
  ['messenger', /FBAN\/Messenger|FB_IAB\/(?:Orca-Android|Messenger)/i],
  ['instagram', /\bInstagram\b/],
  ['facebook', /\bFBAN\/|\bFBAV\/|\bFB_IAB\//],
  ['linkedin', /LinkedInApp/i],
  ['tiktok', /musical_ly|\bTikTok\b|BytedanceWebview/i],
  ['snapchat', /\bSnapchat\b/],
  ['line', /\bLine\/\d/],
  ['wechat', /MicroMessenger/],
];

export function detectBrowser(ua: string, hints: BrowserHints = {}): BrowserInfo {
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (hints.maxTouchPoints ?? 0) > 1);
  const android = !ios && /Android/.test(ua);
  const os: Os = ios ? 'ios' : android ? 'android' : 'other';

  const named = IN_APPS.find(([, pattern]) => pattern.test(ua));
  if (named) return { os, browser: 'other', inApp: named[0] };

  if (ios) {
    // A webview (what in-app browsers use) sends neither "Version/" nor "Safari/"; Chrome, Firefox and the
    // others on iPhone are webviews too, but they send "Safari/".
    if (!/Safari\//.test(ua) && !hints.standalone) return { os, browser: 'other', inApp: 'webview' };
    if (/CriOS/.test(ua)) return { os, browser: 'chrome', inApp: null };
    if (/FxiOS|EdgiOS|OPiOS|OPT\/|DuckDuckGo/.test(ua)) return { os, browser: 'other', inApp: null };
    return { os, browser: 'safari', inApp: null };
  }
  if (android) {
    // Android's WebView announces itself with "; wv)".
    if (/;\s*wv\)/.test(ua)) return { os, browser: 'other', inApp: 'webview' };
    const chrome = /Chrome\//.test(ua) && !/EdgA|OPR\/|SamsungBrowser|DuckDuckGo|Firefox|Vivaldi|YaBrowser|UCBrowser/.test(ua);
    return { os, browser: chrome ? 'chrome' : 'other', inApp: null };
  }
  return { os, browser: 'other', inApp: null };
}

/** One short word for the event log: 'ios-safari', 'ios-chrome', 'ios-other', 'android-chrome', 'android-other' or 'other'. */
export function browserLabel(info: BrowserInfo): string {
  return info.os === 'other' ? 'other' : `${info.os}-${info.browser}`;
}

/**
 * A link that asks Android to open this page in Chrome. From an in-app browser it leaves the app; with no
 * Chrome on the phone, Android loads the fallback address, which is this page again.
 */
export function chromeIntentUrl(href: string): string {
  const url = new URL(href);
  return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=${url.protocol.replace(':', '')};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(href)};end`;
}
