// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { flowReducer, initialState, rangeFromPicks, type FlowEvent, type FlowState } from '../../src/lib/client/flow';
import { knownSongs, me, recommendationsPage } from '../fixtures/screen';

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

  it('appends pages and tracks the next offset', () => {
    let s = run([{ type: 'pageLoaded', page: recommendationsPage(0) }], atResults);
    expect(s.matches).toHaveLength(5);
    expect(s.nextOffset).toBe(5);
    expect(s.loading).toBe(false);
    s = run([{ type: 'loadMore' }], s);
    expect(s.loading).toBe(true);
    s = run([{ type: 'pageLoaded', page: recommendationsPage(5) }], s);
    expect(s.matches).toHaveLength(10);
    expect(s.nextOffset).toBeNull();
    expect(Object.keys(s.sources)).toHaveLength(10);
    expect(run([{ type: 'loadMore' }], s).loading).toBe(false);
  });

  it('does not duplicate songs seen on an earlier page', () => {
    const s = run([{ type: 'pageLoaded', page: recommendationsPage(0) }, { type: 'pageLoaded', page: recommendationsPage(3) }], atResults);
    expect(s.matches.map((m) => m.track.id)).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7']);
  });

  it('opens and closes a song, and remembers feedback', () => {
    let s = run([{ type: 'pageLoaded', page: recommendationsPage(0) }, { type: 'select', trackId: 't2' }], atResults);
    expect(s.selectedId).toBe('t2');
    s = run([{ type: 'feedback', trackId: 't2', thumbs: 'up' }, { type: 'deselect' }], s);
    expect(s.selectedId).toBeNull();
    expect(s.feedback).toEqual({ t2: 'up' });
  });

  it('re-sings just the low note and keeps the high one', () => {
    let s = run([{ type: 'pageLoaded', page: recommendationsPage(0) }, { type: 'redoEnd', end: 'low' }], atResults);
    expect(s).toMatchObject({ step: 'low', low: null, high: 72, redoing: 'low' });
    expect(run([{ type: 'holdEnd', midi: 74 }], s)).toMatchObject({ step: 'low', hold: 'order' });
    s = run([{ type: 'holdEnd', midi: 48 }], s);
    expect(s).toMatchObject({ step: 'saving', range: { low: 48, high: 72, source: 'test' }, redoing: null });
    expect(run([{ type: 'rangeSaved' }], s)).toMatchObject({ step: 'results', matches: [], loading: true });
  });

  it('re-sings just the high note and keeps the low one', () => {
    let s = run([{ type: 'redoEnd', end: 'high' }], atResults);
    expect(s).toMatchObject({ step: 'high', low: 45, high: null, redoing: 'high' });
    s = run([{ type: 'holdEnd', midi: 70 }], s);
    expect(s).toMatchObject({ step: 'saving', range: { low: 45, high: 70 } });
  });

  it('redo restarts the test and clears results', () => {
    const s = run([{ type: 'pageLoaded', page: recommendationsPage(0) }, { type: 'redo' }], atResults);
    expect(s).toMatchObject({ step: 'quiet', low: null, high: null, matches: [], nextOffset: 0, signedIn: true });
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
