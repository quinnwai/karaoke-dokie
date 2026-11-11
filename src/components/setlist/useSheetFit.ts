import { useLayoutEffect, useState, type RefObject } from 'react';
import { expandedFit, type ExpandedFit } from '../../lib/setlist/fit';

/**
 * How the expanded sheet would fit this screen (QWW-57, decision 1), measured in the browser from the screen's own root:
 * the song list's height, the rack's height and how far the content runs past the bottom edge. The browser's layout is the
 * truth here (safe areas, the TV frame's padding and the phone's real height are all in it), and src/lib/setlist/fit.ts
 * turns the three numbers into answers. Measured when the screen first draws, before it is painted, and again whenever the
 * screen changes size (a phone turned on its side, Safari's bars coming and going).
 *
 * null until there is a layout to measure: jsdom has none (every height is 0), and the answer then is "no opinion", which
 * the screen reads as "the sheet can expand and nothing opens in mini".
 */
export function useSheetFit(root: RefObject<HTMLElement | null>): ExpandedFit | null {
  const [fit, setFit] = useState<ExpandedFit | null>(null);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => {
      const list = el.querySelector<HTMLElement>('#list-scroll');
      const rack = el.querySelector<HTMLElement>('#rack');
      if (!list || !rack || el.clientHeight === 0) return;
      const next = expandedFit({ list: list.clientHeight, rack: rack.offsetHeight, overflow: Math.max(0, el.scrollHeight - el.clientHeight) });
      setFit((prev) => (prev && prev.listHeight === next.listHeight ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [root]);

  return fit;
}
