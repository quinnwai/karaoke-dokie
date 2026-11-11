// The Setlist tuner screen (round 5 design, QWW-46; Round 6A's neon reskin, QWW-57): a header row, "Tune your setlist", a
// ranked list, and the bottom sheet of gears. It lives inside the TV (Tv.tsx) like every other step, and fills it. It holds
// no ranking: it shows the list the ranking engine returned for what is set on the sheet, and sends every change up as a
// TunerAction.

import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './setlist-global.css';
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
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
import { useSheetFit } from './useSheetFit';
import listStyles from './rows.module.css';
import styles from './setlist.module.css';

export interface SetlistScreenProps {
  range: VocalRange;
  mode: ResultsMode;
  tuner: TunerState;
  /** The ranked list from the ranking engine, best first; null until it has answered once. */
  songs: SetlistSong[] | null;
  /** Why the engine sent no songs, when it sent none (Era on with nothing picked, no song in the eras, none in range). */
  empty?: EmptyReason;
  /** `SetlistResponse.total`: every song that fits the range and the picked eras, not just the loaded page. */
  total?: number | null;
  /**
   * `SetlistResponse.nextOffset`: where the next page of the engine's list would start, or null when the list it sent is
   * the end of it. The screen asks for one page (the most a request may), so a number here means songs that are not on
   * screen and never will be in this release, and the list must not say it has shown them all.
   */
  nextOffset?: number | null;
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
  /**
   * True the first time the singer reaches this screen: it measures what the expanded sheet would leave of the list, and
   * opens the sheet in mini when that is fewer than three whole rows (QWW-57, decision 1). It is false afterwards, so a
   * singer who dragged the sheet up on a short phone finds it up again when they come back from a song.
   */
  openMiniIfShort?: boolean;
  /** The first measure is done (whether or not it chose mini): `openMiniIfShort` can go false. */
  onSheetSized?(): void;
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
  const { range, mode, tuner, songs, empty, shown, loading, error, nextOffset = null } = props;
  const low = midiToNoteName(range.low);
  const high = midiToNoteName(range.high);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // The rows read the Difficulty gear for their reason line ("In your sweet spot"), so they are made again when it moves.
  const difficultyOn = !tuner.off.includes('difficulty');
  const rows = useMemo(
    () => (songs ? toRows(songs, { difficulty: tuner.difficulty, off: difficultyOn ? [] : ['difficulty'] }) : []),
    [songs, tuner.difficulty, difficultyOn],
  );
  const visible = rows.slice(0, shown);
  const waiting = !error && (loading || songs === null);
  const noSongs = !waiting && !error && rows.length === 0;
  const pickAnEra = noSongs && empty === 'no-era-picked';
  const noneInEra = noSongs && empty === 'no-songs-in-era';
  const nothing = noSongs && !pickAnEra && !noneInEra;
  // Listening history is Spotify's. A signed-in singer whose library the server could not read has none either, whichever
  // route said so: the engine's answer (`libraryUnavailable`) is what the note under the list follows, so the gear follows it too.
  const historyAvailable = mode === 'library' && !props.libraryUnavailable;

  // How the expanded sheet fits this screen. On a short phone the first time it opens mini (decision 1); where the expanded
  // sheet is taller than the screen can hold at all (an iPhone SE with Safari's bars, a phone on its side), the handle keeps
  // it in mini. Before the first measure (and in jsdom, which has no layout) nothing is known and nothing is changed.
  const fit = useSheetFit(root);
  const canExpand = fit?.canExpand ?? true;
  const { openMiniIfShort, onSheetSized, onTuner } = props;
  const sized = useRef(false);
  useLayoutEffect(() => {
    // Once, for the first measure: a later one (the phone turned) only changes whether the handle can expand.
    if (!fit || !openMiniIfShort || sized.current) return;
    sized.current = true;
    onSheetSized?.();
    if (fit.opensMini && !tuner.mini) onTuner({ type: 'mini', mini: true });
  }, [fit]);
  const mini = tuner.mini || !canExpand;

  useTestHook(props, rows);

  // The screen is the whole page: a vertical drag that starts on it must not pull the page (Android Chrome's
  // pull-to-refresh, an iOS rubber band) while a finger is on the handle or a slider. Only while it is shown.
  useEffect(() => {
    const doc = document.documentElement;
    const before = doc.style.overscrollBehaviorY;
    doc.style.overscrollBehaviorY = 'none';
    return () => {
      doc.style.overscrollBehaviorY = before;
    };
  }, []);

  return (
    <div ref={root} id="app" className={styles.app} data-mode={mini ? 'mini' : 'expanded'} data-open={tuner.open}>
      <header className={styles.head}>
        <div className={styles.topbar}>
          {/* The range and its redo sit together: redo is about the range. */}
          <span className={styles.rangeChip} role="group" aria-label={`Your range ${low} to ${high}`}>
            <button type="button" className={styles.rangeNote} onClick={() => props.onRedoEnd('low')} aria-label={`Redo your low note, ${low}`}>
              <span className={styles.noteMark}>{low}</span>
            </button>
            {' – '}
            <button type="button" className={styles.rangeNote} onClick={() => props.onRedoEnd('high')} aria-label={`Redo your high note, ${high}`}>
              <span className={styles.noteMark}>{high}</span>
            </button>
          </span>
          <button type="button" className={styles.redo} onClick={props.onRedo} aria-label="Redo the singing test">
            redo
          </button>
          {/* The sign sits in the middle of the room between redo and the Spotify button, and goes first when there is none. */}
          <span className={styles.signSlot} aria-hidden="true">
            <span className={styles.sign} lang="ja" aria-hidden="true">
              カラオケ
            </span>
          </span>
          {mode === 'catalogue' && !props.libraryUnavailable && (
            <button type="button" className={`${screen.connect} ${styles.spotify}`} onClick={props.onConnect} aria-label="Connect to Spotify">
              <SpotifyIcon />
              <span className={screen.connectTip} aria-hidden>
                Connect to Spotify
              </span>
            </button>
          )}
          {(mode === 'library' || props.libraryUnavailable) && (
            <span className={styles.spotify}>
              <SpotifyAccount name={props.displayName} onLogout={props.onLogout} />
            </span>
          )}
        </div>
        <h1 className={styles.title}>Tune your setlist</h1>
      </header>

      <div ref={scroller} id="list-scroll" className={listStyles.listScroll}>
        {props.libraryUnavailable && (
          <p className={listStyles.note} role="status">
            Couldn’t reach Spotify, showing popular songs.
          </p>
        )}
        {props.signInFailed && (
          <p className={listStyles.note} role="status">
            Couldn’t sign in to Spotify.
          </p>
        )}

        {pickAnEra && (
          <p id="empty" className={listStyles.empty} role="status">
            Pick an era to see songs.
          </p>
        )}
        {noneInEra && <p className={listStyles.empty}>No songs from those eras fit your range. Try another era, or reset Era.</p>}
        {nothing && (
          <p className={listStyles.empty}>
            {mode === 'catalogue' ? 'None of our catalogue songs fit this range yet.' : 'None of your songs have range data yet, or none fit your range.'}
          </p>
        )}
        {error && <p className={listStyles.empty}>Couldn’t load songs.</p>}
        {error && (
          <button type="button" className={listStyles.more} onClick={props.onRetry} aria-label="Try loading songs again">
            Try again
          </button>
        )}
        {waiting && visible.length === 0 && <p className={listStyles.empty}>Loading…</p>}

        {visible.length > 0 && <SongRows rows={visible} scroller={scroller} onOpen={props.onSelect} renderPlay={props.renderPlay} />}
        {/* A big library comes in pages: the rows that have arrived are shown, and what is still coming is said under them. */}
        {waiting && visible.length > 0 && <p className={listStyles.note}>Loading…</p>}

        {!error && visible.length < rows.length && (
          <button type="button" className={listStyles.more} onClick={props.onMore} aria-label="Load more songs">
            Load more
          </button>
        )}
        {/* Only when this really is the end: the engine sends one page (the most a request may ask for), and when it says
            there is more (nextOffset) the list ends without claiming it has shown every song that fits. */}
        {mode === 'library' && !waiting && !error && rows.length > 0 && visible.length >= rows.length && nextOffset === null && (
          <p className={listStyles.note}>That’s every song that fits, for now.</p>
        )}
        {mode === 'catalogue' && !props.libraryUnavailable && rows.length > 0 && (
          <div className={listStyles.connectNote}>
            <p>Want personalized recommendations?</p>
            <button type="button" className={listStyles.connectLink} onClick={props.onConnect}>
              Connect to Spotify
            </button>
          </div>
        )}
        <a className={listStyles.credits} href="/credits" aria-label="Sources and credits" title="Sources and credits">
          <BookIcon />
        </a>
      </div>

      <Sheet
        tuner={tuner}
        historyAvailable={historyAvailable}
        historyHint={props.libraryUnavailable ? HISTORY_HINT_UNREACHABLE : HISTORY_HINT_LOGGED_OUT}
        songCount={props.total ?? null}
        canExpand={canExpand}
        onTuner={props.onTuner}
        onGearDone={props.onGearDone}
      />
    </div>
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
