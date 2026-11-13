// @vitest-environment jsdom
// QWW-66: the range the singer sang last wins, signed in and signed out. The signed-in list used the range stored on
// the account and the signed-out list the one kept on the device, so one singer got two lists (the account held F2 to
// C4 while the device and its header said F#2 to C5). Here the whole screen runs: the singing test, the sign-in round
// trip, and what the list, the header, the account and the device each end up with.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KaraokeApp } from '../../src/components/KaraokeApp';
import type { Api } from '../../src/lib/client/api';
import type { Mic, MicRecorder } from '../../src/lib/client/mic';
import type { MeResponse, VocalRange } from '../../src/lib/contracts';
import { SAMPLE_RATE, voice } from '../helpers/synth';
import { allMatches, knownSongs, me, recommendationsPage } from '../fixtures/screen';

/** A mic that "hears" the tone the test queued for the next hold. */
function fakeMic() {
  const queue: Float32Array[] = [];
  let current: Float32Array = new Float32Array(0);
  const recorder: MicRecorder = {
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
  const mic: Mic = { permission: async () => 'prompt', open: async () => recorder };
  return { mic, sing: (hz: number) => queue.push(voice(hz, 1.5)) };
}

/** An API whose account remembers what was saved to it, like the server does. */
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
  return Object.assign(api, { account: () => current?.range ?? null });
}

async function startTest() {
  fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Turn on microphone' }));
  return screen.findByRole('button', { name: /lowest note/ });
}

/** The button is pressed at T_PRESSED and the note let go at T_SUNG, so a range stamped at the press instead of the release shows. */
async function hold(label: RegExp) {
  const button = screen.getByRole('button', { name: label });
  vi.mocked(Date.now).mockReturnValue(T_PRESSED);
  await act(async () => {
    fireEvent.pointerDown(button);
  });
  vi.mocked(Date.now).mockReturnValue(T_SUNG);
  await act(async () => {
    fireEvent.pointerUp(button);
  });
}

/** Sings a low note, then a high one, and waits for what follows: the range screen, or the account saving it. */
async function sing(mic: ReturnType<typeof fakeMic>, lowHz: number, highHz: number) {
  await startTest();
  mic.sing(lowHz);
  await hold(/lowest note/);
  await screen.findByTestId('low-note');
  mic.sing(highHz);
  await hold(/highest note/);
}

const FS2 = 92.5;
const A2 = 110;
const C5 = 523.25;
const T_OLD = 1_700_000_000_000;
const T_SUNG = T_OLD + 3_600_000;
const T_PRESSED = T_SUNG - 5_000;
const FS2_C5 = { low: 42, high: 72 };
const F2_C4 = { low: 41, high: 60 };

/**
 * The list screen: the header with the range, and the list asked for. The rows come from the screen's own design, which
 * this rule does not depend on, so nothing here waits for a song.
 */
async function onList(api: ReturnType<typeof fakeApi>) {
  await screen.findByLabelText(/^Your range /);
  await waitFor(() => expect(api.allRecommendations.mock.calls.length + api.catalogue.mock.calls.length).toBeGreaterThan(0));
}

/** What the header says the list is built on. */
const headerRange = () => screen.getByLabelText(/^Your range /).getAttribute('aria-label');
const device = () => JSON.parse(localStorage.getItem('kd.range') ?? 'null');

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.spyOn(Date, 'now').mockReturnValue(T_SUNG);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('sing a new range logged out, then sign in', () => {
  it('the list and the header use the new range, and the account stores it', async () => {
    const heard = fakeMic();
    const navigate = vi.fn();
    const signedOut = fakeApi(null);
    const out = render(<KaraokeApp api={signedOut} mic={heard.mic} navigate={navigate} quietMs={0} />);

    // Logged out: F#2 to C5 is sung and kept on the device, with the time it was sung.
    await sing(heard, FS2, C5);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await onList(signedOut);
    expect(headerRange()).toBe('Your range F#2 to C5');
    expect(signedOut.catalogue).toHaveBeenCalledWith(FS2_C5);
    expect(device()).toEqual({ ...FS2_C5, measuredAt: T_SUNG });

    // Connect Spotify: the range goes with the round trip.
    fireEvent.click(screen.getAllByRole('button', { name: 'Connect to Spotify' })[0]!);
    expect(navigate).toHaveBeenCalledWith('/api/auth/login');
    expect(JSON.parse(sessionStorage.getItem('kd.test')!)).toEqual({ ...FS2_C5, measuredAt: T_SUNG });
    out.unmount();

    // Back from Spotify, the account still holds the old F2 to C4 (sung an hour before).
    window.history.replaceState(null, '', '/?signedIn=1');
    const api = fakeApi(me({ ...F2_C4, source: 'test', measuredAt: T_OLD }));
    render(<KaraokeApp api={api} mic={heard.mic} />);
    await onList(api);

    // The new range was saved first, with its own time, so the library list is built on it.
    expect(api.saveRange).toHaveBeenCalledTimes(1);
    expect(api.saveRange).toHaveBeenCalledWith({ ...FS2_C5, source: 'test', measuredAt: T_SUNG });
    expect(api.saveRange.mock.invocationCallOrder[0]).toBeLessThan(api.allRecommendations.mock.invocationCallOrder[0]!);
    expect(api.account()).toEqual({ ...FS2_C5, source: 'test', measuredAt: T_SUNG });
    // The header shows the range the list was built on, and nothing is left over in session storage.
    expect(headerRange()).toBe('Your range F#2 to C5');
    expect(sessionStorage.getItem('kd.test')).toBeNull();
    expect(device()).toEqual({ ...FS2_C5, measuredAt: T_SUNG });
  });

  it('an account range saved before times were kept gives way to the range sung on this device', async () => {
    // The case that started this: the account held F2 to C4 with no time, the device F#2 to C5 (kept by the earlier version).
    localStorage.setItem('kd.range', JSON.stringify(FS2_C5));
    const api = fakeApi(me({ ...F2_C4, source: 'test' }));
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);
    await onList(api);

    expect(api.saveRange).toHaveBeenCalledWith({ ...FS2_C5, source: 'test' });
    expect(api.account()).toEqual({ ...FS2_C5, source: 'test' });
    expect(headerRange()).toBe('Your range F#2 to C5');
  });
});

describe('an older range on the device never overwrites a newer one on the account', () => {
  it('the list and the header use the account\'s, nothing is saved, and the device keeps the account\'s range from then on', async () => {
    localStorage.setItem('kd.range', JSON.stringify({ ...F2_C4, measuredAt: T_OLD }));
    // What a Spotify round trip leaves behind when the singer had started from that older range.
    sessionStorage.setItem('kd.test', JSON.stringify({ ...F2_C4, measuredAt: T_OLD }));
    const api = fakeApi(me({ ...FS2_C5, source: 'test', measuredAt: T_SUNG }));
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);
    await onList(api);

    expect(api.saveRange).not.toHaveBeenCalled();
    expect(api.account()).toEqual({ ...FS2_C5, source: 'test', measuredAt: T_SUNG });
    expect(headerRange()).toBe('Your range F#2 to C5');
    expect(device()).toEqual({ ...FS2_C5, measuredAt: T_SUNG });
    expect(sessionStorage.getItem('kd.test')).toBeNull();

    // Signed out on this device later, the list is built on that same range, not the old one it had.
    fireEvent.click(screen.getByRole('button', { name: 'Spotify account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await screen.findAllByRole('button', { name: 'Connect to Spotify' });
    expect(api.catalogue).toHaveBeenCalledWith(FS2_C5);
    expect(headerRange()).toBe('Your range F#2 to C5');
  });

  it('a device range with no time does not outrank an account range that has one', async () => {
    localStorage.setItem('kd.range', JSON.stringify(F2_C4));
    const api = fakeApi(me({ ...FS2_C5, source: 'test', measuredAt: T_OLD }));
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);
    await onList(api);
    expect(api.saveRange).not.toHaveBeenCalled();
    expect(headerRange()).toBe('Your range F#2 to C5');
  });
});

describe('a new test while signed in', () => {
  it('goes to the account with the time it was sung, and the device keeps it for when the singer is signed out', async () => {
    const heard = fakeMic();
    const api = fakeApi(me());
    render(<KaraokeApp api={api} mic={heard.mic} quietMs={0} />);

    await sing(heard, A2, C5);
    await onList(api);
    expect(api.saveRange).toHaveBeenCalledWith({ low: 45, high: 72, source: 'test', measuredAt: T_SUNG });
    expect(api.account()).toEqual({ low: 45, high: 72, source: 'test', measuredAt: T_SUNG });
    expect(headerRange()).toBe('Your range A2 to C5');
    expect(device()).toEqual({ low: 45, high: 72, measuredAt: T_SUNG });
  });

  it('a range redone on its own is the range sung last: the account and the device both take it', async () => {
    const heard = fakeMic();
    const api = fakeApi(me({ ...F2_C4, source: 'test', measuredAt: T_OLD }));
    render(<KaraokeApp api={api} mic={heard.mic} quietMs={0} />);
    await onList(api);
    expect(headerRange()).toBe('Your range F2 to C4');
    expect(device()).toEqual({ ...F2_C4, measuredAt: T_OLD });

    fireEvent.click(screen.getByRole('button', { name: 'Redo your high note, C4' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on microphone' }));
    await screen.findByRole('button', { name: /highest note/ });
    heard.sing(C5);
    await hold(/highest note/);
    await onList(api);

    expect(api.saveRange).toHaveBeenCalledWith({ low: 41, high: 72, source: 'test', measuredAt: T_SUNG });
    expect(headerRange()).toBe('Your range F2 to C5');
    expect(device()).toEqual({ low: 41, high: 72, measuredAt: T_SUNG });
  });
});

describe('nothing changes for a singer who has one range', () => {
  it('signed out, the range kept on the device shows its list', async () => {
    localStorage.setItem('kd.range', JSON.stringify({ ...FS2_C5, measuredAt: T_OLD }));
    const api = fakeApi(null);
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);
    await onList(api);
    expect(api.catalogue).toHaveBeenCalledWith(FS2_C5);
    expect(headerRange()).toBe('Your range F#2 to C5');
    expect(device()).toEqual({ ...FS2_C5, measuredAt: T_OLD });
  });

  it('signed in with the same range on both, nothing is saved', async () => {
    localStorage.setItem('kd.range', JSON.stringify({ ...FS2_C5, measuredAt: T_OLD }));
    const api = fakeApi(me({ ...FS2_C5, source: 'test', measuredAt: T_OLD }));
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);
    await onList(api);
    expect(api.saveRange).not.toHaveBeenCalled();
    expect(headerRange()).toBe('Your range F#2 to C5');
  });
});
