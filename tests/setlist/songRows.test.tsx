// @vitest-environment jsdom
// The song row of Round 6A (README §4, QWW-57, decisions 3): the ▶ slot where the rank number was, then the text (title,
// "Artist · Era", reason line) and the difficulty badge. jsdom applies no CSS, so the sizes (66 px, 44 px, 10 px) are
// tests/e2e's; here is the DOM: what is in a row, in what order, and what a screen reader hears.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetlistScreen } from '../../src/components/setlist/SetlistScreen';
import type { Match } from '../../src/lib/contracts';
import type { SetlistSong } from '../../src/lib/setlist/types';
import { all, el, RANGE, rankedSong, SEL, setlistProps } from '../helpers/setlist';

afterEach(cleanup);

const draw = (songs: SetlistSong[], extra: Partial<Parameters<typeof setlistProps>[2]> = {}) => {
  const onSelect = vi.fn();
  render(<SetlistScreen {...setlistProps(RANGE, songs, { onSelect, ...extra })} />);
  return { onSelect };
};

const rows = () => all(SEL.row);
const button = (row: HTMLElement) => within(row).getAllByRole('button').find((b) => b.className.includes('rowOpen'))!;

const songs = [
  rankedSong('c', { title: 'Cello', artist: 'Cara', year: 2004, difficulty: 'hard' }, { difficulty: 80, popularity: 95 }),
  rankedSong('a', { title: 'Alpha', artist: 'Ada', year: 1969, difficulty: 'easy' }, { difficulty: 5, popularity: 20 }),
  rankedSong('b', { title: 'Bravo', artist: 'Bo', year: null, difficulty: 'maybe' }, { difficulty: null, tempo: 90 }),
];

describe('a row', () => {
  it('has the ▶ slot first, then one button with the text and the badge, and no rank number on screen', () => {
    draw(songs);
    for (const row of rows()) {
      const children = Array.from(row.children);
      expect(children).toHaveLength(2);
      expect(children[0]!.matches(SEL.playSlot)).toBe(true);
      expect(children[1]).toBe(button(row));
      // The slot is beside the row's button and never inside it, so a tap on the ▶ cannot also open the song page.
      expect(button(row).querySelector(SEL.playSlot)).toBeNull();
      expect(button(row).querySelector('button')).toBeNull();
    }
    // The position is in data-rank and in the list being an <ol>, and nowhere in the text a sighted singer reads.
    expect(rows().map((r) => r.dataset.rank)).toEqual(['1', '2', '3']);
    for (const row of rows()) expect(row.textContent).not.toMatch(/^\d/);
  });

  it('shows the title, then "Artist · Era", then the reason line, and the badge after them', () => {
    draw(songs);
    const [cello] = rows();
    const lines = Array.from(button(cello!).querySelectorAll('span'))
      .filter((s) => s.children.length === 0 && !s.hasAttribute('aria-hidden'))
      .map((s) => s.textContent);
    expect(lines).toEqual(['Cello', 'Cara · ’00s', 'Crowd favourite', 'Hard']);
  });

  it('carries the title text once, where the page reads it: the lyric wipe is drawn by CSS from data-wipe, not as a second copy of the text', () => {
    draw(songs);
    expect(all('[data-row-title]').map((t) => t.textContent)).toEqual(['Cello', 'Alpha', 'Bravo']);
    // One piece of text per title: a screen reader, find-in-page and a copy see it once.
    expect(screen.getAllByText('Cello')).toHaveLength(1);
    const wipes = all('[data-wipe]');
    expect(wipes).toHaveLength(1);
    expect(wipes[0]!.getAttribute('data-wipe')).toBe('Cello');
    expect(wipes[0]!.textContent).toBe('Cello');
    expect(rows()[0]!.contains(wipes[0]!)).toBe(true);
  });

  it('shows the lyric wipe on the #1 row only, and it moves with the #1 spot', () => {
    draw(songs);
    expect(all('[data-wipe]').map((w) => w.closest('li')!.dataset.id)).toEqual(['c']);
    cleanup();
    draw([songs[1]!, songs[0]!, songs[2]!]);
    expect(all('[data-wipe]').map((w) => w.closest('li')!.dataset.id)).toEqual(['a']);
    expect(all('[data-wipe]').map((w) => w.getAttribute('data-wipe'))).toEqual(['Alpha']);
  });

  it('gives each song its badge from its own label, and a Maybe song none', () => {
    draw(songs);
    const badges = rows().map((r) => r.querySelector('[data-badge]')?.textContent ?? null);
    expect(badges).toEqual(['Hard', 'Easy', null]);
  });

  it('gives each row its reason line, from the song\'s own places', () => {
    draw(songs);
    // Difficulty is on at 0: Alpha (place 5) is in the sweet spot; Cello is a crowd favourite; Bravo has only a tempo.
    expect(rows().map((r) => r.querySelector('[data-row-why]')?.textContent)).toEqual(['Crowd favourite', 'In your sweet spot · Deep cut', 'Gets the room moving']);
  });

  it('names the button "title by artist, era, difficulty" and describes it with the reason line, so both are read with the row', () => {
    draw(songs);
    expect(rows().map((r) => button(r).getAttribute('aria-label'))).toEqual(['Cello by Cara, ’00s, Hard', 'Alpha by Ada, Pre-’70s, Easy', 'Bravo by Bo, Maybe']);
    for (const row of rows()) {
      const described = button(row).getAttribute('aria-describedby');
      expect(described, 'the button points at its reason line').toBeTruthy();
      expect(document.getElementById(described!)?.textContent).toBe(row.querySelector('[data-row-why]')?.textContent);
    }
    expect(rows().map((r) => document.getElementById(button(r).getAttribute('aria-describedby')!)?.textContent)).toEqual([
      'Crowd favourite',
      'In your sweet spot · Deep cut',
      'Gets the room moving',
    ]);
  });

  it('opens the song from the button with its 1-based place, and the ▶ slot opens nothing', () => {
    const { onSelect } = draw(songs);
    fireEvent.click(button(rows()[1]!));
    expect(onSelect.mock.calls).toEqual([['a', 2]]);
    fireEvent.click(el(SEL.playSlot));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('reads the Difficulty gear for its sweet spot: the reasons change when the slider moves', () => {
    const tuner = { difficulty: 80, history: 100, popularity: 100, tempo: 50, eras: [], off: ['history', 'tempo', 'era'], open: 'difficulty', mini: false } as const;
    draw(songs, { tuner: { ...tuner, eras: [], off: [...tuner.off] } });
    expect(rows().map((r) => r.querySelector('[data-row-why]')?.textContent)).toEqual(['In your sweet spot · Crowd favourite', 'Deep cut', 'Gets the room moving']);
  });

  it('says nothing of the sweet spot while Difficulty is off', () => {
    const tuner = { difficulty: 0, history: 100, popularity: 100, tempo: 50, eras: [], off: ['difficulty', 'history', 'tempo', 'era'], open: 'difficulty', mini: false } as const;
    draw(songs, { tuner: { ...tuner, eras: [], off: [...tuner.off] } });
    expect(all('[data-row-why]').some((w) => (w.textContent ?? '').includes('sweet spot'))).toBe(false);
  });
});

describe('the ▶ slot', () => {
  it('holds a disabled ▶ until the play button is mounted, so the row\'s layout is final', () => {
    draw(songs);
    for (const slot of all(SEL.playSlot)) {
      const play = slot.querySelector('button')!;
      expect(play.disabled).toBe(true);
      expect(play.getAttribute('aria-label')).toMatch(/Play preview/);
    }
  });

  it('holds what renderPlay gives, per song', () => {
    const renderPlay = (match: Match) => <button type="button" data-testid={`play-${match.track.id}`} />;
    draw(songs, { renderPlay });
    expect(all(SEL.playSlot).map((s) => s.querySelector('button')?.getAttribute('data-testid'))).toEqual(['play-c', 'play-a', 'play-b']);
  });
});

describe('the header', () => {
  it('has the singer\'s range as two buttons, redo, the sign, and the heading under them', () => {
    draw(songs);
    const header = el('header');
    expect(within(header).getByRole('group', { name: 'Your range A2 to C5' })).toBeTruthy();
    expect(within(header).getByRole('button', { name: 'Redo your low note, A2' })).toBeTruthy();
    expect(within(header).getByRole('button', { name: 'Redo your high note, C5' })).toBeTruthy();
    expect(within(header).getByRole('button', { name: 'Redo the singing test' })).toBeTruthy();
    expect(within(header).getByRole('heading', { name: 'Tune your setlist' })).toBeTruthy();
  });

  it('draws the カラオケ sign as decoration: Japanese, and hidden from a screen reader', () => {
    draw(songs);
    const sign = el('[lang="ja"]');
    expect(sign.textContent).toBe('カラオケ');
    expect(sign.getAttribute('aria-hidden')).toBe('true');
    expect(sign.parentElement!.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the Spotify logo last, after redo and the sign', () => {
    draw(songs);
    const bar = el('header > div');
    const order = Array.from(bar.children).map((c) => (c.querySelector('[lang="ja"]') ? 'sign' : (c as HTMLElement).getAttribute('aria-label') ?? c.tagName));
    expect(order.at(-1)).toBe('Connect to Spotify');
    expect(order.indexOf('sign')).toBeGreaterThan(order.indexOf('Redo the singing test'));
    expect(order.indexOf('sign')).toBeLessThan(order.indexOf('Connect to Spotify'));
  });
});
