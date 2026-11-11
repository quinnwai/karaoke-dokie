import type { ReactNode } from 'react';
import { RotateNotice } from './RotateNotice';
import styles from './screen.module.css';

/** The one object on the page: a karaoke TV. Every step happens on its screen. */
export function Tv({ children }: { children: ReactNode }) {
  return (
    <main className={styles.stage}>
      <section className={styles.tv} aria-label="Karaoke screen">
        <div className={styles.screen}>
          <div className={styles.screenInner}>{children}</div>
        </div>
        <div className={styles.chin} aria-hidden>
          <span className={styles.chinLabel}>karaoke-dokie</span>
          <span className={styles.led} />
        </div>
      </section>
      {/* Beside the TV, not around it: it covers the page on a phone on its side and leaves the TV's tree as it was. */}
      <RotateNotice />
    </main>
  );
}
