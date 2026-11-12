// @vitest-environment jsdom
// The song row of Round 6A (README §4, QWW-57, decision 3 and review items R3 and R12): the slot where the rank number was,
// holding the number and the ▶, then the text (title, "Artist · Era", reason line) and the difficulty badge; and the title's
// fill, which starts when its row comes into view. jsdom applies no CSS, so the sizes (66 px, 44 px, 10 px), which of the
// number and the ▶ shows, and the fill's look and timing are tests/e2e's (setlist-rows.spec.ts); here is the DOM: what is in a
// row, in what order, what a screen reader hears, and which rows have filled (with a fake IntersectionObserver).

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetlistScreen } from '../../src/components/setlist/SetlistScreen';
import { FILL_AT, FILL_STAGGER_MS, FILL_STAGGER_ROWS, staggerOf, type FillMemory } from '../../src/components/setlist/useFillIn';
import type { Match } from '../../src/lib/contracts';
import type { SetlistSong } from '../../src/lib/setlist/types';
import { all, el, RANGE, rankedSong, SEL, setlistProps } from '../helpers/setlist';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
  it('has the slot first, then one button with the text and the badge; the rank number is in the slot, not in the button', () => {
    draw(songs);
    for (const row of rows()) {
      const children = Array.from(row.children);
      expect(children).toHaveLength(2);
      expect(children[0]!.matches(SEL.playSlot)).toBe(true);
      expect(children[1]).toBe(button(row));
      // The slot is beside the row's button and never inside it, so a tap on the ▶ cannot also open the song page.
      expect(button(row).querySelector(SEL.playSlot)).toBeNull();
      expect(button(row).querySelector('button')).toBeNull();
      // The number is the slot's, so it comes and goes with the ▶ and is not part of what the row's own button reads.
      expect(button(row).querySelector('[data-rank-number]')).toBeNull();
    }
    // The position is in data-rank, in the list being an <ol>, and (R3) in the number the slot shows on a pointer device.
    expect(rows().map((r) => r.dataset.rank)).toEqual(['1', '2', '3']);
    expect(rows().map((r) => el('[data-rank-number]', r).textContent)).toEqual(['1', '2', '3']);
  });

  it('shows the title, then "Artist · Era", then the reason line, and the badge after them', () => {
    draw(songs);
    const [cello] = rows();
    const lines = Array.from(button(cello!).querySelectorAll('span'))
      .filter((s) => s.children.length === 0 && !s.hasAttribute('aria-hidden'))
      .map((s) => s.textContent);
    expect(lines).toEqual(['Cello', 'Cara · ’00s', 'Crowd favourite', 'Hard']);
  });

  it('carries the title text once, where the page reads it: the fill is drawn by CSS from data-fill-text, not as a second copy of the text', () => {
    draw(songs);
    expect(all('[data-row-title]').map((t) => t.textContent)).toEqual(['Cello', 'Alpha', 'Bravo']);
    // One piece of text per title: a screen reader, find-in-page and a copy see it once.
    expect(screen.getAllByText('Cello')).toHaveLength(1);
    // The copy CSS draws is an attribute of the title's box, not a node: the box holds the title's own text and nothing more.
    const boxes = all('[data-fill-text]');
    expect(boxes.map((b) => b.getAttribute('data-fill-text'))).toEqual(['Cello', 'Alpha', 'Bravo']);
    for (const box of boxes) {
      expect(box.textContent).toBe(box.getAttribute('data-fill-text'));
      expect(box.querySelector('[data-row-title]')?.textContent).toBe(box.getAttribute('data-fill-text'));
    }
    expect(boxes.map((b) => b.closest('li')!.dataset.id)).toEqual(['c', 'a', 'b']);
  });

  it('has no lyric wipe: the #1 row is marked by nothing but its place (R12 took the looping wipe away)', () => {
    draw(songs);
    expect(all('[data-wipe]')).toHaveLength(0);
    cleanup();
    draw([songs[1]!, songs[0]!, songs[2]!]);
    expect(all('[data-wipe]')).toHaveLength(0);
  });

  it('gives each song its badge from its own label, and a Maybe song none', () => {
    draw(songs);
    const badges = rows().map((r) => r.querySelector('[data-badge]')?.textContent ?? null);
    expect(badges).toEqual(['Hard', 'Easy', null]);
  });

  it('gives each row its reason line, from the song\'s own places', () => {
    draw(songs);
    // Difficulty is on at 0: Alpha (place 5) is in the sweet spot; Cello is a crowd favourite; Bravo has only a tempo.
    expect(rows().map((r) => r.querySelector('[data-row-why]')?.textContent)).toEqual(['Crowd favourite', 'In your sweet spot · Wildcard', 'For the party people']);
  });

  it('says a shifted song fits an octave away in its reason line, and nothing else, in place of the sweet spot, and keeps its badge (R13)', () => {
    draw([
      rankedSong('d', { title: 'Down', octave: 'down', difficulty: 'hard' }, { difficulty: 3, popularity: 95 }),
      rankedSong('u', { title: 'Up', octave: 'up', difficulty: 'easy' }, { difficulty: 3 }),
      rankedSong('w', { title: 'Written', difficulty: 'easy' }, { difficulty: 3, popularity: 95 }),
    ]);
    // Difficulty is on at 0, so all three sit in the sweet spot; the two shifted ones do not say so, and the third does.
    expect(rows().map((r) => r.querySelector('[data-row-why]')?.textContent)).toEqual([
      'Shifted down to fit range',
      'Shifted up to fit range',
      'In your sweet spot · Crowd favourite',
    ]);
    expect(rows().map((r) => r.querySelector('[data-badge]')?.textContent)).toEqual(['Hard', 'Easy', 'Easy']);
    // A screen reader hears it as the button's description, as it hears any reason line.
    const described = button(rows()[0]!).getAttribute('aria-describedby')!;
    expect(document.getElementById(described)?.textContent).toBe('Shifted down to fit range');
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
      'In your sweet spot · Wildcard',
      'For the party people',
    ]);
  });

  it('describes each button with its own reason line when the track ids have spaces, as a catalogue id does', () => {
    // aria-describedby is a list of ids split at spaces, so an id made from "cat:michael jackson|beat it" named three ids that do not exist.
    const spaced = [
      rankedSong('cat:michael jackson|beat it', { title: 'Beat It', artist: 'Michael Jackson', year: 1983, difficulty: 'easy' }, { difficulty: 5, popularity: 95 }),
      rankedSong('cat:a ha|take on me', { title: 'Take On Me', artist: 'a-ha', year: 1985, difficulty: 'hard' }, { difficulty: 80, popularity: 20 }),
      rankedSong('cat:the beatles|let it be', { title: 'Let It Be', artist: 'The Beatles', year: 1970, difficulty: 'easy' }, { difficulty: 10, popularity: 50 }),
    ];
    draw(spaced);
    // What a screen reader makes of it: the text of each element the space-separated ids name.
    const description = (b: HTMLElement) =>
      (b.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
    expect(rows().map((r) => r.dataset.id)).toEqual(spaced.map((s) => s.match.track.id)); // the spaces are really on the page
    const ids = rows().map((r) => button(r).getAttribute('aria-describedby')!);
    for (const id of ids) expect(id).not.toMatch(/\s/);
    expect(new Set(ids).size).toBe(ids.length);
    const why = rows().map((r) => r.querySelector('[data-row-why]')!.textContent);
    expect(why.every((w) => !!w)).toBe(true);
    expect(rows().map((r) => description(button(r)))).toEqual(why);
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
    expect(rows().map((r) => r.querySelector('[data-row-why]')?.textContent)).toEqual(['In your sweet spot · Crowd favourite', 'Wildcard', 'For the party people']);
  });

  it('says nothing of the sweet spot while Difficulty is off', () => {
    const tuner = { difficulty: 0, history: 100, popularity: 100, tempo: 50, eras: [], off: ['difficulty', 'history', 'tempo', 'era'], open: 'difficulty', mini: false } as const;
    draw(songs, { tuner: { ...tuner, eras: [], off: [...tuner.off] } });
    expect(all('[data-row-why]').some((w) => (w.textContent ?? '').includes('sweet spot'))).toBe(false);
  });
});

/** Draws the screen, and gives back a way to draw it again with other songs (a re-rank, a filter that takes a song away). */
const drawable = (list: SetlistSong[], extra: Partial<Parameters<typeof setlistProps>[2]> = {}) => {
  const props = setlistProps(RANGE, list, extra);
  const view = render(<SetlistScreen {...props} />);
  return { ...view, again: (next: SetlistSong[]) => view.rerender(<SetlistScreen {...props} songs={next} />) };
};

describe('the slot: the rank number and the ▶ (R3)', () => {
  it('holds the rank number, then a disabled ▶ until the play button is mounted, so the row\'s layout is final', () => {
    draw(songs);
    for (const slot of all(SEL.playSlot)) {
      expect(Array.from(slot.children).map((c) => (c.hasAttribute('data-rank-number') ? 'number' : c.tagName))).toEqual(['number', 'BUTTON']);
      const play = slot.querySelector('button')!;
      expect(play.disabled).toBe(true);
      expect(play.getAttribute('aria-label')).toMatch(/Play preview/);
    }
  });

  // The stand-in for a screen given no renderPlay is the glyph alone. The circle round the ▶ (R17) is the app's own button's, which always
  // takes its place (tests/screen/previewPlay.test.tsx and tests/e2e/setlist-play.spec.ts).
  it('draws the placeholder ▶ as the glyph alone: one svg, no ring and no circle in it', () => {
    draw(songs);
    for (const slot of all(SEL.playSlot)) {
      const play = slot.querySelector('button')!;
      expect(play.querySelectorAll('svg')).toHaveLength(1);
      expect(slot.querySelectorAll('circle, ellipse')).toHaveLength(0);
      expect(play.querySelector('path')?.getAttribute('fill')).toBe('currentColor');
    }
  });

  it('hides the number from a screen reader: the <ol> already says each position, so it is not read twice', () => {
    draw(songs);
    expect(all('[data-rank-number]')).toHaveLength(3);
    for (const number of all('[data-rank-number]')) expect(number.getAttribute('aria-hidden')).toBe('true');
    // The accessible name of a row's button is the song's, with no number in front of it.
    for (const row of rows()) expect(button(row).getAttribute('aria-label')).not.toMatch(/^\d/);
  });

  it('numbers by place on the list, so a re-rank renumbers the rows and the number follows data-rank', () => {
    const { again } = drawable(songs);
    expect(rows().map((r) => [r.dataset.id, r.dataset.rank, el('[data-rank-number]', r).textContent])).toEqual([
      ['c', '1', '1'],
      ['a', '2', '2'],
      ['b', '3', '3'],
    ]);
    again([songs[1]!, songs[2]!, songs[0]!]);
    expect(rows().map((r) => [r.dataset.id, r.dataset.rank, el('[data-rank-number]', r).textContent])).toEqual([
      ['a', '1', '1'],
      ['b', '2', '2'],
      ['c', '3', '3'],
    ]);
  });

  it('holds what renderPlay gives, per song, after the number, and leaves it as it is (QWW-48\'s markup is its own)', () => {
    const renderPlay = (match: Match) => <button type="button" data-testid={`play-${match.track.id}`} />;
    draw(songs, { renderPlay });
    expect(all(SEL.playSlot).map((s) => s.querySelector('button')?.getAttribute('data-testid'))).toEqual(['play-c', 'play-a', 'play-b']);
    for (const slot of all(SEL.playSlot)) {
      expect(Array.from(slot.children).map((c) => (c.hasAttribute('data-rank-number') ? 'number' : c.tagName))).toEqual(['number', 'BUTTON']);
      expect(slot.querySelector('button')!.attributes).toHaveLength(2); // type and data-testid: nothing added to it
    }
  });
});

// ---- the title fill (R12) ----

/** The browser's IntersectionObserver, by hand: what each one watches, and a way to tell it how much of each row is in view. */
class FakeObserver {
  static made: FakeObserver[] = [];
  readonly watched = new Set<Element>();
  disconnected = false;

  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit = {},
  ) {
    FakeObserver.made.push(this);
  }

  observe(target: Element) {
    this.watched.add(target);
  }

  unobserve(target: Element) {
    this.watched.delete(target);
  }

  disconnect() {
    this.watched.clear();
    this.disconnected = true;
  }

  takeRecords() {
    return [];
  }

  /** The browser reporting the share (0 to 1) of some rows that is inside the scroller. */
  see(...seen: Array<[Element, number]>) {
    const entries = seen.map(([target, ratio]) => ({ target, intersectionRatio: ratio, isIntersecting: ratio > 0 }) as unknown as IntersectionObserverEntry);
    act(() => this.callback(entries, this as unknown as IntersectionObserver));
  }
}

/** The observer the list is using now: the latest that was not disconnected. */
const watching = () => FakeObserver.made.filter((o) => !o.disconnected).at(-1)!;

const media = (reduce: boolean) => (query: string) => ({ matches: reduce && query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;

describe('the title fill (R12)', () => {
  beforeEach(() => {
    FakeObserver.made = [];
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    vi.stubGlobal('matchMedia', media(false));
  });

  const byId = (id: string) => el(`[data-row][data-id="${id}"]`);
  const boxOf = (row: HTMLElement) => el('[data-fill-text]', row);
  const filled = () => rows().map((r) => boxOf(r).hasAttribute('data-filled'));
  const delayOf = (row: HTMLElement) => boxOf(row).style.getPropertyValue('--fill-delay');
  /** n songs, in rank order s0, s1, ... */
  const many = (n: number) => Array.from({ length: n }, (_, i) => rankedSong(`s${i}`, { title: `Song ${i}` }));

  it('draws every title filled where nothing can say when a row is in view, as in jsdom or a browser without IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    draw(songs);
    expect(filled()).toEqual([true, true, true]);
    expect(rows().map(delayOf)).toEqual(['', '', '']);
  });

  it('starts every title unfilled, and watches the rows in the list\'s own scroller', () => {
    draw(songs);
    expect(filled()).toEqual([false, false, false]);
    expect(FakeObserver.made).toHaveLength(1);
    expect(watching().options.root).toBe(el('#list-scroll'));
    expect(watching().options.threshold).toBe(FILL_AT);
    expect(Array.from(watching().watched)).toEqual(rows());
  });

  it('fills a row once enough of it is in view, and only that row, and then stops watching it', () => {
    draw(songs);
    watching().see([rows()[0]!, 1]);
    expect(filled()).toEqual([true, false, false]);
    expect(delayOf(rows()[0]!)).toBe('0ms');
    expect(Array.from(watching().watched)).toEqual([rows()[1], rows()[2]]);
  });

  it('does not fill a row that only touches the scroller, or is a little way in: it waits to be far enough in', () => {
    draw(songs);
    const [, alpha] = rows();
    watching().see([alpha!, 0]);
    expect(filled()).toEqual([false, false, false]);
    watching().see([alpha!, 0.2]);
    expect(filled()).toEqual([false, false, false]);
    watching().see([alpha!, FILL_AT]);
    expect(filled()).toEqual([false, true, false]);
  });

  it('staggers the rows that come into view together, top first, 60 ms apart for the first eight; a later row starts again from none', () => {
    expect([staggerOf(0), staggerOf(1), staggerOf(2)]).toEqual([0, FILL_STAGGER_MS, 2 * FILL_STAGGER_MS]);
    expect(staggerOf(FILL_STAGGER_ROWS + 5)).toBe(FILL_STAGGER_ROWS * FILL_STAGGER_MS);
    drawable(many(12));
    // Told in the wrong order on purpose: the stagger goes down the list, whatever order the browser reports in.
    const first10 = rows().slice(0, 10);
    watching().see(...[...first10].reverse().map((r): [Element, number] => [r, 1]));
    expect(first10.map(delayOf)).toEqual(first10.map((_, k) => `${staggerOf(k)}ms`));
    expect(delayOf(first10[0]!)).toBe('0ms');
    expect(delayOf(first10[1]!)).toBe('60ms');
    expect(delayOf(first10[9]!)).toBe('480ms');
    // One more row comes in later, alone: it does not wait behind the others.
    watching().see([rows()[11]!, 1]);
    expect(delayOf(rows()[11]!)).toBe('0ms');
    // Row 10 was not in view for either, so it has not filled.
    expect(filled()).toEqual(Array.from({ length: 12 }, (_, i) => i !== 10));
  });

  it('fills once per visit: a re-rank, a re-render, and a row that leaves and comes back do not undo it or play it again', () => {
    const { again } = drawable(songs);
    watching().see([byId('c'), 1]);
    expect(boxOf(byId('c')).hasAttribute('data-filled')).toBe(true);
    const made = FakeObserver.made.length;

    // The same order drawn again changes nothing and watches nothing anew.
    again([...songs]);
    expect(FakeObserver.made).toHaveLength(made);
    expect(boxOf(byId('c')).hasAttribute('data-filled')).toBe(true);

    // A re-rank: React moves the row's node, and it keeps what it holds. Only the rows that have not filled are watched again.
    again([songs[1]!, songs[0]!, songs[2]!]);
    expect(rows().map((r) => r.dataset.id)).toEqual(['a', 'c', 'b']);
    expect(filled()).toEqual([false, true, false]);
    expect(Array.from(watching().watched)).toEqual([byId('a'), byId('b')]);

    // It leaves (an era takes it off the list) and comes back: its new node is drawn filled, and is not watched.
    again([songs[1]!, songs[2]!]);
    expect(rows().map((r) => r.dataset.id)).toEqual(['a', 'b']);
    again(songs);
    expect(rows().map((r) => r.dataset.id)).toEqual(['c', 'a', 'b']);
    expect(filled()).toEqual([true, false, false]);
    expect(Array.from(watching().watched)).toEqual([byId('a'), byId('b')]);
  });

  it('fills once per visit, not once per list: with the app\'s memory, a list that empties and fills, or a screen that goes and comes back, draws what filled as filled (R12)', () => {
    const memory: FillMemory = new Map();
    const first = drawable(songs, { fillMemory: memory });
    watching().see([byId('c'), 1], [byId('a'), 1]);
    expect(filled()).toEqual([true, true, false]);
    // The list empties, as an untapped era leaves it (SongRows goes), and fills again: the rows that filled are drawn filled at once, and
    // only the one that never did is watched.
    first.again([]);
    expect(rows()).toHaveLength(0);
    first.again(songs);
    expect(filled()).toEqual([true, true, false]);
    expect(Array.from(watching().watched)).toEqual([byId('b')]);
    expect(delayOf(byId('a'))).toBe('60ms');
    // The whole screen goes (the song page opens) and comes back (Back): a new screen, the same memory.
    first.unmount();
    draw(songs, { fillMemory: memory });
    expect(filled()).toEqual([true, true, false]);
    expect(Array.from(watching().watched)).toEqual([byId('b')]);
    expect(delayOf(byId('c'))).toBe('0ms');
  });

  it('fills them all again for a new visit: a new memory (the singer\'s range changed) starts none filled', () => {
    const memory: FillMemory = new Map();
    const first = drawable(songs, { fillMemory: memory });
    watching().see([byId('c'), 1], [byId('a'), 1], [byId('b'), 1]);
    expect(filled()).toEqual([true, true, true]);
    first.unmount();
    draw(songs, { fillMemory: new Map() });
    expect(filled()).toEqual([false, false, false]);
    expect(Array.from(watching().watched)).toEqual(rows());
  });

  it('without the app\'s memory a list that goes forgets what it filled, as one that is given none always did', () => {
    const first = drawable(songs);
    watching().see([byId('c'), 1]);
    first.unmount();
    draw(songs);
    expect(filled()).toEqual([false, false, false]);
  });

  it('does not start a fill again, or change its wait, when the browser reports a filled row once more', () => {
    drawable(songs);
    watching().see([byId('a'), 1], [byId('b'), 1]);
    expect(delayOf(byId('a'))).toBe('0ms');
    expect(delayOf(byId('b'))).toBe('60ms');
    watching().see([byId('b'), 1]);
    expect(delayOf(byId('b'))).toBe('60ms');
  });

  it('draws every title filled and watches nothing for a singer who asked for reduced motion', () => {
    vi.stubGlobal('matchMedia', media(true));
    draw(songs);
    expect(filled()).toEqual([true, true, true]);
    expect(FakeObserver.made).toHaveLength(0);
  });

  it('stops watching when the list goes, and ignores a report that comes after it', () => {
    const { unmount } = drawable(songs);
    const observer = watching();
    const row = rows()[0]!;
    unmount();
    expect(observer.disconnected).toBe(true);
    expect(() => observer.see([row, 1])).not.toThrow();
  });
});

describe('the header', () => {
  it('has the singer\'s range as two buttons, redo, the sign, and the heading under them', () => {
    draw(songs);
    const header = el('header');
    expect(within(header).getByRole('group', { name: 'Your range A2 to C5' })).toBeTruthy();
    expect(within(header).getByRole('button', { name: 'Redo your low note, A2' })).toBeTruthy();
    expect(within(header).getByRole('button', { name: 'Redo your high note, C5' })).toBeTruthy();
    expect(within(header).getByRole('button', { name: 'Redo the range test' })).toBeTruthy();
    expect(within(header).getByRole('heading', { name: 'Tune your setlist' })).toBeTruthy();
  });

  it('draws the カラオケ sign as decoration: Japanese, and hidden from a screen reader', () => {
    draw(songs);
    const sign = el('[lang="ja"]');
    expect(sign.textContent).toBe('カラオケ');
    // The sign carries its own aria-hidden (R1 took away the wrapper that used to).
    expect(sign.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the Spotify logo last, after redo and the sign', () => {
    draw(songs);
    const bar = el('header > div');
    // The sign is a direct child of the row (R1: centred on the header's middle), so the child itself is the sign.
    const order = Array.from(bar.children).map((c) => (c.matches('[lang="ja"]') || c.querySelector('[lang="ja"]') ? 'sign' : (c as HTMLElement).getAttribute('aria-label') ?? c.tagName));
    expect(order.at(-1)).toBe('Connect to Spotify');
    expect(order.indexOf('sign')).toBeGreaterThan(order.indexOf('Redo the range test'));
    expect(order.indexOf('sign')).toBeLessThan(order.indexOf('Connect to Spotify'));
  });
});
