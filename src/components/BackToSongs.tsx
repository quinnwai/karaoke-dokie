import styles from './screen.module.css';

/**
 * "Back to songs" on the mic and note steps of a redo (QWW-57), for a singer who already has a range: it leaves the test and brings
 * the list back with the old range and the tuning as they were. Top left, where the song page's ‹ is. It comes just before the
 * step's own box, which makes room for it (`.backToSongs + .mic`, and the like, in screen.module.css).
 */
export function BackToSongs({ onBack }: { onBack(): void }) {
  return (
    <button type="button" className={styles.backToSongs} onClick={onBack}>
      <span aria-hidden>‹</span>
      Back to songs
    </button>
  );
}
