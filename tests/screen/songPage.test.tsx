// @vitest-environment jsdom
// The song page, and what the browser's Back button and a second tap do around it (the second adversarial review of PR #38, QWW-57):
//   1. a song page opened while a re-rank is pending stays open, with the match it was opened with, whatever the new list holds
//   2. opening a song pushes a history entry, and the system Back closes the page like the page's own ‹ Back, tuning kept
//   3. the mic and note steps of a redo show "Back to songs" (keeps the old range and the tuning), and the system Back does the same;
//      the very first test, with no range yet, has no such button and pushes nothing
// and of the final pass on d623eda:
//   a. a double tap lands once: for a moment after a tap brings up a screen, taps on the range notes, redo and "Back to songs" are ignored
//   b. "That's your range" after a redo (no Spotify) has Back to songs and answers the system Back: the old range and the tuning come back
//   c. closing a song page puts the focus back on the row that opened it, at its place in the list now
// and of the fourth pass on 828aaca:
//   3. a double tap on a row: the song page holds its controls for the same moment (400 ms), so the second tap falls through
//   5. Back puts the list at the place the singer scrolled it to (the page and the list are one screen's contents in turn)
//   6. an ignored tap puts the moment off again, so three or four quick taps never get through
// Layout and a real phone's Back are tests/e2e/setlist-back.spec.ts's, and the real touches of 3 and 5 tests/e2e/setlist-row-tap.spec.ts's; here is
// the app's behaviour with jsdom's own History API.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KaraokeApp, TAP_GUARD_MS } from '../../src/components/KaraokeApp';
import { SongDetail } from '../../src/components/SongDetail';
import type { Api } from '../../src/lib/client/api';
import type { Mic, MicRecorder } from '../../src/lib/client/mic';
import { OVERLAY_STATE_KEY } from '../../src/lib/client/useOverlayHistory';
import type { MeResponse, RecommendationsResponse, VocalRange } from '../../src/lib/contracts';
import type { SetlistEngine } from '../../src/lib/setlist/engine';
import type { SetlistResponse } from '../../src/lib/setlist/types';
import { allMatches, knownSongs, me, recommendationsPage } from '../fixtures/screen';
import { el, ranked, response, rowIds, SEL } from '../helpers/setlist';
import { SAMPLE_RATE, voice } from '../helpers/synth';

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

/** A microphone that hears the note queued for the next hold: enough to finish a redo. */
function singingMic() {
  const queue: Float32Array[] = [];
  let current: Float32Array = new Float32Array(0);
  const sung: MicRecorder = {
    sampleRate: SAMPLE_RATE,
    reset: () => {
      current = queue.shift() ?? new Float32Array(0);
    },
    latest: (n) => current.subarray(Math.max(0, current.length - n)),
    take: () => current,
    live: () => true,
    running: () => true,
    resume: () => {},
    close: () => {},
  };
  const heard: Mic = { permission: async () => 'prompt', open: async () => sung };
  return { mic: heard, sing: (hz: number) => void queue.push(voice(hz, 1.5)) };
}
/** Holds the note button (the label names the note) and lets go. */
async function hold(label: RegExp) {
  const button = screen.getByRole('button', { name: label });
  await act(async () => {
    fireEvent.pointerDown(button);
  });
  await act(async () => {
    fireEvent.pointerUp(button);
  });
}
/** The app's clock moves on (only `Date` is faked in the describes that call this): the tap guard is a matter of how long since a tap. */
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const clock = () => {
  beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => void vi.useRealTimers());
};

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

  it('pushes nothing on the tuner itself, and a Back press there is the browser’s own: nothing of the app answers it', async () => {
    const before = window.history.length;
    await onTheTuner({ engine: engine() });
    tuneIt();
    await settle();
    const tuned = tuning();
    // Moving gears and picking eras is not something to go back from: no entry, and no marker on the one the page is on.
    expect(window.history.length, 'the tuner pushes no entry').toBe(before);
    expect(overlayNow()).toBeUndefined();

    // Something else leaves an entry, and the browser goes back through it: the app has no entry of its own to answer, so it
    // pushes none, takes none off, and changes nothing (the guard in useOverlayHistory: a Back press is the app's only when it pushed).
    window.history.pushState({ elsewhere: true }, '');
    const back = vi.spyOn(window.history, 'back');
    const push = vi.spyOn(window.history, 'pushState');
    act(() => window.history.go(-1));
    await settle();
    expect(back).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(tunerOpen()).toBe(true);
    expect(tuning()).toEqual(tuned);
    back.mockRestore();
    push.mockRestore();
  });
});

describe('"Back to songs" on the mic and note steps of a redo (3)', () => {
  clock();
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
    tick(TAP_GUARD_MS); // a tap that is meant comes after the moment a double tap's second one would
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
    tick(TAP_GUARD_MS);
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

    fireEvent.click(screen.getByRole('button', { name: 'Redo the range test' }));
    await screen.findByRole('button', { name: 'Turn on microphone' });
    fireEvent.click(back());
    await screen.findByText('Plastic Love');
    expect(api.allRecommendations).toHaveBeenCalledTimes(2);
    expect(tuning()).toEqual(tuned);
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

describe('a double tap lands once (a): taps on the range notes, redo and "Back to songs" wait a moment after a tap brings one up', () => {
  clock();
  const engine = (): SetlistEngine => ({ rank: async () => inOrder(allMatches()) });
  const redoLow = () => fireEvent.click(screen.getByRole('button', { name: /^Redo your low note/ }));
  const redoAll = () => fireEvent.click(screen.getByRole('button', { name: 'Redo the range test' }));
  const micStep = () => screen.queryByRole('button', { name: 'Turn on microphone' });
  /** The same gaps a finger leaves between two taps: close to none, a quick double tap, and just inside the moment. */
  const GAPS = [60, 250, TAP_GUARD_MS - 10];

  it.each(GAPS)('‹ on a song page, then %i ms later the low note under it: the second tap is ignored, and a tap after the moment works', async (gap) => {
    await onTheTuner({ engine: engine() });
    tuneIt();
    await settle();
    const tuned = tuning();

    fireEvent.click(await row(/^Plastic Love/));
    fireEvent.click(back()); // the first tap: the page closes
    tick(gap);
    redoLow(); // the second tap: on whatever the tuner has under the ‹
    await settle();
    expect(micStep()).toBeNull();
    expect(tunerOpen()).toBe(true);
    expect(tuning()).toEqual(tuned);
    expect(overlayNow()).toBeUndefined();

    tick(TAP_GUARD_MS); // the ignored tap put the moment off again (6): after a whole one of quiet a tap is a choice
    redoLow();
    await screen.findByRole('button', { name: 'Turn on microphone' });
  });

  it.each(GAPS)('a range note, then %i ms later "Back to songs" under it: the second tap is ignored, so the redo is not cancelled at once', async (gap) => {
    await onTheTuner({ engine: engine() });
    tuneIt();
    await settle();
    const tuned = tuning();

    redoLow(); // the first tap: the mic step comes up
    await screen.findByRole('button', { name: 'Turn on microphone' });
    tick(gap);
    fireEvent.click(back()); // the second tap: on "Back to songs"
    await settle();
    expect(micStep()).not.toBeNull();
    expect(tunerOpen()).toBe(false);
    expect(overlayNow()).toBe('redo');

    tick(TAP_GUARD_MS);
    fireEvent.click(back());
    await waitFor(() => expect(tunerOpen()).toBe(true));
    expect(tuning()).toEqual(tuned);
  });

  it.each(GAPS)('"Back to songs", then %i ms later redo under it: the second tap is ignored, so the whole test does not start and the list is not emptied', async (gap) => {
    const { api } = await onTheTuner({ engine: engine() });
    tuneIt();
    await settle();
    const tuned = tuning();
    const ids = rowIds();

    redoLow();
    await screen.findByRole('button', { name: 'Turn on microphone' });
    tick(TAP_GUARD_MS);
    fireEvent.click(back()); // the first tap: back to the list
    await waitFor(() => expect(tunerOpen()).toBe(true));
    tick(gap);
    redoAll(); // the second tap: on redo
    await settle();
    expect(screen.queryByRole('button', { name: /Find a quiet spot/ })).toBeNull();
    expect(tunerOpen()).toBe(true);
    expect(rowIds()).toEqual(ids);
    expect(api.allRecommendations).toHaveBeenCalledTimes(1); // no list was emptied and fetched again
    expect(tuning()).toEqual(tuned);

    tick(TAP_GUARD_MS);
    redoAll(); // after the moment it is a choice
    await screen.findByRole('button', { name: /Find a quiet spot/ });
  });

  it('the moment is only for those three: a tap on a song row, or on a gear, right after a tap is not held back', async () => {
    await onTheTuner({ engine: engine() });
    fireEvent.click(await row(/^Plastic Love/));
    fireEvent.click(back()); // a tap that starts the moment
    fireEvent.input(el(SEL.slider('difficulty')), { target: { value: '55' } }); // a gear
    expect(el<HTMLInputElement>(SEL.slider('difficulty')).value).toBe('55');
    fireEvent.click(await row(/^Lemon/)); // a row
    expect(songPageOpen('Lemon')).toBe(true);
  });

  it('the system Back is not a tap, and starts no moment: redo right after it works', async () => {
    await onTheTuner({ engine: engine() });
    fireEvent.click(await row(/^Plastic Love/));
    act(() => window.history.back());
    await settle();
    expect(tunerOpen()).toBe(true);
    redoLow();
    await screen.findByRole('button', { name: 'Turn on microphone' });
  });
});

describe("a double tap on a row lands once (3): the song page holds its controls for a moment after it opens", () => {
  // jsdom has no hit testing: it dispatches a click at whatever it is told to, `pointer-events` or not. So these check what the page does to hold
  // its controls: the attribute and the style, when they go on and off, and what they leave alone. That a tap really falls through (the ▶ not
  // pressed, no tab opened, nothing sent, nothing played) is tests/e2e/setlist-row-tap.spec.ts's, with real touches in Chromium and WebKit.
  const held = () => document.querySelector<HTMLElement>('[data-hold]');
  const timers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  afterEach(() => void vi.useRealTimers());
  /** The page's controls other than ‹: the ▶, Spotify's link or player, and the two thumbs. */
  const controls = () => [...document.querySelectorAll<HTMLElement>('button[data-preview], a[href], iframe, button[aria-pressed]')];
  const style = (e: Element) => (e as HTMLElement).style.pointerEvents;
  const lemon = allMatches().matches[1]!; // its Spotify link is a track, so its page has Spotify's player
  const catalogue = { ...lemon, track: { ...lemon.track, id: 'cat:kenshi yonezu|lemon', spotifyUrl: 'https://open.spotify.com/search/Lemon' } }; // a search link: no player, the link
  const page = (props: Partial<Parameters<typeof SongDetail>[0]> = {}) => (
    <SongDetail match={lemon} userRange={RANGE} feedback={undefined} onFeedback={vi.fn()} onBack={vi.fn()} {...props} />
  );

  it('from the row’s tap: the controls are held, ‹ and the chart are not, and all let go after TAP_GUARD_MS, not a millisecond before', async () => {
    await onTheTuner({ engine: { rank: async () => inOrder(allMatches()) } });
    const row = await screen.findByRole('button', { name: /^Lemon/ });
    timers();
    fireEvent.click(row); // the first tap: the song page is on the screen in this very commit
    expect(songPageOpen('Lemon')).toBe(true);
    expect(held(), 'the page says it is holding').toBe(back().parentElement);
    expect(controls().map((c) => c.tagName), 'the ▶, Spotify’s player and the two thumbs').toEqual(['BUTTON', 'IFRAME', 'BUTTON', 'BUTTON']);
    expect(controls().map(style)).toEqual(['none', 'none', 'none', 'none']);
    expect(style(back()), '‹ is not held: no row is under it').toBe('');
    expect(style(screen.getByRole('img', { name: /^Song goes from/ })), 'nor is the chart, which is no control').toBe('');

    tick(TAP_GUARD_MS - 1);
    expect(held()).not.toBeNull();
    expect(controls().map(style)).toEqual(['none', 'none', 'none', 'none']);
    tick(1);
    expect(held()).toBeNull();
    expect(controls().map(style)).toEqual(['', '', '', '']);
  });

  it('the Spotify link is held too, where the song has a link and no player', () => {
    timers();
    render(page({ match: catalogue, holdMs: 400 }));
    const link = screen.getByRole('link', { name: 'Find on Spotify' });
    expect(style(link)).toBe('none');
    expect(controls().map(style)).toEqual(['none', 'none', 'none', 'none']); // the ▶, the link and the thumbs
    act(() => void vi.advanceTimersByTime(400));
    expect(style(link)).toBe('');
  });

  it('a page opened without a moment holds nothing', () => {
    render(page());
    expect(held()).toBeNull();
    expect(controls().map(style)).toEqual(['', '', '', '']);
  });

  it('each song is held for its own moment: another page opened later starts it again', () => {
    timers();
    const { rerender } = render(<div>{page({ holdMs: 400 })}</div>);
    expect(held()).not.toBeNull();
    act(() => void vi.advanceTimersByTime(400));
    expect(held()).toBeNull();
    // KaraokeApp keys the page by its track: another song is another page, mounted afresh.
    const other = allMatches().matches[0]!;
    rerender(
      <div>
        <SongDetail key={other.track.id} match={other} userRange={RANGE} feedback={undefined} onFeedback={vi.fn()} onBack={vi.fn()} holdMs={400} />
      </div>,
    );
    expect(held()).not.toBeNull();
    expect(controls().map(style)).toEqual(['none', 'none', 'none', 'none']);
    act(() => void vi.advanceTimersByTime(399));
    expect(held()).not.toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(held()).toBeNull();
  });

  it('a page that goes before its moment is over leaves no timer behind', () => {
    timers();
    const { unmount } = render(page({ holdMs: 400 }));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keys are not held: what a key press does, a click at the control, still goes through in the moment', () => {
    timers();
    const onFeedback = vi.fn();
    render(page({ holdMs: 400, onFeedback }));
    expect(held()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'It went well' }));
    expect(onFeedback).toHaveBeenCalledWith('up');
  });
});

describe('a run of quick taps never gets through (6): an ignored tap puts the moment off again, wherever it landed', () => {
  clock();
  const engine = (): SetlistEngine => ({ rank: async () => inOrder(allMatches()) });
  const redoLow = () => fireEvent.click(screen.getByRole('button', { name: /^Redo your low note/ }));
  const micStep = () => screen.queryByRole('button', { name: 'Turn on microphone' });
  /** Between a finger's taps: more than the third of a moment, so the fourth tap is more than a moment after the first. */
  const EVERY = 150;

  it('‹, then three more taps on the same spot 150 ms apart: the list shows and no redo has started; a tap after the moment starts it', async () => {
    await onTheTuner({ engine: engine() });
    tuneIt();
    await settle();
    const tuned = tuning();

    fireEvent.click(await row(/^Plastic Love/));
    fireEvent.click(back()); // the first of four: the page closes
    for (let i = 0; i < 3; i++) {
      tick(EVERY);
      redoLow(); // the second, third and fourth: on the tuner's low note, the fourth 450 ms after the first
    }
    await settle();
    expect(micStep()).toBeNull();
    expect(tunerOpen()).toBe(true);
    expect(tuning()).toEqual(tuned);
    expect(overlayNow()).toBeUndefined();

    tick(TAP_GUARD_MS);
    redoLow();
    await screen.findByRole('button', { name: 'Turn on microphone' });
  });

  it('a range note, then "Back to songs" three times 150 ms apart: the redo is still there; a tap after the moment leaves it', async () => {
    await onTheTuner({ engine: engine() });
    tuneIt();
    await settle();
    const tuned = tuning();

    redoLow(); // the first: the mic step comes up
    await screen.findByRole('button', { name: 'Turn on microphone' });
    for (let i = 0; i < 3; i++) {
      tick(EVERY);
      fireEvent.click(back()); // each lands on "Back to songs", the third 450 ms after the first
    }
    await settle();
    expect(micStep()).not.toBeNull();
    expect(tunerOpen()).toBe(false);
    expect(overlayNow()).toBe('redo');

    tick(TAP_GUARD_MS);
    fireEvent.click(back());
    await waitFor(() => expect(tunerOpen()).toBe(true));
    expect(tuning()).toEqual(tuned);
  });

  it('"Back to songs", then redo three times 150 ms apart: the whole test does not start; a tap after the moment starts it', async () => {
    await onTheTuner({ engine: engine() });
    redoLow();
    await screen.findByRole('button', { name: 'Turn on microphone' });
    tick(TAP_GUARD_MS);
    fireEvent.click(back()); // the first: back to the list
    await waitFor(() => expect(tunerOpen()).toBe(true));
    for (let i = 0; i < 3; i++) {
      tick(EVERY);
      fireEvent.click(screen.getByRole('button', { name: 'Redo the range test' })); // each on redo, the third 450 ms after the first
    }
    await settle();
    expect(screen.queryByRole('button', { name: /Find a quiet spot/ })).toBeNull();
    expect(tunerOpen()).toBe(true);

    tick(TAP_GUARD_MS);
    fireEvent.click(screen.getByRole('button', { name: 'Redo the range test' }));
    await screen.findByRole('button', { name: /Find a quiet spot/ });
  });

  it('taps more than a moment apart each work, as they did: quiet is what lets one through, not the number of taps', async () => {
    await onTheTuner({ engine: engine() });
    redoLow();
    await screen.findByRole('button', { name: 'Turn on microphone' });
    tick(TAP_GUARD_MS + 1);
    fireEvent.click(back()); // works: back to the list, and a moment starts
    await waitFor(() => expect(tunerOpen()).toBe(true));
    tick(TAP_GUARD_MS + 1);
    redoLow(); // works again
    await screen.findByRole('button', { name: 'Turn on microphone' });
  });
});

describe('"That’s your range" after a redo, for a singer without Spotify (b)', () => {
  clock();
  const OLD = { low: 45, high: 72 };
  const engine = (): SetlistEngine => ({ rank: async () => inOrder(allMatches()) });
  const rangeChip = () => document.querySelector('[role="group"][aria-label^="Your range"]')?.getAttribute('aria-label');

  /** A singer without Spotify who kept A2 to C5 on the device, on the tuner. */
  async function onTheTunerWithoutSpotify() {
    localStorage.setItem('kd.range', JSON.stringify(OLD));
    const heard = singingMic();
    const api = fakeApi(null);
    render(<KaraokeApp api={api} track={{ track: vi.fn(), flush: async () => {} }} mic={heard.mic} quietMs={5} setlistEngine={engine()} />);
    await screen.findByText('Plastic Love');
    return { api, sing: heard.sing };
  }
  /** Redoes the low note, sings G2 and lands on "That's your range". */
  async function redoToTheResult(sing: (hz: number) => void) {
    fireEvent.click(screen.getByRole('button', { name: /^Redo your low note/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on microphone' }));
    await screen.findByRole('button', { name: /lowest note/ });
    sing(98); // G2
    await hold(/lowest note/);
    await screen.findByTestId('range-low');
    expect(screen.getByTestId('range-low').textContent).toBe('G2');
    expect(screen.getByTestId('range-high').textContent).toBe('C5');
  }

  it('has "Back to songs", and the redo’s history entry is still there for the system Back', async () => {
    const { sing } = await onTheTunerWithoutSpotify();
    await redoToTheResult(sing);
    expect(overlayNow()).toBe('redo');
    expect(screen.getByRole('button', { name: 'Back to songs' })).toBeTruthy();
  });

  it('answers the system Back with the songs: the old range and the tuning are as they were, and the new range is not kept', async () => {
    const { sing } = await onTheTunerWithoutSpotify();
    tuneIt();
    await settle();
    const tuned = tuning();
    const ids = rowIds();
    expect(tuned.range).toBe('Your range A2 to C5');

    await redoToTheResult(sing);
    act(() => window.history.back());
    await settle();
    expect(tunerOpen()).toBe(true);
    expect(tuning()).toEqual(tuned);
    expect(rangeChip()).toBe('Your range A2 to C5');
    await waitFor(() => expect(rowIds()).toEqual(ids));
    // Nothing of the new range is kept, on this device or for the next visit.
    expect(JSON.parse(localStorage.getItem('kd.range')!)).toMatchObject(OLD);
    expect(sessionStorage.getItem('kd.test')).toBeNull();
    expect(overlayNow()).toBeUndefined();
  });

  it('answers "Back to songs" the same way', async () => {
    const { sing } = await onTheTunerWithoutSpotify();
    tuneIt();
    await settle();
    const tuned = tuning();
    await redoToTheResult(sing);
    tick(TAP_GUARD_MS);
    fireEvent.click(back());
    await waitFor(() => expect(tunerOpen()).toBe(true));
    expect(tuning()).toEqual(tuned);
    expect(rangeChip()).toBe('Your range A2 to C5');
    expect(JSON.parse(localStorage.getItem('kd.range')!)).toMatchObject(OLD);
    await settle();
    expect(overlayNow()).toBeUndefined();
  });

  it('Continue keeps the new range, as it always did, and takes the redo’s entry off', async () => {
    const { sing } = await onTheTunerWithoutSpotify();
    await redoToTheResult(sing);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Plastic Love');
    expect(rangeChip()).toBe('Your range G2 to C5');
    expect(JSON.parse(localStorage.getItem('kd.range')!)).toMatchObject({ low: 43, high: 72 });
    await settle();
    expect(overlayNow()).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'Back to songs' })).toBeNull();
  });

  it('is not on the first test’s result: no old range to go back to, and no entry pushed', async () => {
    const heard = singingMic();
    render(<KaraokeApp api={fakeApi(null)} track={{ track: vi.fn(), flush: async () => {} }} mic={heard.mic} quietMs={5} setlistEngine={engine()} />);
    const entries = window.history.length;
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on microphone' }));
    await screen.findByRole('button', { name: /lowest note/ });
    heard.sing(110); // A2
    await hold(/lowest note/);
    await screen.findByRole('button', { name: /highest note/ });
    heard.sing(440); // A4
    await hold(/highest note/);
    await screen.findByTestId('range-low');
    expect(screen.queryByRole('button', { name: 'Back to songs' })).toBeNull();
    expect(window.history.length).toBe(entries);
    expect(overlayNow()).toBeUndefined();
  });
});

describe('closing a song page puts the focus back on the row that opened it (c)', () => {
  clock();
  const engine = (): SetlistEngine => ({ rank: async () => inOrder(allMatches()) });
  const rowOf = (button: HTMLElement) => button.closest<HTMLElement>('[data-row]')!;
  /** Opens a song the way the keyboard does: the row has focus, and Enter presses it. */
  async function openByKeyboard(title: RegExp) {
    const button = await row(title);
    button.focus();
    fireEvent.click(button);
    return rowOf(button).dataset.id!;
  }

  it('‹ Back: the focus is on that row’s button, not at the top of the page', async () => {
    await onTheTuner({ engine: engine() });
    const id = await openByKeyboard(/^Lemon/);
    expect(songPageOpen('Lemon')).toBe(true);
    fireEvent.click(back());
    const again = await row(/^Lemon/);
    await waitFor(() => expect(document.activeElement).toBe(again));
    expect(rowOf(again).dataset.id).toBe(id);
  });

  it('the system Back does the same', async () => {
    await onTheTuner({ engine: engine() });
    await openByKeyboard(/^Dancing Queen/);
    act(() => window.history.back());
    await settle();
    expect(tunerOpen()).toBe(true);
    const again = await row(/^Dancing Queen/);
    await waitFor(() => expect(document.activeElement).toBe(again));
  });

  it('at the row’s new place when a re-rank moved it under the page', async () => {
    const page = allMatches();
    const second = deferred<SetlistResponse>();
    let asked = 0;
    await onTheTuner({ engine: { rank: async () => (++asked === 2 ? second.promise : inOrder(page)) } });
    const before = rowOf(await row(/^Lemon/)).dataset.rank;
    fireEvent.input(el(SEL.slider('difficulty')), { target: { value: '60' } });
    await waitFor(() => expect(asked).toBe(2));
    await openByKeyboard(/^Lemon/); // opened in the list the singer was looking at
    await act(async () => second.resolve(response([...page.matches].reverse().map((m) => ranked(m)))));
    await settle();
    expect(songPageOpen('Lemon')).toBe(true);

    fireEvent.click(back());
    const again = await row(/^Lemon/);
    await waitFor(() => expect(document.activeElement).toBe(again));
    expect(rowOf(again).dataset.rank, 'the list was ranked again under the page: the row is somewhere else').not.toBe(before);
  });

  it('a song that has left the list leaves the focus where the page left it, and breaks nothing', async () => {
    const page = allMatches();
    const second = deferred<SetlistResponse>();
    let asked = 0;
    await onTheTuner({ engine: { rank: async () => (++asked === 2 ? second.promise : inOrder(page)) } });
    fireEvent.input(el(SEL.slider('difficulty')), { target: { value: '60' } });
    await waitFor(() => expect(asked).toBe(2));
    await openByKeyboard(/^Lemon/);
    await act(async () => second.resolve(inOrder(page, ['t1'])));
    await settle();
    fireEvent.click(back());
    await waitFor(() => expect(tunerOpen()).toBe(true));
    expect(rowIds()).not.toContain('t1');
    expect(document.activeElement).toBe(document.body);
  });

  it('is for a page that is closed, not for one that was left some other way: the next visit to the tuner takes no focus', async () => {
    await onTheTuner({ engine: engine() });
    await openByKeyboard(/^Lemon/);
    fireEvent.click(back());
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Lemon/));
    // Away to a redo and back: the focus is not put on the row again by an old memory of it.
    (document.activeElement as HTMLElement).blur();
    tick(TAP_GUARD_MS); // redo is not one a double tap's second tap may reach
    fireEvent.click(screen.getByRole('button', { name: 'Redo the range test' }));
    await screen.findByRole('button', { name: /Find a quiet spot/ });
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on microphone' }));
    await screen.findByRole('button', { name: /lowest note/ });
    act(() => window.history.back());
    await settle();
    await screen.findByText('Plastic Love');
    expect(document.activeElement).toBe(document.body);
  });
});

describe('closing a song page puts the list back where the singer left it (5)', () => {
  clock();
  const engine = (): SetlistEngine => ({ rank: async () => inOrder(allMatches()) });
  /** The list's scroller. The song page and the list take turns in one screen, so it is a new element every time the list comes back. */
  const scroller = () => el('#list-scroll');
  const rowOf = (button: HTMLElement) => button.closest<HTMLElement>('[data-row]')!;

  it('‹: the list is scrolled to where it was, and the row that opened the page has the focus', async () => {
    await onTheTuner({ engine: engine() });
    scroller().scrollTop = 420; // jsdom has no layout: it keeps the number it is given
    fireEvent.click(await row(/^Lemon/));
    expect(songPageOpen('Lemon')).toBe(true);
    fireEvent.click(back());
    await waitFor(() => expect(tunerOpen()).toBe(true));
    expect(scroller().scrollTop).toBe(420);
    expect(document.activeElement).toBe(await row(/^Lemon/));
  });

  it('the system Back does the same', async () => {
    await onTheTuner({ engine: engine() });
    scroller().scrollTop = 260;
    fireEvent.click(await row(/^Dancing Queen/));
    act(() => window.history.back());
    await settle();
    expect(tunerOpen()).toBe(true);
    expect(scroller().scrollTop).toBe(260);
  });

  it('is where it was at the page that closed, not where it was the time before', async () => {
    await onTheTuner({ engine: engine() });
    scroller().scrollTop = 420;
    fireEvent.click(await row(/^Lemon/));
    fireEvent.click(back());
    await waitFor(() => expect(tunerOpen()).toBe(true));
    expect(scroller().scrollTop).toBe(420);

    tick(TAP_GUARD_MS);
    scroller().scrollTop = 90;
    fireEvent.click(await row(/^Plastic Love/));
    fireEvent.click(back());
    await waitFor(() => expect(tunerOpen()).toBe(true));
    expect(scroller().scrollTop).toBe(90);
  });

  it('a list that was at the top comes back at the top', async () => {
    await onTheTuner({ engine: engine() });
    fireEvent.click(await row(/^Plastic Love/));
    fireEvent.click(back());
    await waitFor(() => expect(tunerOpen()).toBe(true));
    expect(scroller().scrollTop).toBe(0);
  });

  it('the focus is still on the row at its new place when a re-rank moved it, and the list is where it was', async () => {
    const page = allMatches();
    const second = deferred<SetlistResponse>();
    let asked = 0;
    await onTheTuner({ engine: { rank: async () => (++asked === 2 ? second.promise : inOrder(page)) } });
    const before = rowOf(await row(/^Lemon/)).dataset.rank;
    fireEvent.input(el(SEL.slider('difficulty')), { target: { value: '60' } });
    await waitFor(() => expect(asked).toBe(2));
    scroller().scrollTop = 300;
    (await row(/^Lemon/)).focus();
    fireEvent.click(await row(/^Lemon/)); // opened in the list the singer was looking at
    await act(async () => second.resolve(response([...page.matches].reverse().map((m) => ranked(m)))));
    await settle();
    fireEvent.click(back());
    const again = await row(/^Lemon/);
    await waitFor(() => expect(document.activeElement).toBe(again));
    expect(rowOf(again).dataset.rank, 'the list was ranked again under the page: the row is somewhere else').not.toBe(before);
    expect(scroller().scrollTop).toBe(300);
  });
});

describe('a reload in the middle of a redo (d)', () => {
  const OLD = { low: 45, high: 72 };
  const engine = (): SetlistEngine => ({ rank: async () => inOrder(allMatches()) });
  const rangeChip = () => document.querySelector('[role="group"][aria-label^="Your range"]')?.getAttribute('aria-label');
  /** The page loaded again: what the device kept (the range, and the test's progress, which survives a reload to survive Spotify's round trip). */
  function reload(opts: { saved?: typeof OLD | null; progress?: { low: number | null; high: number | null } | null; user?: MeResponse | null }) {
    if (opts.saved) localStorage.setItem('kd.range', JSON.stringify(opts.saved));
    if (opts.progress) sessionStorage.setItem('kd.test', JSON.stringify(opts.progress));
    render(<KaraokeApp api={fakeApi(opts.user ?? null)} track={{ track: vi.fn(), flush: async () => {} }} mic={mic} quietMs={5} setlistEngine={engine()} />);
  }

  it.each([
    ['the low note, the first one sung in a whole redo or the one of a low-note redo', { low: 50, high: null }],
    ['the high note of a high-note redo', { low: null, high: 69 }],
  ])('after %s, with a range kept, comes back to the songs with it, and drops the half-finished test', async (_what, progress) => {
    const entries = window.history.length;
    reload({ saved: OLD, progress });
    await screen.findByText('Plastic Love');
    expect(rangeChip()).toBe('Your range A2 to C5');
    expect(screen.queryByRole('button', { name: 'Turn on microphone' })).toBeNull();
    // It was a redo that was left, not a first test: nothing of it is kept, here or for the next visit, and nothing is pushed.
    expect(sessionStorage.getItem('kd.test')).toBeNull();
    expect(window.history.length).toBe(entries);
    expect(overlayNow()).toBeUndefined();
  });

  it('signed in with a range saved does the same', async () => {
    reload({ user: me(RANGE), progress: { low: 50, high: null } });
    await screen.findByText('Plastic Love');
    expect(rangeChip()).toBe('Your range A2 to C5');
    expect(sessionStorage.getItem('kd.test')).toBeNull();
  });

  it('half a test with no range kept is a first test, and is resumed: on the mic step to sing the high note, with nothing to go back to', async () => {
    reload({ progress: { low: 50, high: null } });
    await screen.findByRole('button', { name: 'Turn on microphone' });
    expect(screen.queryByRole('button', { name: 'Back to songs' })).toBeNull();
    expect(sessionStorage.getItem('kd.test')).not.toBeNull();
  });

  it('a finished test waiting at the arrow is kept, range kept or not: it is what the Spotify round trip comes back to', async () => {
    reload({ saved: OLD, progress: { low: 43, high: 72 } });
    await screen.findByTestId('range-low');
    expect(screen.getByTestId('range-low').textContent).toBe('G2');
    expect(sessionStorage.getItem('kd.test')).not.toBeNull();
  });
});
