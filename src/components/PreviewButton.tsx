import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { createPreviewPlayer, type PreviewPlayer, type PreviewSnapshot, type PreviewStatus } from '../lib/client/preview';
import styles from './screen.module.css';

// The ▶ in a song row (QWW-48): it plays the song's 30 s Deezer preview without leaving the list. Self-contained, so
// any row can mount it with the song's track id and Deezer id; every button on the page shares one player
// (lib/client/preview.ts). There is no visible player: the button is a thin circle round the ▶ (R17), and the playing button shows
// ⏸ and a ring that fills as the preview plays. The song page mounts the same button, larger (R27).

/** Who hears when a preview starts playing: the event log's row_play (QWW-51). The screen sets it while it is on the page. */
let rowPlayListener: ((trackId: string, position: number | undefined) => void) | null = null;

/** Listens for previews that start playing on the page's shared player, until the returned function is called. */
export function listenForRowPlay(listener: (trackId: string, position: number | undefined) => void): () => void {
  rowPlayListener = listener;
  return () => {
    if (rowPlayListener === listener) rowPlayListener = null;
  };
}

/** The page's one player. Made here, but it touches the page only on the first tap, so this is safe on the server. */
const shared = createPreviewPlayer({ onStart: (trackId, position) => rowPlayListener?.(trackId, position) });

/** Which player the buttons use. Tests provide one with a fake <audio>. */
export const PreviewPlayerContext = createContext<PreviewPlayer>(shared);

/** What a row's button shows: the player's state for it, or 'unavailable' when it has nothing to play. */
export type PreviewButtonState = PreviewStatus | 'unavailable';

export function previewStateOf(s: PreviewSnapshot, id: string, deezerId: number | undefined): PreviewButtonState {
  if (deezerId === undefined || s.missing.has(deezerId)) return 'unavailable';
  return s.key === id ? s.status : 'idle';
}

/**
 * One row's preview: its state, and the toggle for a tap. `id` is the row's own id (the song's track id); `deezerId`
 * unset means nothing to play; `position` is the row's 1-based place in the list, reported with the play.
 */
export function usePreview(id: string, deezerId: number | undefined, position?: number): { state: PreviewButtonState; toggle(): void; player: PreviewPlayer } {
  const player = useContext(PreviewPlayerContext);
  // A string, so a change to another row's state does not redraw this one.
  const state = useSyncExternalStore(
    player.subscribe,
    () => previewStateOf(player.snapshot(), id, deezerId),
    () => (deezerId === undefined ? 'unavailable' : 'idle'),
  );
  // When its row goes (the song page opens, or a filter takes the song off the list), its preview stops.
  useEffect(() => () => player.release(id), [player, id]);
  return {
    state,
    toggle: () => {
      if (deezerId !== undefined) player.toggle(id, deezerId, position);
    },
    player,
  };
}

/**
 * Follows row `id`'s preview on `player` and tells `draw` how far it has come, 0 to 1: 0 while the player is not on this row (it
 * never was, ended, failed, or another row plays), the place it holds while loading or paused, and a frame at a time while it
 * plays. Returns what ends it. This is the one place that decides when a progress is drawn, for the ring in the ▶ (R17) and for a
 * row's title sweep (R16). `draw` writes a style, never React state, so a tick redraws nothing else.
 */
function followPreview(player: PreviewPlayer, id: string, draw: (progress: number) => void): () => void {
  let status: PreviewStatus | undefined;
  let frame: number | undefined;
  const stop = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  };
  const sync = () => {
    const s = player.snapshot();
    const now: PreviewStatus = s.key === id ? s.status : 'idle';
    if (now === status) return; // another row's change, or none of this row's
    status = now;
    stop();
    draw(now === 'idle' ? 0 : player.progress());
    if (now !== 'playing' || typeof requestAnimationFrame === 'undefined') return;
    frame = requestAnimationFrame(function tick() {
      draw(player.progress());
      frame = requestAnimationFrame(tick);
    });
  };
  sync();
  const off = player.subscribe(sync);
  return () => {
    off();
    stop();
  };
}

/** The custom property a row's title sweep reads (rows.module.css): how much of the preview has played, 0 to 1. */
const PROGRESS_VAR = '--preview-progress';

/**
 * Puts row `id`'s preview progress in `--preview-progress` on `target`, for CSS to draw (R16: the row's title sweeps in pink as its
 * preview plays): the share played while it plays, and where it stopped while it is paused. The property is removed when the player
 * is not on this row, so it resets when the preview ends or another row plays. It is a style on one element, once a frame, not React
 * state, so the list is not redrawn by it.
 */
export function usePreviewProgress(id: string, target: RefObject<HTMLElement | null>): void {
  const player = useContext(PreviewPlayerContext);
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const off = followPreview(player, id, (p) => (p > 0 ? el.style.setProperty(PROGRESS_VAR, String(p)) : el.style.removeProperty(PROGRESS_VAR)));
    return () => {
      off();
      el.style.removeProperty(PROGRESS_VAR);
    };
  }, [player, id, target]);
}

/** The ring's radius and length, in the 36-unit box it is drawn in. */
const RING_R = 16.5;
const RING = 2 * Math.PI * RING_R;

interface PreviewButtonProps {
  /** The row's own id (the song's track id): which row plays, even when two rows share one Deezer track. */
  id: string;
  /** The song's Deezer track id (Match.deezerId); unset shows a disabled button. */
  deezerId: number | undefined;
  title: string;
  artist: string;
  /** The row's 1-based place in the list on screen, for the event log's row_play (QWW-51). */
  position?: number;
  /**
   * The song page's ▶ (R27): about 64 px, with its words ("Play 30 s", "Pause", "No preview") under the circle. They are the button's
   * name too, so what is seen is what is read; the song is the page's heading above it.
   */
  large?: boolean;
  className?: string;
}

export function PreviewButton({ id, deezerId, title, artist, position, large, className }: PreviewButtonProps) {
  const { state, toggle, player } = usePreview(id, deezerId, position);
  const ring = useRef<SVGCircleElement>(null);

  // The ring follows the preview a frame at a time while it plays, stays where it stopped when paused, and is empty otherwise.
  useEffect(() => {
    const el = ring.current;
    if (!el) return;
    return followPreview(player, id, (p) => {
      el.style.strokeDashoffset = String(RING * (1 - p));
    });
  }, [player, id]);

  const song = `${title} by ${artist}`;
  const sounding = state === 'loading' || state === 'playing';
  const words = state === 'unavailable' ? 'No preview' : sounding ? 'Pause' : 'Play 30 s';
  const label = large ? words : state === 'unavailable' ? `No preview of ${song}` : sounding ? `Pause ${song}` : `Play ${song}`;
  return (
    <button
      type="button"
      className={[styles.preview, large && styles.previewLarge, className].filter(Boolean).join(' ')}
      data-preview={state}
      aria-label={label}
      title={state === 'unavailable' && !large ? 'No preview' : undefined}
      disabled={state === 'unavailable'}
      onClick={(e) => {
        // Never the row's own tap as well: the row opens the song page.
        e.stopPropagation();
        toggle();
      }}
    >
      <svg className={styles.previewRing} viewBox="0 0 36 36" aria-hidden focusable="false">
        <circle className={styles.previewTrack} cx="18" cy="18" r={RING_R} />
        <circle ref={ring} className={styles.previewFill} cx="18" cy="18" r={RING_R} strokeDasharray={RING} strokeDashoffset={RING} />
      </svg>
      <svg className={styles.previewIcon} viewBox="0 0 24 24" width="18" height="18" aria-hidden focusable="false">
        {sounding ? <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" /> : <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />}
      </svg>
      {large && <span className={styles.previewWords}>{words}</span>}
    </button>
  );
}
