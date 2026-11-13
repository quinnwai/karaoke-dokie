// The title fill of the song list (QWW-57, review item R12): each row's title fills in once, left to right, when its row first
// scrolls into view, and ends in its normal white. This hook decides WHICH rows have filled; the look is rows.module.css's.
//
// Three rules shape it:
//  - A row fills once per visit. A row that leaves and comes back (an era change takes it off the list and a later one puts
//    it on again; the list empties and fills; the song page opens and Back brings the list again) is drawn filled, and so is
//    every row after the list is re-ranked. The ids that have filled are kept in a memory that outlives the list (KaraokeApp's,
//    see `useFillMemory`): a visit lasts until the singer's range changes (redo) or the page is reloaded.
//  - The fill is a CSS transition, not an animation, and it is switched on by an attribute (`data-filled`) that this hook's
//    state puts on the row. React moves a row by moving its DOM node, which restarts or cancels a CSS animation, but a node
//    that is moved and inserted again already holding the attribute is simply drawn in its last state, with no transition.
//    That is what a re-rank needs.
//  - Where there is nothing to watch with (no IntersectionObserver, as in jsdom) or the singer asked for less motion, every
//    row counts as filled from the start, so the titles simply show.

import { useEffect, useReducer, useRef, useState, type MutableRefObject, type RefObject } from 'react';

/**
 * How much of a row has to be inside the list's scroller before its title fills. The title is in the top 26 px of the 66 px
 * row, so at 40% a title coming up from the bottom edge can be seen whole.
 */
export const FILL_AT = 0.4;

/** The wait between one row's fill and the next's, among rows that come into view together (the list has just loaded). */
export const FILL_STAGGER_MS = 60;

/** The stagger stops growing here, so a tall window never leaves a row waiting long. */
export const FILL_STAGGER_ROWS = 8;

/** How long the k-th row (0-based, top first) of a batch waits before its title starts to fill, ms. */
export const staggerOf = (k: number): number => Math.min(k, FILL_STAGGER_ROWS) * FILL_STAGGER_MS;

/**
 * Whether titles fill in at all: the browser can say when a row is in view, and the singer has not asked for less motion.
 * (The stylesheet also draws no fill under `prefers-reduced-motion: reduce`, so a singer who asks while the list is open
 * loses the fill at once.)
 */
const canFill = (): boolean =>
  typeof IntersectionObserver === 'function' && !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

/** The ids whose fill has started this visit, with how long each waited, ms. */
export type FillMemory = Map<string, number>;

/**
 * The memory of one visit (R12): the same Map for as long as `visit` stays the same, a new empty one when it changes. The owner
 * of the screen keeps it, so it outlives the list: the list unmounts when an era untapped leaves it empty, and the whole
 * tuner when a song page opens. `visit` is what a visit is made of, the singer's range, so a new range fills the titles again.
 */
export function useFillMemory(visit: string): FillMemory {
  const kept = useRef<{ visit: string; memory: FillMemory }>({ visit, memory: new Map() });
  if (kept.current.visit !== visit) kept.current = { visit, memory: new Map() };
  return kept.current.memory;
}

export interface TitleFill {
  /** Whether this song's title is drawn filled: its fill has started this visit, or there is no fill to wait for. */
  filled(id: string): boolean;
  /** How long this song's fill waits to start, ms (its place in the batch of rows that came into view with it); undefined when it did not wait. */
  delay(id: string): number | undefined;
}

/**
 * Watches the rows of `list` (the `<ol>`; each `[data-row]` carries `data-id` and `data-rank`) in `scroller` (the box that
 * scrolls it), and hands back which titles have filled. `order` is the ids in rank order: when it changes, the rows that have
 * not filled yet are watched again (a new song may have come on screen). `memory` is the visit's (useFillMemory); a list given
 * none keeps its own for as long as it is mounted.
 */
export function useFillIn(list: RefObject<HTMLElement | null>, scroller: RefObject<HTMLElement | null>, order: string, memory?: FillMemory): TitleFill {
  // Decided once, when the list first draws, so a list never changes its mind about whether it fills.
  const [fills] = useState(canFill);
  // The ids whose fill has started this visit, with how long each waited. Read by the observer's callback, which must see the
  // latest, and a fill that has started is never undone; `redraw` is what puts a change on screen.
  const own = useRef(new Map<string, number>());
  const started: MutableRefObject<FillMemory> = useRef(memory ?? own.current);
  started.current = memory ?? own.current;
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const ol = list.current;
    if (!fills || !ol) return;
    let live = true;
    const watch = new IntersectionObserver(
      (entries) => {
        if (!live) return;
        // Rows that have come far enough in and have not filled, top first. A row that is only touching the edge, or came in
        // a little way, is told again when it crosses FILL_AT. (The 0.02 is slack for the browser's rounding at the threshold.)
        const ready = entries
          .filter((e) => e.isIntersecting && e.intersectionRatio >= FILL_AT - 0.02)
          .map((e) => e.target as HTMLElement)
          .filter((li) => li.dataset.id !== undefined && !started.current.has(li.dataset.id));
        if (ready.length === 0) return;
        ready.sort((a, b) => Number(a.dataset.rank) - Number(b.dataset.rank));
        ready.forEach((li, k) => {
          started.current.set(li.dataset.id!, staggerOf(k));
          watch.unobserve(li);
        });
        redraw();
      },
      { root: scroller.current, threshold: FILL_AT },
    );
    for (const li of ol.querySelectorAll<HTMLElement>('[data-row]')) {
      if (li.dataset.id !== undefined && !started.current.has(li.dataset.id)) watch.observe(li);
    }
    return () => {
      live = false;
      watch.disconnect();
    };
  }, [fills, list, scroller, order]);

  return {
    filled: (id) => !fills || started.current.has(id),
    delay: (id) => started.current.get(id),
  };
}
