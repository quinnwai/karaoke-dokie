import { useId, useLayoutEffect, useRef } from 'react';
import styles from './screen.module.css';

/**
 * "Turn your phone upright", over every step (rendered by Tv; QWW-57, the review of PR #38, finding 1). A phone on its side is
 * wider than 430 px, so it gets the 390 px TV at the window's height less 32 px: 328 px at 640x360, which cannot hold the tuner.
 * On a touch screen in landscape under 500 px tall this covers the page instead. The one media query that shows it is in
 * screen.module.css; anywhere else it is display: none, so it is not in the accessibility tree either.
 *
 * It is only drawn over the page, never in place of it: nothing underneath is unmounted or changed, so turning the phone back
 * finds the screen, its scroll, the tuner's gears and sheet, and a running mic step as they were. It is a modal dialog, and
 * `aria-modal` alone does not make the page under it one: Tab still reached "Start", Enter started the flow, a slider that had focus
 * kept taking the arrow keys, and the accessibility tree still held the buttons. So while it is up Tv makes the TV `inert`, and focus
 * is moved here (a dialog is where the focus goes), and back to what had it when the phone is turned upright again. `sideways` comes
 * from Tv, which asks the browser once: two components asking separately are two commits, and the focus was given back in the first
 * while the TV was still inert, which refuses it.
 */
export function RotateNotice({ sideways }: { sideways: boolean }) {
  const words = useId();
  const box = useRef<HTMLDivElement>(null);
  const had = useRef<HTMLElement | null>(null);
  // Both ways are in the effect's body, not in a cleanup: React puts back the focus a commit started with after its own changes,
  // and a cleanup runs before that, so a focus given back there is taken away again.
  useLayoutEffect(() => {
    if (sideways) {
      // What has focus now, if anything does: it is about to become inert, which takes the focus away.
      const now = document.activeElement;
      had.current = now instanceof HTMLElement && now !== document.body ? now : null;
      box.current?.focus({ preventScroll: true });
      return;
    }
    // Turned upright: the focus goes back to what had it, unless the singer has put it somewhere else since, or that has gone. A page
    // can need a frame to be as it was (the mini sheet hid the strips it had no room for while the phone was on its side, and shows
    // them again once it is measured), and an element that is not shown cannot take focus, so it tries on the next few frames too.
    const before = had.current;
    had.current = null;
    let frames = 0;
    let frame = 0;
    const giveBack = () => {
      const now = document.activeElement;
      const free = now === null || now === document.body || now === box.current;
      if (!before?.isConnected || !free) {
        // Nothing to give it back to: the message is about to be hidden, and a hidden element does not keep the focus (a browser takes it, soon).
        if (now === box.current) box.current?.blur();
        return;
      }
      before.focus({ preventScroll: true });
      if (document.activeElement !== before && ++frames < 5) frame = requestAnimationFrame(giveBack);
      else if (document.activeElement === box.current) box.current?.blur();
    };
    giveBack();
    return () => cancelAnimationFrame(frame);
  }, [sideways]);
  return (
    <div ref={box} className={styles.rotateNotice} role="dialog" aria-modal="true" aria-labelledby={words} tabIndex={-1}>
      <svg viewBox="0 0 64 64" width="56" height="56" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={styles.rotateIcon}>
        {/* An upright phone, and the turn that brings it there. */}
        <rect x="22" y="6" width="20" height="38" rx="4" />
        <path d="M29 38h6" />
        <path d="M10 40a22 22 0 0 0 44 0M48 46l6-6 6 6" className={styles.rotateArrow} />
      </svg>
      <p id={words} className={styles.rotateWords}>
        Turn your phone upright
      </p>
    </div>
  );
}
