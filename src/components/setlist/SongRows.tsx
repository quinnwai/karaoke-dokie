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
   * The ▶ at the end of each row. QWW-48 owns playback and mounts its button here; it sits beside the row's own
   * button, never inside it, so a tap on ▶ cannot also open the song page. Without it the slot shows an inert ▶.
   */
  renderPlay?(match: Match): ReactNode;
}

/**
 * The ranked list (spec §5). Rows stand in rank order, so a screen reader reads the ranking, and slide into place
 * when it changes (useFlip). A row is 58 px; tapping it opens the song page.
 */
export function SongRows({ rows, scroller, onOpen, renderPlay }: SongRowsProps) {
  const list = useRef<HTMLOListElement>(null);
  useFlip(list, scroller, rows.map((r) => r.id).join('\n'));

  return (
    <ol ref={list} id="list" className={styles.list} role="list" aria-label="Ranked songs">
      {rows.map((row, i) => (
        <li key={row.id} className={styles.row} data-row="" data-id={row.id} data-rank={i + 1}>
          <button type="button" className={styles.rowOpen} onClick={() => onOpen(row.id, i + 1)} aria-label={row.label}>
            <span className={styles.rank} aria-hidden>
              {i + 1}
            </span>
            <span className={styles.rowText}>
              <span className={styles.rowTitle} data-row-title="">
                {row.title}
              </span>
              <span className={styles.rowSub}>{row.sub}</span>
            </span>
            <Lane lane={row.lane} />
          </button>
          <span className={styles.playSlot} data-play-slot="">
            {renderPlay ? renderPlay(row.match) : <PlayPlaceholder />}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The song's mini difficulty lane: a band that grows with difficulty and three dashes, in the difficulty colour. A song
 * whose range cannot be trusted has no lane, only the space where it would be, so the rows stay aligned.
 */
function Lane({ lane }: { lane: SetlistRow['lane'] }) {
  if (lane === null) return <span className={styles.laneNone} aria-hidden />;
  const dash = (left: number, width: number, top: number) => (
    <i className={styles.laneDash} style={{ left, width, top, background: lane.color }} />
  );
  return (
    <span className={styles.lane} aria-hidden>
      <i className={styles.laneBand} style={{ top: lane.bandTop, height: lane.bandHeight, background: lane.color }} />
      {dash(3, 10, lane.dashTop[0])}
      {dash(16, 12, lane.dashTop[1])}
      {dash(31, 10, lane.dashTop[2])}
    </span>
  );
}

/** Stands where QWW-48's ▶ goes until it is mounted: same size, disabled, so a row's layout is final. */
function PlayPlaceholder() {
  return (
    <button type="button" className={styles.playButton} disabled aria-label="Play preview (not available yet)">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
        <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
      </svg>
    </button>
  );
}
