// Which beta events (QWW-16, QWW-20) each screen action produces. Pure: it runs the reducer to
// see what the action did, so the event log follows the flow without handlers scattered through
// components.
//
// Privacy: events never carry a Spotify id or a song from someone's Spotify library. Catalogue
// songs (no Spotify) may carry their catalogue key; library songs carry only their position.

import type { EventValue } from '../contracts';
import { browserLabel } from './browser';
import { flowReducer, type FlowEvent, type FlowState, type Step } from './flow';

export interface FunnelEvent {
  name: string;
  props?: Record<string, EventValue>;
}

/** The view a song was found in, as event props: each slider's target (null = not set) and the picks. */
function viewProps(s: FlowState): Record<string, EventValue> {
  const v = s.view;
  const round = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);
  return {
    mode: s.mode,
    difficulty: round(v.difficulty),
    familiarity: round(v.familiarity),
    popularity: round(v.popularity),
    tempo: round(v.tempo),
    decade: v.decade,
    mood: v.mood,
    duetsOnly: v.duetsOnly,
  };
}

/** The catalogue key of a catalogue song ("cat:<key>"), or null for a library song. */
export function catalogueKey(trackId: string): string | null {
  return trackId.startsWith('cat:') ? trackId.slice(4) : null;
}

/** Events for one action, given the state before it. */
export function eventsFor(prev: FlowState, action: FlowEvent): FunnelEvent[] {
  const next = flowReducer(prev, action);
  const out: FunnelEvent[] = [];
  switch (action.type) {
    case 'start':
      out.push({ name: 'start_pressed' });
      break;
    case 'holdEnd': {
      const step = prev.step;
      if (step !== 'low' && step !== 'high') break;
      if (action.midi === null) out.push({ name: 'hold_too_short', props: { step } });
      else if (next.hold === 'order') out.push({ name: 'note_out_of_order', props: { step, midi: action.midi } });
      else out.push({ name: 'note_detected', props: { step, midi: action.midi } });
      break;
    }
    case 'showCatalogue':
      out.push({ name: 'catalogue_chosen' });
      break;
    case 'allLoaded': {
      // Only the first answer for a range counts as viewing results; later ones finish a slow load.
      if (prev.attempt > 0) break;
      const matchCount = action.page.matches.filter((m) => m.difficulty !== 'maybe').length;
      const maybeCount = action.page.matches.length - matchCount;
      // A library the server could not read comes back as catalogue songs, whatever the screen asked for (QWW-55).
      const unavailable = action.page.libraryUnavailable === true;
      const mode = unavailable ? 'catalogue' : prev.mode;
      out.push({ name: 'results_viewed', props: { mode, matchCount, maybeCount, ...(unavailable ? { libraryUnavailable: true } : {}) } });
      if (action.page.matches.length === 0) out.push({ name: 'results_empty', props: { mode } });
      break;
    }
    case 'loadFailed':
      out.push({ name: 'results_failed', props: { mode: prev.mode } });
      break;
    case 'loadMore':
      out.push({ name: 'generate_more_pressed', props: { shown: prev.shown, ...viewProps(prev) } });
      break;
    case 'sliderDone':
      // One record per adjustment, when the thumb is let go; dragging itself records nothing.
      out.push({ name: 'slider_changed', props: { slider: action.slider, ...viewProps(prev) } });
      break;
    case 'resetSliders':
      out.push({ name: 'sliders_reset', props: viewProps(next) });
      break;
    case 'pickDecade':
      out.push({ name: 'chip_toggled', props: { kind: 'decade', value: action.decade, on: next.view.decade === action.decade, ...viewProps(next) } });
      break;
    case 'pickMood':
      out.push({ name: 'chip_toggled', props: { kind: 'mood', value: action.mood, on: next.view.mood === action.mood, ...viewProps(next) } });
      break;
    case 'toggleDuets':
      out.push({ name: 'chip_toggled', props: { kind: 'duets', value: 'duets', on: next.view.duetsOnly, ...viewProps(next) } });
      break;
    case 'clearFilters':
      out.push({ name: 'filters_cleared', props: viewProps(next) });
      break;
    case 'select': {
      const props: Record<string, EventValue> = { ...viewProps(prev), position: action.position ?? null };
      const key = catalogueKey(action.trackId);
      if (key) props.songKey = key;
      out.push({ name: 'song_opened', props });
      break;
    }
    case 'feedback':
      out.push({ name: 'feedback_tapped', props: { thumbs: action.thumbs, ...viewProps(prev) } });
      break;
    case 'redo':
      out.push({ name: 'redo_pressed', props: { from: prev.step } });
      break;
    case 'redoEnd':
      out.push({ name: 'redo_end_pressed', props: { end: action.end } });
      break;
    case 'pickStart':
      out.push({ name: 'pick_songs_pressed', props: { signedIn: prev.signedIn } });
      break;
    default:
      break;
  }
  out.push(...micEvents(prev, next, action));
  if (next.step !== prev.step) out.push(...stepEvents(next.step, next));
  return out;
}

/**
 * Events for the mic step (QWW-50). `mic_prompt_shown` is our own screen ahead of the browser's question, the closest
 * we can get: the browser does not say when its own box appears. `mic_denied` is any way the answer was no (blocked,
 * closed, no microphone, in use), told apart by `reason`. `mic_granted` is the yes itself: it goes straight on to the
 * note, so there is no screen to arrive at, and it is logged on the grant, once per grant (a late answer the flow
 * ignores logs nothing). `via` says whether a tap asked ('prompt') or the browser had already said ('already').
 * `browser` is 'ios-safari', 'android-chrome', ...
 */
function micEvents(prev: FlowState, next: FlowState, action: FlowEvent): FunnelEvent[] {
  if (prev.step !== 'mic') return [];
  const { env, problem } = next.mic;
  const browser = env ? browserLabel(env) : 'other';
  const via = prev.mic.view === 'asking' ? 'prompt' : 'already';
  // The flow takes a grant only on a screen that waits for one, and then leaves the mic step.
  if (action.type === 'micGranted') return next.step === 'mic' ? [] : [{ name: 'mic_granted', props: { via, browser } }];
  if (next.mic.view === prev.mic.view) return [];
  switch (next.mic.view) {
    case 'inapp':
      return [{ name: 'inapp_browser_detected', props: { app: env?.inApp ?? 'webview', browser } }];
    case 'prompt':
      return [{ name: 'mic_prompt_shown', props: { browser } }];
    case 'recovery':
      return [
        { name: 'mic_denied', props: { reason: problem ?? 'denied', via, browser } },
        { name: 'mic_recovery_shown', props: { reason: problem ?? 'denied', browser } },
      ];
    default:
      return [];
  }
}

/** Events for arriving at a step. */
export function stepEvents(step: Step, s: FlowState): FunnelEvent[] {
  switch (step) {
    case 'landing':
      return [{ name: 'landing_viewed' }];
    case 'quiet':
      return [{ name: 'quiet_shown' }];
    case 'signin':
      return s.range ? [{ name: 'range_shown', props: { low: s.range.low, high: s.range.high, spanSemitones: s.range.high - s.range.low } }] : [];
    default:
      return [];
  }
}
