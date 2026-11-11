import { useRef, type ReactNode, type RefObject } from 'react';
import type { Match } from '../../lib/contracts';
import type { SetlistRow } from '../../lib/setlist/rows';
import { useFlip } from './flip';
import styles from './setlist.module.css';

interface SongRowsProps {
  /** The rows to show, best first. The DOM follows this order. */
  rows: SetlistRow[];
  /** The box that scrolls the list, so only rows in view animate. */
  scroller: RefObject<HTMLElement | null>;
  /** `position` is the song's 1-based place in the list on screen. */
  onOpen(trackId: string, position: number): void;
  /**
   * The ▶ at the start of each row, where the rank number was (Round 6A, decision 3). QWW-48 owns playback and mounts its
   * button here; it sits beside the row's own button, never inside it, so a tap on ▶ cannot also open the song page. Without
   * it the slot shows an inert ▶.
   */
  renderPlay?(match: Match): ReactNode;
}

/**
 * The ranked list (Round 6A §4). A row is 66 px: the ▶ slot (44 px), the text (title over "Artist · Era" over the reason
 * line) and the difficulty badge, 10 px apart. There is no rank number on screen: the list is an `<ol>`, so a screen reader
 * still hears each position, and a row keeps its place in `data-rank`. Rows stand in rank order, and slide into place when
 * it changes (useFlip). Tapping a row opens the song page.
 */
export function SongRows({ rows, scroller, onOpen, renderPlay }: SongRowsProps) {
  const list = useRef<HTMLOListElement>(null);
  useFlip(list, scroller, rows.map((r) => r.id).join('\n'));

  return (
    <ol ref={list} id="list" className={styles.list} role="list" aria-label="Ranked songs">
      {rows.map((row, i) => (
        <li key={row.id} className={styles.row} data-row="" data-id={row.id} data-rank={i + 1}>
          <span className={styles.playSlot} data-play-slot="">
            {renderPlay ? renderPlay(row.match) : <PlayPlaceholder />}
          </span>
          <button type="button" className={styles.rowOpen} onClick={() => onOpen(row.id, i + 1)} aria-label={row.label} aria-describedby={`why-${row.id}`}>
            <span className={styles.rowText} data-row-text="">
              {/* The karaoke lyric wipe on the #1 title: a pink copy laid over the title and revealed left to right. It is drawn by
                  CSS from `data-wipe` (the ::after of this box), not as a second piece of text: the title is read, found and
                  copied once. It moves with the #1 spot. */}
              <span className={styles.rowTitleBox} data-wipe={i === 0 ? row.title : undefined}>
                <span className={styles.rowTitle} data-row-title="">
                  {row.title}
                </span>
              </span>
              <span className={styles.rowSub}>{row.sub}</span>
              <span className={styles.rowWhy} id={`why-${row.id}`} data-row-why="">
                {row.why}
              </span>
            </span>
            {row.badge && (
              <span className={styles.badge} data-badge="">
                {row.badge}
              </span>
            )}
          </button>
        </li>
      ))}
    </ol>
  );
}

/** Stands where QWW-48's ▶ goes until it is mounted: same size and look, disabled, so a row's layout is final. */
function PlayPlaceholder() {
  return (
    <button type="button" className={styles.playButton} disabled aria-label="Play preview (not available yet)">
      <svg className={styles.playRing} viewBox="0 0 36 36" aria-hidden focusable="false">
        <circle cx="18" cy="18" r="16.5" />
      </svg>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden focusable="false">
        <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
      </svg>
    </button>
  );
}
