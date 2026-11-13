import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { CreditsContent } from './CreditsContent';
import styles from './CreditsPanel.module.css';

/**
 * Sources and credits, inside the TV's screen (QWW-57, R28): the link in the chin opens it, over whatever step is on the screen, on the
 * same page (no new tab, and the address does not change). It is drawn over that step as the landscape message is drawn over the page,
 * never in place of it, so the step is not unmounted and is as it was when this closes. Tv makes the step inert while this is up and
 * gives the focus back to the link when it goes; this takes the focus in when it comes up, as a dialog does, and closes on Escape.
 *
 * The box itself is what scrolls (the heading and the ✕ stay at its top), so the focus on it is enough for the arrow keys to scroll
 * the text: no extra tab stop for the scroller.
 */
export function CreditsPanel({ onClose }: { onClose(): void }) {
  const heading = useId();
  const box = useRef<HTMLDivElement>(null);

  // The box takes the focus (tabIndex -1, so a script can), and a screen reader reads out its name. It is not a control: no ring.
  useLayoutEffect(() => {
    box.current?.focus({ preventScroll: true });
  }, []);

  // On the document, not the box: a tap on the page around the TV moves the focus off the box, and Escape should still close it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div ref={box} className={styles.panel} role="dialog" aria-modal="true" aria-labelledby={heading} tabIndex={-1}>
      <div className={styles.head}>
        <h2 id={heading} className={styles.title}>
          Sources and credits
        </h2>
        <button type="button" className={styles.close} aria-label="Close sources and credits" onClick={onClose}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
            <path d="M6 6L18 18M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div className={styles.body}>
        <CreditsContent />
      </div>
    </div>
  );
}
