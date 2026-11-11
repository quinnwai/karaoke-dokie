// @vitest-environment jsdom
// Two follow-ups from the independent review of #34 (QWW-57, 11 Nov), each with its test. The third, the copied server
// constants, is covered by tests/setlist/defaults.test.ts and engine.test.ts.
//   1. History stays live when the engine says the library is unreachable: the gear followed `mode` (from
//      /api/recommendations) while the note under the list followed `libraryUnavailable` (from /api/setlist), so when only
//      the second said so, the note showed and the History slider moved but did nothing.
//   2. A false end note after 200 songs: the engine is asked for 200 and never reads `total` or `nextOffset`, so a signed-in
//      singer who tapped Load more down to row 200 was told "That's every song that fits, for now." with more behind it.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SetlistScreen, type SetlistScreenProps } from '../../src/components/setlist/SetlistScreen';
import { HISTORY_HINT_LOGGED_OUT, HISTORY_HINT_UNREACHABLE } from '../../src/lib/setlist/gears';
import { SHOW_STEP } from '../../src/lib/client/flow';
import { el, RANGE, rankedSong, SEL, setlistProps } from '../helpers/setlist';

afterEach(cleanup);

const draw = (overrides: Partial<SetlistScreenProps> = {}) => {
  const songs = overrides.songs === undefined ? [rankedSong('a'), rankedSong('b')] : overrides.songs;
  return render(<SetlistScreen {...setlistProps(RANGE, songs, overrides)} />);
};

describe('History follows the engine\'s word that the library is unreachable', () => {
  const history = () => el(SEL.strip('history'));
  const slider = () => el<HTMLInputElement>(SEL.slider('history'));

  it('is off and disabled, with the "could not be reached" hint, when /api/setlist says so while the mode is still library', () => {
    draw({ mode: 'library', libraryUnavailable: true });
    expect(slider().disabled).toBe(true);
    expect(history().hasAttribute('data-off')).toBe(true);
    expect(history().textContent).toContain(HISTORY_HINT_UNREACHABLE);
    expect(history().textContent).not.toContain(HISTORY_HINT_LOGGED_OUT);
    // The note under the list says the same thing, so the gear and the note agree.
    expect(screen.getByText('Couldn’t reach Spotify, showing popular songs.')).toBeTruthy();
  });

  it('has no reset button to press in that state: there is nothing to reset', () => {
    draw({ mode: 'library', libraryUnavailable: true });
    expect(el(SEL.reset('history')).hasAttribute('hidden')).toBe(true);
  });

  it('is live when the library was read: a signed-in singer\'s History slider works', () => {
    draw({ mode: 'library' });
    expect(slider().disabled).toBe(false);
    expect(history().textContent).not.toContain(HISTORY_HINT_UNREACHABLE);
    expect(history().textContent).not.toContain(HISTORY_HINT_LOGGED_OUT);
  });

  it('stays disabled in the catalogue, with the "Connect Spotify" hint, as before', () => {
    draw({ mode: 'catalogue' });
    expect(slider().disabled).toBe(true);
    expect(history().textContent).toContain(HISTORY_HINT_LOGGED_OUT);
  });

  it('is disabled when both routes say the library is out of reach', () => {
    draw({ mode: 'catalogue', libraryUnavailable: true });
    expect(slider().disabled).toBe(true);
    expect(history().textContent).toContain(HISTORY_HINT_UNREACHABLE);
  });

  it('comes back when a later answer says the library is readable again', () => {
    const view = draw({ mode: 'library', libraryUnavailable: true });
    expect(slider().disabled).toBe(true);
    view.rerender(<SetlistScreen {...setlistProps(RANGE, [rankedSong('a')], { mode: 'library', libraryUnavailable: false })} />);
    expect(slider().disabled).toBe(false);
  });
});

describe('the end note of the list', () => {
  const END = 'That’s every song that fits, for now.';
  /** `n` songs, all shown, for a singer whose library was read. */
  const library = (n: number, extra: Partial<SetlistScreenProps> = {}) =>
    draw({ mode: 'library', songs: Array.from({ length: n }, (_, i) => rankedSong(`s${i}`)), shown: n, ...extra });

  it('says every song is shown when the engine\'s list is the end of it (nextOffset null)', () => {
    library(5, { nextOffset: null });
    expect(screen.getByText(END)).toBeTruthy();
  });

  it('says it too when nextOffset is not given: one page is the whole list', () => {
    library(5);
    expect(screen.getByText(END)).toBeTruthy();
  });

  it('does not say it after 200 songs when the engine says there is more behind them', () => {
    // The engine is asked for 200 (the most one request may ask for). A singer who loads more down to row 200 has seen a page.
    library(200, { nextOffset: 200, total: 1204 });
    expect(screen.queryByText(END)).toBeNull();
    // And there is nothing left to load more of: the screen holds all 200 rows it has.
    expect(screen.queryByRole('button', { name: 'Load more songs' })).toBeNull();
  });

  it('does not say it while rows are still waiting behind Load more', () => {
    draw({ mode: 'library', songs: Array.from({ length: 200 }, (_, i) => rankedSong(`s${i}`)), shown: SHOW_STEP, nextOffset: null });
    expect(screen.queryByText(END)).toBeNull();
    expect(screen.getByRole('button', { name: 'Load more songs' })).toBeTruthy();
  });

  it('does not say it in the catalogue, which has its own closing note', () => {
    draw({ mode: 'catalogue', songs: [rankedSong('a'), rankedSong('b')], nextOffset: null });
    expect(screen.queryByText(END)).toBeNull();
    expect(screen.getByText('Want personalized recommendations?')).toBeTruthy();
  });
});
