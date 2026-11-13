import { useEffect, useId, useRef, useState } from 'react';
import { SpotifyIcon } from './Icon';
import styles from './screen.module.css';

/**
 * The Spotify logo of a singer who is signed in: green, with a small box that says who and offers
 * Log out. A mouse pointing at the logo shows the box (CSS, only where a pointer can hover); a tap
 * on it, or Enter, opens and closes it, and a tap elsewhere or Escape closes it. Logging out is one
 * more tap on purpose, so a stray tap on the logo cannot end the session.
 */
export function SpotifyAccount({ name, onLogout }: { name: string | null; onLogout(): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<'idle' | 'working' | 'failed'>('idle');
  const root = useRef<HTMLDivElement>(null);
  const logo = useRef<HTMLButtonElement>(null);
  const boxId = useId();

  useEffect(() => {
    if (!open) return;
    const tapAway = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      logo.current?.focus();
    };
    document.addEventListener('pointerdown', tapAway);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', tapAway);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const logOut = async () => {
    setStatus('working');
    try {
      await onLogout();
      // Done: the screen switches to the signed-out view and this box goes with it.
    } catch {
      setStatus('failed');
    }
  };

  return (
    <div ref={root} className={styles.account} data-open={open || undefined}>
      <button
        ref={logo}
        type="button"
        className={`${styles.connect} ${styles.connectOn}`}
        aria-label="Spotify account"
        aria-expanded={open}
        aria-controls={boxId}
        onClick={() => setOpen((o) => !o)}
      >
        <SpotifyIcon />
      </button>
      <div id={boxId} className={styles.accountMenu}>
        <div className={styles.accountBox}>
          <span className={styles.accountName}>{name ? `Logged in as ${name}` : 'Logged in'}</span>
          <span aria-hidden>·</span>
          <button type="button" className={styles.logout} disabled={status === 'working'} onClick={() => void logOut()}>
            Log out
          </button>
          {status === 'failed' && (
            <p className={styles.accountError} role="alert">
              Couldn’t log out. Try again.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
