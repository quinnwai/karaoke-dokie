'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { detectPitch } from '../lib/audio/pitch';
import { detectHeldNote } from '../lib/audio/heldNote';
import { frequencyToMidi, midiToNoteName } from '../lib/audio/notes';
import { createApi, LOGIN_PATH, type Api } from '../lib/client/api';
import { flowReducer, initialState } from '../lib/client/flow';
import { browserMic, type Mic, type MicRecorder } from '../lib/client/mic';
import { clearProgress, loadProgress, saveProgress, setWantsPick, takeWantsPick } from '../lib/client/storage';
import { HoldStep } from './HoldStep';
import { Lyric } from './Lyric';
import { PickSongs } from './PickSongs';
import { Results } from './Results';
import { SongDetail } from './SongDetail';
import { Tv } from './Tv';
import styles from './screen.module.css';

export interface KaraokeAppProps {
  api?: Api;
  mic?: Mic;
  /** Leaves the page (Spotify sign-in). */
  navigate?: (url: string) => void;
  /** How long "Find a quiet spot" stays up. */
  quietMs?: number;
}

const LIVE_FRAME = 2048;
const LIVE_EVERY_MS = 50; // ~20 times a second

const defaultNavigate = (url: string) => window.location.assign(url);

export function KaraokeApp({ api: apiProp, mic = browserMic, navigate = defaultNavigate, quietMs = 2600 }: KaraokeAppProps) {
  const [api] = useState(() => apiProp ?? createApi());
  const [state, dispatch] = useReducer(flowReducer, initialState);
  const [live, setLive] = useState<number | null>(null);
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
      if (url.searchParams.has('signedIn')) {
        url.searchParams.delete('signedIn');
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      }
      dispatch({ type: 'booted', me, progress: loadProgress(), wantsPick: me ? takeWantsPick() : false });
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

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

  const { loading, nextOffset } = state;
  useEffect(() => {
    if (step !== 'results' || !loading) return;
    let cancelled = false;
    api.recommendations(nextOffset ?? 0).then(
      (page) => !cancelled && dispatch({ type: 'pageLoaded', page }),
      () => !cancelled && dispatch({ type: 'loadFailed' }),
    );
    return () => {
      cancelled = true;
    };
  }, [api, step, loading, nextOffset]);

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
    if (!match) return;
    dispatch({ type: 'feedback', trackId, thumbs });
    api.feedback({ trackId, thumbs, difficulty: match.difficulty, octave: match.octave }).catch(() => {});
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
          <button type="button" className={styles.textButton} onClick={pickSongs}>
            or pick songs you sing well
          </button>
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
          <button type="button" className={styles.arrow} aria-label="Continue" onClick={() => navigate(LOGIN_PATH)}>
            <svg viewBox="0 0 48 24" width="56" height="28" aria-hidden>
              <path d="M2 12h40M32 3l10 9-10 9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
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
          matches={state.matches}
          loading={state.loading}
          error={state.error === 'load'}
          hasMore={state.nextOffset !== null}
          onSelect={(trackId) => dispatch({ type: 'select', trackId })}
          onMore={() => dispatch({ type: 'loadMore' })}
          onRedo={redo}
        />
      )}

      {step === 'results' && state.range && selected && (
        <SongDetail
          key={selected.track.id}
          match={selected}
          userRange={state.range}
          source={state.sources[selected.track.id]}
          feedback={state.feedback[selected.track.id]}
          onFeedback={(thumbs) => sendFeedback(selected.track.id, thumbs)}
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
