// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FastLyricsIcon, OctaveIcon } from '../../src/components/Icon';
import { Results } from '../../src/components/Results';
import { SongDetail } from '../../src/components/SongDetail';
import type { Match } from '../../src/lib/contracts';
import { match } from '../fixtures/screen';

afterEach(cleanup);

const range = { low: 45, high: 72, source: 'test' as const };

function withMatch(base: Match, over: Partial<Match> & { fastLyrics?: boolean }): Match {
  const { fastLyrics, ...rest } = over;
  return { ...base, ...rest, range: { ...base.range, fastLyrics: fastLyrics ?? base.range.fastLyrics } };
}

describe('icons', () => {
  it('octave up and down have their own labels and a hover title', () => {
    const { container } = render(
      <>
        <OctaveIcon octave="up" />
        <OctaveIcon octave="down" />
      </>,
    );
    const up = screen.getByRole('img', { name: 'Sing it an octave higher than the artist' });
    const down = screen.getByRole('img', { name: 'Sing it an octave lower than the artist' });
    expect(up.getAttribute('title')).toBe('Sing it an octave higher than the artist');
    expect(down.getAttribute('title')).toBe('Sing it an octave lower than the artist');
    expect(up.textContent).toBe('8va');
    expect(down.textContent).toBe('8vb');
    expect(container.querySelectorAll('svg')).toHaveLength(0);
  });

  it('octave none renders nothing', () => {
    const { container } = render(<OctaveIcon octave="none" />);
    expect(container.innerHTML).toBe('');
  });

  it('fast lyrics icon', () => {
    render(<FastLyricsIcon />);
    const icon = screen.getByRole('img', { name: 'Fast lyrics' });
    expect(icon.querySelector('title')?.textContent).toBe('Fast lyrics');
  });
});

describe('Results row', () => {
  const props = { range, loading: false, error: false, hasMore: false, onSelect: vi.fn(), onMore: vi.fn(), onRedo: vi.fn() };

  it('shows octave and fast-lyrics icons, and reasons under the artist', () => {
    const matches = [
      withMatch(match(0), { octave: 'up', fastLyrics: true, reasons: ['In your sweet spot', 'You play this a lot'] }),
      withMatch(match(1), { octave: 'down', fastLyrics: false, reasons: undefined }),
      withMatch(match(3), { octave: 'none', fastLyrics: false, reasons: [] }),
    ];
    render(<Results {...props} matches={matches} />);
    const [first, second, third] = screen.getAllByRole('listitem');

    expect(within(first!).getByRole('img', { name: 'Sing it an octave higher than the artist' })).toBeTruthy();
    expect(within(first!).getByRole('img', { name: 'Fast lyrics' })).toBeTruthy();
    expect(within(first!).getByText('In your sweet spot · You play this a lot')).toBeTruthy();
    expect(within(first!).getByRole('button').getAttribute('aria-label')).toBe(
      'Plastic Love by Mariya Takeuchi, Easy. Sing it higher than the artist. Fast lyrics',
    );

    expect(within(second!).getByRole('img', { name: 'Sing it an octave lower than the artist' })).toBeTruthy();
    expect(within(second!).queryByRole('img', { name: 'Fast lyrics' })).toBeNull();

    expect(within(third!).queryAllByRole('img')).toHaveLength(0);
    expect(third!.textContent).toBe('Fly Me to the MoonFrank SinatraEasy');
  });
});

describe('SongDetail', () => {
  it('shows icons next to the wording and the reasons', () => {
    const m = withMatch(match(2), { reasons: ['You play this a lot'] });
    render(<SongDetail match={m} userRange={range} source={undefined} feedback={undefined} onFeedback={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole('img', { name: 'Fast lyrics' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Sing it an octave lower than the artist' })).toBeTruthy();
    expect(screen.getByText('Sing it lower than the artist')).toBeTruthy();
    expect(screen.getByText('You play this a lot')).toBeTruthy();
  });
});

describe('sources', () => {
  it('links the song to its USDB page from the info button when the id is known', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const m = { ...match(0), range: { ...match(0).range, usdbId: 1234 } };
    render(<SongDetail match={m} userRange={range} source={undefined} feedback={undefined} onFeedback={() => {}} onBack={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Where this came from' }));
    expect(screen.getByRole('link', { name: 'View on USDB' }).getAttribute('href')).toBe('https://usdb.animux.de/index.php?link=detail&id=1234');
  });

  it('shows a Sources and credits link under the results', () => {
    render(<Results range={range} matches={[match(0)]} hasMore={false} loading={false} error={false} onSelect={() => {}} onMore={() => {}} onRedo={() => {}} />);
    expect(screen.getByRole('link', { name: 'Sources and credits' }).getAttribute('href')).toBe('/credits');
  });
});
