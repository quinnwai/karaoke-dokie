// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetlistScreen } from '../../src/components/setlist/SetlistScreen';
import { SongDetail } from '../../src/components/SongDetail';
import type { Match } from '../../src/lib/contracts';
import { initialTuner } from '../../src/lib/setlist/tuner';
import { match } from '../fixtures/screen';
import { all, ranked, SEL, setlistProps } from '../helpers/setlist';

afterEach(cleanup);

const range = { low: 45, high: 72, source: 'test' as const };
/** The accessible name of each row's button that opens the song, top to bottom. */
const labels = () =>
  all(SEL.row).map((li) => Array.from(li.children).find((c) => c.tagName === 'BUTTON')!.getAttribute('aria-label'));

describe('Maybe songs on the Setlist screen', () => {
  // The old list had a Maybe section after the main one, under its own heading. The ranking engine puts Maybe songs last
  // (tests/setlist/engine.test.ts); the screen draws the one list it is given, and a Maybe song says so in its row.
  it('sit in the one ranked list with no Maybe section, and say Maybe in their row label instead of a difficulty', () => {
    render(<SetlistScreen {...setlistProps(range, [0, 1, 8, 9].map((i) => ranked(match(i))))} />);
    expect(screen.getAllByRole('list')).toHaveLength(1);
    expect(labels()).toEqual([
      'Plastic Love by Mariya Takeuchi, Easy',
      'Lemon by Kenshi Yonezu, Medium',
      'Linda Linda by The Blue Hearts, Maybe',
      'Sukiyaki by Kyu Sakamoto, Maybe',
    ]);
    expect(screen.queryByRole('region', { name: 'Maybe' })).toBeNull();
    expect(screen.queryByText(/less sure of these songs/)).toBeNull(); // the Maybe note (display.ts MAYBE_NOTE) is not on this screen
    // A sure song has its badge, the word of its label; a Maybe song has none, so no difficulty is shown for it anywhere.
    const badges = all(SEL.row).map((li) => li.querySelector('[data-badge]')?.textContent ?? null);
    expect(badges).toEqual(['Easy', 'Medium', null, null]);
  });

  it('keep the position the engine gave them, even when it is above a sure fit', () => {
    render(<SetlistScreen {...setlistProps(range, [8, 0].map((i) => ranked(match(i))))} />);
    expect(labels()).toEqual(['Linda Linda by The Blue Hearts, Maybe', 'Plastic Love by Mariya Takeuchi, Easy']);
  });

  it('can be the whole list: no note that nothing fits, and the end of the list says so', () => {
    render(<SetlistScreen {...setlistProps(range, [8, 9].map((i) => ranked(match(i))), { mode: 'library', tuner: initialTuner() })} />);
    expect(all(SEL.row)).toHaveLength(2);
    expect(labels().every((label) => label!.endsWith(', Maybe'))).toBe(true);
    expect(screen.queryByText(/None of your songs/)).toBeNull();
    expect(screen.getByText('That’s every song that fits, for now.')).toBeTruthy();
  });
});

describe('Maybe songs on the song page', () => {
  it('song detail says Maybe instead of a difficulty', () => {
    render(<SongDetail match={match(9)} userRange={range} feedback={undefined} onFeedback={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText('Maybe')).toBeTruthy();
    expect(screen.queryByText(/^(Easy|Medium|Hard)$/)).toBeNull();
  });

  it('song detail for a sure fit keeps its difficulty and has no info button', () => {
    render(<SongDetail match={match(1)} userRange={range} feedback={undefined} onFeedback={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText('Medium')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Where this came from' })).toBeNull();
  });
});

describe('a narrow note-file Maybe song never says its range is an estimate (QWW-60)', () => {
  // A note file of 5 semitones or fewer after the 1% trim is marked low confidence, so it is a Maybe song (range.ts applyNarrowRule). Its range is measured,
  // not an artist's estimate, so no word on the screen may say so. display.test.ts checks the text of sourceTooltip, which nothing renders now, and MAYBE_NOTE is not
  // shown any more either; this renders the two screens that show a Maybe song and reads what a person or a screen reader gets from them.
  const wallows: Match = {
    track: { id: 'w1', title: 'Are You Bored Yet?', artist: 'Wallows', artistId: 'a-w1', spotifyUrl: 'https://open.spotify.com/track/w1', playRank: 0 },
    range: { low: 54, high: 59, tessitura: 56, source: 'note-file', confidence: 'low', fastLyrics: false },
    difficulty: 'maybe',
    octave: 'none',
  };
  /** Every word under `root`: its text, and the labels and titles that a screen reader or a long press reads. */
  const said = (root: HTMLElement) =>
    [root.textContent, ...Array.from(root.querySelectorAll('[aria-label], [title]'), (e) => `${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('title') ?? ''}`)].join(' ');

  it('on the Setlist screen: the row says Maybe and shows no difficulty, and nothing on the screen says estimate', () => {
    const { container } = render(<SetlistScreen {...setlistProps(range, [ranked(wallows)])} />);
    expect(labels()).toEqual(['Are You Bored Yet? by Wallows, Maybe']);
    expect(all(SEL.row).map((li) => li.querySelector('[data-badge]')?.textContent ?? null)).toEqual([null]);
    expect(said(container)).toContain('Are You Bored Yet?'); // it reads the song's own words, so the check below is not vacuous
    expect(said(container)).not.toMatch(/estimate/i);
  });

  it('on the song page: the quiet Maybe pill and no difficulty, and nothing on the page says estimate', () => {
    const { container } = render(<SongDetail match={wallows} userRange={range} feedback={undefined} onFeedback={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText('Maybe')).toBeTruthy();
    expect(screen.queryByText(/^(Easy|Medium|Hard)$/)).toBeNull();
    expect(said(container)).toContain('Are You Bored Yet?');
    expect(said(container)).not.toMatch(/estimate/i);
  });
});
