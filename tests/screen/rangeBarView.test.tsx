// @vitest-environment jsdom
// The song page's range bar as the screen draws it (QWW-55): a bar above it for each bin that has sung time and
// none for an empty bin, each inside the song's pink stretch. The numbers come from display.ts (see
// tests/screen/rangeBarShape.test.ts); this is what reaches the page.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RangeBarView } from '../../src/components/SongDetail';
import type { Match, SongRange } from '../../src/lib/contracts';
import { shapeOf } from '../../src/lib/songs/score';
import { track } from '../fixtures/screen';
import { areYouWithMe, USER_D2_TO_D5 } from '../songs/rangeBarFixture';

afterEach(cleanup);

const percent = (value: string) => parseFloat(value);
const barsOf = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>('[class*="barShape"] i'));
const pinkOf = (root: HTMLElement) => {
  const pink = root.querySelector<HTMLElement>('[class*="barSong"]')!;
  return { left: percent(pink.style.left), right: percent(pink.style.left) + percent(pink.style.width) };
};

function view(range: SongRange, shape?: number[]) {
  const match: Match = { track: track(0), range, difficulty: 'hard', octave: 'none', ...(shape ? { shape } : {}) };
  return render(<RangeBarView userRange={USER_D2_TO_D5} match={match} />);
}

describe('RangeBarView: the bars above the range bar', () => {
  const range = areYouWithMe();

  it('draws one bar for each bin with sung time and none for an empty bin, each inside the pink stretch', () => {
    const shape = shapeOf(USER_D2_TO_D5, range, 'none')!;
    const { container } = view(range, shape);
    const bars = barsOf(container);
    expect(bars).toHaveLength(shape.filter((b) => b > 0).length); // 3 of the 12 bins
    expect(bars).toHaveLength(3);
    const pink = pinkOf(container);
    for (const bar of bars) {
      expect(percent(bar.style.left)).toBeGreaterThanOrEqual(pink.left - 0.01);
      expect(percent(bar.style.left) + percent(bar.style.width)).toBeLessThanOrEqual(pink.right + 0.01);
    }
    expect(bars.map((b) => b.style.height)).toEqual(['71%', '33%', '100%']);
  });

  it('keeps a bin with a little sung time at least 3% tall, so it is still there', () => {
    const { container } = view(range, [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 99]);
    expect(barsOf(container).map((b) => b.style.height)).toEqual(['3%', '100%']);
  });

  it('draws nothing, and does not say the taller bars show where the song sits, when no bin is inside the song', () => {
    const { container } = view(range, [5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(container.querySelector('[class*="barShape"]')).toBeNull();
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Song goes from G4 to C#5. You sing from D#2 to D5.');
  });

  it('draws nothing for a song with no histogram', () => {
    const { container } = view(range);
    expect(container.querySelector('[class*="barShape"]')).toBeNull();
  });

  it('describes the bar in the same words as before when there are bars', () => {
    view(range, shapeOf(USER_D2_TO_D5, range, 'none'));
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
      'Song goes from G4 to C#5. You sing from D#2 to D5. Most of the song sits where the taller bars are.',
    );
  });
});
