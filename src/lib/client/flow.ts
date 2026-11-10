// The screen's flow as a pure reducer. Side effects (mic, fetch, storage,
// redirects) live in the component; this file only decides what shows next.
//
// Results come in two modes. Library: a signed-in Spotify user's own songs. Catalogue: anyone
// else, straight after the range test, from our public catalogue (QWW-2 Track B), with Spotify
// as an optional upgrade. Either way the server sends every match at once; the Setlist tuner (QWW-46,
// src/lib/setlist) holds what the singer has set, and the ranking engine orders the songs for it.

import type {
  DataSourceLogEntry,
  KnownSongsResponse,
  Match,
  MeResponse,
  Midi,
  RecommendationsResponse,
  ResultsMode,
  VocalRange,
} from '../contracts';
import type { BrowserInfo } from './browser';
import type { MicPermission, MicProblem } from './mic';
import { initialTuner, tunerReducer, type TunerAction } from '../setlist/tuner';
import type { GearId, TunerState } from '../setlist/types';

export type Step =
  | 'boot' // asking /api/me who this is
  | 'landing' // the screen alone
  | 'quiet' // "Find a quiet spot"
  | 'mic' // getting the microphone working (QWW-50); see MicGate
  | 'low' // hold for the lowest note
  | 'high' // hold for the highest note
  | 'signin' // "That's your range" and the arrow on to the songs (catalogue), or Spotify
  | 'saving' // PUT /api/me/range
  | 'results' // song list (and song detail when `selectedId` is set)
  | 'pick'; // "pick songs you sing well"

/** What the hold button is doing on the low/high steps. */
export type HoldStatus = 'ready' | 'holding' | 'short' | 'order';

/**
 * The mic step's screens (QWW-50). Older singers often miss, dismiss or block the browser's own microphone
 * question, so the step walks them through it:
 * - checking: looking at the browser and what it already says about the microphone (no screen yet)
 * - inapp: this page is inside another app's built-in browser, which often cannot use the microphone
 * - prompt: "Set up your microphone", before the browser's own question; its round button asks
 * - asking: the browser's question is up (or the microphone is opening after a tap)
 * - opening: the browser had already said yes, so the microphone opens by itself (no screen)
 * - recovery: it did not work; what to do, for this browser
 * A yes, from asking or opening, goes straight on to the note: there is no screen for it.
 */
export type MicView = 'checking' | 'inapp' | 'prompt' | 'asking' | 'opening' | 'recovery';

export interface MicGate {
  view: MicView;
  /** The hold step a yes leads to. */
  next: 'low' | 'high';
  /** What the browser is, once the step has looked. */
  env: BrowserInfo | null;
  /** Why the microphone is not on, on the recovery screen. */
  problem: MicProblem | null;
  /** How many times the answer was no. The recovery screen says "still" from the second. */
  fails: number;
  /** "Try here anyway" was tapped: the in-app screen does not come back this visit, since the guess may be wrong. */
  triedHere: boolean;
  /**
   * The microphone was lost during a note (another app took it, or its audio went silent). The browser may still say
   * "allowed", so this time our own screen shows instead of the microphone opening by itself: the tap on its button is
   * what starts the audio again.
   */
  lost: boolean;
}

/** Test progress kept in sessionStorage so it survives the Spotify round trip. */
export interface TestProgress {
  low: Midi | null;
  high: Midi | null;
}

export type KnownSong = KnownSongsResponse['songs'][number];

export const MAX_PICKS = 3;
/** Songs shown at first and added by each "Load more". The list slides its rows when it re-ranks (FLIP), so it stays short. */
export const SHOW_STEP = 40;
/** How many times an incomplete library load is asked for again (the server continues its lookups). */
export const MAX_LOAD_ATTEMPTS = 5;

export interface FlowState {
  step: Step;
  hold: HoldStatus;
  /** The mic step's own state; only read while `step` is 'mic'. */
  mic: MicGate;
  low: Midi | null;
  high: Midi | null;
  signedIn: boolean;
  displayName: string | null;
  range: VocalRange | null;
  /** Where results come from: the Spotify library (signed in) or the catalogue (no Spotify). */
  mode: ResultsMode;
  /**
   * A signed-in singer whose Spotify library could not be read: the server sent the catalogue's songs instead
   * (`libraryUnavailable`), so `mode` is 'catalogue' for the list but the singer is still signed in (QWW-55).
   */
  libraryUnavailable: boolean;
  /** Every match, in the server's Top picks order. */
  matches: Match[];
  sources: Record<string, DataSourceLogEntry>;
  /** What the singer has set on the Setlist tuner: the gears, the eras, the sheet mode. */
  tuner: TunerState;
  /** How many songs of the ranked list are on screen. */
  shown: number;
  /** Load attempts so far; an incomplete library load asks again (see MAX_LOAD_ATTEMPTS). */
  attempt: number;
  loading: boolean;
  error: 'save' | 'load' | null;
  selectedId: string | null;
  feedback: Record<string, 'up' | 'down'>;
  known: KnownSong[] | null;
  picks: string[];
  /** Set while re-singing just one end of a saved range; the other end is kept. */
  redoing: 'low' | 'high' | null;
}

export const initialState: FlowState = {
  step: 'boot',
  hold: 'ready',
  mic: { view: 'checking', next: 'low', env: null, problem: null, fails: 0, triedHere: false, lost: false },
  low: null,
  high: null,
  signedIn: false,
  displayName: null,
  range: null,
  mode: 'library',
  libraryUnavailable: false,
  matches: [],
  sources: {},
  tuner: initialTuner(),
  shown: SHOW_STEP,
  attempt: 0,
  loading: false,
  error: null,
  selectedId: null,
  feedback: {},
  known: null,
  picks: [],
  redoing: null,
};

export type FlowEvent =
  | {
      type: 'booted';
      me: MeResponse | null;
      progress: TestProgress | null;
      wantsPick: boolean;
      /** A range kept on this device by someone without Spotify. */
      savedRange?: { low: Midi; high: Midi } | null;
      /** Start the tuner's sheet in mini mode (`?mini=1`). */
      mini?: boolean;
    }
  | { type: 'start' }
  | { type: 'quietDone' }
  | { type: 'holdStart' }
  | { type: 'holdEnd'; midi: Midi | null }
  /** The mic step looked at the browser and asked what it already knows about the microphone (this never shows a question). */
  | { type: 'micChecked'; env: BrowserInfo; permission: MicPermission }
  /** "Turn on microphone" or "Try again" was tapped: the browser's own question comes up. */
  | { type: 'micAsk' }
  /** The microphone is on: straight on to the note. */
  | { type: 'micGranted' }
  | { type: 'micFailed'; reason: MicProblem }
  /** "Try here anyway" on the in-app screen. */
  | { type: 'micTryHere' }
  /** The microphone went away or went silent during a hold step (the permission was taken back, another app took it): the mic step again. */
  | { type: 'micLost' }
  | { type: 'rangeSaved' }
  | { type: 'saveFailed' }
  | { type: 'retrySave' }
  | { type: 'showCatalogue' }
  /** The session ended (the Spotify logo's Log out): the library goes, the same range shows catalogue songs. */
  | { type: 'loggedOut' }
  | { type: 'loadMore' }
  | { type: 'allLoaded'; page: RecommendationsResponse }
  | { type: 'loadFailed' }
  | { type: 'retryLoad' }
  /** Something on the Setlist tuner changed. A slider fires continuously while dragging, so the list follows the thumb. */
  | { type: 'tuner'; action: TunerAction }
  /** A thumb was let go: only the event log cares (one record per adjustment, not per pixel). */
  | { type: 'gearDone'; gear: GearId }
  | { type: 'select'; trackId: string; /** 1-based place in the list on screen, for the event log. */ position?: number }
  | { type: 'deselect' }
  | { type: 'feedback'; trackId: string; thumbs: 'up' | 'down' }
  | { type: 'redo' }
  | { type: 'redoEnd'; end: 'low' | 'high' }
  | { type: 'pickStart' }
  | { type: 'knownLoaded'; songs: KnownSong[] }
  | { type: 'togglePick'; trackId: string }
  | { type: 'pickDone' };

const testRange = (low: Midi, high: Midi): VocalRange => ({ low, high, source: 'test' });

/** Clears everything about results so a new range starts from the top. The tuner keeps what the singer set. */
function freshResults() {
  return {
    libraryUnavailable: false,
    matches: [] as Match[],
    sources: {} as Record<string, DataSourceLogEntry>,
    shown: SHOW_STEP,
    attempt: 0,
    selectedId: null,
    error: null,
  };
}

/** Listening history is Spotify's: it needs a library, not the catalogue (spec: logged out, the gear is off and disabled). */
export const historyAvailable = (state: Pick<FlowState, 'mode'>): boolean => state.mode === 'library';

/**
 * The way into a hold step when the microphone is not open (QWW-50): the mic step first, then `next`.
 * Starts it from the top every time, since the browser may have been asked since and the answer may
 * have changed; what the browser is, and that "Try here anyway" was tapped, stay. `lost` is for a microphone that
 * went away or silent during a note (see MicGate).
 */
function enterMic(state: FlowState, next: 'low' | 'high', lost = false): FlowState {
  return { ...state, step: 'mic', hold: 'ready', mic: { ...initialState.mic, next, env: state.mic.env, triedHere: state.mic.triedHere, lost } };
}

/** The mic step moves only on an event meant for the screen it is on, so a late answer cannot undo a later one. */
const inMic = (state: FlowState, ...views: MicView[]): boolean => state.step === 'mic' && views.includes(state.mic.view);

export function flowReducer(state: FlowState, event: FlowEvent): FlowState {
  switch (event.type) {
    case 'booted': {
      const { me, progress, wantsPick, savedRange } = event;
      const low = progress?.low ?? null;
      const high = progress?.high ?? null;
      // The tuner starts from its defaults (a reload, as after the Spotify round trip, starts it over).
      const fresh = { ...state, tuner: initialTuner({ mini: event.mini }) };
      if (me) {
        const base = { ...fresh, signedIn: true, displayName: me.displayName, low, high, mode: 'library' as const };
        if (low !== null && high !== null) return { ...base, step: 'saving', range: testRange(low, high) };
        if (wantsPick) return { ...base, step: 'pick', range: me.range };
        if (me.range) return { ...base, step: 'results', range: me.range, loading: true };
        if (low !== null) return enterMic(base, 'high');
        return { ...base, step: 'landing' };
      }
      if (low !== null && high !== null) return { ...fresh, step: 'signin', low, high, range: testRange(low, high) };
      if (low !== null) return enterMic({ ...fresh, low }, 'high');
      if (savedRange) {
        const range = testRange(savedRange.low, savedRange.high);
        return { ...fresh, ...freshResults(), step: 'results', mode: 'catalogue', range, loading: true };
      }
      return { ...fresh, step: 'landing' };
    }
    case 'start':
      return { ...state, step: 'quiet', hold: 'ready', low: null, high: null, redoing: null };
    case 'quietDone':
      return state.step === 'quiet' ? enterMic(state, 'low') : state;
    case 'holdStart':
      return isHoldStep(state) ? { ...state, hold: 'holding' } : state;
    case 'holdEnd': {
      if (!isHoldStep(state)) return state;
      const { midi } = event;
      if (midi === null) return { ...state, hold: 'short' };
      const done = (low: Midi, high: Midi): FlowState => ({
        ...state,
        low,
        high,
        hold: 'ready',
        redoing: null,
        range: testRange(low, high),
        step: state.signedIn ? 'saving' : 'signin',
      });
      if (state.step === 'low') {
        if (state.redoing !== 'low' || state.high === null) return { ...state, step: 'high', hold: 'ready', low: midi };
        return midi >= state.high ? { ...state, hold: 'order' } : done(midi, state.high);
      }
      if (state.low !== null && midi <= state.low) return { ...state, hold: 'order' };
      return done(state.low ?? midi, midi);
    }
    case 'micChecked': {
      if (!inMic(state, 'checking')) return state;
      const { env, permission } = event;
      const mic = { ...state.mic, env };
      // Inside another app: say so before anything else (unless the singer said to try here anyway). Already blocked: no
      // point asking, go straight to what to do.
      if (env.inApp && !mic.triedHere) return { ...state, mic: { ...mic, view: 'inapp' } };
      if (permission === 'denied') return { ...state, mic: { ...mic, view: 'recovery', problem: 'denied', fails: mic.fails + 1 } };
      // Already allowed: the microphone opens by itself and the singer goes straight on to the note. Not after a lost
      // microphone: the browser still says yes, but the audio went quiet, and only a tap on our screen starts it again.
      return { ...state, mic: { ...mic, view: permission === 'granted' && !mic.lost ? 'opening' : 'prompt' } };
    }
    case 'micAsk':
      return inMic(state, 'prompt', 'recovery') ? { ...state, mic: { ...state.mic, view: 'asking' } } : state;
    case 'micGranted':
      return inMic(state, 'asking', 'opening') ? { ...state, step: state.mic.next, hold: 'ready', mic: { ...state.mic, problem: null } } : state;
    case 'micFailed':
      return inMic(state, 'asking', 'opening')
        ? { ...state, mic: { ...state.mic, view: 'recovery', problem: event.reason, fails: state.mic.fails + 1 } }
        : state;
    case 'micTryHere':
      return inMic(state, 'inapp') ? { ...state, mic: { ...state.mic, view: 'prompt', triedHere: true } } : state;
    case 'micLost':
      return state.step === 'low' || state.step === 'high' ? enterMic(state, state.step, true) : state;
    case 'rangeSaved':
      return { ...state, ...freshResults(), step: 'results', mode: 'library', loading: true };
    case 'showCatalogue':
      return state.range ? { ...state, ...freshResults(), step: 'results', mode: 'catalogue', loading: true } : state;
    case 'loggedOut': {
      // Nothing of the library stays: not its matches, not the songs offered to pick from.
      const out = { ...state, signedIn: false, displayName: null, known: null, picks: [] };
      return state.range ? { ...out, ...freshResults(), step: 'results', mode: 'catalogue', loading: true } : out;
    }
    case 'saveFailed':
      return { ...state, error: 'save' };
    case 'retrySave':
      return { ...state, error: null };
    case 'loadMore':
      return { ...state, shown: state.shown + SHOW_STEP };
    case 'allLoaded': {
      const { page } = event;
      const attempt = state.attempt + 1;
      // The server stops its lookups at a budget on a very large first visit, and says so with a
      // nextOffset; ask again to finish. A list trimmed to the best matches has no nextOffset.
      const again = page.complete === false && page.nextOffset !== null && attempt < MAX_LOAD_ATTEMPTS;
      // A library the server could not read comes back as catalogue songs: shown as such (no listening history), with its note.
      const libraryUnavailable = page.libraryUnavailable === true;
      const mode = libraryUnavailable ? 'catalogue' : state.mode;
      return { ...state, mode, libraryUnavailable, loading: again, attempt, error: null, matches: page.matches, sources: page.sources };
    }
    case 'loadFailed':
      return { ...state, loading: false, error: 'load' };
    case 'retryLoad':
      return state.step === 'results' ? { ...state, loading: true, error: null, attempt: 0 } : state;
    case 'tuner': {
      const { action } = event;
      // Listening history is Spotify's: without a library the gear is off and cannot be turned on.
      if ((action.type === 'input' || action.type === 'touch') && action.gear === 'history' && !historyAvailable(state)) return state;
      return { ...state, tuner: tunerReducer(state.tuner, action) };
    }
    case 'gearDone':
      return state;
    case 'select':
      return { ...state, selectedId: event.trackId };
    case 'deselect':
      return { ...state, selectedId: null };
    case 'feedback':
      return { ...state, feedback: { ...state.feedback, [event.trackId]: event.thumbs } };
    case 'redo':
      return { ...state, ...freshResults(), step: 'quiet', hold: 'ready', low: null, high: null, loading: false, picks: [], redoing: null };
    case 'redoEnd': {
      if (!state.range) return state;
      const keep = event.end === 'low' ? { low: null, high: state.range.high } : { low: state.range.low, high: null };
      return enterMic({ ...state, ...keep, redoing: event.end, selectedId: null }, event.end);
    }
    case 'pickStart':
      return { ...state, step: 'pick', picks: [], selectedId: null };
    case 'knownLoaded':
      return { ...state, known: event.songs };
    case 'togglePick': {
      const has = state.picks.includes(event.trackId);
      if (has) return { ...state, picks: state.picks.filter((id) => id !== event.trackId) };
      if (state.picks.length >= MAX_PICKS) return state;
      return { ...state, picks: [...state.picks, event.trackId] };
    }
    case 'pickDone': {
      const range = rangeFromPicks(state.known ?? [], state.picks);
      return range ? { ...state, step: 'saving', range, error: null } : state;
    }
  }
}

function isHoldStep(state: FlowState): boolean {
  return state.step === 'low' || state.step === 'high';
}

/** Lowest low and highest high of the picked songs. */
export function rangeFromPicks(known: KnownSong[], picks: string[]): VocalRange | null {
  const chosen = known.filter((s) => picks.includes(s.track.id));
  if (!chosen.length) return null;
  return {
    low: Math.min(...chosen.map((s) => s.range.low)),
    high: Math.max(...chosen.map((s) => s.range.high)),
    source: 'songs',
  };
}
