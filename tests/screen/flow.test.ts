// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { flowReducer, historyAvailable, initialState, overlayOf, rangeFromPicks, SHOW_STEP, type FlowEvent, type FlowState } from '../../src/lib/client/flow';
import { DEFAULTS } from '../../src/lib/setlist/defaults';
import { initialTuner, isOn, type TunerAction } from '../../src/lib/setlist/tuner';
import { allMatches, knownSongs, me } from '../fixtures/screen';
import { INSTAGRAM, IOS_SAFARI, micOn } from '../helpers/micFlow';

const run = (events: FlowEvent[], from: FlowState = initialState) => events.reduce(flowReducer, from);
const signedOut: FlowEvent = { type: 'booted', me: null, progress: null, wantsPick: false };
/** Tuner actions as flow events, in order. */
const tune = (...actions: TunerAction[]): FlowEvent[] => actions.map((action) => ({ type: 'tuner', action }));

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

  it('a range kept on the device wins over half a test, which a redo that was abandoned leaves behind; Spotify wins over both', () => {
    // A reload in the middle of a one-note redo used to resume it as a first test: no "Back to songs", and no way to the list (the second
    // review of PR #38). With a range kept, half a test is dropped and the singer is where the redo started.
    for (const progress of [{ low: 45, high: null }, { low: null, high: 72 }, { low: null, high: null }]) {
      const s = run([{ type: 'booted', me: null, progress, wantsPick: false, savedRange: { low: 40, high: 60 } }]);
      expect(s, JSON.stringify(progress)).toMatchObject({ step: 'results', mode: 'catalogue', loading: true, range: { low: 40, high: 60, source: 'test' }, previousRange: null });
    }
    const signedIn = run([{ type: 'booted', me: me({ low: 45, high: 72, source: 'test', measuredAt: 2000 }), progress: null, wantsPick: false, savedRange: { low: 40, high: 60, measuredAt: 1000 } }]);
    expect(signedIn).toMatchObject({ step: 'results', mode: 'library', range: { low: 45, high: 72 } });
    // Signed in with a range saved and half a test left: the list too.
    expect(run([{ type: 'booted', me: me({ low: 45, high: 72, source: 'test' }), progress: { low: 40, high: null }, wantsPick: false }])).toMatchObject({ step: 'results', range: { low: 45, high: 72 } });
  });

  it('half a test with no range kept is a first test, and is resumed (the Spotify round trip); a finished test waiting at the arrow is resumed too, range kept or not', () => {
    expect(run([{ type: 'booted', me: null, progress: { low: 45, high: null }, wantsPick: false }])).toMatchObject({ step: 'mic', mic: { next: 'high' }, low: 45, range: null });
    const finished = run([{ type: 'booted', me: null, progress: { low: 45, high: 72 }, wantsPick: false, savedRange: { low: 40, high: 60 } }]);
    expect(finished).toMatchObject({ step: 'signin', low: 45, high: 72, range: { low: 45, high: 72 } });
  });
});

describe('boot: the tuner a singer starts from', () => {
  // [who, the boot event, whether they are signed in]: the defaults depend on it (R31).
  const boots: [string, FlowEvent, boolean][] = [
    ['a new visitor on the landing screen', signedOut, false],
    ['a half-done test', { type: 'booted', me: null, progress: { low: 45, high: null }, wantsPick: false }, false],
    ['a finished test waiting at the arrow', { type: 'booted', me: null, progress: { low: 45, high: 72 }, wantsPick: false }, false],
    ['a range kept on the device', { type: 'booted', me: null, progress: null, wantsPick: false, savedRange: { low: 45, high: 72 } }, false],
    ['a signed-in singer with a saved range', { type: 'booted', me: me({ low: 45, high: 72, source: 'test' }), progress: null, wantsPick: false }, true],
    ['a signed-in singer with a finished test to save', { type: 'booted', me: me(), progress: { low: 45, high: 72 }, wantsPick: false }, true],
    ['a signed-in singer with half a test', { type: 'booted', me: me(), progress: { low: 45, high: null }, wantsPick: false }, true],
    ['a signed-in singer who asked to pick songs', { type: 'booted', me: me(), progress: null, wantsPick: true }, true],
    ['a signed-in singer with no range yet', { type: 'booted', me: me(), progress: null, wantsPick: false }, true],
  ];

  it.each(boots)('%s gets the defaults', (_who, event, signedIn) => {
    expect(run([event]).tuner).toEqual(initialTuner({ signedIn }));
  });

  it('starts History on when the singer is signed in, and off when not (R31); Tempo and Era start off for both', () => {
    const signedOutTuner = run([signedOut]).tuner;
    const signedInTuner = run([{ type: 'booted', me: me(), progress: null, wantsPick: false }]).tuner;
    // Signed out, as it always was: there is no history, so History is off.
    expect(signedOutTuner.off).toEqual(['history', 'tempo', 'era']);
    // Signed in, "that's the purpose of logging in": History is on at 100 ("On repeat"), so the singer's own top and liked songs come first.
    expect(signedInTuner.off).toEqual(['tempo', 'era']);
    expect(signedInTuner.history).toBe(100);
    expect(isOn(signedInTuner, 'history')).toBe(true);
    // Nothing else differs, and the sheet opens on the same gear.
    expect({ ...signedInTuner, off: [] }).toEqual({ ...signedOutTuner, off: [] });
    expect(signedOutTuner.open).toBe('difficulty');
    expect(signedInTuner.open).toBe('difficulty');
    // Before anything has booted, the state is the signed-out one.
    expect(initialState.tuner).toEqual(initialTuner());
    expect(initialTuner().off).toEqual(['history', 'tempo', 'era']);
  });

  it('starts the sheet in mini mode when asked (?mini=1), and expanded otherwise', () => {
    expect(run([signedOut]).tuner.mini).toBe(false);
    expect(run([{ ...signedOut, mini: false } as FlowEvent]).tuner.mini).toBe(false);
    const mini = run([{ ...signedOut, mini: true } as FlowEvent]).tuner;
    expect(mini).toEqual(initialTuner({ mini: true }));
    // Signed in too, whichever way the boot goes.
    expect(run([{ type: 'booted', me: me({ low: 45, high: 72, source: 'test' }), progress: null, wantsPick: false, mini: true }]).tuner).toEqual(
      initialTuner({ mini: true, signedIn: true }),
    );
    expect(run([{ type: 'booted', me: null, progress: null, wantsPick: false, savedRange: { low: 45, high: 72 }, mini: true }]).tuner.mini).toBe(true);
  });
});

// QWW-66: the signed-in list used the range stored on the account and the signed-out list the one kept on the device,
// so one singer got two lists (the account held F2 to C4 while the device and its header said F#2 to C5). The range
// sung last wins, so each range carries the time it was sung.
describe('boot: the range sung last wins (QWW-66)', () => {
  const F2_C4 = { low: 41, high: 60 };
  const FS2_C5 = { low: 42, high: 72 };
  const OLD = 1_700_000_000_000;
  const NEW = OLD + 60_000;
  const signedIn = (account: { low: number; high: number; measuredAt?: number } | null, rest: Partial<Extract<FlowEvent, { type: 'booted' }>> = {}): FlowEvent => ({
    type: 'booted',
    me: me(account && { ...account, source: 'test' }),
    progress: null,
    wantsPick: false,
    ...rest,
  });

  it('a device range sung after the account\'s is saved to the account first, and the list is built on it', () => {
    const s = run([signedIn({ ...F2_C4, measuredAt: OLD }, { savedRange: { ...FS2_C5, measuredAt: NEW } })]);
    expect(s).toMatchObject({ step: 'saving', mode: 'library', range: { ...FS2_C5, source: 'test', measuredAt: NEW } });
    // Saved, the list loads on that range: the header, the request and the account all read `range`.
    expect(run([{ type: 'rangeSaved' }], s)).toMatchObject({ step: 'results', loading: true, range: { ...FS2_C5, measuredAt: NEW } });
  });

  it('an older device range never overwrites a newer account range', () => {
    const s = run([signedIn({ ...FS2_C5, measuredAt: NEW }, { savedRange: { ...F2_C4, measuredAt: OLD } })]);
    expect(s).toMatchObject({ step: 'results', loading: true, mode: 'library', range: { ...FS2_C5, source: 'test', measuredAt: NEW } });
  });

  it('the same time on both is one measurement: the list loads, nothing is saved', () => {
    const s = run([signedIn({ ...FS2_C5, measuredAt: NEW }, { savedRange: { ...FS2_C5, measuredAt: NEW } })]);
    expect(s).toMatchObject({ step: 'results', range: { ...FS2_C5, measuredAt: NEW } });
  });

  it('an account range with no time (saved before times were) gives way to the device\'s, with or without a time of its own', () => {
    for (const measuredAt of [NEW, undefined]) {
      const s = run([signedIn(F2_C4, { savedRange: { ...FS2_C5, ...(measuredAt ? { measuredAt } : {}) } })]);
      expect(s, String(measuredAt)).toMatchObject({ step: 'saving', range: { ...FS2_C5, source: 'test' } });
      expect(s.range?.measuredAt).toBe(measuredAt);
    }
  });

  it('a device range with no time does not outrank an account range that has one', () => {
    const s = run([signedIn({ ...F2_C4, measuredAt: OLD }, { savedRange: FS2_C5 })]);
    expect(s).toMatchObject({ step: 'results', range: { ...F2_C4, measuredAt: OLD } });
  });

  it('a device range and no account range: the device\'s is saved, not a new test asked for', () => {
    const s = run([signedIn(null, { savedRange: { ...FS2_C5, measuredAt: NEW } })]);
    expect(s).toMatchObject({ step: 'saving', range: { ...FS2_C5, measuredAt: NEW } });
  });

  it('no device range: the account\'s is used as it was', () => {
    expect(run([signedIn({ ...F2_C4, measuredAt: OLD })])).toMatchObject({ step: 'results', loading: true, range: { ...F2_C4, measuredAt: OLD } });
    expect(run([signedIn(null)]).step).toBe('landing');
  });

  it('the finished test left in storage (the Spotify round trip) carries its own time, and is compared the same way', () => {
    const newer = run([signedIn({ ...F2_C4, measuredAt: OLD }, { progress: { ...FS2_C5, measuredAt: NEW } })]);
    expect(newer).toMatchObject({ step: 'saving', range: { ...FS2_C5, source: 'test', measuredAt: NEW } });
    // Older than the account's range, it is dropped: the account's range is the one sung last.
    const older = run([signedIn({ ...FS2_C5, measuredAt: NEW }, { progress: { ...F2_C4, measuredAt: OLD } })]);
    expect(older).toMatchObject({ step: 'results', range: { ...FS2_C5, measuredAt: NEW } });
    // With no time at all on either (a test started before times were recorded), it is saved, as it always was.
    expect(run([signedIn(F2_C4, { progress: FS2_C5 })])).toMatchObject({ step: 'saving', range: { ...FS2_C5, source: 'test' } });
  });

  it('a finished test in storage and a range on the device: the one sung last is the device\'s', () => {
    const s = run([signedIn({ ...F2_C4, measuredAt: OLD }, { progress: { low: 40, high: 70, measuredAt: OLD + 1 }, savedRange: { ...FS2_C5, measuredAt: NEW } })]);
    expect(s).toMatchObject({ step: 'saving', range: { ...FS2_C5, measuredAt: NEW } });
  });

  it('a range kept on the device that the account cannot store is never offered to it: the account\'s list shows, not a save that cannot succeed', () => {
    // The server takes notes from MIDI 28 to 96 spanning 5 to 48 semitones. The singing test accepts any low note under the high one,
    // and a signed-in singer's list never depended on the range kept on the device before this change.
    for (const bad of [{ low: 60, high: 63 }, { low: 30, high: 90 }, { low: 20, high: 50 }]) {
      const s = run([signedIn({ ...F2_C4, measuredAt: OLD }, { savedRange: { ...bad, measuredAt: NEW } })]);
      expect(s, JSON.stringify(bad)).toMatchObject({ step: 'results', range: { ...F2_C4, measuredAt: OLD } });
    }
    // With no account range to fall back on, there is no range at all: the singer starts the test.
    expect(run([signedIn(null, { savedRange: { low: 60, high: 63, measuredAt: NEW } })]).step).toBe('landing');
    // A kept range the account can store is still saved, whatever else is on the device.
    expect(run([signedIn({ ...F2_C4, measuredAt: OLD }, { savedRange: { ...FS2_C5, measuredAt: NEW } })])).toMatchObject({ step: 'saving', range: { ...FS2_C5, measuredAt: NEW } });
  });

  it('signed out, the range kept on the device keeps its time, for the sign-in that may follow', () => {
    const s = run([{ type: 'booted', me: null, progress: null, wantsPick: false, savedRange: { ...FS2_C5, measuredAt: NEW } }]);
    expect(s).toMatchObject({ step: 'results', mode: 'catalogue', range: { ...FS2_C5, source: 'test', measuredAt: NEW } });
    const confirm = run([{ type: 'booted', me: null, progress: { ...FS2_C5, measuredAt: NEW }, wantsPick: false }]);
    expect(confirm).toMatchObject({ step: 'signin', range: { ...FS2_C5, measuredAt: NEW } });
  });

  it('a new test is stamped with the time its last note was let go', () => {
    const toHigh = run([signedOut, { type: 'start' }, { type: 'quietDone' }, ...micOn, { type: 'holdEnd', midi: 42, at: OLD }]);
    const out = run([{ type: 'holdEnd', midi: 72, at: NEW }], toHigh);
    expect(out).toMatchObject({ step: 'signin', range: { ...FS2_C5, source: 'test', measuredAt: NEW } });
    // Signed in, it goes to the account at once, with that time.
    const signedInTest = run([signedIn(null), { type: 'start' }, { type: 'quietDone' }, ...micOn, { type: 'holdEnd', midi: 42, at: OLD }, { type: 'holdEnd', midi: 72, at: NEW }]);
    expect(signedInTest).toMatchObject({ step: 'saving', range: { ...FS2_C5, measuredAt: NEW } });
  });

  it('a note redone on its own re-stamps the whole range: it is the range sung last', () => {
    const atList = run([signedIn({ ...F2_C4, measuredAt: OLD })]);
    const s = run([{ type: 'redoEnd', end: 'high' }, ...micOn, { type: 'holdEnd', midi: 72, at: NEW }], atList);
    expect(s).toMatchObject({ step: 'saving', range: { low: 41, high: 72, source: 'test', measuredAt: NEW } });
  });

  it('a test with no time on its note (older callers) makes a range with no time, as before', () => {
    const toHigh = run([signedOut, { type: 'start' }, { type: 'quietDone' }, ...micOn, { type: 'holdEnd', midi: 42 }]);
    expect(run([{ type: 'holdEnd', midi: 72 }], toHigh).range).toEqual({ ...FS2_C5, source: 'test' });
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
    expect(atMic).toMatchObject({ step: 'mic', mic: { view: 'checking', next: 'low', env: null, problem: null, fails: 0, lost: false } });
  });

  it('shows our own screen first when the browser has not been asked, or cannot say', () => {
    expect(gate([{ type: 'micChecked', env: IOS_SAFARI, permission: 'prompt' }])).toMatchObject({ view: 'prompt', env: IOS_SAFARI });
    expect(gate([{ type: 'micChecked', env: IOS_SAFARI, permission: 'unknown' }]).view).toBe('prompt');
  });

  it('skips that screen when the microphone is already allowed: it opens by itself, then goes straight to the note', () => {
    const opening = run([{ type: 'micChecked', env: IOS_SAFARI, permission: 'granted' }], atMic);
    expect(opening.mic).toMatchObject({ view: 'opening', lost: false });
    expect(run([{ type: 'micGranted' }], opening)).toMatchObject({ step: 'low', hold: 'ready' });
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
    const again = run([{ type: 'micAsk' }, { type: 'micGranted' }, { type: 'micLost' }], tried);
    expect(again).toMatchObject({ step: 'mic', mic: { view: 'checking', triedHere: true, env: INSTAGRAM } });
    expect(run([{ type: 'micChecked', env: INSTAGRAM, permission: 'prompt' }], again).mic.view).toBe('prompt');
    expect(run([{ type: 'micChecked', env: INSTAGRAM, permission: 'denied' }], again).mic.view).toBe('recovery');
    // A redo, which comes in with no lost microphone, opens an allowed one by itself.
    const atResults = run([{ type: 'booted', me: me({ low: 45, high: 72, source: 'test' }), progress: null, wantsPick: false }]);
    const redo = run([{ type: 'redoEnd', end: 'low' }], { ...atResults, mic: { ...atResults.mic, env: INSTAGRAM, triedHere: true } });
    expect(redo.mic).toMatchObject({ view: 'checking', triedHere: true, lost: false });
    expect(run([{ type: 'micChecked', env: INSTAGRAM, permission: 'granted' }], redo).mic.view).toBe('opening');
    // Not before it was tapped.
    expect(atMic.mic.triedHere).toBe(false);
  });

  it('a tap asks, and a yes goes straight on to the note', () => {
    let s = run([{ type: 'micChecked', env: IOS_SAFARI, permission: 'prompt' }, { type: 'micAsk' }], atMic);
    expect(s.mic.view).toBe('asking');
    s = run([{ type: 'micGranted' }], s);
    expect(s).toMatchObject({ step: 'low', hold: 'ready', mic: { problem: null } });
  });

  it('a no goes to recovery, "Try again" asks again, a second no counts, and a yes at last goes on to the note', () => {
    let s = run([{ type: 'micChecked', env: IOS_SAFARI, permission: 'prompt' }, { type: 'micAsk' }, { type: 'micFailed', reason: 'denied' }], atMic);
    expect(s.mic).toMatchObject({ view: 'recovery', problem: 'denied', fails: 1 });
    s = run([{ type: 'micAsk' }], s);
    expect(s.mic.view).toBe('asking');
    s = run([{ type: 'micFailed', reason: 'denied' }], s);
    expect(s.mic).toMatchObject({ view: 'recovery', fails: 2 });
    s = run([{ type: 'micAsk' }, { type: 'micGranted' }], s);
    expect(s).toMatchObject({ step: 'low', mic: { problem: null } });
  });

  it('keeps going to the end it was heading for', () => {
    const toHigh = run([{ type: 'booted', me: null, progress: { low: 45, high: null }, wantsPick: false }, ...micOn]);
    expect(toHigh).toMatchObject({ step: 'high', low: 45 });
  });

  it('answers only count on the screen they belong to, so a late one cannot undo a later one', () => {
    const prompt = run([{ type: 'micChecked', env: IOS_SAFARI, permission: 'prompt' }], atMic);
    expect(run([{ type: 'micGranted' }], prompt)).toBe(prompt);
    expect(run([{ type: 'micFailed', reason: 'denied' }], prompt)).toBe(prompt);
    expect(run([{ type: 'micTryHere' }], prompt)).toBe(prompt);
    expect(run([{ type: 'micChecked', env: INSTAGRAM, permission: 'denied' }], prompt)).toBe(prompt);
    expect(run([{ type: 'micAsk' }], atMic)).toBe(atMic);
    expect(run([{ type: 'holdEnd', midi: 45 }, { type: 'holdStart' }], prompt)).toMatchObject({ step: 'mic', low: null });
    // A second yes, after the first has taken the singer on to the note, is ignored.
    const atNote = run(micOn, atMic);
    expect(atNote.step).toBe('low');
    expect(run([{ type: 'micGranted' }], atNote)).toBe(atNote);
    // Outside the mic step none of it does anything.
    const landing = run([signedOut]);
    expect(run(micOn, landing)).toBe(landing);
  });

  it('a microphone lost during a hold goes back to the mic step, and on to the same note', () => {
    const atHigh = run([...toLowEvents(), { type: 'holdEnd', midi: 45 }]);
    expect(atHigh.step).toBe('high');
    const lost = run([{ type: 'micLost' }], atHigh);
    expect(lost).toMatchObject({ step: 'mic', low: 45, mic: { view: 'checking', next: 'high', fails: 0, lost: true } });
    expect(run(micOn, lost)).toMatchObject({ step: 'high', low: 45 });
    // Only a hold step can lose it.
    const landing = run([signedOut]);
    expect(run([{ type: 'micLost' }], landing)).toBe(landing);
  });

  it('a lost microphone shows our own screen even when the browser says it is allowed, so a tap starts the audio again', () => {
    const lost = run([...toLowEvents(), { type: 'micLost' }]);
    // Allowed but silent: opening it by itself would drop the singer straight back on the note with no word.
    for (const permission of ['granted', 'prompt', 'unknown'] as const) {
      expect(run([{ type: 'micChecked', env: IOS_SAFARI, permission }], lost).mic).toMatchObject({ view: 'prompt', lost: true });
    }
    // Taken back for good: the steps, not a button that cannot work.
    expect(run([{ type: 'micChecked', env: IOS_SAFARI, permission: 'denied' }], lost).mic).toMatchObject({ view: 'recovery', problem: 'denied' });
    // The tap on its button asks, and a yes goes straight back to the note the singer was on.
    const prompt = run([{ type: 'micChecked', env: IOS_SAFARI, permission: 'granted' }], lost);
    expect(run([{ type: 'micAsk' }, { type: 'micGranted' }], prompt)).toMatchObject({ step: 'low', hold: 'ready' });
    // Only a lost microphone is not opened by itself: a first visit with an allowed one still is.
    expect(run([{ type: 'micChecked', env: IOS_SAFARI, permission: 'granted' }], atMic).mic.view).toBe('opening');
  });

  /** Landing to the low note through the usual mic step. */
  function toLowEvents(): FlowEvent[] {
    return [signedOut, { type: 'start' }, { type: 'quietDone' }, ...micOn];
  }
});

describe('results', () => {
  const atResults = run([{ type: 'booted', me: me({ low: 45, high: 72, source: 'test' }), progress: null, wantsPick: false }]);
  const loaded = run([{ type: 'allLoaded', page: allMatches() }], atResults);

  it('takes every match at once and pages the ranked list SHOW_STEP songs at a time', () => {
    expect(loaded.matches).toHaveLength(10);
    expect(Object.keys(loaded.sources)).toHaveLength(10);
    expect(loaded.loading).toBe(false);
    expect(SHOW_STEP).toBe(40);
    expect(loaded.shown).toBe(SHOW_STEP);
    const more = run([{ type: 'loadMore' }], loaded);
    expect(more.shown).toBe(2 * SHOW_STEP);
    expect(more.loading).toBe(false);
    expect(run([{ type: 'loadMore' }], more).shown).toBe(3 * SHOW_STEP);
  });

  it.each(['rangeSaved', 'showCatalogue', 'loggedOut', 'redo'] as const)('%s starts the list over at the first page', (type) => {
    const paged = run([{ type: 'loadMore' }, { type: 'loadMore' }], loaded);
    expect(paged.shown).toBe(3 * SHOW_STEP);
    expect(run([{ type }], paged).shown).toBe(SHOW_STEP);
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

  it('redo restarts the test and clears results, and keeps the tuner', () => {
    const tuned = run(tune({ type: 'input', gear: 'difficulty', value: 80 }, { type: 'era', era: 's80' }), loaded);
    const s = run([{ type: 'redo' }], tuned);
    expect(s).toMatchObject({ step: 'quiet', low: null, high: null, matches: [], signedIn: true });
    expect(s.tuner).toEqual(tuned.tuner);
    expect(s.tuner).toMatchObject({ difficulty: 80, eras: ['s80'] });
  });
});

describe('what is open on top of the list, and Back to songs from a redo (QWW-57)', () => {
  const range = { low: 45, high: 72, source: 'test' as const };
  const atResults = run([{ type: 'booted', me: me(range), progress: null, wantsPick: false }]);
  const loaded = run([{ type: 'allLoaded', page: allMatches() }], atResults);
  const tuned = run(tune({ type: 'input', gear: 'difficulty', value: 80 }, { type: 'era', era: 's80' }), loaded);

  it('is a song page at the results, and the quiet, mic and note steps of a redo; the first test, with no range, has nothing open', () => {
    expect(overlayOf(loaded)).toBeNull();
    expect(overlayOf(run([{ type: 'select', trackId: 't2' }], loaded))).toBe('song');
    expect(overlayOf(run([{ type: 'select', trackId: 't2' }, { type: 'deselect' }], loaded))).toBeNull();
    // A redo, whole or of one end: the range is kept, so there is a list to go back to.
    expect(overlayOf(run([{ type: 'redo' }], loaded))).toBe('redo');
    expect(overlayOf(run([{ type: 'redo' }, { type: 'quietDone' }], loaded))).toBe('redo');
    expect(overlayOf(run([{ type: 'redo' }, { type: 'quietDone' }, ...micOn], loaded))).toBe('redo');
    expect(overlayOf(run([{ type: 'redoEnd', end: 'low' }], loaded))).toBe('redo');
    expect(overlayOf(run([{ type: 'redoEnd', end: 'high' }, ...micOn], loaded))).toBe('redo');
    // Finished: saving and the range screen are not on top of a list.
    expect(overlayOf(run([{ type: 'redoEnd', end: 'low' }, ...micOn, { type: 'holdEnd', midi: 48 }], loaded))).toBeNull();
    // The very first test: no range yet, so none of its steps has a list under it.
    const firstTest = run([{ type: 'booted', me: me(), progress: null, wantsPick: false }]);
    expect(firstTest.range).toBeNull();
    for (const events of [[{ type: 'start' }], [{ type: 'start' }, { type: 'quietDone' }], [{ type: 'start' }, { type: 'quietDone' }, ...micOn]] as FlowEvent[][]) {
      expect(overlayOf(run(events, firstTest))).toBeNull();
    }
    expect(overlayOf(firstTest)).toBeNull(); // the title
    expect(overlayOf(run([{ type: 'start' }, { type: 'quietDone' }, ...micOn, { type: 'holdEnd', midi: 45 }, { type: 'holdEnd', midi: 72 }], firstTest))).toBeNull(); // saving
  });

  it.each([
    ['the mic step of one end', [{ type: 'redoEnd', end: 'low' }] as FlowEvent[]],
    ['its note step', [{ type: 'redoEnd', end: 'high' }, ...micOn] as FlowEvent[]],
    ['a note step after the first note of a whole redo', [{ type: 'redo' }, { type: 'quietDone' }, ...micOn, { type: 'holdEnd', midi: 40 }] as FlowEvent[]],
  ])('Back to songs from %s keeps the range, the tuning and the list, and stops the redo', (_what, events) => {
    const s = run([...events, { type: 'backToSongs' }], tuned);
    expect(s).toMatchObject({ step: 'results', hold: 'ready', redoing: null, selectedId: null, range, low: 45, high: 72, signedIn: true, mode: 'library' });
    expect(s.tuner).toEqual(tuned.tuner);
    expect(s.tuner).toMatchObject({ difficulty: 80, eras: ['s80'] });
    expect(overlayOf(s)).toBeNull();
    // The singer can start a redo again from there, from the top.
    expect(run([{ type: 'redoEnd', end: 'low' }], s)).toMatchObject({ step: 'mic', low: null, high: 72, redoing: 'low' });
  });

  it('keeps the list when only one end was being redone, and loads it again when the whole test was (it emptied the list)', () => {
    expect(run([{ type: 'redoEnd', end: 'low' }, { type: 'backToSongs' }], tuned)).toMatchObject({ loading: false, attempt: tuned.attempt, matches: tuned.matches });
    const whole = run([{ type: 'redo' }, { type: 'backToSongs' }], tuned);
    expect(whole).toMatchObject({ step: 'results', matches: [], loading: true, attempt: 0, error: null });
    // ...and the load that follows fills it, as at the first visit.
    expect(run([{ type: 'allLoaded', page: allMatches() }], whole)).toMatchObject({ loading: false, matches: allMatches().matches });
  });

  describe('the result screen of a redo, for a singer without Spotify ("That\'s your range")', () => {
    // Signed out, with a range kept on the device: the list is catalogue songs, and a finished test waits for Continue.
    const OLD = { low: 45, high: 72, source: 'test' as const };
    const signedOutAtResults = run([{ type: 'booted', me: null, progress: null, wantsPick: false, savedRange: OLD }, { type: 'allLoaded', page: allMatches() }]);
    const tunedOut = run(tune({ type: 'input', gear: 'difficulty', value: 80 }, { type: 'era', era: 's80' }), signedOutAtResults);
    const oneEnd = run([{ type: 'redoEnd', end: 'low' }, ...micOn, { type: 'holdEnd', midi: 43 }], tunedOut);
    const wholeTest = run([{ type: 'redo' }, { type: 'quietDone' }, ...micOn, { type: 'holdEnd', midi: 40 }, { type: 'holdEnd', midi: 70 }], tunedOut);

    it('remembers the range a redo started from, and forgets it when the redo is over', () => {
      expect(run([{ type: 'redoEnd', end: 'low' }], tunedOut).previousRange).toEqual(OLD);
      expect(run([{ type: 'redo' }], tunedOut).previousRange).toEqual(OLD);
      expect(tunedOut.previousRange).toBeNull();
      // The finished test is waiting at the arrow: the new range is `range`, the old one is `previousRange`.
      expect(oneEnd).toMatchObject({ step: 'signin', range: { low: 43, high: 72 }, previousRange: OLD });
      expect(wholeTest).toMatchObject({ step: 'signin', range: { low: 40, high: 70 }, previousRange: OLD });
      // Continue keeps the new range, and the redo is over.
      expect(run([{ type: 'showCatalogue' }], oneEnd)).toMatchObject({ step: 'results', range: { low: 43, high: 72 }, previousRange: null });
      // A signed-in singer's range is saved as soon as it is sung, and the redo is over then.
      const signedIn = run([{ type: 'redoEnd', end: 'low' }, ...micOn, { type: 'holdEnd', midi: 43 }], loaded);
      expect(signedIn).toMatchObject({ step: 'saving', range: { low: 43, high: 72 }, previousRange: range });
      expect(run([{ type: 'rangeSaved' }], signedIn).previousRange).toBeNull();
    });

    it('is something open on top of the list, which the browser’s Back closes: a redo’s result, not the first test’s', () => {
      expect(overlayOf(oneEnd)).toBe('redo');
      expect(overlayOf(wholeTest)).toBe('redo');
      expect(overlayOf(run([{ type: 'showCatalogue' }], oneEnd))).toBeNull();
      // The first test of a singer with no range: the same screen, with nothing before it.
      const first = run([signedOut, { type: 'start' }, { type: 'quietDone' }, ...micOn, { type: 'holdEnd', midi: 45 }, { type: 'holdEnd', midi: 72 }]);
      expect(first).toMatchObject({ step: 'signin', previousRange: null });
      expect(overlayOf(first)).toBeNull();
      // A finished test that a reload found waiting (no memory of the redo it came from) is the first test's case too.
      expect(overlayOf(run([{ type: 'booted', me: null, progress: { low: 45, high: 72 }, wantsPick: false, savedRange: OLD }]))).toBeNull();
      // Saving is not one: the range is on its way to the account.
      expect(overlayOf({ step: 'saving', selectedId: null, range: OLD, previousRange: OLD })).toBeNull();
    });

    it('Back to songs from it puts the old range, the tuning and the list back, and the new range is gone', () => {
      const s = run([{ type: 'backToSongs' }], oneEnd);
      expect(s).toMatchObject({ step: 'results', range: OLD, low: 45, high: 72, previousRange: null, redoing: null, loading: false });
      expect(s.matches).toEqual(tunedOut.matches); // a one-end redo kept the list
      expect(s.tuner).toEqual(tunedOut.tuner);
      expect(overlayOf(s)).toBeNull();
    });

    it('after a whole redo the list was emptied, so it loads again', () => {
      const s = run([{ type: 'backToSongs' }], wholeTest);
      expect(s).toMatchObject({ step: 'results', range: OLD, previousRange: null, matches: [], loading: true, attempt: 0 });
      expect(s.tuner).toEqual(tunedOut.tuner);
    });
  });

  it('does nothing outside a redo: the list, a song page, the title, and the very first test', () => {
    expect(run([{ type: 'backToSongs' }], loaded)).toBe(loaded);
    const song = run([{ type: 'select', trackId: 't2' }], loaded);
    expect(run([{ type: 'backToSongs' }], song)).toBe(song);
    const firstTest = run([{ type: 'booted', me: me(), progress: null, wantsPick: false }, { type: 'start' }, { type: 'quietDone' }, ...micOn]);
    expect(firstTest.step).toBe('low');
    expect(run([{ type: 'backToSongs' }], firstTest)).toBe(firstTest);
    const title = run([signedOut]);
    expect(run([{ type: 'backToSongs' }], title)).toBe(title);
  });
});

describe('the Setlist tuner in the flow', () => {
  const atResults = run([{ type: 'booted', me: me({ low: 45, high: 72, source: 'test' }), progress: null, wantsPick: false }]);
  const loaded = run([{ type: 'allLoaded', page: allMatches() }], atResults);
  /** Everything but the tuner, to say an action touched nothing else. */
  const withoutTuner = (s: FlowState) => ({ ...s, tuner: null });

  // One action of each kind, and what the tuner is afterwards (the reducer's own rules are in tests/setlist/tuner.test.ts).
  // This is a signed-in boot, so it starts with History on (R31) and Tempo and Era off, and no era picked.
  const actions: [string, TunerAction, Partial<FlowState['tuner']>][] = [
    ['a slider moving', { type: 'input', gear: 'tempo', value: 90 }, { tempo: 90, open: 'tempo', off: ['era'] }],
    ['a press on an off slider', { type: 'touch', gear: 'tempo' }, { tempo: DEFAULTS.tempo, open: 'tempo', off: ['era'] }],
    ['a reset', { type: 'reset', gear: 'popularity' }, { popularity: DEFAULTS.popularity, open: 'popularity', off: ['tempo', 'era', 'popularity'] }],
    ['an era button', { type: 'era', era: 's80' }, { eras: ['s80'], open: 'era', off: ['tempo'] }],
    ['a tab', { type: 'open', gear: 'era' }, { open: 'era' }],
    ['the handle', { type: 'mini', mini: true }, { mini: true }],
    ['the test hook', { type: 'patch', patch: { difficulty: 5 } }, { difficulty: 5 }],
  ];

  it.each(actions)('%s reaches the tuner and changes nothing else in the flow', (_what, action, expected) => {
    const s = run(tune(action), loaded);
    expect(s.tuner).toMatchObject(expected);
    expect(withoutTuner(s)).toEqual(withoutTuner(loaded));
  });

  it('actions add up: the sliders, the eras and the sheet mode all stay as the singer left them', () => {
    const s = run(
      tune(
        { type: 'input', gear: 'difficulty', value: 35 },
        { type: 'input', gear: 'popularity', value: 60 },
        { type: 'era', era: 's80' },
        { type: 'era', era: 's90' },
        { type: 'era', era: 's80' },
        { type: 'mini', mini: true },
      ),
      loaded,
    );
    // The 80s were picked and taken out again, the 90s stayed.
    expect(s.tuner).toMatchObject({ difficulty: 35, popularity: 60, eras: ['s90'], mini: true, open: 'era' });
    expect(isOn(s.tuner, 'era')).toBe(true);
  });

  it('letting go of a thumb is only for the event log: the state does not change', () => {
    expect(run([{ type: 'gearDone', gear: 'tempo' }], loaded)).toBe(loaded);
  });

  it('opening a song and coming back leaves the tuner as it was', () => {
    const tuned = run(tune({ type: 'input', gear: 'tempo', value: 35 }, { type: 'era', era: 's80' }), loaded);
    expect(run([{ type: 'select', trackId: 't2', position: 3 }, { type: 'deselect' }], tuned).tuner).toEqual(tuned.tuner);
  });

  describe('a new range', () => {
    const tuned = run(tune({ type: 'input', gear: 'difficulty', value: 80 }, { type: 'era', era: 's80' }, { type: 'reset', gear: 'popularity' }), loaded);

    it('keeps what the singer set when one end of the range is sung again and saved', () => {
      const s = run([{ type: 'redoEnd', end: 'low' }, ...micOn, { type: 'holdEnd', midi: 48 }, { type: 'rangeSaved' }], tuned);
      expect(s).toMatchObject({ step: 'results', matches: [], loading: true, range: { low: 48, high: 72 } });
      expect(s.tuner).toEqual(tuned.tuner);
    });

    it('keeps it when the singer switches to the catalogue', () => {
      const s = run([{ type: 'showCatalogue' }], tuned);
      expect(s).toMatchObject({ mode: 'catalogue', loading: true });
      expect(s.tuner).toEqual(tuned.tuner);
    });
  });

  describe('listening history needs a library', () => {
    // Someone with a range kept on the device: catalogue songs. History starts off for them (R31: it starts on only when signed in), so a
    // press or a move would change it if nothing stopped it. A signed-in singer's History starts on, and is not rewritten when the library
    // turns out unreadable (below): the sheet and the engine count it as off.
    const catalogue = run([{ type: 'booted', me: null, progress: null, wantsPick: false, savedRange: { low: 45, high: 72 } }, { type: 'allLoaded', page: allMatches() }]);
    const unreadable = run([{ type: 'allLoaded', page: { ...allMatches(), libraryUnavailable: true } }], atResults);

    it('is available in library mode only', () => {
      expect(historyAvailable({ mode: 'library' })).toBe(true);
      expect(historyAvailable({ mode: 'catalogue' })).toBe(false);
      expect(historyAvailable(loaded)).toBe(true);
      expect(historyAvailable(catalogue)).toBe(false);
    });

    it('ignores moving the slider and pressing it while it is unavailable, so History stays as it was', () => {
      expect(isOn(catalogue.tuner, 'history')).toBe(false);
      expect(isOn(unreadable.tuner, 'history')).toBe(true); // signed in: on at the start, and counted as off because there is no library
      for (const state of [catalogue, unreadable]) {
        for (const action of [{ type: 'input', gear: 'history', value: 90 }, { type: 'touch', gear: 'history' }] as TunerAction[]) {
          expect(run(tune(action), state)).toBe(state);
        }
      }
    });

    it('still lets every other gear and control act, and History be reset, shown or opened', () => {
      expect(run(tune({ type: 'input', gear: 'difficulty', value: 90 }), catalogue).tuner.difficulty).toBe(90);
      expect(run(tune({ type: 'touch', gear: 'tempo' }), catalogue).tuner.off).not.toContain('tempo');
      expect(run(tune({ type: 'open', gear: 'history' }), catalogue).tuner.open).toBe('history');
      expect(run(tune({ type: 'reset', gear: 'history' }), catalogue).tuner).toMatchObject({ history: DEFAULTS.history, open: 'history' });
    });

    it('works in library mode: History starts on at 100 (R31), the slider moves it, a reset turns it off, and a press switches it on again at its default', () => {
      expect(isOn(loaded.tuner, 'history')).toBe(true);
      expect(loaded.tuner.history).toBe(100);
      const moved = run(tune({ type: 'input', gear: 'history', value: 30 }), loaded);
      expect(moved.tuner).toMatchObject({ history: 30, open: 'history' });
      expect(isOn(moved.tuner, 'history')).toBe(true);
      // A reset puts it back at its default value and off, like any other gear (R21: the button says "Turn off"), after which a press switches it on again at 100.
      const reset = run(tune({ type: 'input', gear: 'history', value: 30 }, { type: 'reset', gear: 'history' }), loaded);
      expect(reset.tuner).toMatchObject({ history: DEFAULTS.history });
      expect(isOn(reset.tuner, 'history')).toBe(false);
      const pressed = run(tune({ type: 'touch', gear: 'history' }), reset);
      expect(isOn(pressed.tuner, 'history')).toBe(true);
      expect(pressed.tuner.history).toBe(DEFAULTS.history);
    });

    it('a library the server could not read counts as the catalogue from then on, and the tuner itself is left alone', () => {
      expect(unreadable).toMatchObject({ mode: 'catalogue', libraryUnavailable: true, signedIn: true });
      expect(historyAvailable(unreadable)).toBe(false);
      expect(unreadable.tuner).toEqual(atResults.tuner);
      // Even a History the singer had already switched on is not rewritten: the sheet and the engine count it as off.
      const switchedOn = run([{ type: 'allLoaded', page: allMatches() }, ...tune({ type: 'input', gear: 'history', value: 80 })], atResults);
      expect(isOn(switchedOn.tuner, 'history')).toBe(true);
      const then = run([{ type: 'allLoaded', page: { ...allMatches(), libraryUnavailable: true } }], switchedOn);
      expect(historyAvailable(then)).toBe(false);
      expect(then.tuner).toEqual(switchedOn.tuner);
      expect(run(tune({ type: 'input', gear: 'history', value: 90 }), then)).toBe(then);
    });
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
    ...tune(
      { type: 'input', gear: 'difficulty', value: 80 },
      { type: 'input', gear: 'history', value: 20 },
      { type: 'era', era: 's80' },
      { type: 'mini', mini: true },
    ),
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
      shown: SHOW_STEP,
      selectedId: null,
    });
  });

  it('keeps the tuner as the singer left it, the sheet mode included: nothing needs resetting', () => {
    expect(inLibrary.tuner).toMatchObject({ difficulty: 80, history: 20, eras: ['s80'], mini: true });
    const s = run([{ type: 'loggedOut' }], inLibrary);
    // The very same state: the sliders, History's value, the picked eras, which parts are off, the open gear, and mini.
    expect(s.tuner).toEqual(inLibrary.tuner);
    expect(s.tuner).not.toEqual(initialTuner({ mini: true }));
    // An expanded sheet stays expanded too.
    const expanded = run(tune({ type: 'mini', mini: false }), inLibrary);
    expect(run([{ type: 'loggedOut' }], expanded).tuner.mini).toBe(false);
  });

  it('asks the catalogue for songs once; History counts as off from then on, whatever the tuner says, and cannot be turned on without a library', () => {
    const s = run([{ type: 'loggedOut' }, { type: 'allLoaded', page: allMatches() }], inLibrary);
    expect(s).toMatchObject({ mode: 'catalogue', loading: false, signedIn: false });
    expect(s.matches.length).toBeGreaterThan(0);
    // History is derived off from the results mode, not rewritten in the state: the singer's own History is still in it.
    expect(historyAvailable(s)).toBe(false);
    expect(s.tuner).toEqual(inLibrary.tuner);
    expect(isOn(s.tuner, 'history')).toBe(true);
    // Nothing can change it while there is no library, and a History that was off stays off.
    expect(run(tune({ type: 'input', gear: 'history', value: 90 }, { type: 'touch', gear: 'history' }), s)).toBe(s);
    // (Signed in, History starts on: R31. This one was reset, which turns it off, before the singer logged out.)
    const wasOff = run([
      { type: 'booted', me: me(signedInRange), progress: null, wantsPick: false },
      ...tune({ type: 'reset', gear: 'history' }),
      { type: 'loggedOut' },
      { type: 'allLoaded', page: allMatches() },
    ]);
    expect(isOn(wasOff.tuner, 'history')).toBe(false);
    expect(run(tune({ type: 'input', gear: 'history', value: 90 }, { type: 'touch', gear: 'history' }), wasOff)).toBe(wasOff);
    expect(isOn(run(tune({ type: 'touch', gear: 'history' }), wasOff).tuner, 'history')).toBe(false);
  });

  it('with no range there are no results to replace; it only signs out, and the tuner is as it was', () => {
    const signedIn = run([{ type: 'booted', me: me(), progress: null, wantsPick: false }, ...tune({ type: 'input', gear: 'history', value: 50 })]);
    expect(isOn(signedIn.tuner, 'history')).toBe(true);
    const s = run([{ type: 'loggedOut' }], signedIn);
    expect(s).toMatchObject({ step: 'landing', signedIn: false, displayName: null, range: null });
    expect(s.tuner).toEqual(signedIn.tuner);
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

  it('stops offering listening history, which a catalogue list cannot, and keeps the rest of what was set', () => {
    const tuned = run([{ type: 'allLoaded', page: allMatches() }, ...tune({ type: 'input', gear: 'history', value: 80 }, { type: 'input', gear: 'difficulty', value: 20 })], atResults);
    expect(historyAvailable(tuned)).toBe(true);
    expect(tuned.tuner).toMatchObject({ history: 80, difficulty: 20 });
    const s = run([{ type: 'allLoaded', page: unavailable }], tuned);
    expect(historyAvailable(s)).toBe(false);
    // The tuner is not rewritten: the sheet and the request just count History as off from here.
    expect(s.tuner).toEqual(tuned.tuner);
    expect(run(tune({ type: 'input', gear: 'history', value: 10 }), s)).toBe(s);
    expect(run(tune({ type: 'input', gear: 'difficulty', value: 10 }), s).tuner.difficulty).toBe(10);
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
