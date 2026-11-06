// @vitest-environment jsdom
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KaraokeApp } from '../../src/components/KaraokeApp';
import type { Api } from '../../src/lib/client/api';
import { MicDeniedError, type Mic, type MicRecorder } from '../../src/lib/client/mic';
import type { MeResponse, VocalRange } from '../../src/lib/contracts';
import { SAMPLE_RATE, voice } from '../helpers/synth';
import { allMatches, knownSongs, me, recommendationsPage } from '../fixtures/screen';
import { DEFAULT_VIEW } from '../../src/lib/songs/browse';

/** A mic that "hears" whatever tone the test queues for the next hold. */
function fakeMic() {
  const queue: Float32Array[] = [];
  let current: Float32Array = new Float32Array(0);
  const opened = { count: 0, closed: 0 };
  const recorder: MicRecorder = {
    sampleRate: SAMPLE_RATE,
    reset: () => {
      current = queue.shift() ?? new Float32Array(0);
    },
    latest: (n) => current.subarray(Math.max(0, current.length - n)),
    take: () => current,
    close: () => void opened.closed++,
  };
  const mic: Mic = {
    open: async () => {
      opened.count++;
      return recorder;
    },
  };
  return { mic, sing: (hz: number, seconds = 1.5) => queue.push(voice(hz, seconds)), opened };
}

function fakeApi(user: MeResponse | null) {
  let current = user;
  const api = {
    me: vi.fn(async () => current),
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

    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    await screen.findByRole('button', { name: /lowest note/ });

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
    expect(screen.getAllByRole('button', { name: 'Connect to Spotify' })).toHaveLength(2);
    // Under the list: one short question and the button, nothing else.
    expect(screen.getByText('Want personalized recommendations?')).toBeTruthy();
    expect(screen.queryByText(/every song that fits|invite-only|from our catalogue/)).toBeNull();
    // Catalogue songs are nobody's library, so there is no on-repeat slider.
    expect(screen.getByRole('slider', { name: 'Light work to Locked in' })).toBeTruthy();
    expect(screen.queryByRole('slider', { name: 'Rediscover to On repeat' })).toBeNull();
  });

  it('after the test, "or use songs from your Spotify" keeps the range and goes to sign-in', async () => {
    sessionStorage.setItem('kd.test', JSON.stringify({ low: 45, high: 72 }));
    const navigate = vi.fn();
    render(<KaraokeApp api={fakeApi(null)} mic={fakeMic().mic} navigate={navigate} />);
    fireEvent.click(await screen.findByRole('button', { name: 'or use songs from your Spotify' }));
    expect(navigate).toHaveBeenCalledWith('/api/auth/login');
    expect(JSON.parse(sessionStorage.getItem('kd.test')!)).toEqual({ low: 45, high: 72 });
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

  it('asks to try again when nothing was held', async () => {
    const { mic, sing } = fakeMic();
    render(<KaraokeApp api={fakeApi(null)} mic={mic} quietMs={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    await screen.findByRole('button', { name: /lowest note/ });
    sing(110, 0.2);
    await hold(/lowest note/);
    await waitFor(() => expect(lyrics()).toContain('Try again and hold the note a little longer'));
  });

  it('works with the keyboard: Space held is a press', async () => {
    const { mic, sing } = fakeMic();
    render(<KaraokeApp api={fakeApi(null)} mic={mic} quietMs={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    const button = await screen.findByRole('button', { name: /lowest note/ });
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

  it('shows a lyric line when the mic is denied', async () => {
    const mic: Mic = { open: async () => Promise.reject(new MicDeniedError()) };
    render(<KaraokeApp api={fakeApi(null)} mic={mic} quietMs={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    await screen.findByRole('button', { name: /lowest note/ });
    await hold(/lowest note/);
    await waitFor(() => expect(lyrics()).toContain('We need your mic to hear you'));
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
    expect(reasonLines()).toContain('In your sweet spot · In your top songs this month');
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
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();

    fireEvent.change(slider, { target: { value: '100' } });
    expect(slider.getAttribute('aria-valuetext')).toBe('towards Locked in');
    const lockedIn = titles();
    expect(lockedIn).not.toEqual(before);
    fireEvent.change(slider, { target: { value: '0' } });
    expect(slider.getAttribute('aria-valuetext')).toBe('towards Light work');
    expect(titles()).not.toEqual(lockedIn);

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
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
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
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

    fireEvent.click(await screen.findByRole('button', { name: /^Yoru ni Kakeru/ }));
    expect(screen.getByRole('heading', { name: 'Yoru ni Kakeru' })).toBeTruthy();
    expect(screen.getByRole('img', { name: /Song goes from A#2 to F4. You sing from A2 to C5/ })).toBeTruthy();
    expect(screen.getByText('Hard')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Fast lyrics' })).toBeTruthy();
    expect(screen.getByText('Sing it lower than the artist')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Sing it an octave lower than the artist' })).toBeTruthy();
    expect(screen.getByText('Played recently')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open in Spotify' }).getAttribute('href')).toBe('https://open.spotify.com/track/t2');

    expect(screen.queryByRole('button', { name: 'Where this came from' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'It went well' }));
    expect(screen.getByText('Thanks! That helps.')).toBeTruthy();
    expect(api.feedback).toHaveBeenCalledWith({ trackId: 't2', thumbs: 'up', difficulty: 'hard', octave: 'down', view: DEFAULT_VIEW });

    fireEvent.click(screen.getByRole('button', { name: 'Back to songs' }));
    expect(await screen.findByText('Plastic Love')).toBeTruthy();
  });

  it('returning user lands on results and can redo the test', async () => {
    const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    render(<KaraokeApp api={api} mic={fakeMic().mic} quietMs={60_000} />);
    await screen.findByText('Plastic Love');
    expect(api.saveRange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Redo the singing test' }));
    await waitFor(() => expect(lyrics()).toContain('Find a quiet spot'));
  });

  it('pick songs you sing well: signed out goes to sign-in first', async () => {
    const navigate = vi.fn();
    render(<KaraokeApp api={fakeApi(null)} mic={fakeMic().mic} navigate={navigate} />);
    fireEvent.click(await screen.findByRole('button', { name: 'or pick songs you sing well' }));
    expect(navigate).toHaveBeenCalledWith('/api/auth/login');
    expect(sessionStorage.getItem('kd.wantsPick')).toBe('1');
  });

  it('pick songs you sing well: up to 3 songs set the range', async () => {
    sessionStorage.setItem('kd.wantsPick', '1');
    const api = fakeApi(me());
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);

    for (const title of ['Plastic Love', 'Fly Me to the Moon', 'Dancing Queen']) {
      fireEvent.click(await screen.findByRole('button', { name: new RegExp(title) }));
    }
    expect((screen.getByRole('button', { name: /Lemon/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Use 3 songs' }));
    await screen.findByRole('button', { name: 'Load more songs' });
    expect(api.saveRange).toHaveBeenCalledWith({ low: 40, high: 64, source: 'songs' });
  });

  it('records the beta funnel without any Spotify id or library song', async () => {
    const tracked: { name: string; props?: Record<string, unknown> }[] = [];
    const track = { track: (name: string, props?: Record<string, unknown>) => void tracked.push({ name, props }), flush: async () => {} };
    const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    const navigate = vi.fn();
    render(<KaraokeApp api={api} track={track} mic={fakeMic().mic} navigate={navigate} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Yoru ni Kakeru/ }));
    fireEvent.click(screen.getByRole('link', { name: 'Open in Spotify' }));
    fireEvent.click(screen.getByRole('button', { name: 'It went well' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to songs' }));
    const slider = screen.getByRole('slider', { name: 'Light work to Locked in' });
    // Dragging (input events) records nothing; letting go (the browser's change event) records one adjustment.
    fireEvent.input(slider, { target: { value: '35' } });
    fireEvent.input(slider, { target: { value: '20' } });
    fireEvent.pointerUp(slider);
    fireEvent.change(slider);
    expect(tracked.map((e) => e.name)).toEqual(['results_viewed', 'song_opened', 'spotify_link_pressed', 'feedback_tapped', 'slider_changed']);
    expect(tracked[1]!.props).toEqual({
      mode: 'library',
      difficulty: null,
      familiarity: null,
      popularity: null,
      decade: null,
      mood: null,
      duetsOnly: false,
      position: 3,
    });
    expect(tracked[4]!.props).toMatchObject({ slider: 'difficulty', difficulty: 0.2 });
    expect(JSON.stringify(tracked)).not.toMatch(/"t\d"|Yoru|YOASOBI|open\.spotify/);
  });
});
