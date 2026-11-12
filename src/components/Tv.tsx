import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useSideways } from '../lib/client/useSideways';
import { CreditsPanel } from './CreditsPanel';
import credits from './CreditsPanel.module.css';
import { BookIcon } from './Icon';
import { RotateNotice } from './RotateNotice';
import styles from './screen.module.css';

/**
 * How long what was under the credits panel stays out of reach after the panel closes. It is KaraokeApp's TAP_GUARD_MS (a test holds the
 * two together; KaraokeApp imports this file, so it cannot be imported from there). A double tap on the panel's ✕ puts its second tap on
 * the screen the first one brought back, and the ✕ is over the tuner's top right corner, where the Spotify button is.
 */
export const CREDITS_GUARD_MS = 400;

/**
 * The one object on the page: a karaoke TV. Every step happens on its screen. While a phone is on its side and the message is up
 * the TV is `inert`: nothing in it takes focus, a key or a tap, and the accessibility tree does not hold it. It is the same tree
 * as ever, so turning the phone back finds it as it was.
 *
 * The link in the chin's bottom left opens Sources and credits in a panel inside the screen (QWW-57, R28), on every step. The panel is
 * drawn over the step, never in place of it: the step is not unmounted, so its state, its scroll and a running microphone are as they
 * were when the panel closes. While the panel is up everything else in the TV is inert (as under the landscape message), the focus
 * is in the panel, and on close it goes back to the link. Opening it is not a history entry: the address does not change, and the
 * browser's Back is the browser's own.
 */
export function Tv({ children }: { children: ReactNode }) {
  const sideways = useSideways();
  const [creditsOpen, setCreditsOpen] = useState(false);
  // For a moment after the panel closes, the step stays inert too (CREDITS_GUARD_MS).
  const [settling, setSettling] = useState(false);
  const link = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  const openCredits = () => {
    setSettling(false);
    setCreditsOpen(true);
  };
  const closeCredits = useCallback(() => {
    setCreditsOpen(false);
    setSettling(true);
  }, []);

  // The focus goes back to the link once the commit that closed the panel has made the chin usable again: it was inert while the panel
  // was up, and an inert element refuses the focus. It is in the effect's body, not in a cleanup, for the reason RotateNotice's is.
  useLayoutEffect(() => {
    if (creditsOpen) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    // The panel had the focus and is gone, so it is on the page's body: take it only from there, not from where the singer put it since.
    const now = document.activeElement;
    if (now === null || now === document.body) link.current?.focus({ preventScroll: true });
  }, [creditsOpen]);

  useEffect(() => {
    if (!settling) return;
    const timer = window.setTimeout(() => setSettling(false), CREDITS_GUARD_MS);
    return () => window.clearTimeout(timer);
  }, [settling]);

  return (
    <main className={styles.stage}>
      <section className={styles.tv} aria-label="Karaoke screen" inert={sideways}>
        <div className={styles.screen}>
          <div className={styles.screenInner} inert={creditsOpen || settling}>
            {children}
          </div>
          {creditsOpen && <CreditsPanel onClose={closeCredits} />}
        </div>
        <div className={styles.chin} inert={creditsOpen}>
          <button
            ref={link}
            type="button"
            className={credits.link}
            aria-label="Sources and credits"
            title="Sources and credits"
            aria-haspopup="dialog"
            aria-expanded={creditsOpen}
            onClick={openCredits}
          >
            <BookIcon />
          </button>
          <span className={styles.chinLabel} aria-hidden>
            karaoke-dokie
          </span>
          <span className={styles.led} aria-hidden />
        </div>
      </section>
      {/* Beside the TV, not around it: it covers the page on a phone on its side and leaves the TV's tree as it was. */}
      <RotateNotice sideways={sideways} />
    </main>
  );
}
