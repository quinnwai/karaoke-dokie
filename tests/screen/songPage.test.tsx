// @vitest-environment jsdom
// The song page, and what the browser's Back button and a second tap do around it (the second adversarial review of PR #38, QWW-57):
//   1. a song page opened while a re-rank is pending stays open, with the match it was opened with, whatever the new list holds
//   2. opening a song pushes a history entry, and the system Back closes the page like the page's own ‹ Back, tuning kept
//   3. the mic and note steps of a redo show "Back to songs" (keeps the old range and the tuning), and the system Back does the same;
//      the very first test, with no range yet, has no such button and pushes nothing
// Layout and a real phone's Back are tests/e2e/setlist-back.spec.ts's; here is the app's behaviour with jsdom's own History API.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KaraokeApp } from '../../src/components/KaraokeApp';
import type { Api } from '../../src/lib/client/api';
import type { Mic, MicRecorder } from '../../src/lib/client/mic';
import { OVERLAY_STATE_KEY } from '../../src/lib/client/useOverlayHistory';
import type { MeResponse, RecommendationsResponse, VocalRange } from '../../src/lib/contracts';
import type { SetlistEngine } from '../../src/lib/setlist/engine';
import type { SetlistResponse } from '../../src/lib/setlist/types';
import { allMatches, knownSongs, me, recommendationsPage } from '../fixtures/screen';
import { el, ranked, response, rowIds, SEL } from '../helpers/setlist';

const RANGE = { low: 45, high: 72, source: 'test' as const };

function fakeApi(user: MeResponse | null, page: () => RecommendationsResponse = () => allMatches()) {
  let current = user;
  return {
    me: vi.fn(async () => current),
    logout: vi.fn(async () => {
      current = null;
    }),
    saveRange: vi.fn(async (range: VocalRange) => {
      if (current) current = { ...current, range };
    }),
    recommendations: vi.fn(async (offset: number) => recommendationsPage(offset)),
    allRecommendations: vi.fn(async () => page()),
    catalogue: vi.fn(async () => page()),
    knownSongs: vi.fn(async () => knownSongs()),
    feedback: vi.fn(async (_body: Parameters<Api['feedback']>[0]) => {}),
    catalogueFeedback: vi.fn(async () => {}),
  } satisfies Api;
}

/** A microphone that is on once asked, and hears nothing: enough to reach the note step. */
const recorder: MicRecorder = {
  sampleRate: 44100,
  reset: () => {},
  latest: () => new Float32Array(0),
  take: () => new Float32Array(0),
  live: () => true,
  running: () => true,
  resume: () => {},
  close: () => {},
};
const mic: Mic = { permission: async () => 'prompt', open: async () => recorder };

const inOrder = (page: RecommendationsResponse, without: string[] = []): SetlistResponse =>
  response(page.matches.filter((m) => !without.includes(m.track.id)).map((m) => ranked(m)));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Lets jsdom's History API finish a traversal (it is asynchronous) and the app answer its popstate. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
const pathNow = () => window.location.pathname + window.location.search;
const overlayNow = () => (window.history.state as Record<string, unknown> | null)?.[OVERLAY_STATE_KEY];
const row = (title: RegExp) => screen.findByRole('button', { name: title });
const songPageOpen = (title: string) => screen.queryByRole('heading', { level: 2, name: title }) !== null;
const tunerOpen = () => document.querySelector(SEL.sheet) !== null;
const back = () => screen.getByRole('button', { name: 'Back to songs' });

/** A signed-in singer on the tuner, tuned: Difficulty at 80 and the 80s picked, so there is something to keep. */
async function onTheTuner(opts: { engine: SetlistEngine; api?: ReturnType<typeof fakeApi>; quietMs?: number; mic?: Mic }) {
  const api = opts.api ?? fakeApi(me(RANGE));
  const track = { track: vi.fn(), flush: async () => {} };
  render(<KaraokeApp api={api} track={track} mic={opts.mic ?? mic} quietMs={opts.quietMs ?? 5} setlistEngine={opts.engine} />);
  await screen.findByText('Plastic Love');
  return { api, track };
}
const tuneIt = () => {
  fireEvent.input(el(SEL.slider('difficulty')), { target: { value: '80' } });
  fireEvent.click(el(SEL.era('s80')));
};
/** What the singer set, read back from the screen: the slider, the picked era, the sheet's mode and the range chip. */
const tuning = () => ({
  difficulty: el<HTMLInputElement>(SEL.slider('difficulty')).value,
  s80: el(SEL.era('s80')).getAttribute('aria-pressed'),
  mode: el(SEL.app).dataset.mode,
  range: document.querySelector('[role="group"][aria-label^="Your range"]')?.getAttribute('aria-label'),
});

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  // A new entry on top, so no entry is left ahead of the current one by an earlier test's Back (History.length counts those too).
  window.history.pushState(null, '', '/');
});
afterEach(() => {
  cleanup();
});

describe('a song page opened while a re-rank is pending (1)', () => {
  it('stays open when the new list leaves the song out, shows the match it was opened with, and Back shows the new list', async () => {
    const page = allMatches();
    // The screen's own list lacks Lemon (t1): only the engine knows it, as with a big library or the catalogue, so nothing can find
    // it once the engine's list moves on.
    const api = fakeApi(me(RANGE), () => ({ ...page, matches: page.matches.filter((m) => m.track.id !== 't1') }));
    const second = deferred<SetlistResponse>();
    let asked = 0;
    const engine: SetlistEngine = { rank: async () => (++asked === 2 ? second.promise : inOrder(page)) };
    await onTheTuner({ engine, api });
    expect(rowIds()).toContain('t1');

    // Difficulty moves: the re-rank is asked for and not answered yet. The singer taps Lemon in the list they were looking at.
    fireEvent.input(el(SEL.slider('difficulty')), { target: { value: '60' } });
    await waitFor(() => expect(asked).toBe(2));
    fireEvent.click(await row(/^Lemon/));
    expect(songPageOpen('Lemon')).toBe(true);

    // The answer lands without Lemon: the page stays, whole.
    await act(async () => second.resolve(inOrder(page, ['t1'])));
    await settle();
    expect(songPageOpen('Lemon')).toBe(true);
    expect(tunerOpen()).toBe(false);
    expect(screen.getByText('Kenshi Yonezu')).toBeTruthy();

    // Back shows the new ranking, without Lemon.
    fireEvent.click(back());
    await waitFor(() => expect(tunerOpen()).toBe(true));
    expect(songPageOpen('Lemon')).toBe(false);
    expect(rowIds()).toEqual(page.matches.map((m) => m.track.id).filter((id) => id !== 't1'));
    expect(el<HTMLInputElement>(SEL.slider('difficulty')).value).toBe('60');

    // A later list that has Lemon again opens nothing: only a tap opens a page.
    fireEvent.input(el(SEL.slider('difficulty')), { target: { value: '20' } });
    await waitFor(() => expect(asked).toBe(3));
    await settle();
    expect(rowIds()).toContain('t1');
    expect(songPageOpen('Lemon')).toBe(false);
    expect(tunerOpen()).toBe(true);
  });

  it('still sends feedback for the song when the new list no longer has it', async () => {
    const page = allMatches();
    const api = fakeApi(me(RANGE), () => ({ ...page, matches: page.matches.filter((m) => m.track.id !== 't1') }));
    const second = deferred<SetlistResponse>();
    let asked = 0;
    await onTheTuner({ engine: { rank: async () => (++asked === 2 ? second.promise : inOrder(page)) }, api });
    fireEvent.input(el(SEL.slider('difficulty')), { target: { value: '60' } });
    await waitFor(() => expect(asked).toBe(2));
    fireEvent.click(await row(/^Lemon/));
    await act(async () => second.resolve(inOrder(page, ['t1'])));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'It went well' }));
    expect(api.feedback).toHaveBeenCalledTimes(1);
    expect(api.feedback.mock.calls[0]![0]).toMatchObject({ trackId: 't1', thumbs: 'up' });
  });
});

describe("the browser's Back button on a song page (2)", () => {
  const engine = (): SetlistEngine => ({ rank: async () => inOrder(allMatches()) });

  it('closes the page and brings the tuner back as it was: the system Back is the page’s own ‹ Back', async () => {
    await onTheTuner({ engine: engine() });
    tuneIt();
    await settle();
    const tuned = tuning();
    expect(tuned).toMatchObject({ difficulty: '80', s80: 'true' });
    const entries = window.history.length;

    fireEvent.click(await row(/^Plastic Love/));
    expect(songPageOpen('Plastic Love')).toBe(true);
    // One entry on the stack, and the address is the same.
    expect(window.history.length).toBe(entries + 1);
    expect(overlayNow()).toBe('song');
    expect(pathNow()).toBe('/');

    act(() => window.history.back());
    await settle();
    expect(songPageOpen('Plastic Love')).toBe(false);
    expect(tunerOpen()).toBe(true);
    expect(tuning()).toEqual(tuned);
    expect(overlayNow()).toBeUndefined();
  });

  it('is answered by the ‹ Back too: the entry is taken off, so the next Back press is not wasted on it', async () => {
    await onTheTuner({ engine: engine() });
    const entries = window.history.length;
    fireEvent.click(await row(/^Plastic Love/));
    expect(window.history.length).toBe(entries + 1);
    const goBack = vi.spyOn(window.history, 'back');
    fireEvent.click(back());
    expect(tunerOpen()).toBe(true);
    expect(goBack).toHaveBeenCalledTimes(1);
    await settle();
    // The page is where it was, and the traversal that took the entry off did not close anything else or open anything.
    expect(overlayNow()).toBeUndefined();
    expect(tunerOpen()).toBe(true);
    expect(songPageOpen('Plastic Love')).toBe(false);
    // Opening another song after that works the same.
    fireEvent.click(await row(/^Lemon/));
    expect(songPageOpen('Lemon')).toBe(true);
    act(() => window.history.back());
    await settle();
    expect(tunerOpen()).toBe(true);
    goBack.mockRestore();
  });

  it('does nothing on the tuner itself: a Back press there is the browser’s own', async () => {
    await onTheTuner({ engine: engine() });
    const entries = window.history.length;
    expect(window.history.length).toBe(entries);
    expect(overlayNow()).toBeUndefined();
    window.history.pushState({ elsewhere: true }, '');
    act(() => window.history.back());
    await settle();
    expect(tunerOpen()).toBe(true);
  });
});

describe('"Back to songs" on the mic and note steps of a redo (3)', () => {
  const engine = (): SetlistEngine => ({ rank: async () => inOrder(allMatches()) });
  const redoLow = () => fireEvent.click(screen.getByRole('button', { name: /^Redo your low note/ }));

  it('is on the mic step of one end and brings back the list, the old range and the tuning', async () => {
    await onTheTuner({ engine: engine() });
    tuneIt();
    await settle();
    const tuned = tuning();
    const ids = rowIds();

    redoLow();
    await screen.findByRole('button', { name: 'Turn on microphone' });
    expect(overlayNow()).toBe('redo');
    fireEvent.click(back());
    await waitFor(() => expect(tunerOpen()).toBe(true));
    expect(tuning()).toEqual(tuned);
    expect(tuned.range).toBe('Your range A2 to C5');
    await waitFor(() => expect(rowIds()).toEqual(ids));
    await settle();
    expect(overlayNow()).toBeUndefined();
  });

  it('is on the note step too, and leaves no half-finished test behind to come back at the next visit', async () => {
    await onTheTuner({ engine: engine() });
    tuneIt();
    await settle();
    const tuned = tuning();

    redoLow();
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on microphone' }));
    await screen.findByRole('button', { name: 'Hold to record your lowest note' });
    expect(sessionStorage.getItem('kd.test')).not.toBeNull(); // the test's progress, kept for a Spotify round trip
    fireEvent.click(back());
    await waitFor(() => expect(tunerOpen()).toBe(true));
    expect(sessionStorage.getItem('kd.test')).toBeNull();
    expect(tuning()).toEqual(tuned);
  });

  it('is on the steps of a whole redo, and the list loads again because the redo emptied it', async () => {
    const { api } = await onTheTuner({ engine: engine() });
    tuneIt();
    await settle();
    const tuned = tuning();
    expect(api.allRecommendations).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Redo the singing test' }));
    await screen.findByRole('button', { name: 'Turn on microphone' });
    fireEvent.click(back());
    await screen.findByText('Plastic Love');
    expect(api.allRecommendations).toHaveBeenCalledTimes(2);
    expect(tuning()).toEqual(tuned);
  });

  it('is what a double tap on the song page’s ‹ Back leaves the singer with: the second tap lands on the range note, and there is a way back', async () => {
    await onTheTuner({ engine: engine() });
    tuneIt();
    await settle();
    const tuned = tuning();

    fireEvent.click(await row(/^Plastic Love/));
    fireEvent.click(back()); // the first tap: the page closes
    expect(tunerOpen()).toBe(true);
    await settle();
    redoLow(); // the second tap, 250 ms later, on whatever the tuner has under the ‹
    await screen.findByRole('button', { name: 'Turn on microphone' });
    fireEvent.click(back());
    await waitFor(() => expect(tunerOpen()).toBe(true));
    expect(tuning()).toEqual(tuned);
    await settle();
    expect(overlayNow()).toBeUndefined();
  });

  it('is what the system Back does there too', async () => {
    await onTheTuner({ engine: engine() });
    tuneIt();
    await settle();
    const tuned = tuning();
    redoLow();
    await screen.findByRole('button', { name: 'Turn on microphone' });
    expect(overlayNow()).toBe('redo');
    act(() => window.history.back());
    await settle();
    expect(tunerOpen()).toBe(true);
    expect(tuning()).toEqual(tuned);
  });

  it('is not on the very first test, which has no range to go back to and no entry to push', async () => {
    const api = fakeApi(me());
    render(<KaraokeApp api={api} track={{ track: vi.fn(), flush: async () => {} }} mic={mic} quietMs={5} setlistEngine={engine()} />);
    const entries = window.history.length;
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    await screen.findByRole('button', { name: 'Turn on microphone' });
    expect(screen.queryByRole('button', { name: 'Back to songs' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on microphone' }));
    await screen.findByRole('button', { name: 'Hold to record your lowest note' });
    expect(screen.queryByRole('button', { name: 'Back to songs' })).toBeNull();
    expect(window.history.length).toBe(entries);
    expect(overlayNow()).toBeUndefined();
  });
});
