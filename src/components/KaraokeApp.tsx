'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import type { Match } from '../lib/contracts';
import { detectPitch } from '../lib/audio/pitch';
import { detectHeldNote } from '../lib/audio/heldNote';
import { isDigitalSilence, MIN_MUTED_SAMPLES } from '../lib/audio/level';
import { frequencyToMidi, midiToNoteName } from '../lib/audio/notes';
import { createApi, LOGIN_PATH, type Api } from '../lib/client/api';
import { detectBrowser } from '../lib/client/browser';
import { createTracker, flushWhenHidden, loadAnonId, sendEvents, type Tracker } from '../lib/client/events';
import { flowReducer, initialState, overlayOf, type FlowEvent, type FlowState } from '../lib/client/flow';
import { eventsFor, feedbackView, rowPlayEvent, viewProps } from '../lib/client/funnel';
import { browserMic, classifyMicError, MicError, type Mic, type MicRecorder } from '../lib/client/mic';
import { createPostHogSink } from '../lib/client/posthog';
import {
  clearProgress,
  loadFeedback,
  loadProgress,
  loadSavedRange,
  saveFeedback,
  saveProgress,
  saveRangeOnDevice,
  setWantsPick,
  takeWantsPick,
} from '../lib/client/storage';
import type { PostHogSettings } from '../lib/contracts';
import { EVENT } from '../lib/eventNames';
import { TAP_GUARD_MS } from '../lib/client/tapGuard';
import { useOverlayHistory } from '../lib/client/useOverlayHistory';
import { useRankedSetlist } from '../lib/client/useRankedSetlist';
import { createNetworkEngine, type SetlistEngine } from '../lib/setlist/engine';
import { toRequest } from '../lib/setlist/tuner';
import { BackToSongs } from './BackToSongs';
import { HoldStep } from './HoldStep';
import { Lyric } from './Lyric';
import { MicStep } from './MicStep';
import { PickSongs } from './PickSongs';
import { listenForRowPlay, PreviewButton } from './PreviewButton';
import { SetlistScreen } from './setlist/SetlistScreen';
import { useFillMemory } from './setlist/useFillIn';
import { SongDetail } from './SongDetail';
import { Tv } from './Tv';
import styles from './screen.module.css';

export interface KaraokeAppProps {
  api?: Api;
  /** The beta event log; tests pass a fake. */
  track?: Pick<Tracker, 'track' | 'flush'>;
  mic?: Mic;
  /** Leaves the page (Spotify sign-in). */
  navigate?: (url: string) => void;
  /** Reloads the page ("Reload this page" on the mic step). Not `navigate(location.href)`: that does nothing when the address has a #fragment. */
  reload?: () => void;
  /** How long "Find a quiet spot" stays up. */
  quietMs?: number;
  /**
   * Offers the two extra ways in (PICK_SONGS, off by default; app/page.tsx reads it): "or pick songs you sing well"
   * on the title screen and "or use songs from your Spotify" under the range. Off, the first release has one
   * onboarding flow, the Spotify logo on the list is the one way to sign in, and a pick left over from an earlier
   * visit is ignored.
   */
  pickSongs?: boolean;
  /**
   * The ranking engine behind the Setlist tuner. By default it asks the server (POST /api/setlist, QWW-47;
   * src/lib/setlist/engine.ts). Tests pass one that records its requests.
   */
  setlistEngine?: SetlistEngine;
  /** The ▶ of a list row. Default: the song's 30 s Deezer preview (QWW-48, PreviewButton); a test can pass its own. */
  renderPlay?(match: Match, position: number): ReactNode;
  /**
   * PostHog as the event log's second sink (QWW-51; app/page.tsx reads it from the environment). Null or absent, or with a
   * `track` of your own, events go to our own log alone.
   */
  postHog?: PostHogSettings | null;
}

/** The ▶ in a row's slot: plays the song's Deezer preview, or is disabled when the song has none. `position` is the row's 1-based place on screen, which the event log's row_play carries (QWW-51). */
const previewPlay = (m: Match, position: number): ReactNode => (
  <PreviewButton id={m.track.id} deezerId={m.deezerId} title={m.track.title} artist={m.track.artist} position={position} />
);

const LIVE_FRAME = 2048;
/** A press shorter than this is a tap. */
const TAP_MS = 400;
const LIVE_EVERY_MS = 50; // ~20 times a second

/** A slider drag asks on every input event; the server is asked once the thumb has rested this long (an engine passed in is asked at once). */
const SETLIST_DEBOUNCE_MS = 120;
// The guard's length is in lib/client/tapGuard, where ConnectButton reads it too; it is still KaraokeApp's to the tests and to Tv's copy of it.
export { TAP_GUARD_MS };

const defaultNavigate = (url: string) => window.location.assign(url);
const defaultReload = () => window.location.reload();

export function KaraokeApp({
  api: apiProp,
  track,
  mic = browserMic,
  navigate = defaultNavigate,
  reload = defaultReload,
  quietMs = 2600,
  pickSongs: canPick = false,
  setlistEngine,
  renderPlay = previewPlay,
  postHog = null,
}: KaraokeAppProps) {
  const [api] = useState(() => apiProp ?? createApi());
  const [state, rawDispatch] = useReducer(flowReducer, initialState);

  // Beta event log (QWW-16, QWW-20): every action passes through here, and funnel.ts decides what
  // it records. The server drops everything unless collection is switched on. PostHog is the tracker's
  // second sink (QWW-51), when the environment has a key for it.
  const [posthog] = useState(() => (track || !postHog ? null : createPostHogSink(postHog, loadAnonId())));
  const [tracker] = useState(() => track ?? createTracker({ anonId: loadAnonId(), send: sendEvents, mirror: posthog ?? undefined }));
  useEffect(() => (typeof window === 'undefined' ? undefined : flushWhenHidden(tracker)), [tracker]);
  // The page's one preview player (QWW-48) tells the event log when a preview starts playing (QWW-51).
  useEffect(
    () =>
      listenForRowPlay((trackId, position) => {
        const e = rowPlayEvent(trackId, position);
        tracker.track(e.name, e.props);
      }),
    [tracker],
  );
  const stateRef = useRef<FlowState>(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const dispatch = useCallback(
    (action: FlowEvent) => {
      for (const e of eventsFor(stateRef.current, action)) tracker.track(e.name, e.props);
      // Keep the ref ahead of React so a second action in the same tick sees this one's result.
      stateRef.current = flowReducer(stateRef.current, action);
      rawDispatch(action);
    },
    [tracker],
  );
  // Session replay records only a visitor known to be signed out: a signed-in screen shows their Spotify name and
  // songs from their library, which must not reach PostHog.
  const replayAllowed = state.step !== 'boot' && !state.signedIn;
  useEffect(() => posthog?.setReplay(replayAllowed), [posthog, replayAllowed]);
  const [live, setLive] = useState<number | null>(null);
  // The tuner's sheet has been sized once (QWW-57, decision 1): the first time the singer reaches it, a short phone opens it
  // in mini; after that it stays as they left it, through a song and back.
  const sheetSized = useRef(false);
  // The titles that have filled in this visit (R12): a visit lasts until the singer's range changes (redo) or the page is reloaded,
  // so the fill does not play again when the list empties and fills, or after a song and Back.
  const fillMemory = useFillMemory(state.range ? `${state.range.low}-${state.range.high}` : '');
  // Spotify refused the sign-in the singer just tried: the server sends them back with ?authError=<reason> and nothing else.
  const [signInFailed, setSignInFailed] = useState(false);
  const recorder = useRef<MicRecorder | null>(null);
  const holding = useRef(false);
  const holdStarted = useRef(0);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);

  // Who is this? Signed in, mid-test, or brand new.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const me = await api.me().catch(() => null);
      if (cancelled) return;
      const url = new URL(window.location.href);
      const authError = url.searchParams.get('authError');
      if (url.searchParams.has('signedIn') || authError !== null) {
        url.searchParams.delete('signedIn');
        url.searchParams.delete('authError');
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      }
      // Say so (QWW-55), unless the singer pressed Cancel on Spotify's page: that was their answer, not a failure.
      if (authError && authError !== 'access_denied' && !me) setSignInFailed(true);
      // Always taken, so a pick left over from an earlier visit cannot surface later; only used when picking is on.
      const wantedPick = me ? takeWantsPick() : false;
      const progress = loadProgress();
      const savedRange = me ? null : loadSavedRange();
      // Half a test left over from a redo that was abandoned is dropped when the singer already has a range (the flow goes to the list):
      // it must not come back at the next visit as a first test with no way back (the second review of PR #38).
      if ((me?.range || savedRange) && progress && (progress.low === null || progress.high === null)) clearProgress();
      dispatch({
        type: 'booted',
        me,
        progress,
        wantsPick: wantedPick && canPick,
        savedRange,
        // ?mini=1 starts the tuner's sheet in mini mode (the reference's way to open its "L2 mini" board).
        mini: url.searchParams.get('mini') === '1',
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [api, canPick]);

  // Keep test progress across the Spotify round trip.
  useEffect(() => {
    if (state.step === 'boot') return;
    if (state.step === 'low' || state.step === 'high' || state.step === 'signin' || state.step === 'quiet') {
      saveProgress({ low: state.low, high: state.high });
    }
  }, [state.step, state.low, state.high]);

  useEffect(() => {
    if (state.step !== 'quiet') return;
    const t = setTimeout(() => dispatch({ type: 'quietDone' }), quietMs);
    return () => clearTimeout(t);
  }, [state.step, quietMs]);

  // Save the range, then show results.
  const { step, range, error } = state;
  useEffect(() => {
    if (step !== 'saving' || !range || error) return;
    let cancelled = false;
    api.saveRange(range).then(
      () => {
        if (cancelled) return;
        clearProgress();
        dispatch({ type: 'rangeSaved' });
      },
      () => !cancelled && dispatch({ type: 'saveFailed' }),
    );
    return () => {
      cancelled = true;
    };
  }, [api, step, range, error]);

  // Every match at once: the phone orders, filters and pages them (src/lib/songs/browse.ts).
  const { loading, mode, attempt } = state;
  useEffect(() => {
    if (step !== 'results' || !loading || !range) return;
    let cancelled = false;
    const load = mode === 'catalogue' ? api.catalogue({ low: range.low, high: range.high }) : api.allRecommendations();
    load.then(
      (page) => !cancelled && dispatch({ type: 'allLoaded', page }),
      () => !cancelled && dispatch({ type: 'loadFailed' }),
    );
    return () => {
      cancelled = true;
    };
  }, [api, step, loading, mode, range, attempt]);

  const { known, signedIn } = state;
  useEffect(() => {
    if (step !== 'pick' || known !== null || !signedIn) return;
    let cancelled = false;
    api.knownSongs().then(
      (res) => !cancelled && dispatch({ type: 'knownLoaded', songs: res.songs }),
      () => !cancelled && dispatch({ type: 'knownLoaded', songs: [] }),
    );
    return () => {
      cancelled = true;
    };
  }, [api, step, known, signedIn]);

  // The Setlist tuner sends what is set to the ranking engine and gets the ranked list back. Nothing is asked until the
  // songs have loaded; a new request keeps the last list on screen until its own answer arrives.
  // The server ranks (POST /api/setlist) and decides for itself whether the singer's library counts, from the session. The
  // engine is made again when the songs the screen holds change (a page of a big library landed, so the server's
  // list may have grown), when the singer signs in or out, and so on: a new engine is a new question for the hook.
  const engine = useMemo(() => setlistEngine ?? createNetworkEngine(), [setlistEngine, state.mode, state.matches]);
  // A big library arrives in pages (loading stays true between them): ask as each page lands, and the list shows
  // "Loading…" under its rows until the last one. Nothing is asked while there are no songs of this load yet:
  // `attempt` counts the pages that have landed in it, and starts again at 0 for a first load and for Try again, so a
  // retry clears the request and the server is asked anew once the songs land.
  const hasSongs = !state.loading || (state.attempt > 0 && state.matches.length > 0);
  const ranked = useRankedSetlist(engine, step === 'results' && range && hasSongs && state.error !== 'load' ? toRequest(state.tuner, range) : null, setlistEngine ? 0 : SETLIST_DEBOUNCE_MS);
  // A song the singer taps is looked up in the engine's own answer first: the server sends the songs it ranked,
  // which need not be in the list the screen loaded.
  const findMatch = (trackId: string): Match | undefined =>
    ranked.result?.songs.find((s) => s.match.track.id === trackId)?.match ?? state.matches.find((m) => m.track.id === trackId);
  // The song page keeps the match it was opened with. A re-rank that lands while it is open can leave the song out of the new
  // list, and the lookup above would then find nothing: the page closed by itself and came back when a later list had the song
  // again. Only a tap on a row opens a page, and only Back (or the browser's) closes it.
  const [opened, setOpened] = useState<Match | null>(null);
  const matchOf = (trackId: string): Match | undefined => (opened?.track.id === trackId ? opened : findMatch(trackId));
  // The list and the song page take turns in the screen, so the list that Back brings is a new one, at the top: where the singer had
  // scrolled it to is kept here, and put back by the effect below (returnTo).
  const listTop = useRef(0);
  const openSong = (trackId: string, position: number) => {
    listTop.current = document.getElementById('list-scroll')?.scrollTop ?? 0;
    setOpened(findMatch(trackId) ?? null);
    dispatch({ type: 'select', trackId, position });
  };
  // A double tap puts its second tap on the screen the first one brought up: the song page's ‹ is over the tuner's low note, "Back to
  // songs" is over its range notes and redo, a range note is over "Back to songs", and redo is under the quiet step's full-screen
  // button. So for a moment after a tap changes the screen, taps on those are ignored (the second review of PR #38; the gate on 1ee41b4
  // for the quiet step). A tap that comes after the moment is a choice, and works. A tap that is ignored puts the moment off by another
  // one, so a run of quick taps never gets through. (A double tap on a row lands on the song page, which holds its own controls for the
  // same moment: SongDetail's holdMs.)
  const quietUntil = useRef(0);
  const hush = () => {
    quietUntil.current = Date.now() + TAP_GUARD_MS;
  };
  // The rows have a moment of their own: "Load more" is replaced by the rows it brings, so a double tap on it puts its second tap on one
  // (the gate on 1ee41b4). Nothing else brings rows up under a finger, so nothing else holds them: a row tapped right after ‹ is a choice.
  // A row tap that is ignored puts the moment off again, like the others.
  const rowsQuietUntil = useRef(0);
  const holdRows = () => {
    rowsQuietUntil.current = Date.now() + TAP_GUARD_MS;
  };
  const tapRow = (trackId: string, position: number) => {
    if (Date.now() >= rowsQuietUntil.current) openSong(trackId, position);
    else holdRows();
  };
  const unlessHushed =
    <A extends unknown[]>(act: (...args: A) => void) =>
    (...args: A) => {
      if (Date.now() >= quietUntil.current) act(...args);
      else hush();
    };
  // Closing a song page puts the focus back on the row that opened it, at its place in the list now (a re-rank may have moved it). The
  // page and the list are never in the page together, so the focus would otherwise be lost to the top of the page.
  const returnTo = useRef<string | null>(null);
  const closeSong = () => {
    returnTo.current = state.selectedId;
    dispatch({ type: 'deselect' });
  };

  // ---- mic ----
  const stopTicker = () => {
    if (ticker.current) clearInterval(ticker.current);
    ticker.current = null;
  };

  const releaseMic = useCallback(() => {
    stopTicker();
    holding.current = false;
    recorder.current?.close();
    recorder.current = null;
  }, []);

  // The microphone opened on the mic step stays open into the hold steps, so the browser is not asked again.
  useEffect(() => {
    if (step !== 'mic' && step !== 'low' && step !== 'high') releaseMic();
  }, [step, releaseMic]);
  useEffect(() => releaseMic, [releaseMic]);

  // ---- the mic step (QWW-50) ----
  const gate = state.mic;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Looks at the browser and asks it what it already knows about the microphone. This never shows a question.
  useEffect(() => {
    if (step !== 'mic' || gate.view !== 'checking') return;
    let cancelled = false;
    void mic.permission().then((permission) => {
      if (cancelled) return;
      const nav = navigator as Navigator & { standalone?: boolean };
      const env = detectBrowser(nav.userAgent, { maxTouchPoints: nav.maxTouchPoints, standalone: nav.standalone });
      dispatch({ type: 'micChecked', env, permission });
    });
    return () => {
      cancelled = true;
    };
  }, [step, gate.view, mic, dispatch]);

  // Opens the microphone: the browser's own question after a tap, or a microphone it had already allowed.
  const openMic = useCallback(async () => {
    try {
      const rec = await mic.open();
      // Left the mic step (or the page), or the screen no longer waits for one, while the question was up: nobody
      // wants this microphone any more.
      const { step: at, mic: now } = stateRef.current;
      if (!mounted.current || at !== 'mic' || (now.view !== 'asking' && now.view !== 'opening')) {
        rec.close();
        return;
      }
      recorder.current?.close();
      recorder.current = rec;
      dispatch({ type: 'micGranted' });
    } catch (err) {
      if (mounted.current) dispatch({ type: 'micFailed', reason: err instanceof MicError ? err.reason : classifyMicError(err) });
    }
  }, [mic, dispatch]);

  useEffect(() => {
    if (step === 'mic' && gate.view === 'opening') void openMic();
  }, [step, gate.view, openMic]);

  // The tap itself calls the microphone, so the browser sees a person asking (iOS Safari wants that for audio).
  const askMic = () => {
    // Only the screens that ask can: a second tap before the first answer must not ask the browser twice.
    const { step: at, mic: now } = stateRef.current;
    if (at !== 'mic' || (now.view !== 'prompt' && now.view !== 'recovery')) return;
    dispatch({ type: 'micAsk' });
    void openMic();
  };

  const holdStart = () => {
    if (holding.current) return;
    const rec = recorder.current;
    if (!rec || !rec.live()) {
      // The microphone went away since the mic step (another app took it, the permission was taken back):
      // back to the mic step, which asks again, rather than a hold that records nothing.
      releaseMic();
      dispatch({ type: 'micLost' });
      return;
    }
    holding.current = true;
    holdStarted.current = Date.now();
    setLive(null);
    dispatch({ type: 'holdStart' });
    rec.resume();
    rec.reset();
    stopTicker();
    ticker.current = setInterval(() => {
      const frame = rec.latest(LIVE_FRAME);
      if (frame.length < LIVE_FRAME) return;
      const pitch = detectPitch(frame, rec.sampleRate);
      setLive(pitch ? frequencyToMidi(pitch.frequency) : null);
    }, LIVE_EVERY_MS);
  };

  const holdEnd = () => {
    if (!holding.current) return;
    holding.current = false;
    stopTicker();
    setLive(null);
    const rec = recorder.current;
    if (!rec) {
      dispatch({ type: 'holdEnd', midi: null });
      return;
    }
    const samples = rec.take();
    // Muted, or audio that never started: only exact zeros for long enough, or no sound at all from a recorder that is
    // not running (iOS after a call or the lock screen) or after a hold too long to be a tap. A quiet singer's
    // microphone still wobbles, and a quick tap on a running recorder is just a short hold. "Hold the note a little
    // longer" would be said for ever. Back to the mic step: it shows our own screen even when the browser says the
    // microphone is allowed, and the tap on its button starts the audio again.
    const longHold = Date.now() - holdStarted.current > TAP_MS;
    if (isDigitalSilence(samples) || (samples.length < MIN_MUTED_SAMPLES && (!rec.running() || longHold))) {
      releaseMic();
      dispatch({ type: 'micLost' });
      return;
    }
    // Let the button repaint before the analysis runs.
    setTimeout(() => {
      const held = detectHeldNote(samples, rec.sampleRate);
      dispatch({ type: 'holdEnd', midi: held ? held.midi : null });
    }, 0);
  };

  // ---- actions ----
  const pickSongs = () => {
    if (state.signedIn) dispatch({ type: 'pickStart' });
    else {
      tracker.track('pick_songs_pressed', { signedIn: false });
      tracker.flush();
      setWantsPick(true);
      navigate(LOGIN_PATH);
    }
  };

  const redo = () => {
    hush();
    clearProgress();
    dispatch({ type: 'redo' });
  };

  const sendFeedback = (trackId: string, thumbs: 'up' | 'down') => {
    const match = matchOf(trackId);
    if (!match || !state.range) return;
    // A like or dislike stays and cannot be changed (R26): a second tap, from a double tap or from another tab's answer, is for nothing.
    if (stateRef.current.feedback[trackId] ?? loadFeedback(trackId)) return;
    dispatch({ type: 'feedback', trackId, thumbs });
    saveFeedback(trackId, thumbs);
    const body = { trackId, thumbs, difficulty: match.difficulty, octave: match.octave, view: feedbackView(state) };
    const sent =
      state.mode === 'catalogue'
        ? api.catalogueFeedback({ ...body, anonId: loadAnonId(), range: { low: state.range.low, high: state.range.high } })
        : api.feedback(body);
    sent.catch(() => {});
  };

  // No Spotify: straight to songs from the catalogue, with the range kept on this device.
  const showCatalogue = () => {
    if (!state.range) return;
    saveRangeOnDevice(state.range);
    clearProgress();
    dispatch({ type: 'showCatalogue' });
  };

  // Spotify as the upgrade: keep the range across the sign-in round trip, then it is saved to the account.
  const connectSpotify = () => {
    tracker.track(EVENT.spotifyConnect, { from: state.step, mode: state.mode });
    tracker.flush();
    if (state.range) saveProgress({ low: state.range.low, high: state.range.high });
    navigate(LOGIN_PATH);
  };

  // Log out: end the session, then show catalogue songs for the same range, which stays on this
  // device like it does for anyone without Spotify. A failed request throws, to be shown by the logo's box.
  const logOut = async () => {
    await api.logout();
    if (state.range) saveRangeOnDevice(state.range);
    dispatch({ type: 'loggedOut' });
  };

  const selected = state.selectedId ? matchOf(state.selectedId) : undefined;

  // The browser's Back button closes what is open on top of the list: a song's page, or a redo's quiet, mic and note steps. The
  // singer already has a range then, so "Back to songs" brings the list, the range and the tuning back as they were.
  const overlay = overlayOf(state);
  const backToSongs = () => {
    clearProgress();
    dispatch({ type: 'backToSongs' });
  };
  const tapBackToSongs = unlessHushed(() => {
    hush();
    backToSongs();
  });
  const tapQuiet = unlessHushed(() => dispatch({ type: 'quietDone' }));
  useOverlayHistory(overlay, () => (overlay === 'redo' ? backToSongs() : closeSong()));
  useEffect(() => {
    const id = returnTo.current;
    if (id === null || state.selectedId !== null || step !== 'results' || !ranked.result) return;
    returnTo.current = null;
    // The list first, then the focus. The list is a new element, at the top: focus() alone left it there in WebKit, and in Chromium it only
    // centred the row, not where the singer had the list. With scrollTop back, focus() scrolls only if the row is off the screen now (a
    // re-rank moved it).
    const scroller = document.getElementById('list-scroll');
    if (scroller) scroller.scrollTop = listTop.current;
    const row = [...document.querySelectorAll<HTMLElement>('#list [data-row]')].find((li) => li.dataset.id === id);
    row?.querySelector<HTMLElement>(':scope > button')?.focus();
  }, [state.selectedId, step, ranked.result]);

  // The Setlist tuner is on the TV like every other step (Round 6A, QWW-57): one frame for the whole flow, with no second
  // bezel. It fills the TV's screen, and only its list scrolls.
  if (step === 'results' && state.range && !selected) {
    return (
      <Tv>
        <SetlistScreen
          range={state.range}
          mode={state.mode}
          tuner={state.tuner}
          songs={ranked.result?.songs ?? null}
          empty={ranked.result?.empty}
          total={ranked.result?.total}
          nextOffset={ranked.result?.nextOffset}
          shown={state.shown}
          loading={state.loading}
          error={state.error === 'load' || ranked.failed}
          libraryUnavailable={ranked.result?.libraryUnavailable ?? state.libraryUnavailable}
          signInFailed={signInFailed}
          displayName={state.displayName}
          openMiniIfShort={!sheetSized.current}
          onSheetSized={() => {
            sheetSized.current = true;
          }}
          onTuner={(action) => dispatch({ type: 'tuner', action })}
          onGearDone={(gear) => dispatch({ type: 'gearDone', gear })}
          onSelect={tapRow}
          onMore={() => {
            holdRows();
            dispatch({ type: 'loadMore' });
          }}
          onRetry={() => dispatch({ type: 'retryLoad' })}
          onRedo={unlessHushed(redo)}
          onRedoEnd={unlessHushed((end) => {
            hush();
            dispatch({ type: 'redoEnd', end });
          })}
          onConnect={connectSpotify}
          onLogout={logOut}
          renderPlay={renderPlay}
          fillMemory={fillMemory}
        />
      </Tv>
    );
  }

  return (
    <Tv>
      {step === 'boot' && <div className={styles.center} aria-busy="true" />}

      {step === 'landing' && (
        <div className={styles.center}>
          <p className={styles.sign} aria-hidden>
            カラオケ
          </p>
          <h1 className={styles.brand}>karaoke-dokie</h1>
          <button type="button" className={styles.play} aria-label="Start" onClick={() => dispatch({ type: 'start' })}>
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden>
              <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
            </svg>
          </button>
          {canPick && (
            <button type="button" className={styles.textButton} onClick={pickSongs}>
              or pick songs you sing well
            </button>
          )}
        </div>
      )}

      {step === 'quiet' && (
        <button type="button" className={styles.centerButton} onClick={tapQuiet} aria-label="Find a quiet spot. Tap to continue">
          <Lyric text="Find a quiet spot" />
        </button>
      )}

      {step === 'mic' && (
        <MicStep gate={gate} onAsk={askMic} onTryHere={() => dispatch({ type: 'micTryHere' })} onReload={reload} onBack={overlay === 'redo' ? tapBackToSongs : undefined} />
      )}

      {(step === 'low' || step === 'high') && (
        <HoldStep
          kind={step}
          status={state.hold}
          live={live}
          lowNote={step === 'high' && state.low !== null ? midiToNoteName(state.low) : null}
          onPress={holdStart}
          onRelease={holdEnd}
          onBack={overlay === 'redo' ? tapBackToSongs : undefined}
        />
      )}

      {step === 'signin' && state.range && (
        <>
          {/* A redo's new range waits here to be confirmed: Back to songs (or the browser's Back) keeps the old one, as on the steps before. */}
          {overlay === 'redo' && <BackToSongs onBack={tapBackToSongs} />}
          <div className={styles.center}>
            <Lyric text="That's your range" small />
            <p className={styles.bigRange}>
              <span data-testid="range-low">{midiToNoteName(state.range.low)}</span>
              <span className={styles.dash} aria-hidden>
                –
              </span>
              <span data-testid="range-high">{midiToNoteName(state.range.high)}</span>
            </p>
            <button type="button" className={styles.arrow} aria-label="Continue" onClick={showCatalogue}>
              <svg viewBox="0 0 48 24" width="56" height="28" aria-hidden>
                <path d="M2 12h40M32 3l10 9-10 9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {canPick && (
              <button type="button" className={styles.textButton} onClick={connectSpotify}>
                or use songs from your Spotify
              </button>
            )}
            {signInFailed && (
              <p className={styles.hint} role="status">
                Couldn’t sign in. Spotify sign-in is for invited testers only right now.
              </p>
            )}
          </div>
        </>
      )}

      {step === 'saving' && (
        <div className={styles.center}>
          {state.error === 'save' ? (
            <>
              <Lyric text="Couldn't save your range" />
              <button type="button" className={styles.more} onClick={() => dispatch({ type: 'retrySave' })}>
                Try again
              </button>
            </>
          ) : (
            <Lyric text="Finding your songs" />
          )}
        </div>
      )}

      {step === 'results' && state.range && selected && (
        <SongDetail
          key={selected.track.id}
          match={selected}
          userRange={state.range}
          feedback={state.feedback[selected.track.id] ?? loadFeedback(selected.track.id)}
          onFeedback={(thumbs) => sendFeedback(selected.track.id, thumbs)}
          onSpotify={() => tracker.track('spotify_link_pressed', viewProps(state))}
          holdMs={TAP_GUARD_MS}
          onBack={() => {
            hush();
            closeSong();
          }}
        />
      )}

      {step === 'pick' && (
        <PickSongs
          songs={state.known}
          picks={state.picks}
          saving={false}
          onToggle={(trackId) => dispatch({ type: 'togglePick', trackId })}
          onDone={() => dispatch({ type: 'pickDone' })}
          onTest={redo}
        />
      )}
    </Tv>
  );
}
