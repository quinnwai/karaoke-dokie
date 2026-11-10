// @vitest-environment jsdom
// PostHog wired into the screen (QWW-51): the screen builds the tracker with PostHog behind it only when it is given
// the settings, the device's own id goes to PostHog, and session replay runs only for a visitor who is signed out.
// posthog-js itself is faked here (tests/screen/posthogLibrary.test.ts runs the real one).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KaraokeApp } from '../../src/components/KaraokeApp';
import type { Api } from '../../src/lib/client/api';
import type { Mic } from '../../src/lib/client/mic';
import type { PostHogSettings } from '../../src/lib/client/posthog';
import type { MeResponse, VocalRange } from '../../src/lib/contracts';
import { allMatches, knownSongs, me, recommendationsPage } from '../fixtures/screen';

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  startSessionRecording: vi.fn(),
  stopSessionRecording: vi.fn(),
}));
vi.mock('posthog-js', () => ({ default: posthog }));

const SETTINGS: PostHogSettings = { key: 'phc_testtoken', host: 'https://us.i.posthog.com', environment: 'production' };

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

const mic: Mic = { open: async () => Promise.reject(new Error('no mic in this test')) };
const captured = () => posthog.capture.mock.calls.map(([name]) => name as string);

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  // The tracker's own log would post to /api/events; nothing here is listening.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
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
    expect(config.api_host).toBe('https://us.i.posthog.com');
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

  it('puts the Spotify connect press in PostHog before the page leaves', async () => {
    sessionStorage.setItem('kd.test', JSON.stringify({ low: 45, high: 72 }));
    const navigate = vi.fn();
    render(<KaraokeApp api={fakeApi(null)} mic={mic} navigate={navigate} postHog={SETTINGS} pickSongs />);
    fireEvent.click(await screen.findByRole('button', { name: 'or use songs from your Spotify' }));
    expect(navigate).toHaveBeenCalledWith('/api/auth/login');
    await waitFor(() => expect(captured()).toContain('spotify_connect'));
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

  it('still works, and still logs, when posthog-js is broken', async () => {
    posthog.init.mockImplementationOnce(() => {
      throw new Error('bad token');
    });
    render(<KaraokeApp api={fakeApi(null)} mic={mic} postHog={SETTINGS} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    await waitFor(() => expect(posthog.init).toHaveBeenCalledTimes(1));
    await screen.findByRole('button', { name: 'Find a quiet spot. Tap to continue' });
    expect(posthog.capture).not.toHaveBeenCalled();
  });
});
