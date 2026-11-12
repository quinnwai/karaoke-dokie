// @vitest-environment jsdom
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KaraokeApp } from '../../src/components/KaraokeApp';
import type { Api } from '../../src/lib/client/api';
import { MicError, type Mic, type MicPermission, type MicRecorder } from '../../src/lib/client/mic';
import type { MeResponse, VocalRange } from '../../src/lib/contracts';
import { noise, SAMPLE_RATE, voice } from '../helpers/synth';
import { allMatches, knownSongs, me, recommendationsPage } from '../fixtures/screen';
import { DEFAULT_VIEW } from '../../src/lib/songs/browse';

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
  return api;
}

const lyrics = () => Array.from(document.querySelectorAll('[data-lyric]')).map((p) => p.textContent);
/** Each song's reason line as read on screen (its words are sung in one by one, so they sit in separate spans). */
const reasonLines = () => Array.from(document.querySelectorAll('[data-reasons]')).map((r) => r.textContent!.replace(/\u00a0/g, ' '));

async function hold(label: RegExp) {
  const button = screen.getByRole('button', { name: label });
  await act(async () => {
    fireEvent.pointerDown(button);
  });
  await act(async () => {
    fireEvent.pointerUp(button);
  });
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(cleanup);

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
    expect(JSON.parse(sessionStorage.getItem('kd.test')!)).toEqual({ low: 45, high: 72, measuredAt: expect.any(Number) });

    fireEvent.click(arrow);
    await screen.findByText('Plastic Love');
    expect(navigate).not.toHaveBeenCalled();
    expect(api.catalogue).toHaveBeenCalledWith({ low: 45, high: 72 });
    expect(api.allRecommendations).not.toHaveBeenCalled();
    // The range stays on this device instead of an account, with the time it was sung (QWW-66).
    expect(JSON.parse(localStorage.getItem('kd.range')!)).toEqual({ low: 45, high: 72, measuredAt: expect.any(Number) });
    expect(sessionStorage.getItem('kd.test')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Connect to Spotify' })).toHaveLength(2);
    // Under the list: one short question, the button, and who can sign in (Spotify adds testers by hand, QWW-53).
    expect(screen.getByText('Want personalized recommendations?')).toBeTruthy();
    expect(screen.getByText('Invited testers only for now.')).toBeTruthy();
    expect(screen.queryByText(/every song that fits|invite-only|from our catalogue/)).toBeNull();
    // Catalogue songs are nobody's library, so there is no on-repeat slider.
    expect(screen.getByRole('slider', { name: 'Light work to Locked in' })).toBeTruthy();
    expect(screen.queryByRole('slider', { name: 'Rediscover to On repeat' })).toBeNull();
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
      expect(screen.getAllByRole('button', { name: 'Connect to Spotify' })).toHaveLength(2);
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

  it('catalogue feedback goes to the catalogue route with the device id and range', async () => {
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
      view: DEFAULT_VIEW,
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
    expect(api.saveRange).toHaveBeenCalledWith({ low: 37, high: 72, source: 'test', measuredAt: expect.any(Number) });
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

  it('after sign-in saves the stored range and shows results', async () => {
    sessionStorage.setItem('kd.test', JSON.stringify({ low: 45, high: 72 }));
    window.history.replaceState(null, '', '/?signedIn=1');
    const api = fakeApi(me());
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);

    await screen.findByText('Plastic Love');
    expect(api.saveRange).toHaveBeenCalledWith({ low: 45, high: 72, source: 'test' });
    expect(sessionStorage.getItem('kd.test')).toBeNull();
    expect(window.location.search).toBe('');
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getAllByRole('img', { name: 'Sing it an octave lower than the artist' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^Lemon by Kenshi Yonezu, Medium\. Sing it lower than the artist$/ })).toBeTruthy();
    expect(reasonLines()).toContain('In your sweet spot · Top songs this month');
    expect(screen.getAllByText('Easy').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Load more songs' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(10));
    // Every match came in one request; more songs come from memory.
    expect(api.allRecommendations).toHaveBeenCalledTimes(1);
    expect(api.recommendations).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Load more songs' })).toBeNull();
  });

  it('a slider reorders the songs without asking the server again, and Reset puts them back', async () => {
    const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);
    await screen.findByText('Plastic Love');
    const titles = () => Array.from(document.querySelectorAll('ol li')).map((li) => li.querySelector('[class*="songTitle"]')?.textContent);
    const before = titles();
    const slider = screen.getByRole('slider', { name: 'Light work to Locked in' });
    expect(slider.getAttribute('aria-valuetext')).toBe('not set');
    // No title line over the list: the reasons under each song are what gets sung in.
    expect(lyrics()).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Reset sliders' })).toBeNull();

    fireEvent.change(slider, { target: { value: '100' } });
    expect(slider.getAttribute('aria-valuetext')).toBe('towards Locked in');
    const lockedIn = titles();
    expect(lockedIn).not.toEqual(before);
    fireEvent.change(slider, { target: { value: '0' } });
    expect(slider.getAttribute('aria-valuetext')).toBe('towards Light work');
    expect(titles()).not.toEqual(lockedIn);

    fireEvent.click(screen.getByRole('button', { name: 'Reset sliders' }));
    expect(slider.getAttribute('aria-valuetext')).toBe('not set');
    expect(titles()).toEqual(before);
    expect(api.allRecommendations).toHaveBeenCalledTimes(1);
  });

  it('an untouched slider switches on when a tap ends, not when a touch starts a scroll or a right click', async () => {
    const tracked: { name: string; props?: Record<string, unknown> }[] = [];
    const track = { track: (name: string, props?: Record<string, unknown>) => void tracked.push({ name, props }), flush: async () => {} };
    render(<KaraokeApp api={fakeApi(me({ low: 45, high: 72, source: 'test' }))} track={track} mic={fakeMic().mic} />);
    await screen.findByText('Plastic Love');
    const slider = screen.getByRole('slider', { name: 'Light work to Locked in' });
    const sliderEvents = () => tracked.filter((e) => e.name === 'slider_changed');

    // A vertical scroll that starts on the track: the browser cancels the pointer.
    fireEvent.pointerDown(slider);
    fireEvent.pointerCancel(slider);
    // A right click (jsdom has no PointerEvent, so the button is set by hand).
    const rightClick = createEvent.pointerUp(slider);
    Object.defineProperty(rightClick, 'button', { value: 2 });
    fireEvent(slider, rightClick);
    expect(slider.getAttribute('aria-valuetext')).toBe('not set');
    expect(screen.queryByRole('button', { name: 'Reset sliders' })).toBeNull();
    expect(sliderEvents()).toEqual([]);

    // A tap on the thumb: nothing moves, and the slider switches on at the middle, recorded once.
    fireEvent.pointerDown(slider);
    fireEvent.pointerUp(slider);
    expect(slider.getAttribute('aria-valuetext')).toBe('in between');
    expect(sliderEvents()).toHaveLength(1);
    expect(sliderEvents()[0]!.props).toMatchObject({ slider: 'difficulty', difficulty: 0.5 });

    // Another tap on a slider that is already on records nothing.
    fireEvent.pointerUp(slider);
    expect(sliderEvents()).toHaveLength(1);

    // Reset disappears once pressed, and focus moves to the Tune panel rather than the page.
    fireEvent.click(screen.getByRole('button', { name: 'Reset sliders' }));
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Tune' }));
  });

  it('decade chips filter the list and show their counts', async () => {
    const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    const years = [1984, 2017, 2020, 1957, 1975, 2004, 1975, 1985, 1987, 1963];
    api.allRecommendations.mockImplementation(async () => {
      const page = allMatches();
      page.matches = page.matches.map((m, i) => ({ ...m, year: years[i] }));
      return page;
    });
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);
    await screen.findByText('Plastic Love');
    expect(screen.getByText('Mariya Takeuchi · 1984')).toBeTruthy();
    const eighties = screen.getByRole('button', { name: '80s, 3 songs' });
    expect(screen.getByRole('button', { name: '90s, 0 songs' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(eighties);
    expect(eighties.getAttribute('aria-pressed')).toBe('true');
    // Two sure fits and one Maybe from the 80s.
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });

  it('song detail: range bar, info tooltip, feedback', async () => {
    const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);

    const song = await screen.findByRole('button', { name: /^Yoru ni Kakeru/ });
    // The screen is one scroller shared with the list: a song opened from a scrolled list must start at the top.
    const scroller = screen.getByRole('region', { name: 'Karaoke screen' }).querySelector('div > div') as HTMLElement;
    scroller.scrollTop = 120;
    fireEvent.click(song);
    expect(scroller.scrollTop).toBe(0);
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
    expect(api.feedback).toHaveBeenCalledWith({ trackId: 't2', thumbs: 'up', difficulty: 'hard', octave: 'down', view: DEFAULT_VIEW });
    // Tapping a thumb must not reload the player: that would restart the song.
    expect(screen.getByTitle('Spotify player: Yoru ni Kakeru by YOASOBI')).toBe(player);

    fireEvent.click(screen.getByRole('button', { name: 'Back to songs' }));
    expect(await screen.findByText('Plastic Love')).toBeTruthy();
    // Leaving the page removes the player, which stops the song.
    expect(screen.queryByTitle(/^Spotify player/)).toBeNull();
  });

  it('returning user lands on results and can redo the test', async () => {
    const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    render(<KaraokeApp api={api} mic={fakeMic().mic} quietMs={60_000} />);
    await screen.findByText('Plastic Love');
    expect(api.saveRange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Redo the singing test' }));
    await waitFor(() => expect(lyrics()).toContain('Find a quiet spot'));
  });

  it('signed in, the logo is the green account button; Log out ends the session and shows the catalogue songs for the same range', async () => {
    const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    // The catalogue has fewer songs than the library, so the library's can be told apart.
    api.catalogue.mockImplementation(async () => allMatches(3));
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);
    await screen.findByText('Plastic Love');
    expect(screen.getAllByRole('listitem')).toHaveLength(5);

    // Signed in: no Connect to Spotify, a logo that says who, and the library's own on-repeat slider.
    expect(screen.queryByRole('button', { name: 'Connect to Spotify' })).toBeNull();
    const logo = screen.getByRole('button', { name: 'Spotify account' });
    expect(logo.className).toMatch(/connectOn/);
    fireEvent.click(logo);
    expect(screen.getByText('Logged in as Quinn')).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Rediscover to On repeat' })).toBeTruthy();
    expect(api.logout).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connect to Spotify' })).toHaveLength(2));

    // The session ended first, then the catalogue was asked for the same range; the library was not asked again.
    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(api.catalogue).toHaveBeenCalledTimes(1);
    expect(api.catalogue).toHaveBeenCalledWith({ low: 45, high: 72 });
    expect(api.logout.mock.invocationCallOrder[0]).toBeLessThan(api.catalogue.mock.invocationCallOrder[0]!);
    expect(api.allRecommendations).toHaveBeenCalledTimes(1);
    // Nothing of the library is left: three catalogue songs, no account, no on-repeat slider.
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
    expect(screen.queryByRole('button', { name: 'Spotify account' })).toBeNull();
    expect(screen.queryByText(/Logged in/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();
    expect(screen.queryByRole('slider', { name: 'Rediscover to On repeat' })).toBeNull();
    expect(screen.getByRole('slider', { name: 'Light work to Locked in' })).toBeTruthy();
    // The range stays on this device, like it does for anyone without Spotify.
    expect(JSON.parse(localStorage.getItem('kd.range')!)).toEqual({ low: 45, high: 72 });
  });

  it('after logging out, a reload comes back to the catalogue songs for the same range', async () => {
    const first = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    const { unmount } = render(<KaraokeApp api={first} mic={fakeMic().mic} />);
    await screen.findByText('Plastic Love');
    fireEvent.click(screen.getByRole('button', { name: 'Spotify account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connect to Spotify' })).toHaveLength(2));
    unmount();

    // The server no longer knows this browser (the session cookie is gone): /api/me says 401.
    const reloaded = fakeApi(null);
    render(<KaraokeApp api={reloaded} mic={fakeMic().mic} />);
    await screen.findByText('Plastic Love');
    expect(reloaded.catalogue).toHaveBeenCalledWith({ low: 45, high: 72 });
    expect(screen.getAllByRole('button', { name: 'Connect to Spotify' })).toHaveLength(2);
  });

  it('if Log out fails, nothing changes: still signed in, the box says so, and a second try works', async () => {
    const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    api.logout.mockRejectedValueOnce(new Error('offline'));
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);
    await screen.findByText('Plastic Love');
    // Signed in, the device already keeps the range of the list on screen (QWW-66); a failed Log out leaves it as it was.
    const kept = localStorage.getItem('kd.range');
    expect(JSON.parse(kept!)).toEqual({ low: 45, high: 72 });
    fireEvent.click(screen.getByRole('button', { name: 'Spotify account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t log out. Try again.');
    expect(api.catalogue).not.toHaveBeenCalled();
    expect(localStorage.getItem('kd.range')).toBe(kept);
    expect(screen.getByText('Logged in as Quinn')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect to Spotify' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connect to Spotify' })).toHaveLength(2));
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
    await screen.findByRole('button', { name: 'Load more songs' });
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
    await screen.findByRole('button', { name: 'Load more songs' });
    expect(api.saveRange).toHaveBeenCalledWith({ low: 40, high: 64, source: 'songs' });
  });

  it('a library Spotify would not give shows catalogue songs with one quiet note, and feedback goes the catalogue way (QWW-55)', async () => {
    // The control: a library that loaded offers the listening slider and has no note.
    const ok = render(<KaraokeApp api={fakeApi(me({ low: 45, high: 72, source: 'test' }))} mic={fakeMic().mic} />);
    await screen.findByRole('slider', { name: 'Rediscover to On repeat' });
    expect(screen.queryByRole('status')).toBeNull();
    ok.unmount();

    const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    api.allRecommendations.mockImplementation(async () => ({ ...allMatches(), libraryUnavailable: true }));
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);
    expect((await screen.findByRole('status')).textContent).toBe('Couldn’t reach Spotify, showing popular songs.');
    // Still signed in; nothing asks to connect; and the listening slider is not offered for songs with no listening data.
    expect(screen.getByRole('slider', { name: 'Light work to Locked in' })).toBeTruthy();
    expect(screen.queryByRole('slider', { name: 'Rediscover to On repeat' })).toBeNull();
    expect(screen.getByText('Logged in as Quinn')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect to Spotify' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /^Yoru ni Kakeru/ }));
    fireEvent.click(screen.getByRole('button', { name: 'It went well' }));
    expect(api.catalogueFeedback).toHaveBeenCalledTimes(1);
    expect(api.feedback).not.toHaveBeenCalled();
    expect(api.allRecommendations).toHaveBeenCalledTimes(1);
  });

  it('records the beta funnel without any Spotify id or library song', async () => {
    const tracked: { name: string; props?: Record<string, unknown> }[] = [];
    const track = { track: (name: string, props?: Record<string, unknown>) => void tracked.push({ name, props }), flush: async () => {} };
    const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    const navigate = vi.fn();
    render(<KaraokeApp api={api} track={track} mic={fakeMic().mic} navigate={navigate} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Yoru ni Kakeru/ }));
    // Spotify's player is Spotify's page, so playing in it is not seen here; only the fallback link is (SpotifyPlayer test).
    fireEvent.click(screen.getByRole('button', { name: 'It went well' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to songs' }));
    const slider = screen.getByRole('slider', { name: 'Light work to Locked in' });
    // Dragging (input events) records nothing; letting go (the browser's change event) records one adjustment.
    fireEvent.input(slider, { target: { value: '35' } });
    fireEvent.input(slider, { target: { value: '20' } });
    fireEvent.pointerUp(slider);
    fireEvent.change(slider);
    expect(tracked.map((e) => e.name)).toEqual(['list_view', 'song_open', 'feedback_tapped', 'slider_changed']);
    expect(tracked[1]!.props).toEqual({
      mode: 'library',
      difficulty: null,
      familiarity: null,
      popularity: null,
      tempo: null,
      decade: null,
      mood: null,
      duetsOnly: false,
      position: 3,
    });
    expect(tracked[3]!.props).toMatchObject({ slider: 'difficulty', difficulty: 0.2 });
    expect(JSON.stringify(tracked)).not.toMatch(/"t\d"|Yoru|YOASOBI|open\.spotify/);
  });
});
