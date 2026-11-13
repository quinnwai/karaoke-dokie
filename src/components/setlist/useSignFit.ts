import { useLayoutEffect, type RefObject } from 'react';
import { SIGN_MAX_SIZE, settleSignSize, signFits, signSize } from '../../lib/setlist/fit';

/**
 * Sizes the カラオケ sign to the room it has, and hides it only when there is none (QWW-57, R1): it is centred on the header's own
 * middle, so on a narrow phone or with a long range redo (or the Spotify button) comes close. It shrinks from 16 px down to 13 px
 * to keep 8 px clear of both, and goes (`data-hidden`) only when even 13 px does not fit. The header row is `bar`; the sign, redo
 * (the last thing on the left) and the Spotify button (the first thing on the right) are found by their `data-sign`,
 * `data-sign-left` and `data-sign-right` hooks. The sign is hidden with `data-hidden` (CSS `visibility`), not removed, so it keeps
 * its box and is measured the same whether it shows or not.
 *
 * Every measure puts the sign back to 16 px first and reads it there, so its width does not depend on the size it was given last:
 * the answer cannot flip-flop, a sign that comes back is sized from scratch, and a hidden one is left at 16 px, not at a stale small
 * size. That width gives a first guess (`signSize`), which holds if the width is proportional to the size. A font with hinted
 * advances (Linux) is not exactly, so the guess is applied and the sign's box is read again: if it is within 8 px of redo or of the
 * Spotify button it steps down (`settleSignSize`) until what is laid out keeps the gap, usually in zero or one step.
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
      // Redo and the Spotify button are not moved by the sign (it is out of the row's flow), so they are read once.
      const redoRight = left.getBoundingClientRect().right;
      const spotifyLeft = right.getBoundingClientRect().left;
      const guess = signSize(sign.getBoundingClientRect(), row.left + row.width / 2, redoRight, spotifyLeft);
      const size = settleSignSize(guess, (candidate) => {
        sign.style.fontSize = `${candidate}px`;
        return signFits(sign.getBoundingClientRect(), redoRight, spotifyLeft);
      });
      if (size === null) sign.style.fontSize = `${SIGN_MAX_SIZE}px`;
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
