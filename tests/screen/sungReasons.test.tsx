// @vitest-environment jsdom
// The reasons under each song are sung in like a karaoke lyric the first time the row scrolls into view.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Results } from '../../src/components/Results';
import type { Match } from '../../src/lib/contracts';
import { match } from '../fixtures/screen';
import { resultsProps } from '../helpers/results';

const range = { low: 45, high: 72, source: 'test' as const };

/** Stands in for the browser's IntersectionObserver; a test says how much of each target is on screen. */
class FakeObserver {
  static all: FakeObserver[] = [];
  targets: Element[] = [];
  disconnected = false;
  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeObserver.all.push(this);
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  takeRecords() {
    return [];
  }
  static show(el: Element, ratio: number) {
    for (const o of FakeObserver.all.filter((x) => !x.disconnected && x.targets.includes(el))) {
      const entry = { target: el, intersectionRatio: ratio, isIntersecting: ratio > 0 } as IntersectionObserverEntry;
      act(() => o.callback([entry], o as unknown as IntersectionObserver));
    }
  }
}

const withReasons = (i: number, reasons: string[]): Match => ({ ...match(i), reasons });
const lines = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>('[data-reasons]'));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeObserver.all = [];
});

describe('sung reasons', () => {
  it('waits faint until its row is mostly on screen, then sings once', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const matches = [withReasons(0, ['In your sweet spot', 'Top songs this month']), withReasons(1, ['Played recently'])];
    const { container } = render(<Results {...resultsProps(range, matches)} />);
    const [first, second] = lines(container);
    expect(first!.dataset.sing).toBe('waiting');
    expect(second!.dataset.sing).toBe('waiting');

    FakeObserver.show(first!, 0.3); // only the top of the line is showing
    expect(first!.dataset.sing).toBe('waiting');
    FakeObserver.show(first!, 0.8);
    expect(first!.dataset.sing).toBe('singing');
    expect(second!.dataset.sing).toBe('waiting');
    // Sung once: nothing is watching that line any more.
    expect(FakeObserver.all.filter((o) => !o.disconnected && o.targets.includes(first!))).toEqual([]);
  });

  it('one word at a time, wrapping only between reasons', () => {
    const matches = [withReasons(0, ['In your sweet spot', 'Top songs this month'])];
    const { container } = render(<Results {...resultsProps(range, matches)} />);
    const [line] = lines(container);
    // Without IntersectionObserver there is no telling when it is seen, so it shows settled.
    expect(line!.dataset.sing).toBe('settled');
    expect(line!.textContent).toBe('In\u00a0your\u00a0sweet\u00a0spot · Top\u00a0songs\u00a0this\u00a0month');
    const words = Array.from(line!.querySelectorAll<HTMLElement>('[class*="reasonWord"]'));
    expect(words.map((w) => w.textContent)).toEqual(['In', 'your', 'sweet', 'spot', '·', 'Top', 'songs', 'this', 'month']);
    expect(words.map((w) => w.style.animationDelay)).toEqual(
      ['0.00s', '0.14s', '0.28s', '0.42s', '0.56s', '0.70s', '0.84s', '0.98s', '1.12s'],
    );
  });

  it('sings again when the reasons change', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const matches = [withReasons(0, ['Played recently', 'In your sweet spot'])];
    const props = resultsProps(range, matches);
    const { container, rerender } = render(<Results {...props} />);
    const [before] = lines(container);
    FakeObserver.show(before!, 1);
    expect(before!.dataset.sing).toBe('singing');

    // Moving the difficulty slider puts the range reason first: a new line, sung in again.
    rerender(<Results {...props} leadSlider="difficulty" />);
    const [after] = lines(container);
    expect(after!.textContent!.replace(/ /g, ' ')).toBe('In your sweet spot · Played recently');
    expect(after).not.toBe(before);
    expect(after!.dataset.sing).toBe('waiting');
    FakeObserver.show(after!, 1);
    expect(after!.dataset.sing).toBe('singing');
  });
});
