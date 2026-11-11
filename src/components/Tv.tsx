import type { ReactNode } from 'react';
import { useSideways } from '../lib/client/useSideways';
import { RotateNotice } from './RotateNotice';
import styles from './screen.module.css';

/**
 * The one object on the page: a karaoke TV. Every step happens on its screen. While a phone is on its side and the message is up
 * the TV is `inert`: nothing in it takes focus, a key or a tap, and the accessibility tree does not hold it. It is the same tree
 * as ever, so turning the phone back finds it as it was.
 */
export function Tv({ children }: { children: ReactNode }) {
  const sideways = useSideways();
  return (
    <main className={styles.stage}>
      <section className={styles.tv} aria-label="Karaoke screen" inert={sideways}>
        <div className={styles.screen}>
          <div className={styles.screenInner}>{children}</div>
        </div>
        <div className={styles.chin} aria-hidden>
          <span className={styles.chinLabel}>karaoke-dokie</span>
          <span className={styles.led} />
        </div>
      </section>
      {/* Beside the TV, not around it: it covers the page on a phone on its side and leaves the TV's tree as it was. */}
      <RotateNotice sideways={sideways} />
    </main>
  );
}
