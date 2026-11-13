import { useId, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import type { Match } from '../../lib/contracts';
import type { SetlistRow } from '../../lib/setlist/rows';
import { usePreviewProgress } from '../PreviewButton';
import { useFlip } from './flip';
import { useFillIn, type FillMemory } from './useFillIn';
import styles from './rows.module.css';

interface SongRowsProps {
  /** The rows to show, best first. The DOM follows this order. */
  rows: SetlistRow[];
  /** The box that scrolls the list, so only rows in view animate and a title fills in when its row comes into view. */
  scroller: RefObject<HTMLElement | null>;
  /** `position` is the song's 1-based place in the list on screen. */
  onOpen(trackId: string, position: number): void;
  /**
   * The ▶ at the start of each row, where the rank number was (Round 6A, decision 3). QWW-48 owns playback and KaraokeApp mounts its
   * button here; it sits beside the row's own button, never inside it, so a tap on ▶ cannot also open the song page. Without
   * it the slot shows an inert ▶.
   */
  renderPlay?(match: Match, position: number): ReactNode;
  /** Which titles have filled this visit (R12). The screen's owner keeps it, so it outlives this list; without it the list keeps its own. */
  fillMemory?: FillMemory;
}

/**
 * The ranked list (Round 6A §4). A row is 66 px: the slot (44 px), the text (title over "Artist · Era" over the reason line)
 * and the difficulty badge, 10 px apart. The slot holds the row's rank number and its ▶ on top of each other (R3): on a pointer
 * device the number shows and hovering the row swaps it for the ▶; on a touch screen, which cannot hover, the ▶ stands there
 * and the number is not drawn. The number is hidden from a screen reader either way, because the list is an `<ol>` and
 * already says each position; a row also keeps its place in `data-rank`. Rows stand in rank order, and slide into place when
 * it changes (useFlip). Each title fills in once as its row comes into view (R12, useFillIn), and while its preview plays it sweeps
 * in pink (R16, SongRow). Tapping a row opens the song page.
 */
export function SongRows({ rows, scroller, onOpen, renderPlay, fillMemory }: SongRowsProps) {
  const list = useRef<HTMLOListElement>(null);
  const order = rows.map((r) => r.id).join('\n');
  useFlip(list, scroller, order);
  const fill = useFillIn(list, scroller, order, fillMemory);
  // The reason line's id is made from the row's place, not its track id: aria-describedby is a list of ids split at spaces, and a
  // catalogue id has them ("cat:michael jackson|beat it"), which pointed the button at ids that do not exist.
  const uid = useId();

  return (
    <ol ref={list} id="list" className={styles.list} role="list" aria-label="Ranked songs">
      {rows.map((row, i) => (
        <SongRow
          key={row.id}
          row={row}
          place={i + 1}
          whyId={`${uid}-why-${i + 1}`}
          filled={fill.filled(row.id)}
          delay={fill.delay(row.id)}
          onOpen={onOpen}
          renderPlay={renderPlay}
        />
      ))}
    </ol>
  );
}

interface SongRowProps {
  row: SetlistRow;
  /** The row's 1-based place in the list. */
  place: number;
  whyId: string;
  /** Whether the title is drawn filled (R12), and how long its fill waited to start, ms. */
  filled: boolean;
  delay: number | undefined;
  onOpen: SongRowsProps['onOpen'];
  renderPlay: SongRowsProps['renderPlay'];
}

/**
 * One row. It is a component of its own for R16: while this row's preview plays, its title sweeps in pink over the length of the
 * preview. The row's element gets the share played in `--preview-progress` (usePreviewProgress), and CSS draws the sweep from it;
 * a style on this one element, so a tick of the preview redraws nothing in the list.
 */
function SongRow({ row, place, whyId, filled, delay, onOpen, renderPlay }: SongRowProps) {
  const li = useRef<HTMLLIElement>(null);
  usePreviewProgress(row.id, li);
  return (
    <li ref={li} className={styles.row} data-row="" data-id={row.id} data-rank={place}>
      <span className={styles.playSlot} data-play-slot="">
        <span className={styles.rankNumber} data-rank-number="" aria-hidden="true">
          {place}
        </span>
        {renderPlay ? renderPlay(row.match, place) : <PlayPlaceholder />}
      </span>
      <button type="button" className={styles.rowOpen} onClick={() => onOpen(row.id, place)} aria-label={row.label} aria-describedby={whyId}>
        <span className={styles.rowText} data-row-text="">
          {/* The title's karaoke fill: a white copy laid over the dim title and revealed left to right, once, when the row
              first comes into view. CSS draws the copy from `data-fill-text` (the ::after of this box), not as a second piece
              of text, so the title is read, found and copied once. `data-filled` is what starts it; it stays on the row,
              so a row that React moves, or that comes back later, is drawn already filled and does not play it again. The
              pink sweep of a playing row (R16) is the ::before of the same box, drawn from the same attribute. */}
          <span
            className={styles.rowTitleBox}
            data-fill-text={row.title}
            data-filled={filled ? '' : undefined}
            style={delay === undefined ? undefined : ({ '--fill-delay': `${delay}ms` } as CSSProperties)}
          >
            <span className={styles.rowTitle} data-row-title="">
              {row.title}
            </span>
          </span>
          <span className={styles.rowSub}>{row.sub}</span>
          <span className={styles.rowWhy} id={whyId} data-row-why="">
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
  );
}

/**
 * Stands where QWW-48's ▶ goes when a screen is given no `renderPlay` (the app always gives one, KaraokeApp's PreviewButton, which
 * draws the thin circle round the ▶, R17): the glyph alone, faded and disabled, so a row's layout is final. The slot's CSS gives it,
 * and QWW-48's button, the size, the colour and the swap with the rank number.
 */
function PlayPlaceholder() {
  return (
    <button type="button" disabled aria-label="Play preview (not available yet)">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden focusable="false">
        <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
      </svg>
    </button>
  );
}
