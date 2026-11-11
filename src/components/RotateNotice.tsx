import { useId } from 'react';
import styles from './screen.module.css';

/**
 * "Turn your phone upright", over every step (rendered by Tv; QWW-57, the review of PR #38, finding 1). A phone on its side is
 * wider than 430 px, so it gets the 390 px TV at the window's height less 32 px: 328 px at 640x360, which cannot hold the tuner.
 * On a touch screen in landscape under 500 px tall this covers the page instead. The one media query that shows it is in
 * screen.module.css; anywhere else it is display: none, so it is not in the accessibility tree either.
 *
 * It is only drawn over the page, never in place of it: nothing underneath is unmounted or changed, so turning the phone back
 * finds the screen, its scroll, the tuner's gears and sheet, and a running mic step as they were. It is a modal dialog so that a
 * screen reader does not read what it covers.
 */
export function RotateNotice() {
  const words = useId();
  return (
    <div className={styles.rotateNotice} role="dialog" aria-modal="true" aria-labelledby={words}>
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
