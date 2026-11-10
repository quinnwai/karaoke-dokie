// The Setlist tuner screen (round 5 design, QWW-46): "Tune your setlist", a ranked list, and the bottom sheet of gears.
// It fills the viewport. It holds no ranking: it shows the list the ranking engine returned for what is set on the
// sheet, and sends every change up as a TunerAction.

import '@fontsource/barlow-semi-condensed/500.css';
import '@fontsource/barlow-semi-condensed/700.css';
import './setlist-global.css';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { Match, ResultsMode, VocalRange } from '../../lib/contracts';
import { midiToNoteName } from '../../lib/audio/notes';
import { toRows } from '../../lib/setlist/rows';
import { HISTORY_HINT_LOGGED_OUT, HISTORY_HINT_UNREACHABLE } from '../../lib/setlist/gears';
import type { TunerAction } from '../../lib/setlist/tuner';
import type { EmptyReason, GearId, SetlistSong, TunerState } from '../../lib/setlist/types';
import { BookIcon, SpotifyIcon } from '../Icon';
import { SpotifyAccount } from '../SpotifyAccount';
import screen from '../screen.module.css';
import { Sheet } from './Sheet';
import { SongRows } from './SongRows';
import styles from './setlist.module.css';

export interface SetlistScreenProps {
  range: VocalRange;
  mode: ResultsMode;
  tuner: TunerState;
  /** The ranked list from the ranking engine, best first; null until it has answered once. */
  songs: SetlistSong[] | null;
  /** Why the engine sent no songs, when it sent none (Era on with nothing picked, no song in the eras, none in range). */
  empty?: EmptyReason;
  /** How many songs of it are on screen. */
  shown: number;
  /** The songs are still being fetched. */
  loading: boolean;
  /** The songs could not be fetched, or the engine could not rank them. */
  error: boolean;
  /** Signed in, but the server could not read the Spotify library and sent catalogue songs (QWW-55). */
  libraryUnavailable?: boolean;
  /** The singer tried to sign in and Spotify refused (QWW-55). */
  signInFailed?: boolean;
  displayName: string | null;
  onTuner(action: TunerAction): void;
  /** A gear's thumb was let go (for the event log). */
  onGearDone(gear: GearId): void;
  /** `position` is the song's 1-based place in the list on screen. */
  onSelect(trackId: string, position: number): void;
  onMore(): void;
  onRetry(): void;
  onRedo(): void;
  /** Re-sing just the low or the high note, keeping the other. */
  onRedoEnd(end: 'low' | 'high'): void;
  /** Catalogue mode: sign in to Spotify for songs from the singer's own library. */
  onConnect(): void;
  /** Library mode: ends the session. Rejects when it could not, which the logo's box then says. */
  onLogout(): Promise<void>;
  /** The ▶ of a row (QWW-48). */
  renderPlay?(match: Match): ReactNode;
}

export function SetlistScreen(props: SetlistScreenProps) {
  const { range, mode, tuner, songs, empty, shown, loading, error } = props;
  const low = midiToNoteName(range.low);
  const high = midiToNoteName(range.high);
  const scroller = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => (songs ? toRows(songs) : []), [songs]);
  const visible = rows.slice(0, shown);
  const waiting = !error && (loading || songs === null);
  const noSongs = !waiting && !error && rows.length === 0;
  const pickAnEra = noSongs && empty === 'no-era-picked';
  const noneInEra = noSongs && empty === 'no-songs-in-era';
  const nothing = noSongs && !pickAnEra && !noneInEra;
  const historyAvailable = mode === 'library';

  useTestHook(props, rows);

  // The screen is the whole page: a vertical drag that starts on it must not pull the page (Android Chrome's
  // pull-to-refresh, an iOS rubber band) while a finger is on the handle or a slider. Only while it is shown.
  useEffect(() => {
    const root = document.documentElement;
    const before = root.style.overscrollBehaviorY;
    root.style.overscrollBehaviorY = 'none';
    return () => {
      root.style.overscrollBehaviorY = before;
    };
  }, []);

  return (
    <main id="app" className={styles.app} data-mode={tuner.mini ? 'mini' : 'expanded'} data-open={tuner.open}>
      <header className={styles.head}>
        <h1 className={styles.title}>Tune your setlist</h1>
        <div className={styles.headTools}>
          {/* The range and its redo sit together: redo is about the range. */}
          <span className={styles.rangeGroup}>
            <span className={styles.rangeChip} role="group" aria-label={`Your range ${low} to ${high}`}>
              <button type="button" className={styles.rangeNote} onClick={() => props.onRedoEnd('low')} aria-label={`Redo your low note, ${low}`}>
                {low}
              </button>
              {' – '}
              <button type="button" className={styles.rangeNote} onClick={() => props.onRedoEnd('high')} aria-label={`Redo your high note, ${high}`}>
                {high}
              </button>
            </span>
            <button type="button" className={styles.redo} onClick={props.onRedo} aria-label="Redo the singing test">
              redo
            </button>
          </span>
          {mode === 'catalogue' && !props.libraryUnavailable && (
            <button type="button" className={screen.connect} onClick={props.onConnect} aria-label="Connect to Spotify">
              <SpotifyIcon />
              <span className={screen.connectTip} aria-hidden>
                Connect to Spotify
              </span>
            </button>
          )}
          {(mode === 'library' || props.libraryUnavailable) && <SpotifyAccount name={props.displayName} onLogout={props.onLogout} />}
        </div>
      </header>

      <div ref={scroller} id="list-scroll" className={styles.listScroll}>
        {props.libraryUnavailable && (
          <p className={styles.note} role="status">
            Couldn’t reach Spotify, showing popular songs.
          </p>
        )}
        {props.signInFailed && (
          <p className={styles.note} role="status">
            Couldn’t sign in to Spotify.
          </p>
        )}

        {pickAnEra && (
          <p id="empty" className={styles.empty} role="status">
            Pick an era to see songs.
          </p>
        )}
        {noneInEra && <p className={styles.note}>No songs from those eras fit your range. Try another era, or reset Era.</p>}
        {nothing && (
          <p className={styles.note}>
            {mode === 'catalogue' ? 'None of our catalogue songs fit this range yet.' : 'None of your songs have range data yet, or none fit your range.'}
          </p>
        )}
        {error && <p className={styles.note}>Couldn’t load songs.</p>}
        {error && (
          <button type="button" className={styles.more} onClick={props.onRetry} aria-label="Try loading songs again">
            Try again
          </button>
        )}
        {waiting && visible.length === 0 && <p className={styles.note}>Loading…</p>}

        {visible.length > 0 && <SongRows rows={visible} scroller={scroller} onOpen={props.onSelect} renderPlay={props.renderPlay} />}
        {/* A big library comes in pages: the rows that have arrived are shown, and what is still coming is said under them. */}
        {waiting && visible.length > 0 && <p className={styles.note}>Loading…</p>}

        {!error && visible.length < rows.length && (
          <button type="button" className={styles.more} onClick={props.onMore} aria-label="Load more songs">
            Load more
          </button>
        )}
        {mode === 'library' && !waiting && !error && rows.length > 0 && visible.length >= rows.length && (
          <p className={styles.note}>That’s every song that fits, for now.</p>
        )}
        {mode === 'catalogue' && !props.libraryUnavailable && rows.length > 0 && (
          <div className={styles.connectNote}>
            <p>Want personalized recommendations?</p>
            <button type="button" className={screen.textButton} onClick={props.onConnect}>
              Connect to Spotify
            </button>
          </div>
        )}
        <a className={styles.credits} href="/credits" aria-label="Sources and credits" title="Sources and credits">
          <BookIcon />
        </a>
      </div>

      <Sheet
        tuner={tuner}
        historyAvailable={historyAvailable}
        historyHint={props.libraryUnavailable ? HISTORY_HINT_UNREACHABLE : HISTORY_HINT_LOGGED_OUT}
        onTuner={props.onTuner}
        onGearDone={props.onGearDone}
      />
    </main>
  );
}

/**
 * Tests only: `window.setlist`, the hook the spec (§9) drives the screen with. It exists only in a build made with
 * NEXT_PUBLIC_SETLIST_TEST_HOOK=1 (the e2e build); in any other build the check below is false at build time and
 * the whole thing is dropped, so production has no `window.setlist`.
 */
function useTestHook(props: SetlistScreenProps, rows: ReturnType<typeof toRows>) {
  const latest = useRef({ props, rows });
  useEffect(() => {
    latest.current = { props, rows };
  });
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SETLIST_TEST_HOOK !== '1') return;
    const hook = {
      getState: () => JSON.parse(JSON.stringify(latest.current.props.tuner)) as TunerState,
      setState: (patch: Partial<TunerState>) => latest.current.props.onTuner({ type: 'patch', patch }),
      ranking: () => latest.current.rows.map((r) => r.title),
      songs: () => latest.current.rows.map((r) => ({ id: r.id, title: r.title, artist: r.artist, era: r.era })),
    };
    (window as unknown as { setlist?: typeof hook }).setlist = hook;
    return () => {
      delete (window as unknown as { setlist?: typeof hook }).setlist;
    };
  }, []);
}
