// The screen's flow as a pure reducer. Side effects (mic, fetch, storage,
// redirects) live in the component; this file only decides what shows next.
//
// Results come in two modes. Library: a signed-in Spotify user's own songs. Catalogue: anyone
// else, straight after the range test, from our public catalogue (QWW-2 Track B), with Spotify
// as an optional upgrade. Either way the server sends every match at once and the phone orders,
// filters and pages them (src/lib/songs/browse.ts).

import type {
  Decade,
  DataSourceLogEntry,
  KnownSongsResponse,
  Match,
  MeResponse,
  Midi,
  Mood,
  RecommendationsResponse,
  ResultsMode,
  ResultsView,
  SliderId,
  VocalRange,
} from '../contracts';
import { availableSliders, DEFAULT_VIEW, fitViewTo, pickDecade, pickMood, toggleDuets } from '../songs/browse';

export type Step =
  | 'boot' // asking /api/me who this is
  | 'landing' // the screen alone
  | 'quiet' // "Find a quiet spot"
  | 'low' // hold for the lowest note
  | 'high' // hold for the highest note
  | 'signin' // "That's your range" and the arrow on to the songs (catalogue), or Spotify
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
/** Songs shown at first and added by each "Load more". */
export const SHOW_STEP = 5;
/** How many times an incomplete library load is asked for again (the server continues its lookups). */
export const MAX_LOAD_ATTEMPTS = 5;

export interface FlowState {
  step: Step;
  hold: HoldStatus;
  low: Midi | null;
  high: Midi | null;
  signedIn: boolean;
  displayName: string | null;
  range: VocalRange | null;
  /** Where results come from: the Spotify library (signed in) or the catalogue (no Spotify). */
  mode: ResultsMode;
  /** Every match, in the server's Top picks order. */
  matches: Match[];
  sources: Record<string, DataSourceLogEntry>;
  /** The sliders set and the chips picked on the results screen. */
  view: ResultsView;
  /** The slider moved last: it leads the lyric line and the reason line. */
  leadSlider: SliderId | null;
  /** How many songs of the current view are on screen. */
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
  low: null,
  high: null,
  signedIn: false,
  displayName: null,
  range: null,
  mode: 'library',
  matches: [],
  sources: {},
  view: DEFAULT_VIEW,
  leadSlider: null,
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
    }
  | { type: 'start' }
  | { type: 'quietDone' }
  | { type: 'holdStart' }
  | { type: 'holdEnd'; midi: Midi | null }
  | { type: 'micDenied' }
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
  /** A slider moved (null = unset it). Fires continuously while dragging, so the list follows the thumb. */
  | { type: 'setSlider'; slider: SliderId; value: number | null }
  /** The thumb was let go: only the event log cares (one record per adjustment, not per pixel). */
  | { type: 'sliderDone'; slider: SliderId }
  | { type: 'resetSliders' }
  | { type: 'pickDecade'; decade: Decade }
  | { type: 'pickMood'; mood: Mood }
  | { type: 'toggleDuets' }
  | { type: 'clearFilters' }
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

/** Clears everything about results so a new range starts from the top, keeping only the sliders. */
function freshResults(state: FlowState) {
  return {
    matches: [] as Match[],
    sources: {} as Record<string, DataSourceLogEntry>,
    view: { ...DEFAULT_VIEW, difficulty: state.view.difficulty, familiarity: state.view.familiarity, popularity: state.view.popularity },
    shown: SHOW_STEP,
    attempt: 0,
    selectedId: null,
    error: null,
  };
}

/** A view change shows the new list from its first song. */
const withView = (state: FlowState, view: ResultsView): FlowState => ({ ...state, view, shown: SHOW_STEP, selectedId: null });

export function flowReducer(state: FlowState, event: FlowEvent): FlowState {
  switch (event.type) {
    case 'booted': {
      const { me, progress, wantsPick, savedRange } = event;
      const low = progress?.low ?? null;
      const high = progress?.high ?? null;
      if (me) {
        const base = { ...state, signedIn: true, displayName: me.displayName, low, high, mode: 'library' as const };
        if (low !== null && high !== null) return { ...base, step: 'saving', range: testRange(low, high) };
        if (wantsPick) return { ...base, step: 'pick', range: me.range };
        if (me.range) return { ...base, step: 'results', range: me.range, loading: true };
        if (low !== null) return { ...base, step: 'high' };
        return { ...base, step: 'landing' };
      }
      if (low !== null && high !== null) return { ...state, step: 'signin', low, high, range: testRange(low, high) };
      if (low !== null) return { ...state, step: 'high', low };
      if (savedRange) {
        const range = testRange(savedRange.low, savedRange.high);
        return { ...state, ...freshResults(state), step: 'results', mode: 'catalogue', range, loading: true };
      }
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
      return { ...state, ...freshResults(state), step: 'results', mode: 'library', loading: true };
    case 'showCatalogue':
      return state.range ? { ...state, ...freshResults(state), step: 'results', mode: 'catalogue', loading: true } : state;
    case 'loggedOut': {
      // Nothing of the library stays: not its matches, not the songs offered to pick from.
      const out = { ...state, signedIn: false, displayName: null, known: null, picks: [] };
      return state.range ? { ...out, ...freshResults(state), step: 'results', mode: 'catalogue', loading: true } : out;
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
      // Sliders this list cannot offer (no listening data, no popularity) are unset.
      const view = fitViewTo(state.view, availableSliders(state.mode, page.matches));
      const leadSlider = state.leadSlider && view[state.leadSlider] !== null ? state.leadSlider : null;
      return { ...state, loading: again, attempt, error: null, matches: page.matches, sources: page.sources, view, leadSlider };
    }
    case 'loadFailed':
      return { ...state, loading: false, error: 'load' };
    case 'retryLoad':
      return state.step === 'results' ? { ...state, loading: true, error: null, attempt: 0 } : state;
    case 'setSlider': {
      const value = event.value === null ? null : Math.min(1, Math.max(0, event.value));
      const view = { ...state.view, [event.slider]: value };
      return { ...withView(state, view), leadSlider: value === null ? null : event.slider };
    }
    case 'sliderDone':
      return state;
    case 'resetSliders':
      return { ...withView(state, { ...state.view, difficulty: null, familiarity: null, popularity: null }), leadSlider: null };
    case 'pickDecade':
      return withView(state, pickDecade(state.view, event.decade));
    case 'pickMood':
      return withView(state, pickMood(state.view, event.mood));
    case 'toggleDuets':
      return withView(state, toggleDuets(state.view));
    case 'clearFilters':
      return withView(state, { ...state.view, decade: null, mood: null, duetsOnly: false });
    case 'select':
      return { ...state, selectedId: event.trackId };
    case 'deselect':
      return { ...state, selectedId: null };
    case 'feedback':
      return { ...state, feedback: { ...state.feedback, [event.trackId]: event.thumbs } };
    case 'redo':
      return { ...state, ...freshResults(state), step: 'quiet', hold: 'ready', low: null, high: null, loading: false, picks: [], redoing: null };
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
