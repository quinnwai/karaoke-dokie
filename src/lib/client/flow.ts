// The screen's flow as a pure reducer. Side effects (mic, fetch, storage,
// redirects) live in the component; this file only decides what shows next.

import type { DataSourceLogEntry, KnownSongsResponse, Match, MeResponse, Midi, RecommendationsResponse, VocalRange } from '../contracts';

export type Step =
  | 'boot' // asking /api/me who this is
  | 'landing' // the screen alone
  | 'quiet' // "Find a quiet spot"
  | 'low' // hold for the lowest note
  | 'high' // hold for the highest note
  | 'signin' // the bouncing arrow to Spotify
  | 'saving' // PUT /api/me/range
  | 'results' // song list (and song detail when `selectedId` is set)
  | 'pick'; // "pick songs you sing well"

/** What the hold button is doing on the low/high steps. */
export type HoldStatus = 'ready' | 'holding' | 'short' | 'order' | 'denied';

/** Test progress kept in sessionStorage so it survives the Spotify round trip. */
export interface TestProgress {
  low: Midi | null;
  high: Midi | null;
}

export type KnownSong = KnownSongsResponse['songs'][number];

export const MAX_PICKS = 3;

export interface FlowState {
  step: Step;
  hold: HoldStatus;
  low: Midi | null;
  high: Midi | null;
  signedIn: boolean;
  displayName: string | null;
  range: VocalRange | null;
  matches: Match[];
  sources: Record<string, DataSourceLogEntry>;
  nextOffset: number | null;
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
  low: null,
  high: null,
  signedIn: false,
  displayName: null,
  range: null,
  matches: [],
  sources: {},
  nextOffset: 0,
  loading: false,
  error: null,
  selectedId: null,
  feedback: {},
  known: null,
  picks: [],
  redoing: null,
};

export type FlowEvent =
  | { type: 'booted'; me: MeResponse | null; progress: TestProgress | null; wantsPick: boolean }
  | { type: 'start' }
  | { type: 'quietDone' }
  | { type: 'holdStart' }
  | { type: 'holdEnd'; midi: Midi | null }
  | { type: 'micDenied' }
  | { type: 'rangeSaved' }
  | { type: 'saveFailed' }
  | { type: 'retrySave' }
  | { type: 'loadMore' }
  | { type: 'pageLoaded'; page: RecommendationsResponse }
  | { type: 'loadFailed' }
  | { type: 'select'; trackId: string }
  | { type: 'deselect' }
  | { type: 'feedback'; trackId: string; thumbs: 'up' | 'down' }
  | { type: 'redo' }
  | { type: 'redoEnd'; end: 'low' | 'high' }
  | { type: 'pickStart' }
  | { type: 'knownLoaded'; songs: KnownSong[] }
  | { type: 'togglePick'; trackId: string }
  | { type: 'pickDone' };

const testRange = (low: Midi, high: Midi): VocalRange => ({ low, high, source: 'test' });

/** Clears everything about results so a new range starts from page one. */
const freshResults = {
  matches: [] as Match[],
  sources: {} as Record<string, DataSourceLogEntry>,
  nextOffset: 0 as number | null,
  selectedId: null,
  error: null,
};

export function flowReducer(state: FlowState, event: FlowEvent): FlowState {
  switch (event.type) {
    case 'booted': {
      const { me, progress, wantsPick } = event;
      const low = progress?.low ?? null;
      const high = progress?.high ?? null;
      if (me) {
        const base = { ...state, signedIn: true, displayName: me.displayName, low, high };
        if (low !== null && high !== null) return { ...base, step: 'saving', range: testRange(low, high) };
        if (wantsPick) return { ...base, step: 'pick', range: me.range };
        if (me.range) return { ...base, step: 'results', range: me.range, loading: true };
        if (low !== null) return { ...base, step: 'high' };
        return { ...base, step: 'landing' };
      }
      if (low !== null && high !== null) return { ...state, step: 'signin', low, high, range: testRange(low, high) };
      if (low !== null) return { ...state, step: 'high', low };
      return { ...state, step: 'landing' };
    }
    case 'start':
      return { ...state, step: 'quiet', hold: 'ready', low: null, high: null, redoing: null };
    case 'quietDone':
      return state.step === 'quiet' ? { ...state, step: 'low', hold: 'ready' } : state;
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
    case 'micDenied':
      return isHoldStep(state) ? { ...state, hold: 'denied' } : state;
    case 'rangeSaved':
      return { ...state, ...freshResults, step: 'results', loading: true };
    case 'saveFailed':
      return { ...state, error: 'save' };
    case 'retrySave':
      return { ...state, error: null };
    case 'loadMore':
      return state.nextOffset === null || state.loading ? state : { ...state, loading: true, error: null };
    case 'pageLoaded': {
      const { page } = event;
      const seen = new Set(state.matches.map((m) => m.track.id));
      const fresh = page.matches.filter((m) => !seen.has(m.track.id));
      return {
        ...state,
        loading: false,
        error: null,
        matches: [...state.matches, ...fresh],
        sources: { ...state.sources, ...page.sources },
        nextOffset: page.nextOffset,
      };
    }
    case 'loadFailed':
      return { ...state, loading: false, error: 'load' };
    case 'select':
      return { ...state, selectedId: event.trackId };
    case 'deselect':
      return { ...state, selectedId: null };
    case 'feedback':
      return { ...state, feedback: { ...state.feedback, [event.trackId]: event.thumbs } };
    case 'redo':
      return { ...state, ...freshResults, step: 'quiet', hold: 'ready', low: null, high: null, loading: false, picks: [], redoing: null };
    case 'redoEnd': {
      if (!state.range) return state;
      const keep = event.end === 'low' ? { low: null, high: state.range.high } : { low: state.range.low, high: null };
      return { ...state, ...keep, step: event.end, hold: 'ready', redoing: event.end, selectedId: null };
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
