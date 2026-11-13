// Which beta events (QWW-16, QWW-20) each screen action produces. Pure: it runs the reducer to
// see what the action did, so the event log follows the flow without handlers scattered through
// components.
//
// Privacy: events never carry a Spotify id or a song from someone's Spotify library. Catalogue
// songs (no Spotify) may carry their catalogue key; library songs carry only their position.

import type { EventValue, ResultsView } from '../contracts';
import { EVENT } from '../eventNames';
import { browserLabel } from './browser';
import { isOn } from '../setlist/tuner';
import type { GearId } from '../setlist/types';
import { flowReducer, historyAvailable, type FlowEvent, type FlowState, type Step } from './flow';

export interface FunnelEvent {
  name: string;
  props?: Record<string, EventValue>;
}

const round = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

/** A gear's target as 0 to 1, or null when it is not factored in (off, or History before Spotify is connected). */
function gearTarget(s: FlowState, gear: GearId): number | null {
  if (!isOn(s.tuner, gear) || (gear === 'history' && !historyAvailable(s))) return null;
  return round(s.tuner[gear] / 100);
}

/**
 * The tuner as a song was found in it, as event props: each gear's target (null = not factored in) and the picked
 * eras. The gear props keep the names the admin page's per-control stats read (src/lib/server/eventStats.ts):
 * `familiarity` is the History gear.
 */
export function viewProps(s: FlowState): Record<string, EventValue> {
  return {
    mode: s.mode,
    difficulty: gearTarget(s, 'difficulty'),
    familiarity: gearTarget(s, 'history'),
    popularity: gearTarget(s, 'popularity'),
    tempo: gearTarget(s, 'tempo'),
    eras: isOn(s.tuner, 'era') ? s.tuner.eras.join(',') : null,
  };
}

/** The tuner in the shape the feedback request has always carried (server validate.ts), for the stored view. */
export function feedbackView(s: FlowState): ResultsView {
  return {
    difficulty: gearTarget(s, 'difficulty'),
    familiarity: gearTarget(s, 'history'),
    popularity: gearTarget(s, 'popularity'),
    tempo: gearTarget(s, 'tempo'),
    decade: null,
    mood: null,
    duetsOnly: false,
  };
}

/** The catalogue key of a catalogue song ("cat:<key>"), or null for a library song. */
export function catalogueKey(trackId: string): string | null {
  return trackId.startsWith('cat:') ? trackId.slice(4) : null;
}

/**
 * A row's preview started playing (QWW-48's ▶, reported by the preview player): the row's place in the list, and a
 * catalogue song's key (a library song carries only its place).
 */
export function rowPlayEvent(trackId: string, position?: number): FunnelEvent {
  const props: Record<string, EventValue> = { position: position ?? null };
  const key = catalogueKey(trackId);
  if (key) props.songKey = key;
  return { name: EVENT.rowPlay, props };
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
      else out.push({ name: step === 'low' ? EVENT.lowNoteDone : EVENT.highNoteDone, props: { midi: action.midi } });
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
      out.push({ name: EVENT.listView, props: { mode, matchCount, maybeCount, ...(unavailable ? { libraryUnavailable: true } : {}) } });
      if (action.page.matches.length === 0) out.push({ name: 'results_empty', props: { mode } });
      break;
    }
    case 'loadFailed':
      out.push({ name: 'results_failed', props: { mode: prev.mode } });
      break;
    case 'loadMore':
      out.push({ name: 'generate_more_pressed', props: { shown: prev.shown, ...viewProps(prev) } });
      break;
    case 'gearDone': {
      // One record per adjustment, when the thumb is let go; dragging itself records nothing.
      const gear = action.gear;
      out.push({ name: EVENT.gearChange, props: { gear, value: next.tuner[gear], on: isOn(next.tuner, gear), mode: next.mode } });
      break;
    }
    case 'tuner': {
      const a = action.action;
      // Reset is a gear going off, at its default value.
      if (a.type === 'reset' && a.gear !== 'era') {
        out.push({ name: EVENT.gearChange, props: { gear: a.gear, value: next.tuner[a.gear], on: false, mode: next.mode } });
      } else if (a.type === 'reset') {
        out.push({ name: EVENT.eraChange, props: { era: null, picked: false, on: false, eras: next.tuner.eras.join(','), mode: next.mode } });
      } else if (a.type === 'era') {
        out.push({ name: EVENT.eraChange, props: { era: a.era, picked: next.tuner.eras.includes(a.era), on: isOn(next.tuner, 'era'), eras: next.tuner.eras.join(','), mode: next.mode } });
      }
      break;
    }
    case 'select': {
      const props: Record<string, EventValue> = { ...viewProps(prev), position: action.position ?? null };
      const key = catalogueKey(action.trackId);
      if (key) props.songKey = key;
      out.push({ name: EVENT.songOpen, props });
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
  if (action.type === 'micGranted') return next.step === 'mic' ? [] : [{ name: EVENT.micGranted, props: { via, browser } }];
  if (next.mic.view === prev.mic.view) return [];
  switch (next.mic.view) {
    case 'inapp':
      return [{ name: EVENT.inappBrowserDetected, props: { app: env?.inApp ?? 'webview', browser } }];
    case 'prompt':
      return [{ name: EVENT.micPromptShown, props: { browser } }];
    case 'recovery':
      return [
        { name: EVENT.micDenied, props: { reason: problem ?? 'denied', via, browser } },
        { name: EVENT.micRecoveryShown, props: { reason: problem ?? 'denied', browser } },
      ];
    default:
      return [];
  }
}

/** Events for arriving at a step. */
export function stepEvents(step: Step, s: FlowState): FunnelEvent[] {
  switch (step) {
    case 'landing':
      return [{ name: EVENT.titleView }];
    case 'quiet':
      return [{ name: 'quiet_shown' }];
    case 'signin':
      return s.range ? [{ name: 'range_shown', props: { low: s.range.low, high: s.range.high, spanSemitones: s.range.high - s.range.low } }] : [];
    default:
      return [];
  }
}
