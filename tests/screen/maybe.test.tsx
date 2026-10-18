// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Results } from '../../src/components/Results';
import { SongDetail } from '../../src/components/SongDetail';
import { match, source } from '../fixtures/screen';

afterEach(cleanup);

const range = { low: 45, high: 72, source: 'test' as const };
const props = { range, loading: false, error: false, hasMore: false, onSelect: vi.fn(), onMore: vi.fn(), onRedo: vi.fn(), onRedoEnd: vi.fn() };
const labels = (el: HTMLElement) => within(el).getAllByRole('button').map((b) => b.getAttribute('aria-label'));

describe('Maybe group', () => {
  it('lists low-confidence songs after the main list, under Maybe, without a difficulty', () => {
    render(<Results {...props} matches={[0, 1, 8, 9].map(match)} />);
    const [main] = screen.getAllByRole('list');
    expect(labels(main!)).toEqual(['Plastic Love by Mariya Takeuchi, Easy', 'Lemon by Kenshi Yonezu, Medium. Sing it lower than the artist']);
    expect(within(main!).getByText('Easy')).toBeTruthy();

    const maybe = screen.getByRole('region', { name: 'Maybe' });
    expect(within(maybe).getByText(/only have an estimate/)).toBeTruthy();
    expect(labels(maybe)).toEqual(['Linda Linda by The Blue Hearts, Maybe. Fast lyrics', 'Sukiyaki by Kyu Sakamoto, Maybe']);
    for (const li of within(maybe).getAllByRole('listitem')) expect(li.querySelector('[data-difficulty]')).toBeNull();
    expect(main!.compareDocumentPosition(maybe) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the Maybe group alone when no song is a sure fit', () => {
    render(<Results {...props} matches={[8, 9].map(match)} />);
    expect(screen.getAllByRole('list')).toHaveLength(1);
    expect(labels(screen.getByRole('region', { name: 'Maybe' }))).toHaveLength(2);
    expect(screen.queryByText(/None of your songs/)).toBeNull();
    expect(screen.getByText('That’s every song that fits, for now.')).toBeTruthy();
  });

  it('has no Maybe heading when every song is a sure fit', () => {
    render(<Results {...props} matches={[0, 1].map(match)} />);
    expect(screen.queryByRole('region', { name: 'Maybe' })).toBeNull();
  });

  it('song detail says Maybe instead of a difficulty, and the info button says the range is an estimate', () => {
    render(<SongDetail match={match(9)} userRange={range} source={source(9)} feedback={undefined} onFeedback={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText('Maybe')).toBeTruthy();
    expect(screen.queryByText(/^(Easy|Medium|Hard)$/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Where this came from' }));
    expect(screen.getByRole('tooltip').textContent).toMatch(/9 s of clear singing\. This range is only an estimate/);
  });

  it('song detail for a sure fit keeps its difficulty and says nothing about an estimate', () => {
    render(<SongDetail match={match(1)} userRange={range} source={source(1)} feedback={undefined} onFeedback={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText('Medium')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Where this came from' }));
    expect(screen.getByRole('tooltip').textContent).toBe(
      'From a recording of this song. Measured from the full recording: vocals separated and pitch-tracked, 74 s of clear singing.',
    );
  });
});
