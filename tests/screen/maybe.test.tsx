// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Results } from '../../src/components/Results';
import { SongDetail } from '../../src/components/SongDetail';
import { match } from '../fixtures/screen';
import { DEFAULT_VIEW } from '../../src/lib/songs/browse';

afterEach(cleanup);

const range = { low: 45, high: 72, source: 'test' as const };
const props = {
  range,
  mode: 'library' as const,
  view: DEFAULT_VIEW,
  leadSlider: null,
  shown: 10,
  loading: false,
  error: false,
  onSelect: vi.fn(),
  onMore: vi.fn(),
  onRetry: vi.fn(),
  onRedo: vi.fn(),
  onRedoEnd: vi.fn(),
  onSlider: vi.fn(),
  onSliderDone: vi.fn(),
  onResetSliders: vi.fn(),
  onDecade: vi.fn(),
  onMood: vi.fn(),
  onDuets: vi.fn(),
  onClear: vi.fn(),
  onConnect: vi.fn(),
  displayName: 'Test Singer',
  onLogout: vi.fn(async () => {}),
};
// The song buttons; each row's play button (QWW-48) is left out.
const labels = (el: HTMLElement) =>
  within(el)
    .getAllByRole('button')
    .filter((b) => !b.hasAttribute('data-preview'))
    .map((b) => b.getAttribute('aria-label'));

describe('Maybe group', () => {
  it('lists low-confidence songs after the main list, under Maybe, without a difficulty', () => {
    render(<Results {...props} matches={[0, 1, 8, 9].map(match)} />);
    const [main] = screen.getAllByRole('list');
    expect(labels(main!)).toEqual(['Plastic Love by Mariya Takeuchi, Easy', 'Lemon by Kenshi Yonezu, Medium. Sing it lower than the artist']);
    expect(within(main!).getByText('Easy')).toBeTruthy();

    const maybe = screen.getByRole('region', { name: 'Maybe' });
    expect(within(maybe).getByText(/less sure of these songs/)).toBeTruthy();
    expect(within(maybe).queryByText(/estimate/)).toBeNull(); // a narrow note file is a Maybe too (QWW-60), and it is not an artist estimate
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
