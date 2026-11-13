// FLIP for the song list: rows are in rank order in the DOM (so a screen reader reads rank order, spec §8), and
// when the order changes each row that moved slides from where it was to where it is now. Rows come to rest by
// browser layout; this only plays the motion.
//
//   First: where each row was seen (its layout top, plus the part of a slide still to go)
//   Last: where it is now
//   Invert + Play: an animation from the difference back to nothing
//
// A slider drag re-ranks the list again and again, so a slide is often interrupted by the next one. React moves a row
// by moving its DOM node, and a node that is moved loses the animation running on it, so the browser cannot be asked
// where an interrupted row is. Each row's slide is therefore remembered here (where it began, and when), and how much
// of it is left is worked out from that, with the same curve the animation uses.

import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Extra px above and below the visible part of the list that still animate. */
const MARGIN_PX = 116;

/** How long a slide takes, ms (spec §5: rows animate `top 280ms ease`). */
export const SLIDE_MS = 280;

/** One coordinate of CSS's cubic Bézier at parameter `t`, with control values `a` and `b` (the end points are 0 and 1). */
const bezier = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;

/** How far a slide has come, 0 to 1, after a share `p` (0 to 1) of its time, in CSS's `ease`: cubic-bezier(.25, .1, .25, 1). */
export function easeProgress(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (bezier(mid, 0.25, 0.25) < p) lo = mid;
    else hi = mid;
  }
  return bezier((lo + hi) / 2, 0.1, 1);
}

/** What is left of a slide that began `elapsedMs` ago from an offset of `from` px. */
export const slideOffset = (from: number, elapsedMs: number): number => from * (1 - easeProgress(elapsedMs / SLIDE_MS));

interface Slide {
  /** The offset the slide began from, px: where the row was seen minus where it is laid out. */
  from: number;
  /** When it began, in `performance.now()` ms. */
  start: number;
  animation: Animation;
}

/**
 * Animates the rows of `list` after `order` (the ids in rank order) changed. `scroller` is the box that scrolls the
 * list: only rows that are, or were, in or near view animate, so a long list stays cheap. Does nothing when the
 * singer prefers reduced motion, or where elements cannot be animated.
 */
export function useFlip(list: RefObject<HTMLElement | null>, scroller: RefObject<HTMLElement | null>, order: string): void {
  const before = useRef<Map<string, number> | null>(null);
  const slides = useRef(new Map<string, Slide>());

  useLayoutEffect(() => {
    const ol = list.current;
    if (!ol) return;
    const rows = Array.from(ol.children).filter((c): c is HTMLElement => c instanceof HTMLElement && c.dataset.id !== undefined);
    const tops = new Map<string, number>();
    for (const el of rows) tops.set(el.dataset.id!, el.offsetTop);

    const prev = before.current;
    before.current = tops;
    const running = slides.current;
    for (const [id, slide] of running) {
      if (!tops.has(id)) {
        slide.animation.cancel();
        running.delete(id);
      }
    }
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The first list for this screen (or the first after an empty one), motion switched off, or nothing to animate with:
    // nothing to slide from.
    if (!prev || prev.size === 0 || reduced || !rows.length || typeof rows[0]!.animate !== 'function') {
      for (const slide of running.values()) slide.animation.cancel();
      running.clear();
      return;
    }

    const view = scroller.current;
    const from = (view?.scrollTop ?? 0) - MARGIN_PX;
    const to = (view?.scrollTop ?? 0) + (view?.clientHeight ?? Infinity) + MARGIN_PX;
    const near = (top: number) => top >= from && top <= to;
    const now = performance.now();

    for (const el of rows) {
      const id = el.dataset.id!;
      const was = prev.get(id);
      const laidOut = tops.get(id)!;
      if (was === undefined) {
        // A song that was not in the list before: fade in where it stands.
        if (near(laidOut)) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease' });
        continue;
      }
      // Where it looked to be: its old place, plus the part of a slide it was still in the middle of.
      const slide = running.get(id);
      const seen = was + (slide ? slideOffset(slide.from, now - slide.start) : 0);
      slide?.animation.cancel();
      running.delete(id);
      const offset = seen - laidOut;
      if (Math.abs(offset) < 1 || (!near(seen) && !near(laidOut))) continue;
      const animation = el.animate([{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }], { duration: SLIDE_MS, easing: 'ease' });
      running.set(id, { from: offset, start: now, animation });
      animation.onfinish = () => {
        if (running.get(id)?.animation === animation) running.delete(id);
      };
    }
  }, [list, scroller, order]);
}
