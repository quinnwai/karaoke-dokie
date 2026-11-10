// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { flowReducer, initialState, rangeFromPicks, type FlowEvent, type FlowState } from '../../src/lib/client/flow';
import { allMatches, knownSongs, me } from '../fixtures/screen';
import { INSTAGRAM, IOS_SAFARI, micOn } from '../helpers/micFlow';

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

  it('resumes a half-done test, by way of the mic step, since the microphone is closed after a reload', () => {
    const half = run([{ type: 'booted', me: null, progress: { low: 45, high: null }, wantsPick: false }]);
    expect(half).toMatchObject({ step: 'mic', low: 45, mic: { view: 'checking', next: 'high' } });
    expect(run(micOn, half)).toMatchObject({ step: 'high', low: 45 });
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
    expect(run([{ type: 'booted', me: null, progress: { low: 45, high: null }, wantsPick: false, savedRange: { low: 40, high: 60 } }])).toMatchObject({ step: 'mic', mic: { next: 'high' } });
    const signedIn = run([{ type: 'booted', me: me({ low: 45, high: 72, source: 'test' }), progress: null, wantsPick: false, savedRange: { low: 40, high: 60 } }]);
    expect(signedIn).toMatchObject({ step: 'results', mode: 'library', range: { low: 45, high: 72 } });
  });
});

describe('the singing test', () => {
  const toLow = [signedOut, { type: 'start' }, { type: 'quietDone' }, ...micOn] as FlowEvent[];

  it('walks landing, quiet spot, mic, low, high, sign-in', () => {
    let s = run([signedOut, { type: 'start' }]);
    expect(s.step).toBe('quiet');
    s = run([{ type: 'quietDone' }], s);
    expect(s.step).toBe('mic');
    s = run(micOn, s);
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

  it('a signed-in user skips the arrow and saves', () => {
    const s = run([{ type: 'booted', me: me(), progress: null, wantsPick: false }, { type: 'start' }, { type: 'quietDone' }, ...micOn, { type: 'holdEnd', midi: 45 }, { type: 'holdEnd', midi: 72 }]);
    expect(s.step).toBe('saving');
  });

  it('ignores hold events outside the hold steps', () => {
    const s = run([signedOut, { type: 'holdEnd', midi: 45 }]);
    expect(s.step).toBe('landing');
    expect(s.low).toBeNull();
  });
});

describe('the mic step (QWW-50)', () => {
  const atMic = run([signedOut, { type: 'start' }, { type: 'quietDone' }]);
  const gate = (events: FlowEvent[], from: FlowState = atMic) => run(events, from).mic;

  it('starts by looking at the browser, and leads on to the low note', () => {
    expect(atMic).toMatchObject({ step: 'mic', mic: { view: 'checking', next: 'low', env: null, problem: null, fails: 0 } });
  });

  it('shows our own screen first when the browser has not been asked, or cannot say', () => {
    expect(gate([{ type: 'micChecked', env: IOS_SAFARI, permission: 'prompt' }])).toMatchObject({ view: 'prompt', env: IOS_SAFARI });
    expect(gate([{ type: 'micChecked', env: IOS_SAFARI, permission: 'unknown' }]).view).toBe('prompt');
  });

  it('skips that screen when the microphone is already allowed: it opens by itself, then the level meter', () => {
    const opening = run([{ type: 'micChecked', env: IOS_SAFARI, permission: 'granted' }], atMic);
    expect(opening.mic.view).toBe('opening');
    expect(run([{ type: 'micGranted' }], opening).mic.view).toBe('level');
    expect(run([{ type: 'micFailed', reason: 'busy' }], opening).mic).toMatchObject({ view: 'recovery', problem: 'busy', fails: 1 });
  });

  it('goes straight to what to do when the microphone is already blocked', () => {
    expect(gate([{ type: 'micChecked', env: IOS_SAFARI, permission: 'denied' }])).toMatchObject({ view: 'recovery', problem: 'denied', fails: 1 });
  });

  it('inside another app it says so before anything else, whatever the permission says; "Try here anyway" goes on', () => {
    for (const permission of ['prompt', 'granted', 'denied', 'unknown'] as const) {
      expect(gate([{ type: 'micChecked', env: INSTAGRAM, permission }]).view).toBe('inapp');
    }
    const s = run([{ type: 'micChecked', env: INSTAGRAM, permission: 'prompt' }, { type: 'micTryHere' }], atMic);
    expect(s.mic).toMatchObject({ view: 'prompt', env: INSTAGRAM });
  });

  it('"Try here anyway" is remembered for the visit: the in-app screen does not come back on the next pass', () => {
    const tried = run([{ type: 'micChecked', env: INSTAGRAM, permission: 'prompt' }, { type: 'micTryHere' }], atMic);
    expect(tried.mic.triedHere).toBe(true);
    // The next time through the mic step (a microphone lost mid-note, a redo) it goes by permission like anywhere else.
    const again = run([{ type: 'micAsk' }, { type: 'micGranted' }, { type: 'micDone' }, { type: 'micLost' }], tried);
    expect(again).toMatchObject({ step: 'mic', mic: { view: 'checking', triedHere: true, env: INSTAGRAM } });
    expect(run([{ type: 'micChecked', env: INSTAGRAM, permission: 'prompt' }], again).mic.view).toBe('prompt');
    expect(run([{ type: 'micChecked', env: INSTAGRAM, permission: 'granted' }], again).mic.view).toBe('opening');
    expect(run([{ type: 'micChecked', env: INSTAGRAM, permission: 'denied' }], again).mic.view).toBe('recovery');
    // Not before it was tapped.
    expect(atMic.mic.triedHere).toBe(false);
  });

  it('a tap asks, a yes shows the level meter, Continue goes to the note', () => {
    let s = run([{ type: 'micChecked', env: IOS_SAFARI, permission: 'prompt' }, { type: 'micAsk' }], atMic);
    expect(s.mic.view).toBe('asking');
    s = run([{ type: 'micGranted' }], s);
    expect(s.mic.view).toBe('level');
    expect(s.step).toBe('mic');
    expect(run([{ type: 'micDone' }], s)).toMatchObject({ step: 'low', hold: 'ready' });
  });

  it('a no goes to recovery, "Try again" asks again, and a second no counts', () => {
    let s = run([{ type: 'micChecked', env: IOS_SAFARI, permission: 'prompt' }, { type: 'micAsk' }, { type: 'micFailed', reason: 'denied' }], atMic);
    expect(s.mic).toMatchObject({ view: 'recovery', problem: 'denied', fails: 1 });
    s = run([{ type: 'micAsk' }], s);
    expect(s.mic.view).toBe('asking');
    s = run([{ type: 'micFailed', reason: 'denied' }], s);
    expect(s.mic).toMatchObject({ view: 'recovery', fails: 2 });
    s = run([{ type: 'micAsk' }, { type: 'micGranted' }], s);
    expect(s.mic).toMatchObject({ view: 'level', problem: null });
  });

  it('keeps going to the end it was heading for', () => {
    const toHigh = run([{ type: 'booted', me: null, progress: { low: 45, high: null }, wantsPick: false }, ...micOn]);
    expect(toHigh).toMatchObject({ step: 'high', low: 45 });
  });

  it('answers only count on the screen they belong to, so a late one cannot undo a later one', () => {
    const prompt = run([{ type: 'micChecked', env: IOS_SAFARI, permission: 'prompt' }], atMic);
    expect(run([{ type: 'micGranted' }], prompt)).toBe(prompt);
    expect(run([{ type: 'micFailed', reason: 'denied' }], prompt)).toBe(prompt);
    expect(run([{ type: 'micDone' }], prompt)).toBe(prompt);
    expect(run([{ type: 'micTryHere' }], prompt)).toBe(prompt);
    expect(run([{ type: 'micChecked', env: INSTAGRAM, permission: 'denied' }], prompt)).toBe(prompt);
    expect(run([{ type: 'micAsk' }], atMic)).toBe(atMic);
    expect(run([{ type: 'holdEnd', midi: 45 }, { type: 'holdStart' }], prompt)).toMatchObject({ step: 'mic', low: null });
    // Outside the mic step none of it does anything.
    const landing = run([signedOut]);
    expect(run([{ type: 'micChecked', env: IOS_SAFARI, permission: 'prompt' }, { type: 'micAsk' }, { type: 'micGranted' }, { type: 'micDone' }], landing)).toBe(landing);
  });

  it('a microphone lost during a hold goes back to the mic step, and on to the same note', () => {
    const atHigh = run([...toLowEvents(), { type: 'holdEnd', midi: 45 }]);
    expect(atHigh.step).toBe('high');
    const lost = run([{ type: 'micLost' }], atHigh);
    expect(lost).toMatchObject({ step: 'mic', low: 45, mic: { view: 'checking', next: 'high', fails: 0 } });
    expect(run(micOn, lost)).toMatchObject({ step: 'high', low: 45 });
    // Only a hold step can lose it.
    const landing = run([signedOut]);
    expect(run([{ type: 'micLost' }], landing)).toBe(landing);
  });

  /** Landing to the low note through the usual mic step. */
  function toLowEvents(): FlowEvent[] {
    return [signedOut, { type: 'start' }, { type: 'quietDone' }, ...micOn];
  }
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
    expect(s.view).toEqual({ difficulty: 0.2, familiarity: null, popularity: null, tempo: null, decade: '90s', mood: 'upbeat', duetsOnly: true });
    s = run([{ type: 'clearFilters' }], s);
    expect(s.view).toEqual({ difficulty: 0.2, familiarity: null, popularity: null, tempo: null, decade: null, mood: null, duetsOnly: false });
  });

  it('a slider is clamped to its track, the last one moved leads, and Reset unsets them all', () => {
    let s = run([{ type: 'setSlider', slider: 'difficulty', value: -3 }, { type: 'setSlider', slider: 'familiarity', value: 9 }], loaded);
    expect(s.view).toMatchObject({ difficulty: 0, familiarity: 1 });
    expect(s.leadSlider).toBe('familiarity');
    expect(run([{ type: 'sliderDone', slider: 'familiarity' }], s)).toBe(s);
    expect(run([{ type: 'setSlider', slider: 'familiarity', value: null }], s).leadSlider).toBeNull();
    s = run([{ type: 'pickDecade', decade: '80s' }, { type: 'resetSliders' }], s);
    expect(s.view).toEqual({ difficulty: null, familiarity: null, popularity: null, tempo: null, decade: '80s', mood: null, duetsOnly: false });
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
    // The microphone was let go at the results, so even one end goes by way of the mic step.
    let s = run([{ type: 'redoEnd', end: 'low' }], loaded);
    expect(s).toMatchObject({ step: 'mic', low: null, high: 72, redoing: 'low', mic: { next: 'low' } });
    s = run(micOn, s);
    expect(s).toMatchObject({ step: 'low', low: null, high: 72, redoing: 'low' });
    expect(run([{ type: 'holdEnd', midi: 74 }], s)).toMatchObject({ step: 'low', hold: 'order' });
    s = run([{ type: 'holdEnd', midi: 48 }], s);
    expect(s).toMatchObject({ step: 'saving', range: { low: 48, high: 72, source: 'test' }, redoing: null });
    expect(run([{ type: 'rangeSaved' }], s)).toMatchObject({ step: 'results', mode: 'library', matches: [], loading: true });
  });

  it('re-sings just the high note and keeps the low one', () => {
    let s = run([{ type: 'redoEnd', end: 'high' }, ...micOn], atResults);
    expect(s).toMatchObject({ step: 'high', low: 45, high: null, redoing: 'high' });
    s = run([{ type: 'holdEnd', midi: 70 }], s);
    expect(s).toMatchObject({ step: 'saving', range: { low: 45, high: 70 } });
  });

  it('redo restarts the test, clears results and filters, and keeps the sliders', () => {
    const s = run([{ type: 'setSlider', slider: 'difficulty', value: 0.8 }, { type: 'pickDecade', decade: '80s' }, { type: 'redo' }], loaded);
    expect(s).toMatchObject({ step: 'quiet', low: null, high: null, matches: [], signedIn: true });
    expect(s.view).toEqual({ difficulty: 0.8, familiarity: null, popularity: null, tempo: null, decade: null, mood: null, duetsOnly: false });
  });
});

describe('no Spotify (catalogue mode)', () => {
  const tested = run([signedOut, { type: 'start' }, { type: 'quietDone' }, ...micOn, { type: 'holdEnd', midi: 45 }, { type: 'holdEnd', midi: 72 }]);

  it('after the test, the arrow shows catalogue songs with no sign-in', () => {
    expect(tested.step).toBe('signin');
    const s = run([{ type: 'showCatalogue' }], tested);
    expect(s).toMatchObject({ step: 'results', mode: 'catalogue', loading: true, signedIn: false, range: { low: 45, high: 72 } });
  });

  it('needs a range first', () => {
    expect(run([signedOut, { type: 'showCatalogue' }]).step).toBe('landing');
  });

  it('a catalogue singer who redoes the test comes back to the arrow, not to Spotify', () => {
    const s = run([{ type: 'showCatalogue' }, { type: 'allLoaded', page: allMatches() }, { type: 'redoEnd', end: 'high' }, ...micOn, { type: 'holdEnd', midi: 70 }], tested);
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
    expect(s.view).toEqual({ difficulty: 0.8, familiarity: 0.2, popularity: null, tempo: null, decade: null, mood: null, duetsOnly: false });
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

describe('a Spotify library the server could not read (QWW-55)', () => {
  const signedInRange = { low: 45, high: 72, source: 'test' as const };
  const atResults = run([{ type: 'booted', me: me(signedInRange), progress: null, wantsPick: false }]);
  const unavailable = { ...allMatches(), libraryUnavailable: true };

  it('shows the catalogue songs it was sent as a catalogue list for a singer who is still signed in', () => {
    expect(atResults).toMatchObject({ mode: 'library', libraryUnavailable: false, signedIn: true });
    const s = run([{ type: 'allLoaded', page: unavailable }], atResults);
    expect(s).toMatchObject({ mode: 'catalogue', libraryUnavailable: true, signedIn: true, loading: false, error: null });
    expect(s.matches).toHaveLength(unavailable.matches.length);
  });

  it('unsets the listening slider, which a catalogue list cannot offer', () => {
    const tuned = run([{ type: 'allLoaded', page: allMatches() }, { type: 'setSlider', slider: 'familiarity', value: 0.8 }, { type: 'setSlider', slider: 'difficulty', value: 0.2 }], atResults);
    expect(tuned.view.familiarity).toBe(0.8);
    const s = run([{ type: 'allLoaded', page: unavailable }], tuned);
    expect(s.view).toMatchObject({ familiarity: null, difficulty: 0.2 });
  });

  it('leaves a library list that loaded fine as it was', () => {
    const s = run([{ type: 'allLoaded', page: allMatches() }], atResults);
    expect(s).toMatchObject({ mode: 'library', libraryUnavailable: false });
  });

  it('goes away with a new range, a redo or a log out, which ask the server again or leave the library', () => {
    const down = run([{ type: 'allLoaded', page: unavailable }], atResults);
    expect(run([{ type: 'redo' }], down).libraryUnavailable).toBe(false);
    expect(run([{ type: 'rangeSaved' }], down)).toMatchObject({ libraryUnavailable: false, mode: 'library', loading: true });
    expect(run([{ type: 'loggedOut' }], down)).toMatchObject({ libraryUnavailable: false, mode: 'catalogue', signedIn: false });
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
