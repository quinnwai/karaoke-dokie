import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';
import { expandedFit, type ExpandedFit } from '../../lib/setlist/fit';

export interface SheetFit {
  /** The last measure, or null until there is a layout to measure. */
  fit: ExpandedFit | null;
  /**
   * A measure of the page as it is laid out right now, or null where there is no layout. The first sizing asks for one when the phone
   * is turned upright (the review of PR #38, a second pass): `fit` may then still be the measure of the page under the "Turn your phone
   * upright" message, taken on its side, which has no room, and the sizing must not go by that.
   */
  measure(): ExpandedFit | null;
}

/**
 * How the expanded sheet would fit this screen (QWW-57, decision 1), measured in the browser from the screen's own root:
 * the song list's height, the rack's height and how far the content runs past the bottom edge. The browser's layout is the
 * truth here (safe areas, the TV frame's padding and the phone's real height are all in it), and src/lib/setlist/fit.ts
 * turns the three numbers into answers. Measured when the screen first draws, before it is painted, and again whenever the
 * screen changes size (a phone turned on its side, Safari's bars coming and going).
 *
 * `fit` is null until there is a layout to measure: jsdom has none (every height is 0), and the answer then is "no opinion", which
 * the screen reads as "the sheet can expand and nothing opens in mini".
 */
export function useSheetFit(root: RefObject<HTMLElement | null>): SheetFit {
  const [fit, setFit] = useState<ExpandedFit | null>(null);

  const measure = useCallback((): ExpandedFit | null => {
    const el = root.current;
    const list = el?.querySelector<HTMLElement>('#list-scroll');
    const rack = el?.querySelector<HTMLElement>('#rack');
    if (!el || !list || !rack || el.clientHeight === 0) return null;
    return expandedFit({ list: list.clientHeight, rack: rack.offsetHeight, overflow: Math.max(0, el.scrollHeight - el.clientHeight) });
  }, [root]);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const update = () => {
      const next = measure();
      if (next) setFit((prev) => (prev && prev.listHeight === next.listHeight ? prev : next));
    };
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [root, measure]);

  return { fit, measure };
}
