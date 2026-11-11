import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { createPreviewPlayer, type PreviewPlayer, type PreviewSnapshot, type PreviewStatus } from '../lib/client/preview';
import { DeezerIcon } from './Icon';
import styles from './screen.module.css';

// The ▶ in a song row (QWW-48): it plays the song's 30 s Deezer preview without leaving the list. Self-contained, so
// any row can mount it with the song's track id and Deezer id; every button on the page shares one player
// (lib/client/preview.ts). There is no visible player: the playing button shows ⏸ and a thin ring that fills as the
// preview plays.

/** The page's one player. Made here, but it touches the page only on the first tap, so this is safe on the server. */
const shared = createPreviewPlayer();

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
 * unset means nothing to play.
 */
export function usePreview(id: string, deezerId: number | undefined): { state: PreviewButtonState; toggle(): void; player: PreviewPlayer } {
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
      if (deezerId !== undefined) player.toggle(id, deezerId);
    },
    player,
  };
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
  className?: string;
}

export function PreviewButton({ id, deezerId, title, artist, className }: PreviewButtonProps) {
  const { state, toggle, player } = usePreview(id, deezerId);
  const ring = useRef<SVGCircleElement>(null);

  // The ring follows the preview a frame at a time while it plays, and stays where it stopped when paused.
  useEffect(() => {
    const el = ring.current;
    if (!el) return;
    const draw = () => {
      el.style.strokeDashoffset = String(RING * (1 - (state === 'idle' || state === 'unavailable' ? 0 : player.progress())));
    };
    draw();
    if (state !== 'playing' || typeof requestAnimationFrame === 'undefined') return;
    let frame = requestAnimationFrame(function tick() {
      draw();
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [state, player]);

  const song = `${title} by ${artist}`;
  const sounding = state === 'loading' || state === 'playing';
  const label = state === 'unavailable' ? `No preview of ${song}` : sounding ? `Pause ${song}` : `Play ${song}`;
  return (
    <button
      type="button"
      className={className ? `${styles.preview} ${className}` : styles.preview}
      data-preview={state}
      aria-label={label}
      title={state === 'unavailable' ? 'No preview' : undefined}
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
    </button>
  );
}

/**
 * Deezer's API terms ask every app that uses it to show Deezer's logo where it can be seen, and to tell listeners the
 * previews are for private use. One quiet line over the list says where they come from and links to the credits
 * page, which says the rest.
 */
export function DeezerCredit({ className }: { className?: string }) {
  return (
    <p className={className ? `${styles.deezerCredit} ${className}` : styles.deezerCredit}>
      <a href="/credits" aria-label="Previews from Deezer, for private listening. Sources and credits">
        Previews from
        <span className={styles.deezerMark}>
          <DeezerIcon />
          Deezer
        </span>
      </a>
    </p>
  );
}
