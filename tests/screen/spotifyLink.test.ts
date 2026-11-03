// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';
import {
  APP_WAIT_MS,
  handleSpotifyClick,
  isComputer,
  openInSpotify,
  spotifyAppUri,
  type ClickLike,
  type SpotifyLinkActions,
} from '../../src/lib/client/spotifyLink';

const TRACK = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC';
const TRACK_URI = 'spotify:track:4uLU6hMCjMI75M1A2tKUQC';

describe('spotifyAppUri', () => {
  it.each([
    [TRACK, TRACK_URI],
    [`${TRACK}?si=a1b2c3`, TRACK_URI],
    ['https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC', TRACK_URI],
    ['https://open.spotify.com/album/abc123', 'spotify:album:abc123'],
    ['https://open.spotify.com/artist/abc123', 'spotify:artist:abc123'],
    ['https://open.spotify.com/playlist/abc123', 'spotify:playlist:abc123'],
    ['https://open.spotify.com/episode/abc123', 'spotify:episode:abc123'],
    ['https://open.spotify.com/show/abc123', 'spotify:show:abc123'],
    // The offline mock client links to a search; the query stays percent-encoded.
    ['https://open.spotify.com/search/Queen%20Bohemian%20Rhapsody', 'spotify:search:Queen%20Bohemian%20Rhapsody'],
  ])('%s becomes %s', (webUrl, uri) => {
    expect(spotifyAppUri(webUrl)).toBe(uri);
  });

  it.each([
    '',
    'not a url',
    'https://example.com/track/abc123',
    'https://open.spotify.com.evil.example/track/abc123',
    'http://open.spotify.com/track/abc123',
    'https://open.spotify.com/',
    'https://open.spotify.com/track',
    'https://open.spotify.com/track/abc123/extra',
    'https://open.spotify.com/user/abc123',
    'https://open.spotify.com/track/a:b',
    'https://open.spotify.com/track/abc%0Adef',
  ])('has no app form for %j', (webUrl) => {
    expect(spotifyAppUri(webUrl)).toBeNull();
  });
});

describe('openInSpotify', () => {
  let actions: {
    isComputer: Mock<() => boolean>;
    launchApp: Mock<(uri: string) => void>;
    openTab: Mock<(url: string) => boolean>;
    goTo: Mock<(url: string) => void>;
  };
  let focused: MockInstance<() => boolean>;
  let visibility: MockInstance<() => DocumentVisibilityState>;

  beforeEach(() => {
    vi.useFakeTimers();
    actions = { isComputer: vi.fn(() => true), launchApp: vi.fn(), openTab: vi.fn(() => true), goTo: vi.fn() };
    focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });

  afterEach(() => {
    vi.runAllTimers(); // settle any attempt still waiting, so none leaks into the next test
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const open = (webUrl = TRACK) => openInSpotify(webUrl, actions satisfies SpotifyLinkActions);

  it('launches the app straight away and keeps the web player closed while it waits', () => {
    expect(open()).toBe(true);
    expect(actions.launchApp).toHaveBeenCalledExactlyOnceWith(TRACK_URI);
    vi.advanceTimersByTime(APP_WAIT_MS - 1);
    expect(actions.openTab).not.toHaveBeenCalled();
    expect(actions.goTo).not.toHaveBeenCalled();
  });

  it('opens the web player in a new tab when the page is still in front after the wait', () => {
    open();
    vi.advanceTimersByTime(APP_WAIT_MS);
    expect(actions.openTab).toHaveBeenCalledExactlyOnceWith(TRACK);
    expect(actions.goTo).not.toHaveBeenCalled();
  });

  it('loads the web player in this tab when the popup is blocked', () => {
    actions.openTab.mockReturnValue(false);
    open();
    vi.advanceTimersByTime(APP_WAIT_MS);
    expect(actions.goTo).toHaveBeenCalledExactlyOnceWith(TRACK);
  });

  it('does nothing more once the window loses focus: the app or its prompt took over', () => {
    open();
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(APP_WAIT_MS * 2);
    expect(actions.openTab).not.toHaveBeenCalled();
    expect(actions.goTo).not.toHaveBeenCalled();
  });

  it('does nothing more once the page is hidden', () => {
    open();
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    visibility.mockReturnValue('visible'); // even if it comes back before the wait is over
    vi.advanceTimersByTime(APP_WAIT_MS * 2);
    expect(actions.openTab).not.toHaveBeenCalled();
  });

  it('does nothing more once the page is left', () => {
    open();
    window.dispatchEvent(new Event('pagehide'));
    vi.advanceTimersByTime(APP_WAIT_MS * 2);
    expect(actions.openTab).not.toHaveBeenCalled();
  });

  it('does not open the web player over a page that is no longer in front', () => {
    open();
    focused.mockReturnValue(false);
    vi.advanceTimersByTime(APP_WAIT_MS);
    expect(actions.openTab).not.toHaveBeenCalled();

    open();
    focused.mockReturnValue(true);
    visibility.mockReturnValue('hidden');
    vi.advanceTimersByTime(APP_WAIT_MS);
    expect(actions.openTab).not.toHaveBeenCalled();
  });

  it('leaves a link without an app form to the browser', () => {
    expect(open('https://example.com/track/abc123')).toBe(false);
    expect(open('')).toBe(false);
    vi.advanceTimersByTime(APP_WAIT_MS * 2);
    expect(actions.launchApp).not.toHaveBeenCalled();
    expect(actions.openTab).not.toHaveBeenCalled();
  });

  it('leaves a phone or tablet to the browser: its https link already opens the app', () => {
    actions.isComputer.mockReturnValue(false);
    expect(open()).toBe(false);
    vi.advanceTimersByTime(APP_WAIT_MS * 2);
    expect(actions.launchApp).not.toHaveBeenCalled();
    expect(actions.openTab).not.toHaveBeenCalled();
    expect(actions.goTo).not.toHaveBeenCalled();
  });

  it('opens the web player once when clicked twice: the second click replaces the first attempt', () => {
    open();
    vi.advanceTimersByTime(APP_WAIT_MS / 2);
    open();
    vi.advanceTimersByTime(APP_WAIT_MS * 2);
    expect(actions.launchApp).toHaveBeenCalledTimes(2);
    expect(actions.openTab).toHaveBeenCalledTimes(1);
  });

  it('works again for a click after an earlier attempt finished', () => {
    open();
    vi.advanceTimersByTime(APP_WAIT_MS);
    window.dispatchEvent(new Event('blur')); // too late to matter to the finished attempt
    open();
    vi.advanceTimersByTime(APP_WAIT_MS);
    expect(actions.openTab).toHaveBeenCalledTimes(2);
  });
});

describe('handleSpotifyClick', () => {
  const click = (over: Partial<Omit<ClickLike, 'preventDefault'>> = {}): ClickLike & { preventDefault: Mock } => ({
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    ...over,
  });
  const actions = (computer = true): SpotifyLinkActions => ({
    isComputer: () => computer,
    launchApp: vi.fn(),
    openTab: vi.fn(() => true),
    goTo: vi.fn(),
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it('sends a plain click through the app and stops the browser following the web link', () => {
    const e = click();
    const a = actions();
    handleSpotifyClick(e, TRACK, a);
    expect(a.launchApp).toHaveBeenCalledExactlyOnceWith(TRACK_URI);
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it.each([
    ['cmd-click', { metaKey: true }],
    ['ctrl-click', { ctrlKey: true }],
    ['shift-click', { shiftKey: true }],
    ['alt-click', { altKey: true }],
    ['middle click', { button: 1 }],
    ['an already handled click', { defaultPrevented: true }],
  ])('leaves %s to the browser', (_name, over) => {
    const e = click(over);
    const a = actions();
    handleSpotifyClick(e, TRACK, a);
    expect(a.launchApp).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('lets the browser follow a link that has no app form', () => {
    const e = click();
    const a = actions();
    handleSpotifyClick(e, 'https://example.com/song', a);
    expect(a.launchApp).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('lets the browser follow the link on a phone or tablet', () => {
    const e = click();
    const a = actions(false);
    handleSpotifyClick(e, TRACK, a);
    expect(a.launchApp).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe('isComputer', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia');
  });
  const setMedia = (matches: boolean) => {
    window.matchMedia = vi.fn(() => ({ matches }) as MediaQueryList);
  };

  it('is true when the main input can hover and point finely: a mouse or trackpad', () => {
    setMedia(true);
    expect(isComputer()).toBe(true);
    expect(window.matchMedia).toHaveBeenCalledWith('(hover: hover) and (pointer: fine)');
  });

  it('is false on a touch screen', () => {
    setMedia(false);
    expect(isComputer()).toBe(false);
  });

  it('is false where matchMedia does not exist', () => {
    expect(window.matchMedia).toBeUndefined();
    expect(isComputer()).toBe(false);
  });
});
