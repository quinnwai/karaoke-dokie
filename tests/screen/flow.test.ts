// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { flowReducer, initialState, rangeFromPicks, type FlowEvent, type FlowState } from '../../src/lib/client/flow';
import { allMatches, knownSongs, me } from '../fixtures/screen';

const run = (events: FlowEvent[], from: FlowState = initialState) => events.reduce(flowReducer, from);
const signedOut: FlowEvent = { type: 'booted', me: null, progress: null, wantsPick: false };

describe('boot', () => {
  it('new visitors land on the screen', () => {
    expect(run([signedOut]).step).toBe('landing');
  });

  it('returning user with a saved range goes straight to results', () => {
    const s = run([{ type: 'booted', me: me({ low: 45, high: 72, source: 'test' }), progress: null, wantsPick: false }]);
    expect(s.step).toBe('results');
    expect(s.loading).toBe(true);
    expect(s.range).toEqual({ low: 45, high: 72, source: 'test' });
  });

  it('after sign-in, a finished test in storage is saved first', () => {
    const s = run([{ type: 'booted', me: me(), progress: { low: 45, high: 72 }, wantsPick: false }]);
    expect(s.step).toBe('saving');
    expect(s.range).toEqual({ low: 45, high: 72, source: 'test' });
  });

  it('after sign-in, a very low or very high note in storage is saved as sung', () => {
    const s = run([{ type: 'booted', me: me(), progress: { low: 37, high: 88 }, wantsPick: false }]);
    expect(s.step).toBe('saving');
    expect(s.range).toEqual({ low: 37, high: 88, source: 'test' });
  });

  it('a fresh test result wins over an older saved range', () => {
    const s = run([{ type: 'booted', me: me({ low: 40, high: 60, source: 'songs' }), progress: { low: 45, high: 72 }, wantsPick: false }]);
    expect(s.step).toBe('saving');
    expect(s.range?.low).toBe(45);
  });

  it('resumes a half-done test', () => {
    expect(run([{ type: 'booted', me: null, progress: { low: 45, high: null }, wantsPick: false }]).step).toBe('high');
    expect(run([{ type: 'booted', me: null, progress: { low: 45, high: 72 }, wantsPick: false }]).step).toBe('signin');
  });

  it('goes to song picking when the user asked for it before sign-in', () => {
    expect(run([{ type: 'booted', me: me(), progress: null, wantsPick: true }]).step).toBe('pick');
  });

  it('someone without Spotify who kept a range on this device goes straight to catalogue songs', () => {
    const s = run([{ type: 'booted', me: null, progress: null, wantsPick: false, savedRange: { low: 45, high: 72 } }]);
    expect(s).toMatchObject({ step: 'results', mode: 'catalogue', loading: true, range: { low: 45, high: 72, source: 'test' } });
  });

  it('a half-done test wins over a range kept on the device, and Spotify wins over both', () => {
    expect(run([{ type: 'booted', me: null, progress: { low: 45, high: null }, wantsPick: false, savedRange: { low: 40, high: 60 } }]).step).toBe('high');
    const signedIn = run([{ type: 'booted', me: me({ low: 45, high: 72, source: 'test' }), progress: null, wantsPick: false, savedRange: { low: 40, high: 60 } }]);
    expect(signedIn).toMatchObject({ step: 'results', mode: 'library', range: { low: 45, high: 72 } });
  });
});

describe('the singing test', () => {
  const toLow = [signedOut, { type: 'start' }, { type: 'quietDone' }] as FlowEvent[];

  it('walks landing, quiet spot, low, high, sign-in', () => {
    let s = run([signedOut, { type: 'start' }]);
    expect(s.step).toBe('quiet');
    s = run([{ type: 'quietDone' }], s);
    expect(s.step).toBe('low');
    s = run([{ type: 'holdStart' }], s);
    expect(s.hold).toBe('holding');
    s = run([{ type: 'holdEnd', midi: 45 }], s);
    expect(s).toMatchObject({ step: 'high', low: 45, hold: 'ready' });
    s = run([{ type: 'holdStart' }, { type: 'holdEnd', midi: 72 }], s);
    expect(s).toMatchObject({ step: 'signin', high: 72, range: { low: 45, high: 72, source: 'test' } });
  });

  it('registers a very low note and a very high note as sung, without asking', () => {
    let s = run([...toLow, { type: 'holdStart' }, { type: 'holdEnd', midi: 37 }]);
    expect(s).toMatchObject({ step: 'high', hold: 'ready', low: 37 });
    s = run([{ type: 'holdStart' }, { type: 'holdEnd', midi: 88 }], s);
    expect(s).toMatchObject({ step: 'signin', range: { low: 37, high: 88, source: 'test' } });
  });

  it('asks again when nothing was held long enough', () => {
    const s = run([...toLow, { type: 'holdStart' }, { type: 'holdEnd', midi: null }]);
    expect(s).toMatchObject({ step: 'low', hold: 'short', low: null });
  });

  it('rejects a high note at or below the low note', () => {
    const s = run([...toLow, { type: 'holdEnd', midi: 50 }, { type: 'holdEnd', midi: 48 }]);
    expect(s).toMatchObject({ step: 'high', hold: 'order', high: null });
  });

  it('shows the mic-denied line', () => {
    expect(run([...toLow, { type: 'holdStart' }, { type: 'micDenied' }]).hold).toBe('denied');
  });

  it('a signed-in user skips the arrow and saves', () => {
    const s = run([{ type: 'booted', me: me(), progress: null, wantsPick: false }, { type: 'start' }, { type: 'quietDone' }, { type: 'holdEnd', midi: 45 }, { type: 'holdEnd', midi: 72 }]);
    expect(s.step).toBe('saving');
  });

  it('ignores hold events outside the hold steps', () => {
    const s = run([signedOut, { type: 'holdEnd', midi: 45 }]);
    expect(s.step).toBe('landing');
    expect(s.low).toBeNull();
  });
});

describe('results', () => {
  const atResults = run([{ type: 'booted', me: me({ low: 45, high: 72, source: 'test' }), progress: null, wantsPick: false }]);
  const loaded = run([{ type: 'allLoaded', page: allMatches() }], atResults);

  it('takes every match at once and pages them on the phone', () => {
    expect(loaded.matches).toHaveLength(10);
    expect(Object.keys(loaded.sources)).toHaveLength(10);
    expect(loaded.loading).toBe(false);
    expect(loaded.shown).toBe(5);
    const more = run([{ type: 'loadMore' }], loaded);
    expect(more.shown).toBe(10);
    expect(more.loading).toBe(false);
  });

  it('asks again while the server is still looking songs up, a few times at most', () => {
    const partial = { ...allMatches(4), complete: false, nextOffset: 4 };
    let s = run([{ type: 'allLoaded', page: partial }], atResults);
    expect(s).toMatchObject({ loading: true, attempt: 1 });
    expect(s.matches).toHaveLength(4);
    s = run([{ type: 'allLoaded', page: allMatches() }], s);
    expect(s).toMatchObject({ loading: false, attempt: 2 });
    const stuck = run(Array.from({ length: 6 }, () => ({ type: 'allLoaded', page: partial }) as FlowEvent), atResults);
    expect(stuck.loading).toBe(false);
  });

  it('does not ask again for a list the server trimmed to its best matches', () => {
    const trimmed = { ...allMatches(), complete: false, nextOffset: null };
    expect(run([{ type: 'allLoaded', page: trimmed }], atResults)).toMatchObject({ loading: false, attempt: 1 });
  });

  it('a failed load can be retried', () => {
    const failed = run([{ type: 'loadFailed' }], atResults);
    expect(failed).toMatchObject({ loading: false, error: 'load' });
    expect(run([{ type: 'retryLoad' }], failed)).toMatchObject({ loading: true, error: null });
  });

  it('moving a slider or tapping a chip shows the new list from its first song', () => {
    let s = run([{ type: 'loadMore' }, { type: 'setSlider', slider: 'difficulty', value: 0.2 }], loaded);
    expect(s.view.difficulty).toBe(0.2);
    expect(s.leadSlider).toBe('difficulty');
    expect(s.shown).toBe(5);
    s = run([{ type: 'loadMore' }, { type: 'pickDecade', decade: '80s' }], s);
    expect(s.view).toMatchObject({ difficulty: 0.2, decade: '80s' });
    expect(s.shown).toBe(5);
    s = run([{ type: 'pickDecade', decade: '90s' }, { type: 'pickMood', mood: 'upbeat' }, { type: 'toggleDuets' }], s);
    expect(s.view).toEqual({ difficulty: 0.2, familiarity: null, popularity: null, decade: '90s', mood: 'upbeat', duetsOnly: true });
    s = run([{ type: 'clearFilters' }], s);
    expect(s.view).toEqual({ difficulty: 0.2, familiarity: null, popularity: null, decade: null, mood: null, duetsOnly: false });
  });

  it('a slider is clamped to its track, the last one moved leads, and Reset unsets them all', () => {
    let s = run([{ type: 'setSlider', slider: 'difficulty', value: -3 }, { type: 'setSlider', slider: 'familiarity', value: 9 }], loaded);
    expect(s.view).toMatchObject({ difficulty: 0, familiarity: 1 });
    expect(s.leadSlider).toBe('familiarity');
    expect(run([{ type: 'sliderDone', slider: 'familiarity' }], s)).toBe(s);
    expect(run([{ type: 'setSlider', slider: 'familiarity', value: null }], s).leadSlider).toBeNull();
    s = run([{ type: 'pickDecade', decade: '80s' }, { type: 'resetSliders' }], s);
    expect(s.view).toEqual({ difficulty: null, familiarity: null, popularity: null, decade: '80s', mood: null, duetsOnly: false });
    expect(s.leadSlider).toBeNull();
  });

  it('a slider the new list cannot offer is unset', () => {
    // The catalogue has no listening data, so "on repeat" is not offered there.
    const s = run([{ type: 'setSlider', slider: 'familiarity', value: 0.9 }, { type: 'allLoaded', page: allMatches() }], { ...atResults, mode: 'catalogue' });
    expect(s.view.familiarity).toBeNull();
    expect(s.leadSlider).toBeNull();
  });

  it('opens and closes a song, and remembers feedback', () => {
    let s = run([{ type: 'select', trackId: 't2' }], loaded);
    expect(s.selectedId).toBe('t2');
    s = run([{ type: 'feedback', trackId: 't2', thumbs: 'up' }, { type: 'deselect' }], s);
    expect(s.selectedId).toBeNull();
    expect(s.feedback).toEqual({ t2: 'up' });
  });

  it('re-sings just the low note and keeps the high one', () => {
    let s = run([{ type: 'redoEnd', end: 'low' }], loaded);
    expect(s).toMatchObject({ step: 'low', low: null, high: 72, redoing: 'low' });
    expect(run([{ type: 'holdEnd', midi: 74 }], s)).toMatchObject({ step: 'low', hold: 'order' });
    s = run([{ type: 'holdEnd', midi: 48 }], s);
    expect(s).toMatchObject({ step: 'saving', range: { low: 48, high: 72, source: 'test' }, redoing: null });
    expect(run([{ type: 'rangeSaved' }], s)).toMatchObject({ step: 'results', mode: 'library', matches: [], loading: true });
  });

  it('re-sings just the high note and keeps the low one', () => {
    let s = run([{ type: 'redoEnd', end: 'high' }], atResults);
    expect(s).toMatchObject({ step: 'high', low: 45, high: null, redoing: 'high' });
    s = run([{ type: 'holdEnd', midi: 70 }], s);
    expect(s).toMatchObject({ step: 'saving', range: { low: 45, high: 70 } });
  });

  it('redo restarts the test, clears results and filters, and keeps the sliders', () => {
    const s = run([{ type: 'setSlider', slider: 'difficulty', value: 0.8 }, { type: 'pickDecade', decade: '80s' }, { type: 'redo' }], loaded);
    expect(s).toMatchObject({ step: 'quiet', low: null, high: null, matches: [], signedIn: true });
    expect(s.view).toEqual({ difficulty: 0.8, familiarity: null, popularity: null, decade: null, mood: null, duetsOnly: false });
  });
});

describe('no Spotify (catalogue mode)', () => {
  const tested = run([signedOut, { type: 'start' }, { type: 'quietDone' }, { type: 'holdEnd', midi: 45 }, { type: 'holdEnd', midi: 72 }]);

  it('after the test, the arrow shows catalogue songs with no sign-in', () => {
    expect(tested.step).toBe('signin');
    const s = run([{ type: 'showCatalogue' }], tested);
    expect(s).toMatchObject({ step: 'results', mode: 'catalogue', loading: true, signedIn: false, range: { low: 45, high: 72 } });
  });

  it('needs a range first', () => {
    expect(run([signedOut, { type: 'showCatalogue' }]).step).toBe('landing');
  });

  it('a catalogue singer who redoes the test comes back to the arrow, not to Spotify', () => {
    const s = run([{ type: 'showCatalogue' }, { type: 'allLoaded', page: allMatches() }, { type: 'redoEnd', end: 'high' }, { type: 'holdEnd', midi: 70 }], tested);
    expect(s).toMatchObject({ step: 'signin', range: { low: 45, high: 70 } });
  });
});

describe('logging out', () => {
  const signedInRange = { low: 45, high: 72, source: 'test' as const };
  const inLibrary = run([
    { type: 'booted', me: me(signedInRange), progress: null, wantsPick: false },
    { type: 'allLoaded', page: allMatches() },
    { type: 'setSlider', slider: 'difficulty', value: 0.8 },
    { type: 'setSlider', slider: 'familiarity', value: 0.2 },
    { type: 'pickMood', mood: 'upbeat' },
    { type: 'loadMore' },
  ]);

  it('shows the catalogue for the same range and forgets the library, who it was and the picks', () => {
    expect(inLibrary).toMatchObject({ mode: 'library', signedIn: true, displayName: 'Quinn' });
    expect(inLibrary.matches.length).toBeGreaterThan(0);
    const s = run([{ type: 'loggedOut' }], { ...inLibrary, known: knownSongs().songs, picks: ['t0'] });
    expect(s).toMatchObject({
      step: 'results',
      mode: 'catalogue',
      loading: true,
      signedIn: false,
      displayName: null,
      range: signedInRange,
      matches: [],
      sources: {},
      known: null,
      picks: [],
      shown: 5,
      selectedId: null,
    });
  });

  it('keeps the sliders and drops the chips, as a new range does', () => {
    const s = run([{ type: 'loggedOut' }], inLibrary);
    expect(s.view).toEqual({ difficulty: 0.8, familiarity: 0.2, popularity: null, decade: null, mood: null, duetsOnly: false });
  });

  it('asks the catalogue for songs once, then drops the sliders it has no data for (on repeat is the library\'s)', () => {
    const s = run([{ type: 'loggedOut' }, { type: 'allLoaded', page: allMatches() }], inLibrary);
    expect(s).toMatchObject({ mode: 'catalogue', loading: false, signedIn: false });
    expect(s.matches.length).toBeGreaterThan(0);
    expect(s.view.familiarity).toBeNull();
    expect(s.view.difficulty).toBe(0.8);
  });

  it('with no range there are no results to replace; it only signs out', () => {
    const s = run([{ type: 'booted', me: me(), progress: null, wantsPick: false }, { type: 'loggedOut' }]);
    expect(s).toMatchObject({ step: 'landing', signedIn: false, displayName: null, range: null });
  });
});

describe('pick songs you sing well', () => {
  const songs = knownSongs().songs;
  const atPick = run([{ type: 'booted', me: me(), progress: null, wantsPick: true }, { type: 'knownLoaded', songs }]);

  it('allows at most three picks and toggles them off', () => {
    let s = run(['t0', 't1', 't3', 't4'].map((trackId) => ({ type: 'togglePick', trackId }) as FlowEvent), atPick);
    expect(s.picks).toEqual(['t0', 't1', 't3']);
    s = run([{ type: 'togglePick', trackId: 't1' }], s);
    expect(s.picks).toEqual(['t0', 't3']);
  });

  it('uses the lowest low and highest high of the picks', () => {
    expect(rangeFromPicks(songs, ['t0', 't1', 't3'])).toEqual({ low: 46, high: 74, source: 'songs' });
    const s = run([{ type: 'togglePick', trackId: 't0' }, { type: 'togglePick', trackId: 't4' }, { type: 'pickDone' }], atPick);
    expect(s.step).toBe('saving');
    expect(s.range).toEqual({ low: 40, high: 64, source: 'songs' });
  });

  it('needs at least one pick', () => {
    expect(rangeFromPicks(songs, [])).toBeNull();
    expect(run([{ type: 'pickDone' }], atPick).step).toBe('pick');
  });
});
