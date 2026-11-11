// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FastLyricsIcon, OctaveIcon, ResetIcon } from '../../src/components/Icon';
import { Results } from '../../src/components/Results';
import { resultsProps } from '../helpers/results';
import { SongDetail } from '../../src/components/SongDetail';
import type { Match } from '../../src/lib/contracts';
import { DEFAULT_VIEW } from '../../src/lib/songs/browse';
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

describe('Reset icon', () => {
  const props = resultsProps(range, [match(0)]);

  it('is a decorative circular arrow, so the button around it carries the name', () => {
    const { container } = render(<ResetIcon />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('viewBox')).toBe('0 -960 960 960');
    expect(svg.querySelectorAll('path')).toHaveLength(1);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('replaces the word Reset: an icon button named "Reset sliders" with no text on screen', () => {
    render(<Results {...props} view={{ ...DEFAULT_VIEW, difficulty: 0.8 }} />);
    const reset = screen.getByRole('button', { name: 'Reset sliders' });
    expect(reset.getAttribute('title')).toBe('Reset sliders');
    expect(reset.textContent).toBe('');
    expect(reset.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByText('Reset')).toBeNull();
  });

  it('shows and hides exactly when the word did: with a slider set, never for a chip', () => {
    const onResetSliders = vi.fn();
    const { rerender } = render(<Results {...props} onResetSliders={onResetSliders} />);
    expect(screen.queryByRole('button', { name: 'Reset sliders' })).toBeNull();

    rerender(<Results {...props} onResetSliders={onResetSliders} view={{ ...DEFAULT_VIEW, mood: 'upbeat' }} />);
    expect(screen.queryByRole('button', { name: 'Reset sliders' })).toBeNull();

    rerender(<Results {...props} onResetSliders={onResetSliders} view={{ ...DEFAULT_VIEW, familiarity: 0.3 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset sliders' }));
    expect(onResetSliders).toHaveBeenCalledTimes(1);
    // Focus moves to the Tune panel, as it did when Reset was a word.
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Tune' }));

    rerender(<Results {...props} onResetSliders={onResetSliders} view={DEFAULT_VIEW} />);
    expect(screen.queryByRole('button', { name: 'Reset sliders' })).toBeNull();
  });
});

describe('Results row', () => {

  it('shows octave and fast-lyrics icons, and reasons under the artist', () => {
    const matches = [
      withMatch(match(0), { octave: 'up', fastLyrics: true, reasons: ['In your sweet spot', 'Top songs this month'] }),
      withMatch(match(1), { octave: 'down', fastLyrics: false, reasons: undefined }),
      withMatch(match(3), { octave: 'none', fastLyrics: false, reasons: [] }),
    ];
    render(<Results {...resultsProps(range, matches)} />);
    const [first, second, third] = screen.getAllByRole('listitem');

    expect(within(first!).getByRole('img', { name: 'Sing it an octave higher than the artist' })).toBeTruthy();
    expect(within(first!).getByRole('img', { name: 'Fast lyrics' })).toBeTruthy();
    expect(first!.querySelector('[data-reasons]')!.textContent!.replace(/\u00a0/g, ' ')).toBe('In your sweet spot · Top songs this month');
    expect(within(first!).getByRole('button', { name: /^Plastic Love by/ }).getAttribute('aria-label')).toBe(
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
    const m = withMatch(match(2), { reasons: ['Played recently'] });
    render(<SongDetail match={m} userRange={range} feedback={undefined} onFeedback={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole('img', { name: 'Fast lyrics' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Sing it an octave lower than the artist' })).toBeTruthy();
    expect(screen.getByText('Sing it lower than the artist')).toBeTruthy();
    expect(screen.getByText('Played recently')).toBeTruthy();
  });
});

describe('sources', () => {
  it('shows Sources and credits as a book icon under the results', () => {
    render(<Results {...resultsProps(range, [match(0)])} />);
    const credits = screen.getByRole('link', { name: 'Sources and credits' });
    expect(credits.getAttribute('href')).toBe('/credits');
    // Just the book icon: no words on screen.
    expect(credits.textContent).toBe('');
    expect(credits.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('credits MGPHot as an offline check of the mood labels, with its licence', async () => {
    const { CREDITS } = await import('../../src/lib/credits');
    const mgphot = CREDITS.find((c) => c.name.startsWith('MGPHot'));
    expect(mgphot?.url).toBe('https://doi.org/10.5334/tismir.236');
    expect(mgphot?.what).toContain('offline only, to check our mood labels');
    expect(mgphot?.what).toContain('CC BY-NC-ND 4.0');
  });

  it('credits Material Symbols for the reset icon too, like the book and fast-lyrics ones', async () => {
    const { CREDITS } = await import('../../src/lib/credits');
    const symbols = CREDITS.find((c) => c.name.startsWith('Material Symbols'));
    expect(symbols?.url).toBe('https://fonts.google.com/icons');
    expect(symbols?.what).toMatch(/fast-lyrics, book and reset icons/);
    expect(symbols?.what).toContain('Apache 2.0');
  });

  it('credits the AI model behind the mood labels', async () => {
    const { CREDITS } = await import('../../src/lib/credits');
    const model = CREDITS.find((c) => c.name.startsWith('OpenAI'));
    expect(model?.name).toBe('OpenAI GPT-6 Luna');
    expect(model?.what).toContain('Upbeat and Heartfelt');
  });
});
