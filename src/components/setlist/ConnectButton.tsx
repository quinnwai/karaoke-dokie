import { useEffect, useRef, useState } from 'react';
import { TAP_GUARD_MS } from '../../lib/client/tapGuard';
import { SpotifyIcon } from '../Icon';
import screen from '../screen.module.css';
import styles from './setlist.module.css';

/**
 * The header's "Connect to Spotify" (QWW-57, R30). With a pointer that can hover it is what it was: a tooltip on hover and on keyboard
 * focus, and a click connects. A touch screen cannot hover, so the tooltip, which is what says what the logo is, comes with a tap: the
 * first tap shows it and goes nowhere, a second tap connects, and a tap anywhere else (or Escape) hides it again.
 *
 * A second tap that comes within TAP_GUARD_MS of the one that showed the tooltip is a double tap, and is ignored: it would connect before
 * the tooltip could be read. An ignored tap puts the moment off by another one, as KaraokeApp's guard does, so a run of quick taps never
 * connects.
 *
 * A click that is not a finger (the keyboard's Enter and Space, a screen reader's activate: `detail` 0) connects at once, since its user
 * has the button's name already and no tooltip to read.
 */
export function ConnectButton({ onConnect }: { onConnect(): void }) {
  const [tip, setTip] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const quietUntil = useRef(0);

  useEffect(() => {
    if (!tip) return;
    const elsewhere = (e: Event) => {
      if (!button.current?.contains(e.target as Node)) setTip(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTip(false);
    };
    document.addEventListener('pointerdown', elsewhere, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', elsewhere, true);
      document.removeEventListener('keydown', escape);
    };
  }, [tip]);

  return (
    <button
      ref={button}
      type="button"
      className={`${screen.connect} ${styles.spotify}`}
      data-tip={tip ? 'open' : undefined}
      aria-label="Connect to Spotify"
      data-sign-right=""
      onClick={(e) => {
        const touch = typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches;
        // The tap that shows the tooltip starts the moment; a tap inside it is ignored and starts it again.
        if (touch && e.detail > 0 && (!tip || Date.now() < quietUntil.current)) {
          quietUntil.current = Date.now() + TAP_GUARD_MS;
          setTip(true);
          return;
        }
        setTip(false);
        onConnect();
      }}
    >
      <SpotifyIcon />
      <span className={screen.connectTip} aria-hidden>
        Connect to Spotify
      </span>
    </button>
  );
}
