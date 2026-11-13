// @vitest-environment jsdom
// What useFlip does when the list is re-ranked while rows are still sliding (src/components/setlist/flip.ts), against a
// fake layout and a fake clock, so the numbers are exact. jsdom has no layout: each row's `offsetTop` is read from its
// data-top, the scroller is tall, and Element.animate is a recorder. A row that React moves loses the animation the
// browser was running (checked in a browser by tests/e2e/setlist.spec.ts), so what a row's next slide starts from has
// to come from what the hook remembers, with the same curve: that is what is checked here.

import { cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLIDE_MS, slideOffset, useFlip } from '../../src/components/setlist/flip';

interface Call {
  id: string;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  cancel: ReturnType<typeof vi.fn>;
}

let calls: Call[];
let now: number;
let proto: HTMLElement;

function List({ ids, tops }: { ids: string[]; tops: Record<string, number> }) {
  const list = useRef<HTMLOListElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useFlip(list, scroller, ids.join('\n'));
  return (
    <div ref={scroller}>
      <ol ref={list}>
        {ids.map((id) => (
          <li key={id} data-id={id} data-top={tops[id]} />
        ))}
      </ol>
    </div>
  );
}

/** The `translateY` of the first keyframe of an animation, in px. */
const startOf = (c: Call): number => Number(String(c.keyframes[0]!.transform).match(/translateY\((-?[\d.]+)px\)/)![1]);
const slidesOf = (id: string) => calls.filter((c) => c.id === id && c.keyframes[0]?.transform !== undefined);
const last = (id: string) => slidesOf(id).at(-1)!;

beforeEach(() => {
  calls = [];
  now = 1000;
  proto = HTMLElement.prototype;
  Object.defineProperty(proto, 'offsetTop', { configurable: true, get: function (this: HTMLElement) { return Number(this.getAttribute('data-top') ?? 0); } });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 2000 });
  Object.defineProperty(proto, 'animate', {
    configurable: true,
    writable: true,
    value: function (this: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const cancel = vi.fn();
      calls.push({ id: this.dataset.id ?? '?', keyframes, options, cancel });
      return { cancel, onfinish: null };
    },
  });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (proto as unknown as { animate?: unknown }).animate;
  delete (proto as unknown as { offsetTop?: unknown }).offsetTop;
  delete (proto as unknown as { clientHeight?: unknown }).clientHeight;
  vi.unstubAllGlobals();
});

const A_B_C = { a: 0, b: 58, c: 116 };

describe('a first re-rank', () => {
  it('draws the first list without a slide', () => {
    render(<List ids={['a', 'b', 'c']} tops={A_B_C} />);
    expect(calls).toHaveLength(0);
  });

  it('slides each row that moved from where it was to where it is, over 280 ms of ease', () => {
    const { rerender } = render(<List ids={['a', 'b', 'c']} tops={A_B_C} />);
    rerender(<List ids={['c', 'a', 'b']} tops={{ c: 0, a: 58, b: 116 }} />);
    expect(startOf(last('a'))).toBe(-58); // was at 0, is at 58: starts 58 px above where it is
    expect(startOf(last('b'))).toBe(-58);
    expect(startOf(last('c'))).toBe(116);
    for (const id of ['a', 'b', 'c']) {
      expect(last(id).keyframes[1]).toEqual({ transform: 'translateY(0)' });
      expect(last(id).options).toMatchObject({ duration: SLIDE_MS, easing: 'ease' });
    }
  });

  it('leaves alone a row that stayed where it was', () => {
    const { rerender } = render(<List ids={['a', 'b', 'c']} tops={A_B_C} />);
    rerender(<List ids={['a', 'c', 'b']} tops={{ a: 0, c: 58, b: 116 }} />);
    expect(slidesOf('a')).toHaveLength(0);
    expect(slidesOf('b')).toHaveLength(1);
    expect(slidesOf('c')).toHaveLength(1);
  });
});

describe('a re-rank in the middle of a slide', () => {
  function interrupted(elapsed: number) {
    const view = render(<List ids={['a', 'b', 'c']} tops={A_B_C} />);
    now = 1000;
    view.rerender(<List ids={['c', 'a', 'b']} tops={{ c: 0, a: 58, b: 116 }} />);
    const first = { a: last('a'), b: last('b'), c: last('c') };
    now = 1000 + elapsed;
    view.rerender(<List ids={['b', 'c', 'a']} tops={{ b: 0, c: 58, a: 116 }} />);
    return first;
  }

  it('starts the next slide from where the row was seen: its old place plus what was left of its slide', () => {
    interrupted(100);
    // c was laid out at 0, and had 116 px to slide from at 1000: 100 ms later it is seen at 0 + what is left of that.
    const seenC = 0 + slideOffset(116, 100);
    expect(startOf(last('c'))).toBeCloseTo(seenC - 58, 9); // now laid out at 58
    const seenA = 58 + slideOffset(-58, 100);
    expect(startOf(last('a'))).toBeCloseTo(seenA - 116, 9);
    const seenB = 116 + slideOffset(-58, 100);
    expect(startOf(last('b'))).toBeCloseTo(seenB - 0, 9);
  });

  it('is not where it would start if the slide in flight were forgotten (the row would jump back and slide on from there)', () => {
    interrupted(100);
    const forgotten = 0 - 58; // c from its old layout place alone
    expect(Math.abs(startOf(last('c')) - forgotten)).toBeGreaterThan(20);
  });

  it('cancels the slide it replaces', () => {
    const first = interrupted(100);
    for (const id of ['a', 'b', 'c'] as const) expect(first[id].cancel).toHaveBeenCalledTimes(1);
  });

  it('carries on from where it was seen however long ago it began, and is a plain move once the slide is over', () => {
    interrupted(SLIDE_MS + 50);
    // Nothing left of the first slide: each row starts from its old layout place, as in the first re-rank.
    expect(startOf(last('c'))).toBeCloseTo(0 - 58, 9);
    expect(startOf(last('a'))).toBeCloseTo(58 - 116, 9);
    expect(startOf(last('b'))).toBeCloseTo(116 - 0, 9);
  });

  it('keeps the direction of a slide that is going the other way', () => {
    interrupted(60);
    // b was sliding up (from -58, toward 0 from above) and now has to go to the top: still above where it is laid out.
    expect(startOf(last('b'))).toBeGreaterThan(0);
  });
});

describe('rows that leave, and motion switched off', () => {
  it('cancels the slide of a row that left the list', () => {
    const { rerender } = render(<List ids={['a', 'b', 'c']} tops={A_B_C} />);
    rerender(<List ids={['c', 'a', 'b']} tops={{ c: 0, a: 58, b: 116 }} />);
    const slideOfB = last('b');
    rerender(<List ids={['c', 'a']} tops={{ c: 0, a: 58 }} />);
    expect(slideOfB.cancel).toHaveBeenCalledTimes(1);
  });

  it('plays nothing, and cancels what runs, when the singer prefers reduced motion', () => {
    const { rerender } = render(<List ids={['a', 'b', 'c']} tops={A_B_C} />);
    rerender(<List ids={['c', 'a', 'b']} tops={{ c: 0, a: 58, b: 116 }} />);
    const running = [last('a'), last('b'), last('c')];
    const before = calls.length;
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }));
    rerender(<List ids={['b', 'c', 'a']} tops={{ b: 0, c: 58, a: 116 }} />);
    expect(calls).toHaveLength(before);
    for (const slide of running) expect(slide.cancel).toHaveBeenCalled();
  });

  it('fades in a song that was not in the list, and slides nothing for it', () => {
    const { rerender } = render(<List ids={['a', 'b']} tops={{ a: 0, b: 58 }} />);
    rerender(<List ids={['a', 'x', 'b']} tops={{ a: 0, x: 58, b: 116 }} />);
    const fade = calls.find((c) => c.id === 'x')!;
    expect(fade.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(slidesOf('x')).toHaveLength(0);
  });
});
