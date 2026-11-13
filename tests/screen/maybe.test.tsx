// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetlistScreen } from '../../src/components/setlist/SetlistScreen';
import { SongDetail } from '../../src/components/SongDetail';
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
    expect(screen.queryByText(/only have an estimate/)).toBeNull();
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
