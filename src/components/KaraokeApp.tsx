'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { detectPitch } from '../lib/audio/pitch';
import { detectHeldNote } from '../lib/audio/heldNote';
import { frequencyToMidi, midiToNoteName } from '../lib/audio/notes';
import { createApi, LOGIN_PATH, type Api } from '../lib/client/api';
import { createTracker, flushWhenHidden, loadAnonId, sendEvents, type Tracker } from '../lib/client/events';
import { flowReducer, initialState, type FlowEvent, type FlowState } from '../lib/client/flow';
import { eventsFor } from '../lib/client/funnel';
import { browserMic, type Mic, type MicRecorder } from '../lib/client/mic';
import { createPostHogSink, type PostHogSettings } from '../lib/client/posthog';
import {
  clearProgress,
  loadProgress,
  loadSavedRange,
  saveProgress,
  saveRangeOnDevice,
  setWantsPick,
  takeWantsPick,
} from '../lib/client/storage';
import { EVENT } from '../lib/eventNames';
import { HoldStep } from './HoldStep';
import { Lyric } from './Lyric';
import { PickSongs } from './PickSongs';
import { Results } from './Results';
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
   * PostHog as the event log's second sink (QWW-51; app/page.tsx reads it from the environment). Null or absent, or with a
   * `track` of your own, events go to our own log alone.
   */
  postHog?: PostHogSettings | null;
}

const LIVE_FRAME = 2048;
const LIVE_EVERY_MS = 50; // ~20 times a second

const defaultNavigate = (url: string) => window.location.assign(url);

export function KaraokeApp({
  api: apiProp,
  track,
  mic = browserMic,
  navigate = defaultNavigate,
  quietMs = 2600,
  pickSongs: canPick = false,
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
  // Spotify refused the sign-in the singer just tried: the server sends them back with ?authError=<reason> and nothing else.
  const [signInFailed, setSignInFailed] = useState(false);
  const recorder = useRef<MicRecorder | null>(null);
  const holding = useRef(false);
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
      dispatch({
        type: 'booted',
        me,
        progress: loadProgress(),
        wantsPick: wantedPick && canPick,
        savedRange: me ? null : loadSavedRange(),
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

  useEffect(() => {
    if (step !== 'low' && step !== 'high') releaseMic();
  }, [step, releaseMic]);
  useEffect(() => releaseMic, [releaseMic]);

  const holdStart = async () => {
    if (holding.current) return;
    holding.current = true;
    setLive(null);
    dispatch({ type: 'holdStart' });
    let rec = recorder.current;
    if (!rec) {
      try {
        rec = await mic.open();
      } catch {
        // Denied, or no microphone at all: either way we cannot hear the user.
        holding.current = false;
        dispatch({ type: 'micDenied' });
        return;
      }
      recorder.current = rec;
      // Released while the permission prompt was up: nothing recorded yet.
      if (!holding.current) return;
    }
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
    clearProgress();
    dispatch({ type: 'redo' });
  };

  const sendFeedback = (trackId: string, thumbs: 'up' | 'down') => {
    const match = state.matches.find((m) => m.track.id === trackId);
    if (!match || !state.range) return;
    dispatch({ type: 'feedback', trackId, thumbs });
    const body = { trackId, thumbs, difficulty: match.difficulty, octave: match.octave, view: state.view };
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

  const selected = state.selectedId ? state.matches.find((m) => m.track.id === state.selectedId) : undefined;

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
        <button type="button" className={styles.centerButton} onClick={() => dispatch({ type: 'quietDone' })} aria-label="Find a quiet spot. Tap to continue">
          <Lyric text="Find a quiet spot" />
        </button>
      )}

      {(step === 'low' || step === 'high') && (
        <HoldStep
          kind={step}
          status={state.hold}
          live={live}
          lowNote={step === 'high' && state.low !== null ? midiToNoteName(state.low) : null}
          onPress={() => void holdStart()}
          onRelease={holdEnd}
        />
      )}

      {step === 'signin' && state.range && (
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
              Couldn’t sign in to Spotify.
            </p>
          )}
        </div>
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

      {step === 'results' && state.range && !selected && (
        <Results
          range={state.range}
          mode={state.mode}
          matches={state.matches}
          view={state.view}
          shown={state.shown}
          loading={state.loading}
          error={state.error === 'load'}
          libraryUnavailable={state.libraryUnavailable}
          signInFailed={signInFailed}
          onSelect={(trackId, position) => dispatch({ type: 'select', trackId, position })}
          onMore={() => dispatch({ type: 'loadMore' })}
          onRetry={() => dispatch({ type: 'retryLoad' })}
          onRedo={redo}
          onRedoEnd={(end) => dispatch({ type: 'redoEnd', end })}
          leadSlider={state.leadSlider}
          onSlider={(slider, value) => dispatch({ type: 'setSlider', slider, value })}
          onSliderDone={(slider) => dispatch({ type: 'sliderDone', slider })}
          onResetSliders={() => dispatch({ type: 'resetSliders' })}
          onDecade={(decade) => dispatch({ type: 'pickDecade', decade })}
          onMood={(mood) => dispatch({ type: 'pickMood', mood })}
          onDuets={() => dispatch({ type: 'toggleDuets' })}
          onClear={() => dispatch({ type: 'clearFilters' })}
          onConnect={connectSpotify}
          displayName={state.displayName}
          onLogout={logOut}
        />
      )}

      {step === 'results' && state.range && selected && (
        <SongDetail
          key={selected.track.id}
          match={selected}
          userRange={state.range}
          feedback={state.feedback[selected.track.id]}
          onFeedback={(thumbs) => sendFeedback(selected.track.id, thumbs)}
          onSpotify={() =>
            tracker.track('spotify_link_pressed', {
              mode: state.mode,
              difficulty: state.view.difficulty,
              familiarity: state.view.familiarity,
              popularity: state.view.popularity,
              tempo: state.view.tempo,
              decade: state.view.decade,
              mood: state.view.mood,
              duetsOnly: state.view.duetsOnly,
            })
          }
          onBack={() => dispatch({ type: 'deselect' })}
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
