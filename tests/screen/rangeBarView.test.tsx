// @vitest-environment jsdom
// The song page's range bar as the screen draws it (QWW-55): a bar above it for each bin that has sung time and
// none for an empty bin, each inside the song's pink stretch. The numbers come from display.ts (see
// tests/screen/rangeBarShape.test.ts); this is what reaches the page.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RangeBarView } from '../../src/components/SongDetail';
import { NAMES_APART, rangeBar } from '../../src/lib/client/display';
import type { Match, SongRange, VocalRange } from '../../src/lib/contracts';
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

// ---- the note names (R25, QWW-57) ----
// They show without a hover. Whether they are on screen, and where, is a browser's (tests/e2e/setlist-song.spec.ts); what is here is what the
// page puts there and the rule that keeps two names of one bar from running into each other (tests/screen/rangeBarNames.test.ts has its sweep).

const namesOf = (root: HTMLElement, tone: 'Song' | 'User') => Array.from(root.querySelectorAll<HTMLElement>(`[class*="barName${tone}"]`));
const textOf = (names: HTMLElement[]) => names.map((n) => n.textContent);
const songSpan = (low: number, high: number): SongRange => ({ low, high, tessitura: (low + high) / 2, source: 'note-file', confidence: 'high', fastLyrics: false });

describe('RangeBarView: the note names under the bars', () => {
  it('names the four ends, each bar’s low before its high: the song’s are the first row, yours the second', () => {
    const { container } = view(areYouWithMe());
    expect(textOf(namesOf(container, 'Song'))).toEqual(['G4', 'C#5']);
    expect(textOf(namesOf(container, 'User'))).toEqual(['D#2', 'D5']);
    expect(namesOf(container, 'Song').map((n) => n.dataset.end)).toEqual(['low', 'high']);
    expect(namesOf(container, 'User').map((n) => n.dataset.end)).toEqual(['low', 'high']);
  });

  it('puts each name under its end, on the same scale as the bars', () => {
    const range = areYouWithMe();
    const bar = rangeBar(USER_D2_TO_D5, range, 'none');
    const { container } = view(range);
    const lefts = (names: HTMLElement[]) => names.map((n) => percent(n.style.left));
    expect(lefts(namesOf(container, 'Song'))).toEqual([bar.song.left, bar.song.left + bar.song.width].map((x) => expect.closeTo(x, 5)));
    expect(lefts(namesOf(container, 'User'))).toEqual([bar.user.left, bar.user.left + bar.user.width].map((x) => expect.closeTo(x, 5)));
  });

  it('is for the eye only: the bar’s own description has the notes for a screen reader', () => {
    const { container } = view(areYouWithMe());
    expect(container.querySelector('[class*="barNames"]')!.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/^Song goes from G4 to C#5\. You sing from D#2 to D5\./);
  });

  it('centres a bar’s two names on its ends when there is room for them side by side', () => {
    const { container } = view(areYouWithMe()); // G4 to C#5 is 6 semitones of the 39 the bar spans (15%), D#2 to D5 is most of it
    for (const name of [...namesOf(container, 'Song'), ...namesOf(container, 'User')]) expect(name.hasAttribute('data-apart')).toBe(false);
  });

  it.each([
    ['the song’s', songSpan(60, 63), USER_D2_TO_D5, 'Song'], // 3 of 39 semitones (7.7%)
    ['the song’s, just under the limit', songSpan(60, 65), USER_D2_TO_D5, 'Song'], // 5 of 39 (12.8%)
    ['yours', songSpan(50, 70), { low: 60, high: 63, source: 'test' } as VocalRange, 'User'], // 3 of the 24 semitones the bar spans (12.5%)
  ] as const)('puts %s two names outside its ends when the ends are close: the low one to the left of its end, the high one to the right', (_which, range, user, tone) => {
    const match: Match = { track: track(0), range, difficulty: 'hard', octave: 'none' };
    const { container } = render(<RangeBarView userRange={user} match={match} />);
    const names = namesOf(container, tone);
    expect(names).toHaveLength(2);
    expect(names.map((n) => n.dataset.end)).toEqual(['low', 'high']);
    expect(names.map((n) => n.hasAttribute('data-apart'))).toEqual([true, true]);
    // The other bar's names have room and stay centred.
    const other = namesOf(container, tone === 'Song' ? 'User' : 'Song');
    expect(other.map((n) => n.hasAttribute('data-apart'))).toEqual([false, false]);
  });

  it('keeps names centred from the limit up, and moves them out below it', () => {
    // The user's bar is 39 semitones wide here, so a song of n semitones is n/39 of it.
    const apart = (semitones: number) => {
      const { container, unmount } = view(songSpan(60, 60 + semitones));
      const flags = namesOf(container, 'Song').map((n) => n.hasAttribute('data-apart'));
      unmount();
      return flags;
    };
    const limit = (NAMES_APART / 100) * 39; // 5.46 semitones
    expect(apart(Math.floor(limit))).toEqual([true, true]);
    expect(apart(Math.ceil(limit))).toEqual([false, false]);
  });

  it('a tap on the chart opens its legend and a second tap closes it, so nothing waits on a hover (R20)', () => {
    view(areYouWithMe());
    const chart = screen.getByRole('img');
    expect(chart.hasAttribute('data-open')).toBe(false);
    fireEvent.click(chart);
    expect(chart.hasAttribute('data-open')).toBe(true);
    fireEvent.click(chart);
    expect(chart.hasAttribute('data-open')).toBe(false);
  });
});
