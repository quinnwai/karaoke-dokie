// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KaraokeApp } from '../../src/components/KaraokeApp';
import type { Api } from '../../src/lib/client/api';
import { SHOW_STEP } from '../../src/lib/client/flow';
import { MicError, type Mic, type MicPermission, type MicRecorder } from '../../src/lib/client/mic';
import type { Match, MeResponse, RecommendationsResponse, SongRange, VocalRange } from '../../src/lib/contracts';
import { DEFAULTS } from '../../src/lib/setlist/defaults';
import type { SetlistEngine } from '../../src/lib/setlist/engine';
import { libraryCandidate, rankSetlist } from '../../src/lib/songs/setlist';
import { ERA_IDS, GEAR_IDS, type SetlistRequest, type SetlistResponse } from '../../src/lib/setlist/types';
import { noise, SAMPLE_RATE, voice } from '../helpers/synth';
import { fader, faderPointer, faderX } from '../helpers/fader';
import { all, el, ranked, response, rowIds, SEL } from '../helpers/setlist';
import { allMatches, allMatchesWithFacts, knownSongs, match, me, recommendationsPage } from '../fixtures/screen';

/**
 * A mic that "hears" whatever tone the test queues for the next hold. `permission` is what the browser says
 * before anyone asks (QWW-50); `lose` takes the microphone away; `stall` is a browser holding the audio back until a
 * tap (nothing runs until `resume`). Opening it again, as a tap on "Turn on microphone" does, gives a fresh microphone
 * whose audio runs.
 */
function fakeMic(permission: MicPermission = 'prompt') {
  const queue: Float32Array[] = [];
  let current: Float32Array = new Float32Array(0);
  let alive = true;
  let stalled = false;
  let stuck = false; // audio that a press does not start
  const opened = { count: 0, closed: 0, resumed: 0 };
  const recorder: MicRecorder = {
    sampleRate: SAMPLE_RATE,
    reset: () => {
      current = queue.shift() ?? new Float32Array(0);
    },
    latest: (n) => current.subarray(Math.max(0, current.length - n)),
    take: () => current,
    live: () => alive,
    running: () => !stalled,
    resume: () => {
      opened.resumed++;
      if (!stuck) stalled = false;
    },
    close: () => void opened.closed++,
  };
  const mic: Mic = {
    permission: async () => permission,
    open: async () => {
      opened.count++;
      alive = true; // a fresh microphone, whose audio runs
      stalled = stuck = false;
      return recorder;
    },
  };
  return {
    mic,
    sing: (hz: number, seconds = 1.5) => queue.push(voice(hz, seconds)),
    /** Whatever the microphone gives for the next hold. */
    play: (samples: Float32Array) => queue.push(samples),
    lose: () => void (alive = false),
    stall: () => void (stalled = true),
    /** Audio that stays stopped however many times it is resumed (iOS after a call or the lock screen). */
    stick: () => void (stalled = stuck = true),
    opened,
  };
}

/** The mic step for a browser that has not said yes yet: one tap on "Turn on microphone", and the note follows. */
async function throughMic() {
  fireEvent.click(await screen.findByRole('button', { name: 'Turn on microphone' }));
}

/** Start, then the mic step (which an already-allowed microphone skips), then the low note's button. */
async function startTest(permission: MicPermission = 'prompt') {
  fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
  if (permission !== 'granted') await throughMic();
  return screen.findByRole('button', { name: /lowest note/ });
}

let lastApi: ReturnType<typeof fakeApi> | null = null;

function fakeApi(user: MeResponse | null) {
  let current = user;
  const api = {
    me: vi.fn(async () => current),
    logout: vi.fn(async () => {
      current = null;
    }),
    saveRange: vi.fn(async (range: VocalRange) => {
      if (current) current = { ...current, range };
    }),
    recommendations: vi.fn(async (offset: number) => recommendationsPage(offset)),
    allRecommendations: vi.fn(async () => allMatches()),
    catalogue: vi.fn(async (_range: { low: number; high: number }) => allMatches()),
    knownSongs: vi.fn(async () => knownSongs()),
    feedback: vi.fn(async () => {}),
    catalogueFeedback: vi.fn(async () => {}),
  } satisfies Api;
  lastApi = api;
  return api;
}

const lyrics = () => Array.from(document.querySelectorAll('[data-lyric]')).map((p) => p.textContent);

async function hold(label: RegExp) {
  const button = screen.getByRole('button', { name: label });
  await act(async () => {
    fireEvent.pointerDown(button);
  });
  await act(async () => {
    fireEvent.pointerUp(button);
  });
}

type Tracked = { name: string; props?: Record<string, unknown> };

/** A beta event log that keeps what it is sent; the real one posts it to the server. */
function fakeTracker() {
  const tracked: Tracked[] = [];
  const track = { track: (name: string, props?: Record<string, unknown>) => void tracked.push({ name, props }), flush: async () => {} };
  return { tracked, track };
}
const gearEvents = (tracked: Tracked[]) => tracked.filter((e) => e.name === 'gear_change');
const eraEvents = (tracked: Tracked[]) => tracked.filter((e) => e.name === 'era_change');

/** The songs as the ranking engine would send them for a test that does not care about places: in the order given. */
const inOrder = (matches: Match[], extra: Partial<SetlistResponse> = {}): SetlistResponse => response(matches.map((m) => ranked(m)), extra);

/**
 * The ranking engine behind the tuner, as a fake: it keeps every request the screen sends it and answers as a test
 * chooses (every song in the server's order unless told otherwise). An answer may be a promise, to hold it back.
 */
function fakeEngine(answer: (request: SetlistRequest) => SetlistResponse | Promise<SetlistResponse> = () => inOrder(allMatches().matches)) {
  const requests: SetlistRequest[] = [];
  const engine: SetlistEngine = {
    rank: async (request) => {
      requests.push(request);
      return answer(request);
    },
  };
  return { engine, requests };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A signed-in singer with A2 to C5 on the results screen, once the fake engine has answered the first request. */
async function signedInWithEngine(answer?: (request: SetlistRequest) => SetlistResponse | Promise<SetlistResponse>) {
  const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
  const { engine, requests } = fakeEngine(answer);
  const { tracked, track } = fakeTracker();
  render(<KaraokeApp api={api} track={track} mic={fakeMic().mic} setlistEngine={engine} />);
  await screen.findByText('Plastic Love');
  expect(requests).toHaveLength(1);
  return { api, requests, tracked };
}

/**
 * The tuner as the feedback request carries it (feedbackView in src/lib/client/funnel.ts): each gear's target, 0 to 1, or
 * null when it is not factored in. An untouched tuner has Difficulty and Popularity on, and Tempo and Era off; History is on when the singer is
 * signed in (R31) and off when not.
 */
const defaultView = (signedIn = false) => ({
  difficulty: DEFAULTS.difficulty / 100,
  familiarity: signedIn ? DEFAULTS.history / 100 : null,
  popularity: DEFAULTS.popularity / 100,
  tempo: null,
  decade: null,
  mood: null,
  duetsOnly: false,
});

const HISTORY_HINT = 'Connect Spotify to use your listening history';

/**
 * POST /api/setlist, as the server answers it, for a test that gives the screen no engine of its own: the real ranking
 * (src/lib/songs/setlist.ts) of the songs the fake API served last, paged as the server pages. Signed in, the library counts.
 */
const landed = new WeakMap<object, RecommendationsResponse | null | undefined>();

async function serveSetlist(_url: string, init?: RequestInit): Promise<Response> {
  const api = lastApi;
  const req = JSON.parse(String(init?.body)) as SetlistRequest & { limit?: number; offset?: number };
  const calls = api
    ? [api.allRecommendations, api.catalogue, api.recommendations].flatMap((f) => f.mock.results.map((r, i) => ({ r, order: f.mock.invocationCallOrder[i]! })))
    : [];
  calls.sort((a, b) => a.order - b.order);
  // The pages that have landed so far, as one list: a page still on its way is not there yet.
  for (const { r } of calls) if (r.type === 'return' && !landed.has(r.value)) landed.set(r.value, undefined), r.value.then((v: RecommendationsResponse) => landed.set(r.value, v), () => landed.set(r.value, null));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pages = calls.flatMap(({ r }) => (r.type === 'return' ? [landed.get(r.value)] : [])).filter((p): p is RecommendationsResponse => !!p);
  if (!pages.length) return new Response('{}', { status: 500 });
  // One load: the last page and the pages before it that said more were coming.
  const load = [pages.at(-1)!];
  for (let k = pages.length - 2; k >= 0 && pages[k]!.complete === false; k--) load.unshift(pages[k]!);
  const byId = new Map<string, Match>();
  for (const p of load) for (const m of p.matches) byId.set(m.track.id, m);
  const page: RecommendationsResponse = { ...pages.at(-1)!, matches: [...byId.values()] };
  const signedIn = ((await api!.me.mock.results.at(-1)?.value) ?? null) !== null;
  const matches = page.matches.filter((m) => m.range.low <= req.range.high && m.range.high >= req.range.low);
  const ranked = rankSetlist(matches.map((match) => (signedIn ? libraryCandidate(match) : { match })), { ...req, loggedIn: signedIn });
  const offset = req.offset ?? 0;
  const songs = ranked.songs.slice(offset, offset + (req.limit ?? 100));
  const end = offset + songs.length;
  const body: SetlistResponse = {
    songs,
    total: ranked.songs.length,
    nextOffset: end < ranked.songs.length ? end : null,
    sources: page.sources ?? {},
    applied: ranked.applied,
    ...(ranked.empty ? { empty: ranked.empty } : {}),
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(serveSetlist));
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('KaraokeApp', () => {
  it('runs the singing test, then shows catalogue songs with no sign-in', async () => {
    const { mic, sing } = fakeMic();
    const navigate = vi.fn();
    const api = fakeApi(null);
    render(<KaraokeApp api={api} mic={mic} navigate={navigate} quietMs={0} />);

    await startTest();

    sing(110); // A2
    await hold(/lowest note/);
    expect(await screen.findByTestId('low-note')).toHaveProperty('textContent', 'A2');
    expect(lyrics()).toContain('Now hold and sing your highest note');

    sing(523.25); // C5
    await hold(/highest note/);
    const arrow = await screen.findByRole('button', { name: 'Continue' });
    expect(screen.getByTestId('range-low').textContent).toBe('A2');
    expect(screen.getByTestId('range-high').textContent).toBe('C5');
    expect(JSON.parse(sessionStorage.getItem('kd.test')!)).toEqual({ low: 45, high: 72 });

    fireEvent.click(arrow);
    await screen.findByText('Plastic Love');
    expect(navigate).not.toHaveBeenCalled();
    expect(api.catalogue).toHaveBeenCalledWith({ low: 45, high: 72 });
    expect(api.allRecommendations).not.toHaveBeenCalled();
    // The range stays on this device instead of an account.
    expect(JSON.parse(localStorage.getItem('kd.range')!)).toEqual({ low: 45, high: 72 });
    expect(sessionStorage.getItem('kd.test')).toBeNull();
    // One Spotify button, the header's (R18 took the block under the list away: "Want personalized recommendations?", the link and
    // "Invited testers only for now." while few people can sign in; R30 gives the header's button its touch behaviour).
    expect(screen.getAllByRole('button', { name: 'Connect to Spotify' })).toHaveLength(1);
    expect(screen.queryByText('Want personalized recommendations?')).toBeNull();
    expect(screen.queryByText('Invited testers only for now.')).toBeNull();
    expect(screen.queryByText(/every song that fits|invite-only|from our catalogue/)).toBeNull();
    // Catalogue songs are nobody's library, so the History gear is off and cannot be used; the others can.
    expect(el<HTMLInputElement>(SEL.slider('history')).disabled).toBe(true);
    expect(screen.getByText(HISTORY_HINT)).toBeTruthy();
    expect(el<HTMLInputElement>(SEL.slider('difficulty')).disabled).toBe(false);
  });

  it('after the test, with the switch on, "or use songs from your Spotify" keeps the range and goes to sign-in', async () => {
    sessionStorage.setItem('kd.test', JSON.stringify({ low: 45, high: 72 }));
    const navigate = vi.fn();
    render(<KaraokeApp api={fakeApi(null)} mic={fakeMic().mic} navigate={navigate} pickSongs />);
    fireEvent.click(await screen.findByRole('button', { name: 'or use songs from your Spotify' }));
    expect(navigate).toHaveBeenCalledWith('/api/auth/login');
    expect(JSON.parse(sessionStorage.getItem('kd.test')!)).toEqual({ low: 45, high: 72 });
  });

  // The range screen has one way on (QWW-55): the arrow. The Spotify link is behind the same PICK_SONGS switch as the
  // title screen's link, which app/page.tsx passes as `pickSongs`; the Spotify logo on the list is the one way to sign in.
  it('the range screen has the arrow and no "or use songs from your Spotify" unless the switch is on', async () => {
    sessionStorage.setItem('kd.test', JSON.stringify({ low: 45, high: 72 }));
    const off = render(<KaraokeApp api={fakeApi(null)} mic={fakeMic().mic} />);
    await screen.findByRole('button', { name: 'Continue' });
    expect(screen.getByTestId('range-low').textContent).toBe('A2');
    expect(screen.queryByRole('button', { name: 'or use songs from your Spotify' })).toBeNull();
    expect(screen.queryByText(/songs from your Spotify/)).toBeNull();
    off.unmount();

    render(<KaraokeApp api={fakeApi(null)} mic={fakeMic().mic} pickSongs />);
    await screen.findByRole('button', { name: 'Continue' });
    expect(screen.getByRole('button', { name: 'or use songs from your Spotify' })).toBeTruthy();
  });

  // The server sends a failed sign-in (Spotify said wait, one of its calls failed, the sign-in cookie was gone, ...)
  // back with ?authError=<reason>. It landed on the range screen with no word about it.
  describe('a refused sign-in (?authError=...)', () => {
    it('says so under the range and under the list, takes ?authError out of the address, and keeps the ways to retry', async () => {
      window.history.replaceState(null, '', '/?authError=spotify');
      sessionStorage.setItem('kd.test', JSON.stringify({ low: 45, high: 72 }));
      render(<KaraokeApp api={fakeApi(null)} mic={fakeMic().mic} />);
      expect((await screen.findByRole('status')).textContent).toBe('Couldn’t sign in. Spotify sign-in is for invited testers only right now.');
      expect(window.location.search).toBe('');

      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      await screen.findByText('Plastic Love');
      expect(screen.getByRole('status').textContent).toBe('Couldn’t sign in. Spotify sign-in is for invited testers only right now.');
      // The logo and the prompt under the list stay, to try again; the failed-load screen is not what this is.
      expect(screen.getAllByRole('button', { name: 'Connect to Spotify' })).toHaveLength(1);
      expect(screen.queryByText('Couldn’t load songs.')).toBeNull();
    });

    it('says it on the list a singer comes back to when the range was kept on the device', async () => {
      window.history.replaceState(null, '', '/?authError=state');
      localStorage.setItem('kd.range', JSON.stringify({ low: 45, high: 72 }));
      render(<KaraokeApp api={fakeApi(null)} mic={fakeMic().mic} />);
      await screen.findByText('Plastic Love');
      expect(screen.getByRole('status').textContent).toBe('Couldn’t sign in. Spotify sign-in is for invited testers only right now.');
      expect(window.location.search).toBe('');
    });

    it('says nothing when the singer pressed Cancel on Spotify, and nothing without an error', async () => {
      window.history.replaceState(null, '', '/?authError=access_denied');
      sessionStorage.setItem('kd.test', JSON.stringify({ low: 45, high: 72 }));
      const cancelled = render(<KaraokeApp api={fakeApi(null)} mic={fakeMic().mic} />);
      await screen.findByRole('button', { name: 'Continue' });
      expect(screen.queryByRole('status')).toBeNull();
      expect(window.location.search).toBe('');
      cancelled.unmount();

      render(<KaraokeApp api={fakeApi(null)} mic={fakeMic().mic} />);
      await screen.findByRole('button', { name: 'Continue' });
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('is not shown to someone who is signed in', async () => {
      window.history.replaceState(null, '', '/?authError=spotify');
      render(<KaraokeApp api={fakeApi(me({ low: 45, high: 72, source: 'test' }))} mic={fakeMic().mic} />);
      await screen.findByText('Plastic Love');
      expect(screen.queryByRole('status')).toBeNull();
      // Signed in, there is no invite note under the list either.
      expect(screen.queryByText('Invited testers only for now.')).toBeNull();
    });
  });

  it('someone without Spotify comes back to their catalogue songs, and can connect Spotify later', async () => {
    localStorage.setItem('kd.range', JSON.stringify({ low: 45, high: 72 }));
    const navigate = vi.fn();
    const api = fakeApi(null);
    render(<KaraokeApp api={api} mic={fakeMic().mic} navigate={navigate} />);
    await screen.findByText('Plastic Love');
    expect(api.catalogue).toHaveBeenCalledWith({ low: 45, high: 72 });

    fireEvent.click(screen.getAllByRole('button', { name: 'Connect to Spotify' })[0]!);
    expect(navigate).toHaveBeenCalledWith('/api/auth/login');
    expect(JSON.parse(sessionStorage.getItem('kd.test')!)).toEqual({ low: 45, high: 72 });
  });

  it('catalogue feedback goes to the catalogue route with the device id, the range and what was set on the sheet', async () => {
    localStorage.setItem('kd.range', JSON.stringify({ low: 45, high: 72 }));
    const api = fakeApi(null);
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Plastic Love/ }));
    fireEvent.click(screen.getByRole('button', { name: 'It went well' }));
    const anonId = localStorage.getItem('kd.anonId');
    expect(anonId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(api.catalogueFeedback).toHaveBeenCalledWith({
      trackId: 't0',
      thumbs: 'up',
      difficulty: 'easy',
      octave: 'none',
      // History, Tempo and Era start off, so only Difficulty and Popularity are in the view.
      view: defaultView(),
      anonId,
      range: { low: 45, high: 72 },
    });
    expect(api.feedback).not.toHaveBeenCalled();
  });

  it('registers a very low note as sung, and never asks the singer to fix it', async () => {
    const { mic, sing } = fakeMic();
    const api = fakeApi(me());
    render(<KaraokeApp api={api} mic={mic} quietMs={0} />);

    await startTest();
    sing(69.3); // C#2, below where most pop songs go
    await hold(/lowest note/);
    expect((await screen.findByTestId('low-note')).textContent).toBe('C#2');
    sing(523.25); // C5
    await hold(/highest note/);

    await screen.findByText('Plastic Love');
    expect(api.saveRange).toHaveBeenCalledWith({ low: 37, high: 72, source: 'test' });
    expect(screen.getByLabelText('Your range C#2 to C5')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep it' })).toBeNull();
    expect(screen.queryByText(/growl|vocal fry/i)).toBeNull();
  });

  it('asks to try again when nothing was held', async () => {
    const { mic, sing } = fakeMic();
    render(<KaraokeApp api={fakeApi(null)} mic={mic} quietMs={0} />);
    await startTest();
    sing(110, 0.2);
    await hold(/lowest note/);
    await waitFor(() => expect(lyrics()).toContain('Try again and hold the note a little longer'));
  });

  it('works with the keyboard: Space held is a press', async () => {
    const { mic, sing } = fakeMic();
    render(<KaraokeApp api={fakeApi(null)} mic={mic} quietMs={0} />);
    const button = await startTest();
    sing(110);
    await act(async () => {
      fireEvent.keyDown(button, { key: ' ' });
    });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      fireEvent.keyUp(button, { key: ' ' });
    });
    expect((await screen.findByTestId('low-note')).textContent).toBe('A2');
  });

  // The microphone step (QWW-50): the browser's own question is a step we do not control, and older singers often
  // miss, close or block it, so our screen comes first and no refusal is a dead end.
  describe('the mic step (QWW-50)', () => {
    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    const PIXEL = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.52 Mobile Safari/537.36';
    const INSTAGRAM_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F90 Instagram 336.0.0.35.121 (iPhone14,5; iOS 17_5)';
    const asBrowser = (ua: string) => vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua);

    /** A fake event log. Only the mic events are looked at: the rest of the funnel has its own tests. */
    function eventLog() {
      const tracked: { name: string; props?: Record<string, unknown> }[] = [];
      const track = { track: (name: string, props?: Record<string, unknown>) => void tracked.push({ name, props }), flush: async () => {} };
      return { track, mic: () => tracked.filter((e) => /^(mic_|inapp_)/.test(e.name)) };
    }

    afterEach(() => {
      vi.restoreAllMocks();
      delete (navigator as unknown as Record<string, unknown>).clipboard;
    });

    it('first run on an iPhone: our screen, then the browser asked once, and straight to the low note', async () => {
      asBrowser(IPHONE);
      const { mic, opened } = fakeMic('prompt');
      const log = eventLog();
      render(<KaraokeApp api={fakeApi(null)} track={log.track} mic={mic} quietMs={0} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Start' }));

      // Our own screen comes first: a title, one line, and a round button. The browser has not been asked.
      const turnOn = await screen.findByRole('button', { name: 'Turn on microphone' });
      expect(lyrics()).toEqual(['Set up your microphone']);
      expect(screen.getByText(/Your phone will ask to use the microphone/)).toBeTruthy();
      expect(screen.getAllByText('Allow')).toHaveLength(1);
      expect(screen.queryByRole('img')).toBeNull();
      expect(screen.queryByText(/voice stays/)).toBeNull();
      expect(opened.count).toBe(0);

      // The tap asks, and a yes goes straight to the note: no meter, nothing more to tap.
      fireEvent.click(turnOn);
      await screen.findByRole('button', { name: /lowest note/ });
      expect(screen.queryByText(/hear you|Listening|ahh/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
      // The same microphone carries on into the note: no second question, nothing let go in between.
      expect(opened.count).toBe(1);
      expect(opened.closed).toBe(0);
      expect(log.mic()).toEqual([
        { name: 'mic_prompt_shown', props: { browser: 'ios-safari' } },
        { name: 'mic_granted', props: { via: 'prompt', browser: 'ios-safari' } },
      ]);
    });

    it('a no shows the steps for this browser; "Try again" asks again, says "still" when it fails again, and a yes carries on', async () => {
      asBrowser(IPHONE);
      const { mic, opened } = fakeMic('prompt');
      let answer: 'no' | 'yes' = 'no';
      const flaky: Mic = { permission: mic.permission, open: () => (answer === 'no' ? Promise.reject(new MicError('denied')) : mic.open()) };
      const log = eventLog();
      render(<KaraokeApp api={fakeApi(null)} track={log.track} mic={flaky} quietMs={0} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Turn on microphone' }));

      await waitFor(() => expect(lyrics()).toContain('The microphone is blocked'));
      expect(document.querySelector('[data-mic-view="recovery"]')!.getAttribute('data-problem')).toBe('denied');
      // iPhone Safari's own steps, the one-line reassurance, and a way on.
      for (const step of ['aA', 'Website Settings', 'Microphone', 'Allow']) expect(screen.getAllByText(step).length).toBeGreaterThan(0);
      expect(screen.getByText('Safari may ask again each time you open this page. That’s normal.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Reload this page' })).toBeTruthy();
      expect(screen.queryByText(/Still not working/)).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByText('Still not working. Follow the steps, then tap Try again.')).toBeTruthy();

      answer = 'yes';
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await screen.findByRole('button', { name: /lowest note/ });
      expect(opened.count).toBe(1);
      expect(log.mic().map((e) => e.name)).toEqual([
        'mic_prompt_shown',
        'mic_denied',
        'mic_recovery_shown',
        'mic_denied',
        'mic_recovery_shown',
        'mic_granted',
      ]);
    });

    it('a question that was closed, an unplugged microphone and a busy one each say what happened', async () => {
      asBrowser(PIXEL);
      for (const [error, title, problem] of [
        [Object.assign(new Error('Permission dismissed'), { name: 'NotAllowedError' }), 'The question was closed', 'dismissed'],
        [new DOMException('Requested device not found', 'NotFoundError'), 'We can’t find a microphone', 'missing'],
        [new DOMException('Could not start audio source', 'NotReadableError'), 'The microphone is busy', 'busy'],
        [Object.assign(new Error('Permission denied by system'), { name: 'NotAllowedError' }), 'Your phone is blocking the microphone', 'system'],
      ] as const) {
        const { unmount } = render(<KaraokeApp api={fakeApi(null)} mic={{ permission: async () => 'prompt', open: () => Promise.reject(error) }} quietMs={0} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Turn on microphone' }));
        await waitFor(() => expect(lyrics()).toContain(title));
        expect(document.querySelector('[data-mic-view="recovery"]')!.getAttribute('data-problem')).toBe(problem);
        // Every one of them can be tried again, whatever went wrong.
        expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
        unmount();
      }
    });

    it('a microphone the browser already allows opens by itself: straight to the low note, no screen of ours', async () => {
      asBrowser(PIXEL);
      const { mic, opened } = fakeMic('granted');
      const log = eventLog();
      render(<KaraokeApp api={fakeApi(null)} track={log.track} mic={mic} quietMs={0} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Start' }));

      await screen.findByRole('button', { name: /lowest note/ });
      expect(screen.queryByRole('button', { name: 'Turn on microphone' })).toBeNull();
      expect(opened.count).toBe(1);
      expect(log.mic()).toEqual([{ name: 'mic_granted', props: { via: 'already', browser: 'android-chrome' } }]);
    });

    it('a microphone the browser already blocks goes straight to the steps, without asking', async () => {
      asBrowser(PIXEL);
      const { mic, opened } = fakeMic('denied');
      const log = eventLog();
      render(<KaraokeApp api={fakeApi(null)} track={log.track} mic={mic} quietMs={0} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Start' }));

      await waitFor(() => expect(lyrics()).toContain('The microphone is blocked'));
      expect(screen.queryByRole('button', { name: 'Turn on microphone' })).toBeNull();
      expect(opened.count).toBe(0);
      // Chrome on Android: its own steps.
      expect(screen.getByText('Permissions')).toBeTruthy();
      expect(screen.queryByText('Website Settings')).toBeNull();
      expect(log.mic()).toEqual([
        { name: 'mic_denied', props: { reason: 'denied', via: 'already', browser: 'android-chrome' } },
        { name: 'mic_recovery_shown', props: { reason: 'denied', browser: 'android-chrome' } },
      ]);
    });

    it('inside Instagram it says to open Safari, with a copy-link button, before anything about the microphone', async () => {
      asBrowser(INSTAGRAM_IPHONE);
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const { mic, opened } = fakeMic('prompt');
      const log = eventLog();
      render(<KaraokeApp api={fakeApi(null)} track={log.track} mic={mic} quietMs={0} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Start' }));

      await waitFor(() => expect(lyrics()).toContain('Open this in Safari'));
      expect(screen.getByText(/open inside Instagram/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Turn on microphone' })).toBeNull();
      expect(opened.count).toBe(0);

      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
      await screen.findByRole('button', { name: 'Link copied ✓' });
      expect(writeText).toHaveBeenCalledWith(window.location.href);
      // The address is also on screen to copy by hand.
      expect((screen.getByLabelText('Link to this page') as HTMLInputElement).value).toBe(window.location.href);

      // A wrong guess about the browser is not a trap.
      fireEvent.click(screen.getByRole('button', { name: 'Try here anyway' }));
      await screen.findByRole('button', { name: 'Turn on microphone' });
      expect(opened.count).toBe(0);
      expect(log.mic()).toEqual([
        { name: 'inapp_browser_detected', props: { app: 'instagram', browser: 'ios-other' } },
        { name: 'mic_prompt_shown', props: { browser: 'ios-other' } },
      ]);
    });

    // "granted" is the microphone that is allowed but silent: the browser still says yes, so without our screen the mic
    // step would open it by itself and drop the singer back on the note with no word.
    it.each(['prompt', 'granted'] as const)(
      'a microphone lost during the note (the browser says %s) shows "Set up your microphone" again, and its tap goes back to the same note',
      async (permission) => {
        asBrowser(IPHONE);
        const { mic, lose, sing, opened } = fakeMic(permission);
        const log = eventLog();
        render(<KaraokeApp api={fakeApi(null)} track={log.track} mic={mic} quietMs={0} />);
        await startTest(permission);

        lose();
        await hold(/lowest note/);
        // Not a hold that records nothing and asks to "try again" for ever, and not straight back on the note: our
        // screen, with the old microphone let go.
        await screen.findByRole('button', { name: 'Turn on microphone' });
        expect(lyrics()).toEqual(['Set up your microphone']);
        expect(opened.closed).toBe(1);
        expect(screen.queryByRole('button', { name: /lowest note/ })).toBeNull();

        // Its tap opens the microphone again, and the note is the one the singer was on.
        await throughMic();
        await screen.findByRole('button', { name: /lowest note/ });
        expect(opened.count).toBe(2);
        sing(110);
        await hold(/lowest note/);
        expect((await screen.findByTestId('low-note')).textContent).toBe('A2');

        // One mic_granted for each grant, and our screen shown again before the second.
        const grant = { name: 'mic_granted', props: { via: 'prompt', browser: 'ios-safari' } };
        const shown = { name: 'mic_prompt_shown', props: { browser: 'ios-safari' } };
        expect(log.mic()).toEqual(
          permission === 'prompt' ? [shown, grant, shown, grant] : [{ name: 'mic_granted', props: { via: 'already', browser: 'ios-safari' } }, shown, grant],
        );
      },
    );

    it('a double tap on "Turn on microphone" asks the browser once, not twice', async () => {
      const spare = fakeMic('prompt');
      let finish!: () => void;
      const open = vi.fn(() => new Promise<MicRecorder>((resolve) => (finish = async () => resolve(await spare.mic.open()))));
      const log = eventLog();
      render(<KaraokeApp api={fakeApi(null)} track={log.track} mic={{ permission: async () => 'prompt', open }} quietMs={0} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
      const turnOn = await screen.findByRole('button', { name: 'Turn on microphone' });
      // Both taps land before the screen has had a chance to disable the button.
      act(() => {
        turnOn.click();
        turnOn.click();
      });
      expect(open).toHaveBeenCalledTimes(1);
      // While the question is up the button says so, and its name does not change.
      expect(screen.getByRole('button', { name: 'Turn on microphone' }).getAttribute('aria-busy')).toBe('true');
      await act(async () => finish());
      await screen.findByRole('button', { name: /lowest note/ });
      expect(open).toHaveBeenCalledTimes(1);
      // One question, one grant.
      expect(log.mic().filter((e) => e.name === 'mic_granted')).toHaveLength(1);
    });

    it('"Reload this page" reloads the page, which is how Safari comes to ask again', async () => {
      asBrowser(IPHONE);
      // `reload`, not `navigate(location.href)`: assigning the address you are on does nothing when it has a #fragment.
      const reload = vi.fn();
      const navigate = vi.fn();
      render(<KaraokeApp api={fakeApi(null)} mic={fakeMic('denied').mic} navigate={navigate} reload={reload} quietMs={0} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Reload this page' }));
      expect(reload).toHaveBeenCalledTimes(1);
      expect(navigate).not.toHaveBeenCalled();
    });

    it.each(['prompt', 'granted'] as const)(
      'a hold that records nothing but zeros (the browser says %s) is a mic the system muted: "Set up your microphone", not a note held too short',
      async (permission) => {
        asBrowser(IPHONE);
        const { mic, play, sing, opened } = fakeMic(permission);
        render(<KaraokeApp api={fakeApi(null)} mic={mic} quietMs={0} />);
        await startTest(permission);

        // A call, another app or the system has muted it: all zeros. "Hold a little longer" would be said for ever.
        play(new Float32Array(48000));
        await hold(/lowest note/);
        await screen.findByRole('button', { name: 'Turn on microphone' });
        expect(opened.closed).toBe(1);
        expect(lyrics()).toEqual(['Set up your microphone']);

        await throughMic();
        await screen.findByRole('button', { name: /lowest note/ });
        sing(110);
        await hold(/lowest note/);
        expect((await screen.findByTestId('low-note')).textContent).toBe('A2');
      },
    );

    it('but a quiet singer is not a muted microphone: hiss, however faint, still says to hold the note longer', async () => {
      asBrowser(IPHONE);
      const { mic, play, opened } = fakeMic('prompt');
      render(<KaraokeApp api={fakeApi(null)} mic={mic} quietMs={0} />);
      await startTest();
      play(noise(1.5, 1e-5));
      await hold(/lowest note/);
      await waitFor(() => expect(lyrics()).toContain('Try again and hold the note a little longer'));
      expect(screen.queryByRole('button', { name: 'Turn on microphone' })).toBeNull();
      expect(opened.closed).toBe(0);
    });

    it.each(['prompt', 'granted'] as const)(
      'a quick tap on the record button (the browser says %s) says "hold a little longer", every time, and never goes to the mic step',
      async (permission) => {
        asBrowser(IPHONE);
        const { mic, play, opened } = fakeMic(permission);
        render(<KaraokeApp api={fakeApi(null)} mic={mic} quietMs={0} />);
        await startTest(permission);
        for (let i = 0; i < 2; i++) {
          play(new Float32Array(0)); // pointerdown and pointerup back to back: no chunk was recorded
          await hold(/lowest note/);
          await waitFor(() => expect(lyrics()).toContain('Try again and hold the note a little longer'));
          expect(screen.queryByRole('button', { name: 'Turn on microphone' })).toBeNull();
          expect(screen.getByRole('button', { name: /lowest note/ })).toBeTruthy();
        }
        expect(opened.closed).toBe(0);
      },
    );

    it.each(['prompt', 'granted'] as const)(
      'audio that never starts (the browser says %s) is "Set up your microphone" again, whose tap starts it; not "hold a little longer" for ever',
      async (permission) => {
        asBrowser(IPHONE);
        const { mic, play, sing, stick, opened } = fakeMic(permission);
        render(<KaraokeApp api={fakeApi(null)} mic={mic} quietMs={0} />);
        await startTest(permission);
        stick();
        play(new Float32Array(0)); // no chunk ever arrives
        await hold(/lowest note/);
        await screen.findByRole('button', { name: 'Turn on microphone' });
        expect(opened.closed).toBe(1);
        expect(lyrics()).toEqual(['Set up your microphone']);

        // The tap opens a fresh microphone, whose audio starts inside it.
        await throughMic();
        await screen.findByRole('button', { name: /lowest note/ });
        sing(110);
        await hold(/lowest note/);
        expect((await screen.findByTestId('low-note')).textContent).toBe('A2');
      },
    );

    it('a long press that records nothing on a running recorder is the mic step too', async () => {
      asBrowser(IPHONE);
      const { mic, play } = fakeMic('prompt');
      render(<KaraokeApp api={fakeApi(null)} mic={mic} quietMs={0} />);
      await startTest();
      const now = vi.spyOn(Date, 'now');
      now.mockReturnValue(1_000);
      play(new Float32Array(0));
      const button = screen.getByRole('button', { name: /lowest note/ });
      await act(async () => void fireEvent.pointerDown(button));
      now.mockReturnValue(2_000); // a second later
      await act(async () => void fireEvent.pointerUp(button));
      await screen.findByRole('button', { name: 'Turn on microphone' });
    });

    it('an allowed microphone whose audio the browser held back is asked to start by the first press, and the note goes on from there', async () => {
      asBrowser(PIXEL);
      const { mic, stall, sing, opened } = fakeMic('granted');
      render(<KaraokeApp api={fakeApi(null)} mic={mic} quietMs={0} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
      await screen.findByRole('button', { name: /lowest note/ });

      // Opened by itself with no tap, so the browser keeps the audio back until one, and nothing asks for it before the
      // note. Whether a real phone starts it from a press is checked by hand: if it does not, the hold bounces to
      // "Set up your microphone" (the test above), whose tap does.
      stall();
      expect(opened.resumed).toBe(0);
      sing(110);
      await hold(/lowest note/);
      expect(opened.resumed).toBe(1);
      expect((await screen.findByTestId('low-note')).textContent).toBe('A2');
      expect(screen.queryByRole('button', { name: 'Turn on microphone' })).toBeNull();
    });

    it('"Try here anyway" is not asked again this visit: a lost microphone goes by permission, not back to the in-app screen', async () => {
      asBrowser(INSTAGRAM_IPHONE);
      const { mic, lose } = fakeMic('prompt');
      render(<KaraokeApp api={fakeApi(null)} mic={mic} quietMs={0} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Try here anyway' }));
      await throughMic();
      await screen.findByRole('button', { name: /lowest note/ });

      lose();
      await hold(/lowest note/);
      await screen.findByRole('button', { name: 'Turn on microphone' });
      expect(lyrics()).toEqual(['Set up your microphone']);
      expect(screen.queryByRole('button', { name: 'Try here anyway' })).toBeNull();
    });

    it('a refusal inside Instagram shows the way out of the app, since that browser has no settings to open', async () => {
      asBrowser(INSTAGRAM_IPHONE);
      const open = vi.fn(() => Promise.reject(new MicError('denied')));
      render(<KaraokeApp api={fakeApi(null)} mic={{ permission: async () => 'prompt', open }} quietMs={0} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Try here anyway' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Turn on microphone' }));

      await waitFor(() => expect(document.querySelector('[data-mic-view="recovery"]')).not.toBeNull());
      expect(lyrics()).toContain('Open this in Safari');
      expect(screen.queryByText('Website Settings')).toBeNull();
      expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
      // And it is still a way on: Try again asks once more.
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    });

    it('lets go of a microphone that arrives after the page is gone', async () => {
      const spare = fakeMic();
      const recorder = await spare.mic.open();
      let finish!: () => void;
      const late: Mic = { permission: async () => 'prompt', open: () => new Promise((resolve) => (finish = () => resolve(recorder))) };
      const { unmount } = render(<KaraokeApp api={fakeApi(null)} mic={late} quietMs={0} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Turn on microphone' }));
      unmount();
      await act(async () => finish());
      expect(spare.opened.closed).toBeGreaterThanOrEqual(1);
    });

    it('a half-done test that comes back after a reload goes through the mic step to the high note', async () => {
      asBrowser(IPHONE);
      sessionStorage.setItem('kd.test', JSON.stringify({ low: 45, high: null }));
      const { mic } = fakeMic('prompt');
      render(<KaraokeApp api={fakeApi(null)} mic={mic} quietMs={0} />);
      await throughMic();
      await screen.findByRole('button', { name: /highest note/ });
      expect(screen.getByTestId('low-note').textContent).toBe('A2');
    });
  });

  it('after sign-in saves the stored range and shows every song in one ranked list', async () => {
    sessionStorage.setItem('kd.test', JSON.stringify({ low: 45, high: 72 }));
    window.history.replaceState(null, '', '/?signedIn=1');
    const api = fakeApi(me());
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);

    await screen.findByText('Plastic Love');
    expect(api.saveRange).toHaveBeenCalledWith({ low: 45, high: 72, source: 'test' });
    expect(sessionStorage.getItem('kd.test')).toBeNull();
    expect(window.location.search).toBe('');
    // The ten fixture songs fit on the first page: one list, ranks 1 to 10, no "Load more".
    expect(all(SEL.row).map((li) => li.dataset.rank)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(screen.queryByRole('button', { name: 'Load more songs' })).toBeNull();
    // A row says what the song is, its era when the year is known, and how hard it is for this singer.
    expect(screen.getByRole('button', { name: 'Lemon by Kenshi Yonezu, Medium' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Plastic Love by Mariya Takeuchi, Easy' })).toBeTruthy();
    // Every match came in one request.
    expect(api.allRecommendations).toHaveBeenCalledTimes(1);
    expect(api.recommendations).not.toHaveBeenCalled();
  });

  it('shows the first page of a long ranked list and adds the next from memory', async () => {
    const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    api.allRecommendations.mockImplementation(async () => allMatches(SHOW_STEP + 5));
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Load more songs' }));
    await waitFor(() => expect(rowIds()).toHaveLength(SHOW_STEP + 5));
    // The ranks run on without a gap, and the button is gone once every song is on screen.
    expect(all(SEL.row).map((li) => li.dataset.rank)).toEqual(Array.from({ length: SHOW_STEP + 5 }, (_, i) => String(i + 1)));
    expect(screen.queryByRole('button', { name: 'Load more songs' })).toBeNull();
    // Every match came in one request; more songs come from memory.
    expect(api.allRecommendations).toHaveBeenCalledTimes(1);
    expect(api.recommendations).not.toHaveBeenCalled();
  });

  it('song detail: range bar, info tooltip, feedback', async () => {
    const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);

    const song = await screen.findByRole('button', { name: /^Yoru ni Kakeru/ });
    // The list is on the TV like every other step (Round 6A, QWW-57), and opening a song keeps the same one.
    const tv = screen.getByRole('region', { name: 'Karaoke screen' });
    fireEvent.click(song);
    expect(screen.getByRole('region', { name: 'Karaoke screen' })).toBe(tv);
    expect(screen.getByRole('heading', { name: 'Yoru ni Kakeru' })).toBeTruthy();
    expect(screen.getByRole('img', { name: /Song goes from A#2 to F4 as you would sing it. You sing from A2 to C5/ })).toBeTruthy();
    expect(screen.getByText('Hard')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Fast lyrics' })).toBeTruthy();
    expect(screen.getByText('Sing it lower than the artist')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Sing it an octave lower than the artist' })).toBeTruthy();
    expect(screen.getByText('Played recently')).toBeTruthy();
    // Spotify's player stands where the "Open in Spotify" button used to be.
    const player = screen.getByTitle('Spotify player: Yoru ni Kakeru by YOASOBI');
    expect(player.getAttribute('src')).toBe('https://open.spotify.com/embed/track/t2');
    expect(screen.queryByRole('link', { name: 'Open in Spotify' })).toBeNull();

    expect(screen.queryByRole('button', { name: 'Where this came from' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'It went well' }));
    expect(screen.getByText('Thanks! That helps.')).toBeTruthy();
    // The answer stays (R26, tests/screen/songFeedback.test.tsx has the rest): the picked thumb is selected, and neither can be tapped again.
    expect(screen.getByRole('button', { name: 'It went well' }).getAttribute('aria-pressed')).toBe('true');
    expect([screen.getByRole('button', { name: 'It went well' }), screen.getByRole('button', { name: "It didn't go well" })].map((b) => (b as HTMLButtonElement).disabled)).toEqual([true, true]);
    // The feedback request keeps the shape the server has always validated, built from the tuner's gears.
    expect(api.feedback).toHaveBeenCalledWith({ trackId: 't2', thumbs: 'up', difficulty: 'hard', octave: 'down', view: defaultView(true) });
    // Tapping a thumb must not reload the player: that would restart the song.
    expect(screen.getByTitle('Spotify player: Yoru ni Kakeru by YOASOBI')).toBe(player);

    fireEvent.click(screen.getByRole('button', { name: 'Back to songs' }));
    expect(await screen.findByText('Plastic Love')).toBeTruthy();
    // Back on the same TV, with the tuner on its screen.
    expect(screen.getByRole('region', { name: 'Karaoke screen' })).toBe(tv);
    expect(tv.contains(el(SEL.app))).toBe(true);
    // Leaving the page removes the player, which stops the song.
    expect(screen.queryByTitle(/^Spotify player/)).toBeNull();
  });

  it('returning user lands on results and can redo the test', async () => {
    const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    render(<KaraokeApp api={api} mic={fakeMic().mic} quietMs={60_000} />);
    await screen.findByText('Plastic Love');
    expect(api.saveRange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Redo the range test' }));
    await waitFor(() => expect(lyrics()).toContain('Find a quiet spot'));
  });

  it('signed in, the logo is the green account button; Log out ends the session and shows the catalogue songs for the same range', async () => {
    const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    // The catalogue has fewer songs than the library, so the library's can be told apart.
    api.catalogue.mockImplementation(async () => allMatches(3));
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);
    await screen.findByText('Plastic Love');
    expect(rowIds()).toHaveLength(10);

    // Signed in: no Connect to Spotify, a logo that says who, and the library's own History gear, usable.
    expect(screen.queryByRole('button', { name: 'Connect to Spotify' })).toBeNull();
    const logo = screen.getByRole('button', { name: 'Spotify account' });
    expect(logo.className).toMatch(/connectOn/);
    fireEvent.click(logo);
    expect(screen.getByText('Logged in as Quinn')).toBeTruthy();
    expect(el<HTMLInputElement>(SEL.slider('history')).disabled).toBe(false);
    expect(screen.queryByText(HISTORY_HINT)).toBeNull();
    expect(api.logout).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connect to Spotify' })).toHaveLength(1));

    // The session ended first, then the catalogue was asked for the same range; the library was not asked again.
    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(api.catalogue).toHaveBeenCalledTimes(1);
    expect(api.catalogue).toHaveBeenCalledWith({ low: 45, high: 72 });
    expect(api.logout.mock.invocationCallOrder[0]).toBeLessThan(api.catalogue.mock.invocationCallOrder[0]!);
    expect(api.allRecommendations).toHaveBeenCalledTimes(1);
    // Nothing of the library is left: three catalogue songs, no account, and History is off and says why.
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    expect(screen.queryByRole('button', { name: 'Spotify account' })).toBeNull();
    expect(screen.queryByText(/Logged in/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();
    expect(el<HTMLInputElement>(SEL.slider('history')).disabled).toBe(true);
    expect(screen.getByText(HISTORY_HINT)).toBeTruthy();
    expect(el<HTMLInputElement>(SEL.slider('difficulty')).disabled).toBe(false);
    // The range stays on this device, like it does for anyone without Spotify.
    expect(JSON.parse(localStorage.getItem('kd.range')!)).toEqual({ low: 45, high: 72 });
  });

  it('after logging out, a reload comes back to the catalogue songs for the same range', async () => {
    const first = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    const { unmount } = render(<KaraokeApp api={first} mic={fakeMic().mic} />);
    await screen.findByText('Plastic Love');
    fireEvent.click(screen.getByRole('button', { name: 'Spotify account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connect to Spotify' })).toHaveLength(1));
    unmount();

    // The server no longer knows this browser (the session cookie is gone): /api/me says 401.
    const reloaded = fakeApi(null);
    render(<KaraokeApp api={reloaded} mic={fakeMic().mic} />);
    await screen.findByText('Plastic Love');
    expect(reloaded.catalogue).toHaveBeenCalledWith({ low: 45, high: 72 });
    expect(screen.getAllByRole('button', { name: 'Connect to Spotify' })).toHaveLength(1);
  });

  it('if Log out fails, nothing changes: still signed in, the box says so, and a second try works', async () => {
    const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    api.logout.mockRejectedValueOnce(new Error('offline'));
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);
    await screen.findByText('Plastic Love');
    fireEvent.click(screen.getByRole('button', { name: 'Spotify account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t log out. Try again.');
    expect(api.catalogue).not.toHaveBeenCalled();
    expect(localStorage.getItem('kd.range')).toBeNull();
    expect(screen.getByText('Logged in as Quinn')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect to Spotify' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connect to Spotify' })).toHaveLength(1));
    expect(api.logout).toHaveBeenCalledTimes(2);
    expect(api.catalogue).toHaveBeenCalledWith({ low: 45, high: 72 });
  });

  // The title screen has one way in (QWW-55): the link is behind the PICK_SONGS switch, which app/page.tsx passes as `pickSongs`.
  it('the title screen has no "pick songs you sing well" link unless the switch is on', async () => {
    const { unmount } = render(<KaraokeApp api={fakeApi(null)} mic={fakeMic().mic} />);
    await screen.findByRole('button', { name: 'Start' });
    expect(screen.queryByRole('button', { name: 'or pick songs you sing well' })).toBeNull();
    expect(screen.queryByText(/pick songs/i)).toBeNull();
    unmount();

    render(<KaraokeApp api={fakeApi(null)} mic={fakeMic().mic} pickSongs />);
    await screen.findByRole('button', { name: 'Start' });
    expect(screen.getByRole('button', { name: 'or pick songs you sing well' })).toBeTruthy();
  });

  it('with the switch off, a pick left over from an earlier visit is dropped, not shown later', async () => {
    sessionStorage.setItem('kd.wantsPick', '1');
    const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);
    await screen.findByText('Plastic Love');
    expect(screen.queryByRole('button', { name: 'Use 3 songs' })).toBeNull();
    expect(api.knownSongs).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('kd.wantsPick')).toBeNull();
  });

  it('pick songs you sing well: signed out goes to sign-in first', async () => {
    const navigate = vi.fn();
    render(<KaraokeApp api={fakeApi(null)} mic={fakeMic().mic} navigate={navigate} pickSongs />);
    fireEvent.click(await screen.findByRole('button', { name: 'or pick songs you sing well' }));
    expect(navigate).toHaveBeenCalledWith('/api/auth/login');
    expect(sessionStorage.getItem('kd.wantsPick')).toBe('1');
  });

  it('pick songs you sing well: up to 3 songs set the range', async () => {
    sessionStorage.setItem('kd.wantsPick', '1');
    const api = fakeApi(me());
    render(<KaraokeApp api={api} mic={fakeMic().mic} pickSongs />);

    for (const title of ['Plastic Love', 'Fly Me to the Moon', 'Dancing Queen']) {
      fireEvent.click(await screen.findByRole('button', { name: new RegExp(title) }));
    }
    expect((screen.getByRole('button', { name: /Lemon/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Use 3 songs' }));
    await screen.findByRole('heading', { name: 'Tune your setlist' });
    expect(api.saveRange).toHaveBeenCalledWith({ low: 40, high: 64, source: 'songs' });
    // The new range shows its songs on the tuner screen.
    await waitFor(() => expect(rowIds()).toHaveLength(10));
    expect(screen.getByLabelText('Your range E2 to E4')).toBeTruthy();
  });

  it('a library Spotify would not give shows catalogue songs with one quiet note, and feedback goes the catalogue way (QWW-55)', async () => {
    // The control: a library that loaded has the History gear in use and no note.
    const ok = render(<KaraokeApp api={fakeApi(me({ low: 45, high: 72, source: 'test' }))} mic={fakeMic().mic} />);
    await screen.findByText('Plastic Love');
    expect(el<HTMLInputElement>(SEL.slider('history')).disabled).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
    ok.unmount();

    const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    api.allRecommendations.mockImplementation(async () => ({ ...allMatches(), libraryUnavailable: true }));
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);
    expect((await screen.findByRole('status')).textContent).toBe('Couldn’t reach Spotify, showing popular songs.');
    // Still signed in; nothing asks to connect; and History is off for songs with no listening data, and says why.
    expect(el<HTMLInputElement>(SEL.slider('difficulty')).disabled).toBe(false);
    expect(el<HTMLInputElement>(SEL.slider('history')).disabled).toBe(true);
    expect(screen.getByText('Spotify could not be reached, so listening history is off')).toBeTruthy();
    expect(screen.queryByText(HISTORY_HINT)).toBeNull();
    expect(screen.getByText('Logged in as Quinn')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect to Spotify' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /^Yoru ni Kakeru/ }));
    fireEvent.click(screen.getByRole('button', { name: 'It went well' }));
    expect(api.catalogueFeedback).toHaveBeenCalledTimes(1);
    expect(api.feedback).not.toHaveBeenCalled();
    expect(api.allRecommendations).toHaveBeenCalledTimes(1);
  });

  it('records the beta funnel without any Spotify id or library song', async () => {
    const { tracked, track } = fakeTracker();
    const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    const navigate = vi.fn();
    // Answers in the server's order, so Yoru ni Kakeru is the third song on screen.
    const { engine } = fakeEngine();
    render(<KaraokeApp api={api} track={track} mic={fakeMic().mic} navigate={navigate} setlistEngine={engine} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Yoru ni Kakeru/ }));
    // Spotify's player is Spotify's page, so playing in it is not seen here; only the fallback link is (SpotifyPlayer test).
    fireEvent.click(screen.getByRole('button', { name: 'It went well' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to songs' }));
    const slider = el(SEL.slider('difficulty'));
    // Dragging (input events) records nothing; letting go (the browser's change event) records one adjustment.
    fireEvent.input(slider, { target: { value: '35' } });
    fireEvent.input(slider, { target: { value: '40' } });
    fireEvent.pointerUp(slider);
    fireEvent.change(slider);
    expect(tracked.map((e) => e.name)).toEqual(['list_view', 'song_open', 'feedback_tapped', 'gear_change']);
    // Signed in, History starts on (R31); Tempo and Era start off, so they are null (Era's picks are only sent while Era is on).
    expect(tracked[1]!.props).toEqual({
      mode: 'library',
      difficulty: DEFAULTS.difficulty / 100,
      familiarity: DEFAULTS.history / 100,
      popularity: DEFAULTS.popularity / 100,
      tempo: null,
      eras: null,
      position: 3,
    });
    expect(tracked[3]!.props).toEqual({ gear: 'difficulty', value: 40, on: true, mode: 'library' });
    expect(JSON.stringify(tracked)).not.toMatch(/"t\d"|Yoru|YOASOBI|open\.spotify/);
  });
});

describe('the Setlist tuner screen', () => {
  describe('on the results', () => {
    it('is the screen the results show: a heading, one ranked list and the sheet of gears, on the one TV every step is on', async () => {
      render(<KaraokeApp api={fakeApi(me({ low: 45, high: 72, source: 'test' }))} mic={fakeMic().mic} />);
      await screen.findByText('Plastic Love');
      expect(screen.getByRole('heading', { level: 1, name: 'Tune your setlist' })).toBeTruthy();
      expect(el(SEL.app).dataset.mode).toBe('expanded');
      expect(screen.getByRole('list', { name: 'Ranked songs' })).toBe(el(SEL.list));
      expect(rowIds()).toHaveLength(10);
      for (const gear of GEAR_IDS) expect(el(SEL.strip(gear))).toBeTruthy();
      expect(el(SEL.eraPanel)).toBeTruthy();
      // One TV, no second bezel: the tuner is inside the frame the title and mic steps use (QWW-57, decision 2).
      expect(screen.getAllByRole('region', { name: 'Karaoke screen' })).toHaveLength(1);
      expect(screen.getByRole('region', { name: 'Karaoke screen' }).contains(el(SEL.app))).toBe(true);
      // No sung title line over the list either: that belongs to the TV steps.
      expect(lyrics()).toEqual([]);
    });

    it('mounts the play button it was given in the play slot of every row, beside the button that opens the song', async () => {
      render(
        <KaraokeApp
          api={fakeApi(me({ low: 45, high: 72, source: 'test' }))}
          mic={fakeMic().mic}
          renderPlay={(m) => (
            <button type="button" data-play={m.track.id}>
              Play {m.track.title}
            </button>
          )}
        />,
      );
      await screen.findByText('Plastic Love');
      expect(all('[data-play]')).toHaveLength(10);
      const row = el('[data-id="t0"]');
      const play = el('[data-play="t0"]', row);
      expect(play.closest('[data-play-slot]')).toBe(el(SEL.playSlot, row));
      // The slot sits beside the button that opens the song, not inside it.
      expect(play.closest('[data-id] > button')).toBeNull();
      fireEvent.click(play);
      expect(screen.queryByRole('heading', { name: 'Plastic Love' })).toBeNull();
      expect(el(SEL.app)).toBeTruthy();
    });
  });

  describe('what the screen sends the ranking engine', () => {
    it('asks nothing while the songs load, then once for the defaults, with the range and no sign-in state', async () => {
      const page = deferred<RecommendationsResponse>();
      const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
      api.allRecommendations.mockImplementation(() => page.promise);
      const { engine, requests } = fakeEngine();
      render(<KaraokeApp api={api} mic={fakeMic().mic} setlistEngine={engine} />);

      await screen.findByText('Loading…');
      // findBy resolves on the commit that shows "Loading…", which can come before the effect that asks for the songs has run.
      await waitFor(() => expect(api.allRecommendations).toHaveBeenCalledTimes(1));
      expect(requests).toEqual([]);

      await act(async () => page.resolve(allMatches()));
      await screen.findByText('Plastic Love');
      // QWW-47's defaults: Difficulty and Popularity on, and Era has no picks; Tempo and Era start off. Signed in, History starts on at
      // 100 as well (R31: "that's the purpose of logging in"). The engine knows who is signed in, so the request does not say.
      expect(requests).toEqual([
        {
          range: { low: 45, high: 72 },
          gears: { difficulty: DEFAULTS.difficulty, history: DEFAULTS.history, popularity: DEFAULTS.popularity, tempo: DEFAULTS.tempo },
          off: ['tempo', 'era'],
          eras: [],
        },
      ]);
      expect(DEFAULTS.history).toBe(100);
    });

    it('sends a singer without Spotify the same request but for History, which is off for them (R31): it does not say who is signed in', async () => {
      const { requests: signedIn } = await signedInWithEngine();
      cleanup();

      localStorage.setItem('kd.range', JSON.stringify({ low: 45, high: 72 }));
      const { engine, requests } = fakeEngine();
      render(<KaraokeApp api={fakeApi(null)} mic={fakeMic().mic} setlistEngine={engine} />);
      await screen.findByText('Plastic Love');
      expect(requests).toHaveLength(1);
      // Signed in, History starts on; without Spotify there is no history to use, and it starts off. Nothing else differs.
      expect(requests[0]).toEqual({ ...signedIn[0], off: ['history', 'tempo', 'era'] });
      expect(requests[0]).not.toHaveProperty('loggedIn');
      expect(signedIn[0]!.off).toEqual(['tempo', 'era']);
    });

    it('sends the tuner as it is: History switched on stays in the request when the library could not be read, and the engine decides', async () => {
      const { mic, sing } = fakeMic();
      const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
      api.allRecommendations.mockImplementationOnce(async () => allMatches()).mockImplementationOnce(async () => ({ ...allMatches(), libraryUnavailable: true }));
      const { engine, requests } = fakeEngine();
      render(<KaraokeApp api={api} mic={mic} setlistEngine={engine} />);
      await screen.findByText('Plastic Love');
      // A signed-in singer's History starts on (R31) and is theirs to move.
      fireEvent.change(el(SEL.slider('history')), { target: { value: '60' } });
      await waitFor(() => expect(requests).toHaveLength(2));
      expect(requests[1]).toEqual({ ...requests[0], gears: { ...requests[0]!.gears, history: 60 }, off: ['tempo', 'era'] });

      // A new range, and this time Spotify will not give the library.
      fireEvent.click(screen.getByRole('button', { name: 'Redo your high note, C5' }));
      await throughMic();
      await screen.findByRole('button', { name: /highest note/ });
      sing(440); // A4
      await hold(/highest note/);
      expect((await screen.findByRole('status')).textContent).toBe('Couldn’t reach Spotify, showing popular songs.');
      await waitFor(() => expect(requests).toHaveLength(3));
      // The sheet shows History as unavailable, but nothing is forced off in the request: the engine knows the library is gone.
      expect(el<HTMLInputElement>(SEL.slider('history')).disabled).toBe(true);
      expect(requests[2]).toEqual({ ...requests[1], range: { low: 45, high: 69 } });
    });

    it('moving a gear sends it on at its new value, and nothing else changes', async () => {
      const { requests } = await signedInWithEngine();
      const first = requests[0]!;
      fireEvent.change(el(SEL.slider('tempo')), { target: { value: '35' } });
      await waitFor(() => expect(requests).toHaveLength(2));
      // Tempo leaves the parts that do not count; the rest of `off` keeps its order.
      expect(requests[1]).toEqual({ ...first, gears: { ...first.gears, tempo: 35 }, off: ['era'] });
    });

    it('Reset sends the gear back at its default value and off, added after the parts that were already off', async () => {
      const { requests } = await signedInWithEngine();
      fireEvent.change(el(SEL.slider('popularity')), { target: { value: '40' } });
      await waitFor(() => expect(requests.at(-1)!.gears.popularity).toBe(40));
      fireEvent.click(el(SEL.reset('popularity')));
      await waitFor(() => expect(requests).toHaveLength(3));
      // The tuner keeps `off` in the order things were switched off, and a reset goes on the end.
      expect(requests[2]).toEqual({ ...requests[0], off: ['tempo', 'era', 'popularity'] });
    });

    it('picking an era turns Era on with just that era, and resetting Era puts it off again with no picks', async () => {
      const { requests } = await signedInWithEngine();
      fireEvent.click(el(SEL.era('s80')));
      await waitFor(() => expect(requests).toHaveLength(2));
      expect(requests[1]).toEqual({ ...requests[0], eras: ['s80'], off: ['tempo'] });

      fireEvent.click(el(SEL.era('s90')));
      await waitFor(() => expect(requests).toHaveLength(3));
      expect(requests[2]!.eras).toEqual(['s80', 's90']);

      fireEvent.click(el(SEL.era('s80')));
      await waitFor(() => expect(requests).toHaveLength(4));
      expect(requests[3]!.eras).toEqual(['s90']);

      fireEvent.click(el(SEL.reset('era')));
      await waitFor(() => expect(requests).toHaveLength(5));
      expect(requests[4]).toEqual(requests[0]);
    });

    it('a drag sends a request for every value it passes through, and records one adjustment when the thumb is let go', async () => {
      const { requests, tracked } = await signedInWithEngine();
      const slider = el(SEL.slider('tempo'));
      for (const value of ['31', '32', '33']) fireEvent.input(slider, { target: { value } });
      await waitFor(() => expect(requests).toHaveLength(4));
      expect(requests.slice(1).map((r) => r.gears.tempo)).toEqual([31, 32, 33]);
      expect(gearEvents(tracked)).toEqual([]);

      fireEvent.pointerUp(slider);
      fireEvent.change(slider);
      expect(gearEvents(tracked)).toEqual([{ name: 'gear_change', props: { gear: 'tempo', value: 33, on: true, mode: 'library' } }]);
    });

    it('pressing a gear that is off turns it on at its default and records it once; Reset records it going off and keeps the focus on the slider', async () => {
      const { requests, tracked } = await signedInWithEngine();
      const slider = el<HTMLInputElement>(SEL.slider('tempo'));
      expect(slider.getAttribute('aria-valuetext')).toBe('Off');
      expect(el(SEL.strip('tempo')).hasAttribute('data-off')).toBe(true);
      expect(el(SEL.reset('tempo')).hasAttribute('hidden')).toBe(true);

      // A press that lands exactly on the default moves nothing, so no input comes: the press itself turns the gear on. (The pointer goes to
      // the fader's hit area, not the input: R33.)
      const hit = fader('tempo');
      faderPointer('pointerDown', hit, { x: faderX(DEFAULTS.tempo) });
      faderPointer('pointerUp', hit, { x: faderX(DEFAULTS.tempo) });
      expect(slider.hasAttribute('aria-valuetext')).toBe(false);
      expect(el(SEL.strip('tempo')).hasAttribute('data-off')).toBe(false);
      expect(el(SEL.reset('tempo')).hasAttribute('hidden')).toBe(false);
      await waitFor(() => expect(gearEvents(tracked)).toHaveLength(1));
      expect(gearEvents(tracked)[0]).toEqual({ name: 'gear_change', props: { gear: 'tempo', value: DEFAULTS.tempo, on: true, mode: 'library' } });
      expect(requests.at(-1)!.off).toEqual(['era']);

      // Another press on a gear that is already on records nothing.
      faderPointer('pointerDown', hit, { x: faderX(DEFAULTS.tempo) });
      faderPointer('pointerUp', hit, { x: faderX(DEFAULTS.tempo) });
      expect(gearEvents(tracked)).toHaveLength(1);

      // Reset hides its own button, so the focus goes to the slider and not to the page.
      fireEvent.click(el(SEL.reset('tempo')));
      expect(document.activeElement).toBe(slider);
      expect(slider.getAttribute('aria-valuetext')).toBe('Off');
      expect(el(SEL.reset('tempo')).hasAttribute('hidden')).toBe(true);
      expect(gearEvents(tracked).at(-1)).toEqual({ name: 'gear_change', props: { gear: 'tempo', value: DEFAULTS.tempo, on: false, mode: 'library' } });
    });

    it('a finger the browser takes for a scroll records nothing and leaves the gear off, and the next tap on it records one adjustment and no more', async () => {
      const { tracked } = await signedInWithEngine();
      const hit = fader('tempo');
      const finger = { kind: 'touch' } as const;
      faderPointer('pointerDown', hit, { ...finger, x: faderX(DEFAULTS.tempo), y: 0 });
      faderPointer('pointerMove', hit, { ...finger, x: faderX(DEFAULTS.tempo), y: 14 });
      faderPointer('pointerCancel', hit, finger);
      expect(el(SEL.strip('tempo')).hasAttribute('data-off')).toBe(true);
      expect(gearEvents(tracked)).toEqual([]);

      faderPointer('pointerDown', hit, { ...finger, x: faderX(DEFAULTS.tempo) });
      faderPointer('pointerUp', hit, { ...finger, x: faderX(DEFAULTS.tempo) });
      expect(gearEvents(tracked)).toEqual([{ name: 'gear_change', props: { gear: 'tempo', value: DEFAULTS.tempo, on: true, mode: 'library' } }]);

      // Tempo is on now: a plain tap on its knob that moves nothing is not an adjustment.
      faderPointer('pointerDown', hit, { ...finger, x: faderX(DEFAULTS.tempo) });
      faderPointer('pointerUp', hit, { ...finger, x: faderX(DEFAULTS.tempo) });
      expect(gearEvents(tracked)).toHaveLength(1);
    });

    it.each([
      [1, 'middle'],
      [2, 'right'],
    ])('a click of button %i (%s) on a gear that is off does not turn it on', async (button) => {
      const { requests, tracked } = await signedInWithEngine();
      const slider = el(SEL.slider('tempo'));
      const hit = fader('tempo');
      faderPointer('pointerDown', hit, { x: faderX(DEFAULTS.tempo), button });
      faderPointer('pointerUp', hit, { x: faderX(DEFAULTS.tempo), button });
      expect(slider.getAttribute('aria-valuetext')).toBe('Off');
      expect(el(SEL.strip('tempo')).hasAttribute('data-off')).toBe(true);
      expect(el(SEL.reset('tempo')).hasAttribute('hidden')).toBe(true);
      expect(requests).toHaveLength(1);
      expect(gearEvents(tracked)).toEqual([]);
    });

    it('records an era tap and an era reset as one event each', async () => {
      const { tracked } = await signedInWithEngine();
      fireEvent.click(el(SEL.era('s80')));
      fireEvent.click(el(SEL.reset('era')));
      // Era starts with no picks, so a tap picks just that era and a reset goes back to none.
      expect(eraEvents(tracked)).toEqual([
        { name: 'era_change', props: { era: 's80', picked: true, on: true, eras: 's80', mode: 'library' } },
        { name: 'era_change', props: { era: null, picked: false, on: false, eras: '', mode: 'library' } },
      ]);
    });

    it('opened songs and feedback carry what is set: the gears that are on, and the eras while Era is on', async () => {
      const { api, tracked } = await signedInWithEngine();
      fireEvent.change(el(SEL.slider('history')), { target: { value: '80' } });
      fireEvent.change(el(SEL.slider('tempo')), { target: { value: '35' } });
      fireEvent.click(el(SEL.reset('difficulty')));
      fireEvent.click(el(SEL.era('s80')));
      fireEvent.click(screen.getByRole('button', { name: /^Lemon/ }));
      fireEvent.click(screen.getByRole('button', { name: 'It went well' }));

      // Difficulty was reset, so it is not in the view; History and Tempo were moved on; Popularity is on at its default.
      const gears = { difficulty: null, familiarity: 0.8, popularity: DEFAULTS.popularity / 100, tempo: 0.35 };
      const view = { mode: 'library', ...gears, eras: 's80' };
      expect(tracked.find((e) => e.name === 'song_open')!.props).toEqual({ ...view, position: 2 });
      expect(tracked.find((e) => e.name === 'feedback_tapped')!.props).toEqual({ ...view, thumbs: 'up' });
      // The feedback request keeps its older shape, which has no eras.
      expect(api.feedback).toHaveBeenCalledWith({
        trackId: 't1',
        thumbs: 'up',
        difficulty: 'medium',
        octave: 'down',
        view: { ...gears, decade: null, mood: null, duetsOnly: false },
      });
    });

    it('a new range keeps what was set on the sheet and asks again with the new range', async () => {
      const { mic, sing } = fakeMic();
      const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
      const { engine, requests } = fakeEngine();
      render(<KaraokeApp api={api} mic={mic} setlistEngine={engine} />);
      await screen.findByText('Plastic Love');
      fireEvent.change(el(SEL.slider('tempo')), { target: { value: '35' } });
      await waitFor(() => expect(requests).toHaveLength(2));
      const tuned = requests[1]!;

      fireEvent.click(screen.getByRole('button', { name: 'Redo your high note, C5' }));
      await throughMic();
      await screen.findByRole('button', { name: /highest note/ });
      sing(440); // A4
      await hold(/highest note/);
      await waitFor(() => expect(requests).toHaveLength(3));
      expect(api.saveRange).toHaveBeenCalledWith({ low: 45, high: 69, source: 'test' });
      expect(requests[2]).toEqual({ ...tuned, range: { low: 45, high: 69 } });
      await screen.findByText('Plastic Love');
      expect(el<HTMLInputElement>(SEL.slider('tempo')).value).toBe('35');
    });
  });

  describe('the list on screen', () => {
    const forward = () => inOrder(allMatches().matches);
    const backward = () => inOrder(allMatches().matches.reverse());
    const ids = (answer: SetlistResponse) => answer.songs.map((s) => s.match.track.id);

    it('is in the order the engine answered, and follows it when it answers differently', async () => {
      const { requests } = await signedInWithEngine((request) => (request.gears.tempo === 90 ? backward() : forward()));
      expect(rowIds()).toEqual(ids(forward()));
      expect(all(SEL.row).map((li) => li.dataset.rank)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);

      fireEvent.change(el(SEL.slider('tempo')), { target: { value: '90' } });
      await waitFor(() => expect(rowIds()).toEqual(ids(backward())));
      // The DOM order is the rank order, so the ranks still run 1 to 10 from the top.
      expect(all(SEL.row).map((li) => li.dataset.rank)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
      expect(requests).toHaveLength(2);
    });

    it('keeps the last list on screen until the answer to a new request arrives', async () => {
      const pending = deferred<SetlistResponse>();
      const { requests } = await signedInWithEngine((request) => (request.gears.tempo === 90 ? pending.promise : forward()));

      fireEvent.change(el(SEL.slider('tempo')), { target: { value: '90' } });
      expect(requests).toHaveLength(2);
      expect(rowIds()).toEqual(ids(forward()));
      expect(screen.queryByText('Loading…')).toBeNull();

      await act(async () => pending.resolve(backward()));
      await waitFor(() => expect(rowIds()).toEqual(ids(backward())));
    });

    it('does not let an answer that arrives late replace the list of a newer request', async () => {
      const slow = deferred<SetlistResponse>();
      const { requests } = await signedInWithEngine((request) =>
        request.gears.tempo === 60 ? slow.promise : request.gears.tempo === 70 ? backward() : forward(),
      );

      fireEvent.change(el(SEL.slider('tempo')), { target: { value: '60' } });
      fireEvent.change(el(SEL.slider('tempo')), { target: { value: '70' } });
      expect(requests.map((r) => r.gears.tempo)).toEqual([DEFAULTS.tempo, 60, 70]);
      await waitFor(() => expect(rowIds()).toEqual(ids(backward())));

      // The slow answer is for a question that has since been replaced: a macrotask later, it has changed nothing.
      await act(async () => {
        slow.resolve(forward());
        await new Promise<void>((done) => setTimeout(done, 0));
      });
      expect(rowIds()).toEqual(ids(backward()));
    });

    it('opening a song and coming back keeps what was set on the sheet, and does not ask again', async () => {
      const { requests } = await signedInWithEngine();
      fireEvent.change(el(SEL.slider('tempo')), { target: { value: '35' } });
      fireEvent.click(el(SEL.era('s80')));
      await waitFor(() => expect(requests).toHaveLength(3));
      const last = requests[2]!;
      expect(last).toMatchObject({ gears: { tempo: 35 }, eras: ['s80'], off: [] });

      fireEvent.click(screen.getByRole('button', { name: /^Lemon/ }));
      expect(screen.getByRole('heading', { name: 'Lemon' })).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Tune your setlist' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Back to songs' }));
      await screen.findByText('Plastic Love');

      // The sheet is as it was left.
      expect(el<HTMLInputElement>(SEL.slider('tempo')).value).toBe('35');
      expect(el(SEL.slider('tempo')).hasAttribute('aria-valuetext')).toBe(false);
      expect(el(SEL.era('s80')).getAttribute('aria-pressed')).toBe('true');
      for (const era of ['s70', 's90'] as const) expect(el(SEL.era(era)).getAttribute('aria-pressed')).toBe('false');
      // The same request by value is not a new question.
      expect(requests).toHaveLength(3);
      // And the next change builds on what was left.
      fireEvent.click(el(SEL.era('s70')));
      await waitFor(() => expect(requests).toHaveLength(4));
      expect(requests[3]).toEqual({ ...last, eras: [...last.eras, 's70'] });
    });

    it.each([
      ['no-era-picked', 'Pick an era to see songs.'],
      ['no-songs-in-era', 'No songs from those eras fit your range. Try another era, or reset Era.'],
      ['no-songs-in-range', 'None of your songs have range data yet, or none fit your range.'],
    ] as const)('an empty answer %s shows its own words, whatever the tuner says', async (empty, words) => {
      // The tuner has Era off throughout: the screen believes the engine's reason, it does not work one out.
      await signedInWithEngine((request) => (request.gears.tempo === 90 ? inOrder([], { empty }) : forward()));
      expect(rowIds()).toHaveLength(10);
      fireEvent.change(el(SEL.slider('tempo')), { target: { value: '90' } });
      await screen.findByText(words);
      expect(rowIds()).toEqual([]);
      const allWords = ['Pick an era to see songs.', 'No songs from those eras fit your range. Try another era, or reset Era.', 'None of your songs have range data yet, or none fit your range.'];
      expect(allWords.filter((w) => screen.queryByText(w) !== null)).toEqual([words]);
      // Only "Pick an era" is the one that has an id of its own.
      expect(document.querySelector(SEL.empty) !== null).toBe(empty === 'no-era-picked');
    });
  });

  // A big library comes in pages: the server stops its lookups at a budget, says the page is not complete and where it got to,
  // and the screen asks again for the rest (flow.ts allLoaded). `loading` stays true between the pages.
  describe('a library that arrives in pages', () => {
    const firstPage = () => ({ ...allMatches(5), complete: false, nextOffset: 5 });

    it('shows the rows of the first page with "Loading…" while the second is awaited, then every row', async () => {
      const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
      const second = deferred<RecommendationsResponse>();
      api.allRecommendations.mockImplementationOnce(async () => firstPage()).mockImplementationOnce(() => second.promise);
      render(<KaraokeApp api={api} mic={fakeMic().mic} />);

      // The five songs that have arrived are on screen, ranked, and the list says it is not finished.
      await waitFor(() => expect(rowIds()).toHaveLength(5));
      expect([...rowIds()].sort()).toEqual(['t0', 't1', 't2', 't3', 't4']);
      // The note is under the rows that are showing, not above them, and there is only the one.
      const notes = screen.getAllByText('Loading…');
      expect(notes).toHaveLength(1);
      expect(el(SEL.list).compareDocumentPosition(notes[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(api.allRecommendations).toHaveBeenCalledTimes(2);
      // Not the end of the list yet: the rest of the library is on its way, and nothing is offered to load.
      expect(screen.queryByText('That’s every song that fits, for now.')).toBeNull();
      expect(screen.queryByText('Couldn’t load songs.')).toBeNull();

      // The second page lands: every row is there, and "Loading…" is gone.
      await act(async () => second.resolve(allMatches()));
      await waitFor(() => expect(rowIds()).toHaveLength(10));
      expect(screen.queryByText('Loading…')).toBeNull();
      expect(screen.getByText('That’s every song that fits, for now.')).toBeTruthy();
      expect(api.allRecommendations).toHaveBeenCalledTimes(2);
    });

    it('asks the engine as soon as there is a song, while the rest is still loading, and shows what it answered', async () => {
      const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
      const second = deferred<RecommendationsResponse>();
      api.allRecommendations.mockImplementationOnce(async () => firstPage()).mockImplementationOnce(() => second.promise);
      const { engine, requests } = fakeEngine(() => inOrder(allMatches(5).matches));
      render(<KaraokeApp api={api} mic={fakeMic().mic} setlistEngine={engine} />);

      await waitFor(() => expect(rowIds()).toHaveLength(5));
      expect(requests).toHaveLength(1);
      expect(screen.getByText('Loading…')).toBeTruthy();
      expect(rowIds()).toEqual(['t0', 't1', 't2', 't3', 't4']);
      // The sheet works on the rows that are there while the rest comes in.
      fireEvent.change(el(SEL.slider('tempo')), { target: { value: '35' } });
      await waitFor(() => expect(requests).toHaveLength(2));
      expect(requests[1]!.gears.tempo).toBe(35);
      expect(screen.getByText('Loading…')).toBeTruthy();
    });

    it('a page that fails to come keeps the rows that arrived, with the error under the tuner', async () => {
      const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
      api.allRecommendations.mockImplementationOnce(async () => firstPage()).mockRejectedValueOnce(new Error('offline'));
      render(<KaraokeApp api={api} mic={fakeMic().mic} />);
      expect(await screen.findByText('Couldn’t load songs.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Try loading songs again' })).toBeTruthy();
      expect(screen.queryByText('Loading…')).toBeNull();
    });
  });

  // A server engine sends the songs it ranked, which need not be among the matches the screen loaded: a tapped row is looked
  // up in the engine's answer first (and in the loaded matches after that).
  describe('a song only the engine sent', () => {
    /** Mr. Brightside (t15) is not among the three songs loaded (t0 to t2); the engine sends it first. */
    const extra = () => match(15);
    const withExtra = (loaded: Match[]) => inOrder([extra(), ...loaded]);

    it('opens its page when its row is tapped, and a thumbs tap sends feedback for it', async () => {
      const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
      api.allRecommendations.mockImplementation(async () => allMatches(3));
      const { engine } = fakeEngine(() => withExtra(allMatches(3).matches));
      const { tracked, track } = fakeTracker();
      render(<KaraokeApp api={api} track={track} mic={fakeMic().mic} setlistEngine={engine} />);

      expect(rowIds()).toEqual([]);
      fireEvent.click(await screen.findByRole('button', { name: /^Mr\. Brightside/ }));
      expect(rowIds()).toEqual([]);
      expect(screen.getByRole('heading', { name: 'Mr. Brightside' })).toBeTruthy();
      expect(screen.getByText('Hard')).toBeTruthy();
      // It was the first row, so that is its position in the event log; the log never carries the song itself.
      expect(tracked.find((e) => e.name === 'song_open')!.props).toMatchObject({ position: 1 });
      expect(JSON.stringify(tracked)).not.toMatch(/Brightside|Killers|t15/);

      fireEvent.click(screen.getByRole('button', { name: 'It went well' }));
      expect(screen.getByText('Thanks! That helps.')).toBeTruthy();
      expect(api.feedback).toHaveBeenCalledTimes(1);
      expect(api.feedback).toHaveBeenCalledWith({ trackId: 't15', thumbs: 'up', difficulty: 'hard', octave: 'none', view: defaultView(true) });
      expect(api.catalogueFeedback).not.toHaveBeenCalled();

      // And back to the list, which still has it.
      fireEvent.click(screen.getByRole('button', { name: 'Back to songs' }));
      expect(await screen.findByRole('button', { name: /^Mr\. Brightside/ })).toBeTruthy();
      expect(rowIds()).toEqual(['t15', 't0', 't1', 't2']);
    });

    it('sends the feedback the catalogue way for a singer without Spotify', async () => {
      localStorage.setItem('kd.range', JSON.stringify({ low: 45, high: 72 }));
      const api = fakeApi(null);
      api.catalogue.mockImplementation(async () => allMatches(3));
      const { engine } = fakeEngine(() => withExtra(allMatches(3).matches));
      render(<KaraokeApp api={api} mic={fakeMic().mic} setlistEngine={engine} />);

      fireEvent.click(await screen.findByRole('button', { name: /^Mr\. Brightside/ }));
      fireEvent.click(screen.getByRole('button', { name: 'It didn\'t go well' }));
      expect(api.feedback).not.toHaveBeenCalled();
      expect(api.catalogueFeedback).toHaveBeenCalledWith({
        trackId: 't15',
        thumbs: 'down',
        difficulty: 'hard',
        octave: 'none',
        view: defaultView(),
        anonId: localStorage.getItem('kd.anonId'),
        range: { low: 45, high: 72 },
      });
    });

    it('uses the engine\'s own copy of a song that is in both, which wins over the loaded one', async () => {
      const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
      api.allRecommendations.mockImplementation(async () => allMatches(3));
      // The server engine sees t0 as Hard where the loaded list has it Easy.
      const theirs: Match = { ...allMatches(3).matches[0]!, difficulty: 'hard' };
      const { engine } = fakeEngine(() => inOrder([theirs, ...allMatches(3).matches.slice(1)]));
      render(<KaraokeApp api={api} mic={fakeMic().mic} setlistEngine={engine} />);

      fireEvent.click(await screen.findByRole('button', { name: /^Plastic Love/ }));
      expect(screen.getByText('Hard')).toBeTruthy();
      expect(screen.queryByText('Easy')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'It went well' }));
      expect(api.feedback).toHaveBeenCalledWith(expect.objectContaining({ trackId: 't0', difficulty: 'hard' }));
    });
  });

  // No fake engine: the default network engine asks a stand-in for POST /api/setlist (serveSetlist above) that ranks the
  // songs the fake API served with the server's own engine. The ranking maths is tests/songs/setlist.test.ts's.
  describe('the ranking on the phone', () => {
    // Popularity of the fixture songs t0 to t9 (allMatchesWithFacts): .55 .8 .7 .6 .95 .85 .9 .75 .4 .5. t8 and t9 are the Maybe songs.
    /** Ranked on Popularity alone at 100: the sure songs, most popular first, then the Maybe songs the same way. */
    const POPULAR_FIRST = ['t4', 't6', 't5', 't1', 't7', 't2', 't3', 't0', 't9', 't8'];
    /** Ranked on Popularity alone at 0: the sure songs, least popular first, then the Maybe songs the same way. */
    const OBSCURE_FIRST = ['t0', 't3', 't2', 't7', 't1', 't5', 't6', 't4', 't8', 't9'];
    /** Listening history of t0 to t9 is 0.9 - 0.07 x i, so the first song is the one played most. At 0 (Rediscover) the least played comes first. */
    const LEAST_PLAYED_FIRST = ['t7', 't6', 't5', 't4', 't3', 't2', 't1', 't0', 't9', 't8'];
    const SERVER_ORDER = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'];

    async function withFacts(user: MeResponse | null = me({ low: 45, high: 72, source: 'test' })) {
      const api = fakeApi(user);
      api.allRecommendations.mockImplementation(async () => allMatchesWithFacts());
      api.catalogue.mockImplementation(async () => allMatchesWithFacts());
      render(<KaraokeApp api={api} mic={fakeMic().mic} />);
      await screen.findByText('Plastic Love');
      return api;
    }

    /** The difficulty word each row on screen ends its label with, top to bottom. */
    const words = () => rowIds().map((id) => el(`[data-id="${id}"] > button`).getAttribute('aria-label')!.split(', ').at(-1));

    it('Difficulty puts the Easy songs first at 0 and the Hard songs first at 100, the songs sung as written before the octave jumps, and the Maybe songs last either way', async () => {
      await withFacts();
      // Difficulty alone: Popularity and History (which a signed-in singer starts with on: R31) are reset. Each label has a third of the track, so the labels come in blocks, but a song that
      // fits only an octave away (t1 Lemon, t2 Yoru ni Kakeru, t4 Dancing Queen) follows every song sung as written (QWW-58, #37).
      fireEvent.click(el(SEL.reset('popularity')));
      fireEvent.click(el(SEL.reset('history')));
      await waitFor(() => expect(words()).toEqual(['Easy', 'Easy', 'Medium', 'Hard', 'Hard', 'Medium', 'Medium', 'Hard', 'Maybe', 'Maybe']));
      expect(rowIds().slice(0, 5).sort()).toEqual(['t0', 't3', 't5', 't6', 't7']); // sung as written
      expect(rowIds().slice(5, 8).sort()).toEqual(['t1', 't2', 't4']); // the octave jumps
      expect(rowIds().slice(8).sort()).toEqual(['t8', 't9']); // the Maybe songs

      fireEvent.change(el(SEL.slider('difficulty')), { target: { value: '100' } });
      await waitFor(() => expect(words()).toEqual(['Hard', 'Hard', 'Medium', 'Easy', 'Easy', 'Hard', 'Medium', 'Medium', 'Maybe', 'Maybe']));
      expect(rowIds().slice(0, 5).sort()).toEqual(['t0', 't3', 't5', 't6', 't7']);
      expect(rowIds().slice(5, 8).sort()).toEqual(['t1', 't2', 't4']);
      expect(rowIds().slice(8).sort()).toEqual(['t8', 't9']);
    });

    it('Maybe songs come after the sure ones, and a Maybe row says so in its label', async () => {
      await withFacts();
      expect(rowIds().slice(-2).sort()).toEqual(['t8', 't9']);
      const label = (id: string) => el(`[data-id="${id}"] > button`).getAttribute('aria-label')!;
      expect(label('t8')).toBe('Linda Linda by The Blue Hearts, ’80s, Maybe');
      expect(label('t9')).toBe('Sukiyaki by Kyu Sakamoto, Pre-’70s, Maybe');
      for (const id of SERVER_ORDER.slice(0, 8)) expect(label(id).endsWith(', Maybe')).toBe(false);
    });

    it('era buttons filter the list, unpicking the last era turns Era off and shows every song (R23), and Reset shows every song again', async () => {
      await withFacts();
      expect(rowIds()).toHaveLength(10);
      // Era starts off with no picks: no button is pressed and none is outlined.
      for (const era of ERA_IDS) {
        expect(el(SEL.era(era)).getAttribute('aria-pressed')).toBe('false');
        expect(el(SEL.era(era)).hasAttribute('data-parked')).toBe(false);
      }
      expect(el(SEL.reset('era')).hasAttribute('hidden')).toBe(true);

      // A tap picks just that era. By year, the fixture has t0, t7 and t8 in the 80s, t1 and t2 in the 10s, t5 in the 00s.
      fireEvent.click(el(SEL.era('s80')));
      await waitFor(() => expect([...rowIds()].sort()).toEqual(['t0', 't7', 't8']));
      // t8 is a Maybe song, so it is last.
      expect(rowIds().at(-1)).toBe('t8');
      expect(ERA_IDS.filter((era) => el(SEL.era(era)).getAttribute('aria-pressed') === 'true')).toEqual(['s80']);
      expect(el(SEL.eraPanel).hasAttribute('data-off')).toBe(false);
      expect(screen.queryByText('Pick an era to see songs.')).toBeNull();

      fireEvent.click(el(SEL.era('s10')));
      await waitFor(() => expect([...rowIds()].sort()).toEqual(['t0', 't1', 't2', 't7', 't8']));
      expect(ERA_IDS.filter((era) => el(SEL.era(era)).getAttribute('aria-pressed') === 'true')).toEqual(['s80', 's10']);

      // Unpick the 80s and Era stays on with the 10s alone.
      fireEvent.click(el(SEL.era('s80')));
      await waitFor(() => expect([...rowIds()].sort()).toEqual(['t1', 't2']));
      expect(el(SEL.eraPanel).hasAttribute('data-off')).toBe(false);

      // Unpick the last one: Era is off, so every song is back (R23), not the empty "Pick an era" screen, and nothing is pressed.
      fireEvent.click(el(SEL.era('s10')));
      await waitFor(() => expect(rowIds()).toHaveLength(10));
      expect(document.querySelector(SEL.empty)).toBeNull();
      expect(screen.queryByText('Pick an era to see songs.')).toBeNull();
      expect(el(SEL.eraPanel).hasAttribute('data-off')).toBe(true);
      expect(el(SEL.reset('era')).hasAttribute('hidden')).toBe(true);
      for (const era of ERA_IDS) expect(el(SEL.era(era)).getAttribute('aria-pressed')).toBe('false');

      // Reset, from a pick, is Era off again with every song back, and the focus goes to the first era button.
      fireEvent.click(el(SEL.era('s80')));
      await waitFor(() => expect([...rowIds()].sort()).toEqual(['t0', 't7', 't8']));
      fireEvent.click(el(SEL.reset('era')));
      await waitFor(() => expect(rowIds()).toHaveLength(10));
      expect(screen.queryByText('Pick an era to see songs.')).toBeNull();
      for (const era of ERA_IDS) expect(el(SEL.era(era)).getAttribute('aria-pressed')).toBe('false');
      expect(document.activeElement).toBe(el(SEL.era('pre')));
    });

    it('R22, R23: Era off asks for no era: picking one era and unpicking it sends the request first load sent, and the list is the same', async () => {
      const { requests } = await signedInWithEngine();
      const first = requests[0]!;
      expect(first.off).toContain('era');
      expect(first.eras).toEqual([]);
      const before = rowIds();
      expect(before).toHaveLength(10);

      fireEvent.click(el(SEL.era('s80')));
      await waitFor(() => expect(requests).toHaveLength(2));
      expect(requests[1]).toMatchObject({ eras: ['s80'] });
      expect(requests[1]!.off).not.toContain('era');

      fireEvent.click(el(SEL.era('s80')));
      await waitFor(() => expect(requests).toHaveLength(3));
      expect(requests[2]).toEqual(first);
      expect(rowIds()).toEqual(before);
    });

    it('an era with no song in it says so, which is not the same as no era picked, and Reset brings every song back', async () => {
      await withFacts();
      // No fixture song is from the 2020s.
      fireEvent.click(el(SEL.era('s20')));
      await waitFor(() => expect(rowIds()).toEqual([]));
      expect(screen.getByText('No songs from those eras fit your range. Try another era, or reset Era.')).toBeTruthy();
      expect(document.querySelector(SEL.empty)).toBeNull();
      expect(screen.queryByText('Pick an era to see songs.')).toBeNull();
      expect(el(SEL.reset('era')).hasAttribute('hidden')).toBe(false);

      fireEvent.click(el(SEL.reset('era')));
      await waitFor(() => expect(rowIds()).toHaveLength(10));
      expect(screen.queryByText('No songs from those eras fit your range. Try another era, or reset Era.')).toBeNull();
    });
  });

  describe('signed in and out, and the sheet mode', () => {
    it('History is usable and starts on at 100 when signed in (R31), and is disabled with a hint when there is no library', async () => {
      const signedIn = render(<KaraokeApp api={fakeApi(me({ low: 45, high: 72, source: 'test' }))} mic={fakeMic().mic} />);
      await screen.findByText('Plastic Love');
      const history = el<HTMLInputElement>(SEL.slider('history'));
      expect(history.disabled).toBe(false);
      // "That's the purpose of logging in": On repeat, with its turn-off button showing, unlike Tempo and Era, which start off.
      expect(history.value).toBe('100');
      expect(history.hasAttribute('aria-valuetext')).toBe(false);
      expect(el(SEL.strip('history')).hasAttribute('data-off')).toBe(false);
      expect(el(SEL.reset('history')).hasAttribute('hidden')).toBe(false);
      expect(el(SEL.strip('tempo')).hasAttribute('data-off')).toBe(true);
      expect(screen.queryByText(HISTORY_HINT)).toBeNull();
      // Its button turns it off like any gear's (R21), back at 100, and touching it turns it on again from there.
      fireEvent.change(history, { target: { value: '40' } });
      fireEvent.click(el(SEL.reset('history')));
      expect(history.value).toBe('100');
      expect(history.getAttribute('aria-valuetext')).toBe('Off');
      expect(el(SEL.reset('history')).hasAttribute('hidden')).toBe(true);
      faderPointer('pointerDown', fader('history'), { x: faderX(DEFAULTS.history) });
      expect(history.hasAttribute('aria-valuetext')).toBe(false);
      expect(el(SEL.reset('history')).hasAttribute('hidden')).toBe(false);
      signedIn.unmount();

      localStorage.setItem('kd.range', JSON.stringify({ low: 45, high: 72 }));
      render(<KaraokeApp api={fakeApi(null)} mic={fakeMic().mic} />);
      await screen.findByText('Plastic Love');
      const none = el<HTMLInputElement>(SEL.slider('history'));
      expect(none.disabled).toBe(true);
      expect(none.getAttribute('aria-valuetext')).toBe('Off');
      expect(el(SEL.reset('history')).hasAttribute('hidden')).toBe(true);
      expect(screen.getByText(HISTORY_HINT)).toBeTruthy();
    });

    it('logging out keeps what was tuned: the sheet and the next request are as they were, and History is off for want of a library', async () => {
      const { requests } = await signedInWithEngine();
      fireEvent.change(el(SEL.slider('tempo')), { target: { value: '35' } });
      fireEvent.change(el(SEL.slider('difficulty')), { target: { value: '60' } });
      fireEvent.click(el(SEL.era('s80')));
      await waitFor(() => expect(requests).toHaveLength(4));
      const tuned = requests[3]!;
      expect(tuned).toMatchObject({ gears: { tempo: 35, difficulty: 60 }, eras: ['s80'], off: [] });

      fireEvent.click(screen.getByRole('button', { name: 'Spotify account' }));
      fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
      // The catalogue loads, and then the request is exactly the one before: nothing needed resetting, and the request does
      // not say who is signed in (the engine knows there is no library and leaves History out).
      await waitFor(() => expect(requests).toHaveLength(5));
      expect(requests[4]).toEqual(tuned);
      expect(requests[4]).not.toEqual(requests[0]);
      // The sheet is as it was: Tempo on at 35, Difficulty at 60, the 80s picked.
      expect(el<HTMLInputElement>(SEL.slider('tempo')).value).toBe('35');
      expect(el(SEL.slider('tempo')).hasAttribute('aria-valuetext')).toBe(false);
      expect(el<HTMLInputElement>(SEL.slider('difficulty')).value).toBe('60');
      expect(el(SEL.era('s80')).getAttribute('aria-pressed')).toBe('true');
      expect(ERA_IDS.filter((era) => el(SEL.era(era)).getAttribute('aria-pressed') === 'true')).toEqual(['s80']);
      // History is the one thing that cannot be: it needs a library. It is off and disabled, with its hint.
      const history = el<HTMLInputElement>(SEL.slider('history'));
      expect(history.disabled).toBe(true);
      expect(history.getAttribute('aria-valuetext')).toBe('Off');
      expect(screen.getByText(HISTORY_HINT)).toBeTruthy();
    });

    it('logging out keeps the sheet mode too: a sheet in mini mode stays mini, on the gear that was open', async () => {
      window.history.replaceState(null, '', '/?mini=1');
      await signedInWithEngine();
      expect(el(SEL.app).dataset.mode).toBe('mini');
      fireEvent.click(el(SEL.tab('popularity')));
      expect(el(SEL.app).dataset.open).toBe('popularity');

      fireEvent.click(screen.getByRole('button', { name: 'Spotify account' }));
      fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
      await screen.findByRole('button', { name: 'Connect to Spotify' });
      expect(el(SEL.app).dataset.mode).toBe('mini');
      expect(el(SEL.app).dataset.open).toBe('popularity');
      expect(el(SEL.handle).getAttribute('aria-expanded')).toBe('false');
    });

    it('starts with the sheet expanded, or in mini mode when the address says ?mini=1, and the mini sheet opens on Difficulty for everyone', async () => {
      const plain = render(<KaraokeApp api={fakeApi(me({ low: 45, high: 72, source: 'test' }))} mic={fakeMic().mic} />);
      await screen.findByText('Plastic Love');
      expect(el(SEL.app).dataset.mode).toBe('expanded');
      expect(el(SEL.handle).getAttribute('aria-expanded')).toBe('true');
      plain.unmount();

      window.history.replaceState(null, '', '/?mini=1');
      const signedIn = render(<KaraokeApp api={fakeApi(me({ low: 45, high: 72, source: 'test' }))} mic={fakeMic().mic} />);
      await screen.findByText('Plastic Love');
      expect(el(SEL.app).dataset.mode).toBe('mini');
      expect(el(SEL.handle).getAttribute('aria-expanded')).toBe('false');
      // The first gear that is on, signed in or not: Difficulty.
      expect(el(SEL.app).dataset.open).toBe('difficulty');
      signedIn.unmount();

      localStorage.setItem('kd.range', JSON.stringify({ low: 45, high: 72 }));
      render(<KaraokeApp api={fakeApi(null)} mic={fakeMic().mic} />);
      await screen.findByText('Plastic Love');
      expect(el(SEL.app).dataset.mode).toBe('mini');
      expect(el(SEL.app).dataset.open).toBe('difficulty');
    });
  });

  describe('when the songs do not come', () => {
    it('after Log out, none of the library songs stay on screen while the catalogue loads, not even for one render', async () => {
      const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
      const catalogue = deferred<RecommendationsResponse>();
      api.catalogue.mockImplementation(() => catalogue.promise);
      render(<KaraokeApp api={api} mic={fakeMic().mic} />);
      await screen.findByText('Plastic Love');
      expect(rowIds()).toHaveLength(10);

      fireEvent.click(screen.getByRole('button', { name: 'Spotify account' }));
      fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
      await screen.findByText('Loading…');
      // findBy resolves on the first commit that shows "Loading…": the library's rows are already gone from that one.
      expect(rowIds()).toEqual([]);

      await act(async () => catalogue.resolve(allMatches(3)));
      await waitFor(() => expect(rowIds()).toHaveLength(3));
    });

    it('after Log out, a catalogue that cannot load shows the error and no library songs, and Try again brings the catalogue songs', async () => {
      const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
      api.catalogue.mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(async () => allMatches(3));
      render(<KaraokeApp api={api} mic={fakeMic().mic} />);
      await screen.findByText('Plastic Love');
      expect(rowIds()).toHaveLength(10);

      fireEvent.click(screen.getByRole('button', { name: 'Spotify account' }));
      fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
      expect(await screen.findByText('Couldn’t load songs.')).toBeTruthy();
      expect(rowIds()).toEqual([]);

      fireEvent.click(screen.getByRole('button', { name: 'Try loading songs again' }));
      await waitFor(() => expect(rowIds()).toHaveLength(3));
      expect(screen.queryByText('Couldn’t load songs.')).toBeNull();
      expect(api.catalogue).toHaveBeenCalledTimes(2);
      expect(api.allRecommendations).toHaveBeenCalledTimes(1);
    });

    it('after a new range is saved, the songs of the old range do not stay on screen while the new list loads, not even for one render', async () => {
      const { mic, sing } = fakeMic();
      const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
      const second = deferred<RecommendationsResponse>();
      api.allRecommendations.mockImplementationOnce(async () => allMatches()).mockImplementationOnce(() => second.promise);
      render(<KaraokeApp api={api} mic={mic} />);
      await screen.findByText('Plastic Love');
      expect(rowIds()).toHaveLength(10);

      fireEvent.click(screen.getByRole('button', { name: 'Redo your low note, A2' }));
      await throughMic();
      await screen.findByRole('button', { name: /lowest note/ });
      sing(98); // G2
      await hold(/lowest note/);
      await screen.findByText('Loading…');
      expect(api.saveRange).toHaveBeenCalledWith({ low: 43, high: 72, source: 'test' });
      // The first commit that shows "Loading…" has no row of the old range in it.
      expect(rowIds()).toEqual([]);

      await act(async () => second.resolve(allMatches(4)));
      await waitFor(() => expect(rowIds()).toHaveLength(4));
    });

    it('a range with no songs says so, with no list, and only the logo left to connect Spotify', async () => {
      localStorage.setItem('kd.range', JSON.stringify({ low: 45, high: 72 }));
      const api = fakeApi(null);
      api.catalogue.mockImplementation(async () => allMatches(0));
      render(<KaraokeApp api={api} mic={fakeMic().mic} />);

      expect(await screen.findByText('None of our catalogue songs fit this range yet.')).toBeTruthy();
      expect(rowIds()).toEqual([]);
      // Era is off, so this is not the empty state of an Era with nothing picked.
      expect(screen.queryByText('Pick an era to see songs.')).toBeNull();
      expect(screen.getAllByRole('button', { name: 'Connect to Spotify' })).toHaveLength(1);
      expect(screen.queryByText('Want personalized recommendations?')).toBeNull();
    });

    it('a failed load says so, asks the engine nothing, and Try again asks the server again', async () => {
      const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
      api.allRecommendations.mockRejectedValueOnce(new Error('offline'));
      const { engine, requests } = fakeEngine();
      render(<KaraokeApp api={api} mic={fakeMic().mic} setlistEngine={engine} />);

      expect(await screen.findByText('Couldn’t load songs.')).toBeTruthy();
      expect(requests).toEqual([]);
      expect(rowIds()).toEqual([]);

      fireEvent.click(screen.getByRole('button', { name: 'Try loading songs again' }));
      await screen.findByText('Plastic Love');
      expect(api.allRecommendations).toHaveBeenCalledTimes(2);
      expect(requests).toHaveLength(1);
      expect(screen.queryByText('Couldn’t load songs.')).toBeNull();
    });

    // The engine, not the songs, failed: the screen says the same thing, and the sheet still works.
    it('an engine that cannot answer shows the error with no rows, and a change on the sheet asks it again and recovers', async () => {
      const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
      let down = true;
      const { engine, requests } = fakeEngine(() => {
        if (down) throw new Error('engine down');
        return inOrder(allMatches().matches);
      });
      render(<KaraokeApp api={api} mic={fakeMic().mic} setlistEngine={engine} />);

      expect(await screen.findByText('Couldn’t load songs.')).toBeTruthy();
      expect(requests).toHaveLength(1);
      expect(rowIds()).toEqual([]);
      expect(screen.getByRole('button', { name: 'Try loading songs again' })).toBeTruthy();
      expect(screen.queryByText('Loading…')).toBeNull();

      // A new question goes to the engine, and its answer takes the error away.
      down = false;
      fireEvent.change(el(SEL.slider('tempo')), { target: { value: '35' } });
      await screen.findByText('Plastic Love');
      expect(requests).toHaveLength(2);
      expect(screen.queryByText('Couldn’t load songs.')).toBeNull();
      expect(rowIds()).toHaveLength(10);
    });

    // Try again clears the request while the songs load again (the old songs are not asked about again), so an injected engine
    // (one that is not rebuilt from the new matches, as a server engine is not) is asked anew once they land.
    it('an engine that cannot answer: Try again loads the songs again and asks the engine again', async () => {
      const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
      let down = true;
      const { engine, requests } = fakeEngine(() => {
        if (down) throw new Error('engine down');
        return inOrder(allMatches().matches);
      });
      render(<KaraokeApp api={api} mic={fakeMic().mic} setlistEngine={engine} />);

      expect(await screen.findByText('Couldn’t load songs.')).toBeTruthy();
      expect(requests).toHaveLength(1);
      expect(rowIds()).toEqual([]);

      down = false;
      fireEvent.click(screen.getByRole('button', { name: 'Try loading songs again' }));
      await screen.findByText('Plastic Love');
      expect(api.allRecommendations).toHaveBeenCalledTimes(2);
      expect(requests).toHaveLength(2);
      expect(screen.queryByText('Couldn’t load songs.')).toBeNull();
    });

    // The same retry with the default engine: the stand-in server throws on a song with no range.
    it('a bad song in the list the server sent makes the engine throw on the spot: the error shows, and Try again with a good list recovers', async () => {
      const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
      const bad = { ...allMatches(), matches: allMatches().matches.map((m, i) => (i === 3 ? { ...m, range: undefined as unknown as SongRange } : m)) };
      api.allRecommendations.mockImplementationOnce(async () => bad);
      render(<KaraokeApp api={api} mic={fakeMic().mic} />);

      expect(await screen.findByText('Couldn’t load songs.')).toBeTruthy();
      expect(rowIds()).toEqual([]);
      expect(screen.getByRole('button', { name: 'Try loading songs again' })).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Try loading songs again' }));
      await screen.findByText('Plastic Love');
      expect(api.allRecommendations).toHaveBeenCalledTimes(2);
      expect(screen.queryByText('Couldn’t load songs.')).toBeNull();
      expect(rowIds()).toHaveLength(10);
    });

    // An engine that throws before it returns a promise (not an `async` function) is a failed answer like any other.
    describe('an engine that throws on the spot', () => {
      const throwing = (isBad: () => boolean) => {
        const requests: SetlistRequest[] = [];
        const engine: SetlistEngine = {
          rank: (request) => {
            requests.push(request);
            if (isBad()) throw new Error('a song with no range');
            return Promise.resolve(inOrder(allMatches().matches));
          },
        };
        return { engine, requests };
      };

      it('shows "Couldn’t load songs." and no rows when it throws on its very first request, and the screen stays up', async () => {
        const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
        const { engine, requests } = throwing(() => true);
        render(<KaraokeApp api={api} mic={fakeMic().mic} setlistEngine={engine} />);

        expect(await screen.findByText('Couldn’t load songs.')).toBeTruthy();
        expect(requests).toHaveLength(1);
        expect(rowIds()).toEqual([]);
        // The rest of the screen is there to use: the heading, the sheet and the way out.
        expect(screen.getByRole('heading', { name: 'Tune your setlist' })).toBeTruthy();
        expect(el(SEL.sheet)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Try loading songs again' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Load more songs' })).toBeNull();
      });

      it('keeps the rows of its last answer on screen when a later request makes it throw, with the error shown, and recovers on the next answer', async () => {
        const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
        let bad = false;
        const { engine, requests } = throwing(() => bad);
        render(<KaraokeApp api={api} mic={fakeMic().mic} setlistEngine={engine} />);
        await screen.findByText('Plastic Love');
        const before = rowIds();
        expect(before).toHaveLength(10);
        expect(screen.queryByText('Couldn’t load songs.')).toBeNull();

        bad = true;
        fireEvent.change(el(SEL.slider('tempo')), { target: { value: '35' } });
        expect(await screen.findByText('Couldn’t load songs.')).toBeTruthy();
        expect(requests).toHaveLength(2);
        expect(rowIds()).toEqual(before);
        expect(screen.getByRole('button', { name: 'Try loading songs again' })).toBeTruthy();
        // While it has failed nothing says the list is complete.
        expect(screen.queryByText('That’s every song that fits, for now.')).toBeNull();

        bad = false;
        fireEvent.change(el(SEL.slider('tempo')), { target: { value: '36' } });
        await waitFor(() => expect(screen.queryByText('Couldn’t load songs.')).toBeNull());
        expect(requests).toHaveLength(3);
        expect(rowIds()).toHaveLength(10);
        expect(screen.getByText('That’s every song that fits, for now.')).toBeTruthy();
      });
    });
  });
});
