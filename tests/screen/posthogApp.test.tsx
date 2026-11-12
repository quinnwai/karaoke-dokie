// @vitest-environment jsdom
// PostHog wired into the screen (QWW-51): the screen builds the tracker with PostHog behind it only when it is given
// the settings, the device's own id goes to PostHog, and session replay runs only for a visitor who is signed out.
// posthog-js itself is faked here (tests/screen/posthogLibrary.test.ts runs the real one).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KaraokeApp } from '../../src/components/KaraokeApp';
import type { Api } from '../../src/lib/client/api';
import type { Mic } from '../../src/lib/client/mic';
import type { EventsRequest, MeResponse, PostHogSettings, VocalRange } from '../../src/lib/contracts';
import { POSTHOG_PROXY_PATH } from '../../src/lib/postHogProxy';
import { allMatches, knownSongs, me, recommendationsPage } from '../fixtures/screen';

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  startSessionRecording: vi.fn(),
  stopSessionRecording: vi.fn(),
}));
vi.mock('posthog-js', () => ({ default: posthog }));

const SETTINGS: PostHogSettings = { key: 'phc_testtoken', host: POSTHOG_PROXY_PATH, uiHost: 'https://us.posthog.com', environment: 'production' };

function fakeApi(user: MeResponse | null) {
  let current = user;
  return {
    me: vi.fn(async () => current),
    logout: vi.fn(async () => {
      current = null;
    }),
    saveRange: vi.fn(async (_range: VocalRange) => {}),
    recommendations: vi.fn(async (offset: number) => recommendationsPage(offset)),
    allRecommendations: vi.fn(async () => allMatches()),
    catalogue: vi.fn(async () => allMatches()),
    knownSongs: vi.fn(async () => knownSongs()),
    feedback: vi.fn(async () => {}),
    catalogueFeedback: vi.fn(async () => {}),
  } satisfies Api;
}

const mic: Mic = { permission: async () => 'prompt', open: async () => Promise.reject(new Error('no mic in this test')) };
const captured = () => posthog.capture.mock.calls.map(([name]) => name as string);

/** The tracker's own log posts to /api/events; nothing here is listening, so the requests are what it recorded. */
const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 204 }));
const logRequests = () => fetchMock.mock.calls.map((call, i) => ({ url: call[0], body: (call[1] as { body?: string } | undefined)?.body ?? '', order: fetchMock.mock.invocationCallOrder[i]! })).filter((r) => r.url === '/api/events');
const loggedNames = () => logRequests().flatMap((r) => (JSON.parse(r.body) as EventsRequest).events.map((e) => e.name));

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  for (const fn of Object.values(posthog)) fn.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('KaraokeApp with PostHog', () => {
  it('sends the title view to PostHog under the device id, and records the replay once it knows the visitor is signed out', async () => {
    render(<KaraokeApp api={fakeApi(null)} mic={mic} postHog={SETTINGS} />);
    await screen.findByRole('button', { name: 'Start' });
    await waitFor(() => expect(captured()).toContain('title_view'));

    expect(posthog.init).toHaveBeenCalledTimes(1);
    const [token, config] = posthog.init.mock.calls[0]!;
    expect(token).toBe('phc_testtoken');
    // Our own origin, not PostHog's: a blocker that refuses *.posthog.com cannot hide it (QWW-63).
    expect(config.api_host).toBe(POSTHOG_PROXY_PATH);
    expect(config.ui_host).toBe('https://us.posthog.com');
    // The device's own random id, the one the event log keeps, is the distinct id.
    const deviceId = localStorage.getItem('kd.anonId')!;
    expect(deviceId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(config.bootstrap).toEqual({ distinctID: deviceId });
    await waitFor(() => expect(posthog.startSessionRecording).toHaveBeenCalledTimes(1));

    // The rest of the flow follows through the same tracker.
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(captured()).toEqual(expect.arrayContaining(['start_pressed', 'quiet_shown'])));
  });

  it('never starts the replay for a signed-in visitor, whose screen shows their Spotify name and songs', async () => {
    render(<KaraokeApp api={fakeApi(me({ low: 45, high: 72, source: 'test' }))} mic={mic} postHog={SETTINGS} />);
    await screen.findByText('Plastic Love');
    await waitFor(() => expect(captured()).toContain('list_view'));
    await act(async () => {});
    expect(posthog.startSessionRecording).not.toHaveBeenCalled();
    // The events still go: they carry no name and no library song.
    expect(captured()).toContain('list_view');
    expect(JSON.stringify(posthog.capture.mock.calls)).not.toMatch(/Quinn|Plastic Love|Yoru/);
  });

  it('starts the replay only after Log out, and not before', async () => {
    render(<KaraokeApp api={fakeApi(me({ low: 45, high: 72, source: 'test' }))} mic={mic} postHog={SETTINGS} />);
    await screen.findByText('Plastic Love');
    await act(async () => {});
    expect(posthog.startSessionRecording).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Spotify account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connect to Spotify' })).toHaveLength(2));
    await waitFor(() => expect(posthog.startSessionRecording).toHaveBeenCalledTimes(1));
  });

  it('has the Spotify connect press in both our log and PostHog before the page leaves', async () => {
    sessionStorage.setItem('kd.test', JSON.stringify({ low: 45, high: 72 }));
    const navigate = vi.fn();
    render(<KaraokeApp api={fakeApi(null)} mic={mic} navigate={navigate} postHog={SETTINGS} pickSongs />);
    // PostHog has loaded once it has taken this screen's first event.
    await waitFor(() => expect(captured()).toContain('range_shown'));
    fireEvent.click(await screen.findByRole('button', { name: 'or use songs from your Spotify' }));
    expect(navigate).toHaveBeenCalledWith('/api/auth/login');
    const left = navigate.mock.invocationCallOrder[0]!;

    const posthogCall = posthog.capture.mock.calls.findIndex(([name]) => name === 'spotify_connect');
    expect(posthogCall).toBeGreaterThanOrEqual(0);
    expect(posthog.capture.mock.invocationCallOrder[posthogCall]!).toBeLessThan(left);
    // Our log's flush starts its request at once, so that went out before the page was left too.
    const logged = logRequests().find((r) => r.body.includes('spotify_connect'));
    expect(logged).toBeTruthy();
    expect(logged!.order).toBeLessThan(left);
    expect(captured()).not.toContain('spotify_connect_pressed');
  });

  it('does not touch PostHog without settings', async () => {
    render(<KaraokeApp api={fakeApi(null)} mic={mic} />);
    await screen.findByRole('button', { name: 'Start' });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await act(async () => {});
    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
    expect(posthog.startSessionRecording).not.toHaveBeenCalled();
  });

  it('does not touch PostHog when a tracker is passed in (tests, previews of other tickets)', async () => {
    const track = { track: vi.fn(), flush: async () => {} };
    render(<KaraokeApp api={fakeApi(null)} mic={mic} track={track} postHog={SETTINGS} />);
    await screen.findByRole('button', { name: 'Start' });
    expect(track.track).toHaveBeenCalledWith('title_view', undefined);
    await act(async () => {});
    expect(posthog.init).not.toHaveBeenCalled();
  });

  it('still works, and our log still gets the events, when posthog-js is broken', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      posthog.init.mockImplementationOnce(() => {
        throw new Error('bad token');
      });
      render(<KaraokeApp api={fakeApi(null)} mic={mic} postHog={SETTINGS} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
      await screen.findByRole('button', { name: 'Find a quiet spot. Tap to continue' });
      await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      expect(posthog.capture).not.toHaveBeenCalled();
      // The page going away sends what our log recorded, PostHog or not.
      window.dispatchEvent(new Event('pagehide'));
      await waitFor(() => expect(loggedNames()).toEqual(expect.arrayContaining(['title_view', 'start_pressed'])));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('a preview starting to play (row_play, QWW-48)', () => {
  /** The page's matches, each with a Deezer track so its play button is on, and ids chosen by `idOf`. */
  const withPreviews = (page: ReturnType<typeof allMatches>, idOf: (i: number, id: string, title: string, artist: string) => string) => ({
    ...page,
    matches: page.matches.map((m, i) => ({ ...m, track: { ...m.track, id: idOf(i, m.track.id, m.track.title, m.track.artist) }, deezerId: 7000 + i })),
  });

  // jsdom has no media stack: the page's one <audio> plays, and says so, when asked.
  beforeEach(() => {
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { value: false, configurable: true });
      queueMicrotask(() => this.dispatchEvent(new Event('playing')));
      return Promise.resolve();
    });
    vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(window.HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup(); // the rows going away stop their preview: before the stand-ins for jsdom's missing media calls go
    vi.restoreAllMocks();
  });

  const rowPlays = () => posthog.capture.mock.calls.filter(([name]) => name === 'row_play');

  it("reaches PostHog and our log with the row's place and a catalogue song's key, once the sound starts", async () => {
    const api = fakeApi(null);
    const page = withPreviews(allMatches(), (_i, _id, title, artist) => `cat:${artist.toLowerCase()}|${title.toLowerCase()}`);
    api.catalogue.mockImplementation(async () => page);
    sessionStorage.setItem('kd.test', JSON.stringify({ low: 45, high: 72 }));
    render(<KaraokeApp api={api} mic={mic} postHog={SETTINGS} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const plays = await screen.findAllByRole('button', { name: /^Play / });
    const second = plays[1]!;
    const label = second.getAttribute('aria-label'); // it reads "Pause ..." once the song plays
    fireEvent.click(second);

    await waitFor(() => expect(rowPlays()).toHaveLength(1));
    const played = page.matches.find((m) => `Play ${m.track.title} by ${m.track.artist}` === label)!;
    expect(rowPlays()[0]![1]).toEqual({ position: 2, songKey: played.track.id.slice(4) });

    // Our own log has it too.
    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() => expect(loggedNames()).toContain('row_play'));
  });

  it('carries only the place for a song from the singer’s Spotify library, never its id or title', async () => {
    const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    const page = withPreviews(allMatches(), (i) => `4uLU6hMCjMI75M1A2tKUQ${i}`);
    api.allRecommendations.mockImplementation(async () => page);
    render(<KaraokeApp api={api} mic={mic} postHog={SETTINGS} />);
    const plays = await screen.findAllByRole('button', { name: /^Play / });
    fireEvent.click(plays[0]!);

    await waitFor(() => expect(rowPlays()).toHaveLength(1));
    expect(rowPlays()[0]![1]).toEqual({ position: 1 });
    expect(JSON.stringify(posthog.capture.mock.calls)).not.toMatch(/4uLU6h|Plastic Love|Mariya/);
    // The visitor is signed in, so there is no replay of this screen.
    expect(posthog.startSessionRecording).not.toHaveBeenCalled();
  });

  it('is not sent for a tap that starts nothing: a play button with no preview is disabled', async () => {
    render(<KaraokeApp api={fakeApi(me({ low: 45, high: 72, source: 'test' }))} mic={mic} postHog={SETTINGS} />);
    const buttons = await screen.findAllByRole('button', { name: /^No preview of / });
    fireEvent.click(buttons[0]!);
    await act(async () => {});
    expect(rowPlays()).toHaveLength(0);
  });
});

