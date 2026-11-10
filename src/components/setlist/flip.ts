// FLIP for the song list: rows are in rank order in the DOM (so a screen reader reads rank order, spec §8), and
// when the order changes each row that moved slides from where it was to where it is now. Rows come to rest by
// browser layout; this only plays the motion.
//
//   First: where each row was (its layout top, plus any slide still in flight)
//   Last: where it is now
//   Invert: put it back with a transform
//   Play: let the CSS transition take the transform off

import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Extra px above and below the visible part of the list that still animate. */
const MARGIN_PX = 116;

/** The row's current vertical offset from a transform, in px (0 when none). */
function currentOffset(el: HTMLElement): number {
  const t = getComputedStyle(el).transform;
  if (!t || t === 'none') return 0;
  try {
    return new DOMMatrixReadOnly(t).m42;
  } catch {
    return 0;
  }
}

/**
 * Animates the rows of `list` after `order` (the ids in rank order) changed. `scroller` is the box that scrolls the
 * list: only rows that are, or were, in or near view animate, so a long list stays cheap. Does nothing when the
 * singer prefers reduced motion.
 */
export function useFlip(list: RefObject<HTMLElement | null>, scroller: RefObject<HTMLElement | null>, order: string): void {
  const before = useRef<Map<string, number> | null>(null);

  useLayoutEffect(() => {
    const ol = list.current;
    if (!ol) return;
    const rows = Array.from(ol.children).filter((c): c is HTMLElement => c instanceof HTMLElement && c.dataset.id !== undefined);
    const tops = new Map<string, number>();
    for (const el of rows) tops.set(el.dataset.id!, el.offsetTop);

    const prev = before.current;
    before.current = tops;
    // The first list for this screen (or the first after an empty one), or motion switched off: nothing to slide from.
    if (!prev || prev.size === 0 || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;

    const view = scroller.current;
    const from = (view?.scrollTop ?? 0) - MARGIN_PX;
    const to = (view?.scrollTop ?? 0) + (view?.clientHeight ?? Infinity) + MARGIN_PX;
    const near = (top: number) => top >= from && top <= to;

    const moved: HTMLElement[] = [];
    for (const el of rows) {
      const id = el.dataset.id!;
      const was = prev.get(id);
      const now = tops.get(id)!;
      if (was === undefined) {
        // A song that was not in the list before: fade in where it stands.
        if (near(now) && typeof el.animate === 'function') el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease' });
        continue;
      }
      // Where it looked to be: its old place, plus the slide it was still in the middle of.
      const seen = was + currentOffset(el);
      if (Math.abs(seen - now) < 1 || (!near(seen) && !near(now))) {
        el.style.transform = '';
        continue;
      }
      el.style.transition = 'none';
      el.style.transform = `translateY(${seen - now}px)`;
      moved.push(el);
    }
    if (!moved.length) return;
    // Make the browser take the inverted position as the start, then let the row's own transition run.
    void ol.offsetHeight;
    for (const el of moved) {
      el.style.transition = '';
      el.style.transform = '';
    }
  }, [list, scroller, order]);
}
