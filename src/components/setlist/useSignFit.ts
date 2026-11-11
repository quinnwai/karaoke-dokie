import { useLayoutEffect, type RefObject } from 'react';
import { SIGN_MAX_SIZE, signSize } from '../../lib/setlist/fit';

/**
 * Sizes the カラオケ sign to the room it has, and hides it only when there is none (QWW-57, R1): it is centred on the header's own
 * middle, so on a narrow phone or with a long range redo (or the Spotify button) comes close. It shrinks from 16 px down to 13 px
 * to keep 8 px clear of both (`signSize`), and goes (`data-hidden`) only when even 13 px does not fit. The header row is `bar`; the
 * sign, redo (the last thing on the left) and the Spotify button (the first thing on the right) are found by their `data-sign`,
 * `data-sign-left` and `data-sign-right` hooks. The sign is hidden with `data-hidden` (CSS `visibility`), not removed, so it keeps
 * its box and is measured the same whether it shows or not.
 *
 * Every measure puts the sign back to 16 px first and measures it there, so its width does not depend on the size it was given last:
 * the answer cannot flip-flop, a sign that comes back is sized from scratch, and a hidden one is left at 16 px, not at a stale small size.
 *
 * Measured before the first paint, and again when anything in the row changes size: the window, the range's note names, the
 * fonts arriving (the sign's glyphs and Inter both change widths when they load). The sign itself is not watched for size: the size
 * is this hook's own doing, and its glyphs arriving is the fonts' event. Where there is no layout (jsdom) it does nothing.
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
      sign.style.fontSize = `${SIGN_MAX_SIZE}px`;
      const row = el.getBoundingClientRect();
      const size = signSize(sign.getBoundingClientRect(), row.left + row.width / 2, left.getBoundingClientRect().right, right.getBoundingClientRect().left);
      // Floored to a tenth of a px: text is laid out in 1/64 px, so a size solved to exactly 8 px could land a hair under it.
      if (size !== null) sign.style.fontSize = `${Math.floor(size * 10) / 10}px`;
      sign.toggleAttribute('data-hidden', size === null);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (observer) for (const node of [el, ...el.querySelectorAll('[data-sign-left], [data-sign-right]')]) observer.observe(node);
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
