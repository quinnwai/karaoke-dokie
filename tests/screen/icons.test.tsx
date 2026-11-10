// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FastLyricsIcon, OctaveIcon, ResetIcon } from '../../src/components/Icon';
import { SetlistScreen } from '../../src/components/setlist/SetlistScreen';
import { SongDetail } from '../../src/components/SongDetail';
import type { Match } from '../../src/lib/contracts';
import { initialTuner } from '../../src/lib/setlist/tuner';
import { TUNER_PARTS } from '../../src/lib/setlist/types';
import { match } from '../fixtures/screen';
import { all, ranked, SEL, setlistProps } from '../helpers/setlist';

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
  it('is a decorative circular arrow, so the button around it carries the name', () => {
    const { container } = render(<ResetIcon />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('viewBox')).toBe('0 -960 960 960');
    expect(svg.querySelectorAll('path')).toHaveLength(1);
    expect(screen.queryByRole('img')).toBeNull();
  });

  // The Setlist screen's own arrow (spec §4a): one on each gear and one on Era, every one an icon with no words.
  it('is on the reset button of every gear: a named button with no text on screen, drawn as the spec gives it', () => {
    // Signed in with every gear on, so every reset button is shown (History needs the library: off in the catalogue).
    render(
      <SetlistScreen
        {...setlistProps({ low: 45, high: 72, source: 'test' }, [ranked(match(0))], { mode: 'library', tuner: { ...initialTuner(), off: [] } })}
      />,
    );
    const buttons = TUNER_PARTS.map((gear) => all<HTMLButtonElement>(SEL.reset(gear)));
    expect(buttons.map((b) => b.length)).toEqual([1, 1, 1, 1, 1]);
    for (const [button] of buttons) {
      expect(button!.hidden).toBe(false);
      expect(button!.getAttribute('title')).toBe("Reset: don't factor in");
      expect(button!.getAttribute('aria-label')).toMatch(/^Reset .+ \(stop factoring it in\)$/);
      expect(button!.textContent).toBe('');
      const svg = button!.querySelector('svg')!;
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg.getAttribute('stroke')).toBe('currentColor');
      expect(svg.getAttribute('stroke-width')).toBe('2');
      expect(Array.from(svg.querySelectorAll('path')).map((path) => path.getAttribute('d'))).toEqual([
        'M4.5 12A7.5 7.5 0 1 0 12 4.5',
        'M14.5 1.75L11.75 4.5L14.5 7.25',
      ]);
    }
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
    render(<SetlistScreen {...setlistProps(range, [ranked(match(0))])} />);
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
