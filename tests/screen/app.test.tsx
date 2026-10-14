// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KaraokeApp } from '../../src/components/KaraokeApp';
import type { Api } from '../../src/lib/client/api';
import { MicDeniedError, type Mic, type MicRecorder } from '../../src/lib/client/mic';
import type { MeResponse, VocalRange } from '../../src/lib/contracts';
import { SAMPLE_RATE, voice } from '../helpers/synth';
import { knownSongs, me, recommendationsPage } from '../fixtures/screen';

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
    knownSongs: vi.fn(async () => knownSongs()),
    feedback: vi.fn(async () => {}),
  } satisfies Api;
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

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(cleanup);

describe('KaraokeApp', () => {
  it('runs the singing test and sends the user to Spotify', async () => {
    const { mic, sing } = fakeMic();
    const navigate = vi.fn();
    render(<KaraokeApp api={fakeApi(null)} mic={mic} navigate={navigate} quietMs={0} />);

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
    expect(navigate).toHaveBeenCalledWith('/api/auth/login');
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
    expect(screen.getAllByText('Sing it lower than the artist').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Easy').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Generate more songs' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(10));
    expect(api.recommendations).toHaveBeenLastCalledWith(5);
    expect(screen.queryByRole('button', { name: 'Generate more songs' })).toBeNull();
  });

  it('song detail: range bar, info tooltip, feedback', async () => {
    const api = fakeApi(me({ low: 45, high: 72, source: 'test' }));
    render(<KaraokeApp api={api} mic={fakeMic().mic} />);

    fireEvent.click(await screen.findByRole('button', { name: /^Yoru ni Kakeru/ }));
    expect(screen.getByRole('heading', { name: 'Yoru ni Kakeru' })).toBeTruthy();
    expect(screen.getByRole('img', { name: /Song goes from A#2 to F4. You sing from A2 to C5/ })).toBeTruthy();
    expect(screen.getByText('Hard')).toBeTruthy();
    expect(screen.getByText('Fast lyrics')).toBeTruthy();
    expect(screen.getByText('Sing it lower than the artist')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open in Spotify' }).getAttribute('href')).toBe('https://open.spotify.com/track/t2');

    fireEvent.click(screen.getByRole('button', { name: 'Where this came from' }));
    expect(screen.getByRole('tooltip').textContent).toBe('Measured from a note-by-note file of this song. Matched a note file by title and artist.');

    fireEvent.click(screen.getByRole('button', { name: 'It went well' }));
    expect(screen.getByText('Thanks! That helps.')).toBeTruthy();
    expect(api.feedback).toHaveBeenCalledWith({ trackId: 't2', thumbs: 'up', difficulty: 'hard', octave: 'down' });

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
    await screen.findByRole('button', { name: 'Generate more songs' });
    expect(api.saveRange).toHaveBeenCalledWith({ low: 40, high: 64, source: 'songs' });
  });
});
