// @vitest-environment jsdom
// A signed-in singer whose Spotify library could not be read (QWW-55): the server sends catalogue songs, and the
// results say so in one quiet line. They stay signed in (the green account logo and Log out), and nothing asks
// them to connect Spotify, which is for someone without it.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Results } from '../../src/components/Results';
import { resultsProps } from '../helpers/results';
import { match } from '../fixtures/screen';

afterEach(cleanup);

const range = { low: 45, high: 72, source: 'test' as const };
const songs = [match(0), match(1)];
const NOTE = 'Couldn’t reach Spotify, showing popular songs.';

describe('results when the Spotify library could not be read', () => {
  it('says so once, quietly, and keeps the singer signed in', () => {
    render(<Results {...resultsProps(range, songs)} mode="catalogue" libraryUnavailable />);
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
    render(<Results {...resultsProps(range, songs)} mode="catalogue" libraryUnavailable />);
    expect(screen.queryByRole('button', { name: 'Connect to Spotify' })).toBeNull();
    expect(screen.queryByText('Want personalized recommendations?')).toBeNull();
  });

  it('shows no note for a library that loaded, or for someone without Spotify', () => {
    const { rerender } = render(<Results {...resultsProps(range, songs)} />);
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<Results {...resultsProps(range, songs)} mode="catalogue" displayName={null} />);
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Connect to Spotify' })).toHaveLength(2);
  });
});
