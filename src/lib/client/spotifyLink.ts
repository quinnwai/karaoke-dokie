// "Open in Spotify": offer the Spotify app first, then fall back to the web player.
//
// A link to open.spotify.com only ever opens the web player on a computer. A spotify: link hands
// the song to the app instead: the browser asks "Open Spotify?". Browsers don't tell a page when
// the app is missing or the prompt was declined, so after launching we wait a moment. If this
// page is still in front, the app did not take over and the song opens on the web.

/** How long to wait for the app to take over before the web player opens. */
export const APP_WAIT_MS = 1500;

const WEB_HOST = 'open.spotify.com';
const KINDS = new Set(['track', 'album', 'artist', 'playlist', 'episode', 'show']);

/** https://open.spotify.com/track/ID becomes spotify:track:ID. Null for anything else. */
export function spotifyAppUri(webUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(webUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== WEB_HOST) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0]?.startsWith('intl-')) parts.shift(); // locale prefix, as in /intl-de/track/ID
  const [kind, id, ...extra] = parts;
  if (!kind || !id || extra.length > 0) return null;
  if (kind === 'search') return `spotify:search:${id}`; // the mock client links to a search; id is already encoded
  return KINDS.has(kind) && /^[A-Za-z0-9]+$/.test(id) ? `spotify:${kind}:${id}` : null;
}

/**
 * A computer with a mouse or trackpad, as opposed to a phone or tablet. Only computers get the
 * app-first click. On a phone the https link already opens the Spotify app when it is installed
 * (universal links on iPhone, app links on Android), and a spotify: address is the riskier route
 * there: iPhone asks for confirmation, and Chrome on Android shows an error page if the app is missing.
 */
export function isComputer(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

/** What a click does to the browser, so tests can watch it instead of a real one. */
export interface SpotifyLinkActions {
  /** Whether to try the app first at all. */
  isComputer(): boolean;
  /** Hands the page to the Spotify app. */
  launchApp(uri: string): void;
  /** Opens the web player in a new tab. False when the browser blocked the popup. */
  openTab(url: string): boolean;
  /** Loads the web player in this tab. */
  goTo(url: string): void;
}

const browserActions: SpotifyLinkActions = {
  isComputer,
  launchApp: (uri) => {
    window.location.href = uri;
  },
  openTab: (url) => {
    // Not "noopener": that makes window.open return null even when the tab opened, which would
    // hide a blocked popup. The link between the tabs is cut by hand instead.
    const tab = window.open(url, '_blank');
    if (!tab) return false;
    tab.opener = null;
    return true;
  },
  goTo: (url) => window.location.assign(url),
};

let cancelPending: (() => void) | undefined;

/**
 * Tries the app for a Spotify web link, and opens the web player if the app doesn't take over.
 * False when this click isn't ours (no app form for the link, or not a computer); the caller then
 * lets the browser follow the link as usual.
 */
export function openInSpotify(webUrl: string, actions: SpotifyLinkActions = browserActions): boolean {
  const uri = spotifyAppUri(webUrl);
  if (!uri || !actions.isComputer()) return false;

  cancelPending?.(); // a second click replaces the first attempt, so the web player opens at most once

  // Losing focus, hiding or leaving the page means the app (or its prompt) took over.
  let tookOver = false;
  const leave = () => {
    tookOver = true;
  };
  const hide = () => {
    if (document.visibilityState === 'hidden') leave();
  };
  window.addEventListener('blur', leave);
  window.addEventListener('pagehide', leave);
  document.addEventListener('visibilitychange', hide);

  const stop = () => {
    clearTimeout(timer);
    window.removeEventListener('blur', leave);
    window.removeEventListener('pagehide', leave);
    document.removeEventListener('visibilitychange', hide);
    if (cancelPending === stop) cancelPending = undefined;
  };
  const timer = setTimeout(() => {
    stop();
    const inFront = !tookOver && document.visibilityState === 'visible' && document.hasFocus();
    if (inFront && !actions.openTab(webUrl)) actions.goTo(webUrl);
  }, APP_WAIT_MS);
  cancelPending = stop;

  actions.launchApp(uri);
  return true;
}

/** The parts of a click that decide whether the link is ours to handle. */
export interface ClickLike {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

/**
 * onClick for the "Open in Spotify" link, whose href stays the web URL. Only a plain click on a
 * computer goes through the app; new-tab and new-window clicks, and phones, keep the browser's
 * own behavior.
 */
export function handleSpotifyClick(e: ClickLike, webUrl: string, actions?: SpotifyLinkActions): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (openInSpotify(webUrl, actions)) e.preventDefault();
}
