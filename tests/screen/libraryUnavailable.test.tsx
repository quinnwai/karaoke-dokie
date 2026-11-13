// @vitest-environment jsdom
// A signed-in singer whose Spotify library could not be read (QWW-55): the server sends catalogue songs, and the
// screen says so in one quiet line. They stay signed in (the green account logo and Log out), and nothing asks
// them to connect Spotify, which is for someone without it. History, which needs the library, says why it is off.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SetlistScreen } from '../../src/components/setlist/SetlistScreen';
import { initialTuner } from '../../src/lib/setlist/tuner';
import { match } from '../fixtures/screen';
import { el, ranked, setlistProps, SEL } from '../helpers/setlist';

afterEach(cleanup);

const range = { low: 45, high: 72, source: 'test' as const };
const songs = [match(0), match(1)].map((m) => ranked(m));
const NOTE = 'Couldn’t reach Spotify, showing popular songs.';
const HINT_UNREACHABLE = 'Spotify could not be reached, so listening history is off';
const HINT_CONNECT = 'Connect Spotify to use your listening history';
/**
 * The singer is still signed in and had History switched on; the songs are the catalogue's, which have no listening data.
 * (History starts off, so the tuner here is one where it was switched on, to show the missing library is what turns it off.)
 */
const unreadable = () => setlistProps(range, songs, { mode: 'catalogue', libraryUnavailable: true, tuner: { ...initialTuner(), off: ['tempo', 'era'] } });

describe('results when the Spotify library could not be read', () => {
  it('says so once, quietly, and keeps the singer signed in', () => {
    render(<SetlistScreen {...unreadable()} />);
    const note = screen.getByRole('status');
    expect(note.textContent).toBe(NOTE);
    expect(screen.getAllByText(NOTE)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Spotify account' })).toBeTruthy();
    expect(screen.getByText('Logged in as Test Singer')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy();
    // Songs are there to pick.
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0);
  });

  it('does not ask a signed-in singer to connect Spotify', () => {
    render(<SetlistScreen {...unreadable()} />);
    expect(screen.queryByRole('button', { name: 'Connect to Spotify' })).toBeNull();
    expect(screen.queryByText('Want personalized recommendations?')).toBeNull();
  });

  it('shows no note for a library that loaded, or for someone without Spotify', () => {
    const { rerender } = render(<SetlistScreen {...setlistProps(range, songs, { mode: 'library', tuner: initialTuner() })} />);
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<SetlistScreen {...setlistProps(range, songs, { mode: 'catalogue', displayName: null })} />);
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Connect to Spotify' })).toHaveLength(1);
  });

  it('turns listening history off and says it could not be reached, not that Spotify needs connecting', () => {
    render(<SetlistScreen {...unreadable()} />);
    const strip = el(SEL.strip('history'));
    expect(el<HTMLInputElement>(SEL.slider('history')).disabled).toBe(true);
    expect(strip.hasAttribute('data-off')).toBe(true);
    expect(strip.textContent).toContain(HINT_UNREACHABLE);
    expect(strip.textContent).not.toContain(HINT_CONNECT);
  });

  it('while the library is fine the signed-in singer has History to use, and a signed-out singer is asked to connect', () => {
    const { rerender } = render(<SetlistScreen {...setlistProps(range, songs, { mode: 'library', tuner: initialTuner() })} />);
    expect(el<HTMLInputElement>(SEL.slider('history')).disabled).toBe(false);
    expect(el(SEL.strip('history')).textContent).not.toMatch(/Connect Spotify|could not be reached/);

    rerender(<SetlistScreen {...setlistProps(range, songs, { mode: 'catalogue', displayName: null })} />);
    expect(el<HTMLInputElement>(SEL.slider('history')).disabled).toBe(true);
    expect(el(SEL.strip('history')).textContent).toContain(HINT_CONNECT);
    expect(el(SEL.strip('history')).textContent).not.toContain(HINT_UNREACHABLE);
  });
});
