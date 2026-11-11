import { useLayoutEffect, type RefObject } from 'react';
import { signFits } from '../../lib/setlist/fit';

/**
 * Hides the カラオケ sign when it would come within 8 px of redo or the Spotify button (QWW-57, R1): the sign is centred on
 * the header's own middle, so on a narrow phone with a long range it can run into redo. The header row is `bar`; the sign, redo
 * (the last thing on the left) and the Spotify button (the first thing on the right) are found by their `data-sign`,
 * `data-sign-left` and `data-sign-right` hooks. The sign is hidden with `data-hidden` (CSS `visibility`), not removed, so
 * it keeps its box and is measured the same whether it shows or not.
 *
 * Measured before the first paint, and again when anything in the row changes size: the window, the range's note names, the
 * fonts arriving (the sign's glyphs and Inter both change widths when they load). Where there is no layout (jsdom) it does nothing.
 */
export function useSignFit(bar: RefObject<HTMLElement | null>, ...watch: unknown[]): void {
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const measure = () => {
      const sign = el.querySelector<HTMLElement>('[data-sign]');
      const left = el.querySelector<HTMLElement>('[data-sign-left]');
      const right = el.querySelector<HTMLElement>('[data-sign-right]');
      if (!sign || !left || !right || el.clientWidth === 0) return;
      const fits = signFits(sign.getBoundingClientRect(), left.getBoundingClientRect().right, right.getBoundingClientRect().left);
      if (sign.hasAttribute('data-hidden') === fits) sign.toggleAttribute('data-hidden', !fits);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (observer) for (const node of [el, ...el.querySelectorAll('[data-sign], [data-sign-left], [data-sign-right]')]) observer.observe(node);
    else window.addEventListener('resize', measure);
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    fonts?.addEventListener?.('loadingdone', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      fonts?.removeEventListener?.('loadingdone', measure);
    };
  }, [bar, ...watch]);
}
