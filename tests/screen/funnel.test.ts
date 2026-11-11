import { describe, expect, it } from 'vitest';
import { catalogueKey, eventsFor, feedbackView, rowPlayEvent, viewProps } from '../../src/lib/client/funnel';
import { flowReducer, initialState, SHOW_STEP, type FlowEvent, type FlowState } from '../../src/lib/client/flow';
import { POSTHOG_PROPS } from '../../src/lib/eventNames';
import { DEFAULTS } from '../../src/lib/setlist/defaults';
import { isOn, type TunerAction } from '../../src/lib/setlist/tuner';
import { allMatches, me } from '../fixtures/screen';
import { ANDROID_CHROME, INSTAGRAM, IOS_SAFARI, micOn } from '../helpers/micFlow';

const run = (events: FlowEvent[], from: FlowState = initialState) => events.reduce(flowReducer, from);
const names = (prev: FlowState, action: FlowEvent) => eventsFor(prev, action).map((e) => e.name);
const signedOut: FlowEvent = { type: 'booted', me: null, progress: null, wantsPick: false };
/** A tuner action as a flow event, and several of them in order. */
const tuner = (action: TunerAction): FlowEvent => ({ type: 'tuner', action });
const tune = (...actions: TunerAction[]): FlowEvent[] => actions.map(tuner);
const gearDone = (gear: 'difficulty' | 'history' | 'popularity' | 'tempo'): FlowEvent => ({ type: 'gearDone', gear });

describe('funnel events', () => {
  it('follows the onboarding: title, start, quiet spot, both notes, range', () => {
    expect(names(initialState, signedOut)).toEqual(['title_view']);
    const landing = run([signedOut]);
    expect(names(landing, { type: 'start' })).toEqual(['start_pressed', 'quiet_shown']);
    const low = run([{ type: 'start' }, { type: 'quietDone' }, ...micOn], landing);
    expect(eventsFor(low, { type: 'holdEnd', midi: null })).toEqual([{ name: 'hold_too_short', props: { step: 'low' } }]);
    expect(eventsFor(low, { type: 'holdEnd', midi: 45 })).toEqual([{ name: 'low_note_done', props: { midi: 45 } }]);
    const high = run([{ type: 'holdEnd', midi: 45 }], low);
    expect(names(high, { type: 'holdEnd', midi: 40 })).toEqual(['note_out_of_order']);
    expect(eventsFor(high, { type: 'holdEnd', midi: 72 })).toEqual([
      { name: 'high_note_done', props: { midi: 72 } },
      { name: 'range_shown', props: { low: 45, high: 72, spanSemitones: 27 } },
    ]);
  });

  describe('the mic step (QWW-50)', () => {
    const atMic = run([signedOut, { type: 'start' }, { type: 'quietDone' }]);
    /** Every event the actions produce, in order, each step starting from where the last left the flow. */
    function record(from: FlowState, actions: FlowEvent[]) {
      const out: { name: string; props?: Record<string, unknown> }[] = [];
      let state = from;
      for (const action of actions) {
        out.push(...eventsFor(state, action));
        state = flowReducer(state, action);
      }
      return out;
    }

    it('a first-time singer on an iPhone: our screen shown, then the answer', () => {
      expect(record(atMic, [...micOn])).toEqual([
        { name: 'mic_prompt_shown', props: { browser: 'ios-safari' } },
        { name: 'mic_granted', props: { via: 'prompt', browser: 'ios-safari' } },
      ]);
    });

    it('mic_granted is logged on the grant itself, once: the grant leaves the mic step, so no screen change carries it', () => {
      const asking = run(micOn.slice(0, 2), atMic);
      expect(asking.mic.view).toBe('asking');
      // The grant is what takes the singer on to the note...
      const atNote = run([{ type: 'micGranted' }], asking);
      expect(atNote.step).toBe('low');
      expect(eventsFor(asking, { type: 'micGranted' })).toEqual([{ name: 'mic_granted', props: { via: 'prompt', browser: 'ios-safari' } }]);
      // ...and a second answer, with nothing waiting for one any more, is not a second grant.
      expect(eventsFor(atNote, { type: 'micGranted' })).toEqual([]);
      expect(record(atMic, [...micOn, { type: 'micGranted' }]).filter((e) => e.name === 'mic_granted')).toHaveLength(1);
    });

    it('a microphone lost during a note and set up again is a second grant, with our screen shown again before it', () => {
      // Allowed from the start, so no screen of ours the first time; the second time the screen shows even though the browser still says yes.
      expect(
        record(atMic, [
          { type: 'micChecked', env: IOS_SAFARI, permission: 'granted' },
          { type: 'micGranted' },
          { type: 'micLost' },
          { type: 'micChecked', env: IOS_SAFARI, permission: 'granted' },
          { type: 'micAsk' },
          { type: 'micGranted' },
        ]),
      ).toEqual([
        { name: 'mic_granted', props: { via: 'already', browser: 'ios-safari' } },
        { name: 'mic_prompt_shown', props: { browser: 'ios-safari' } },
        { name: 'mic_granted', props: { via: 'prompt', browser: 'ios-safari' } },
      ]);
    });

    it('a microphone the browser had already allowed is a grant "via: already", with no prompt screen', () => {
      expect(record(atMic, [{ type: 'micChecked', env: ANDROID_CHROME, permission: 'granted' }, { type: 'micGranted' }])).toEqual([
        { name: 'mic_granted', props: { via: 'already', browser: 'android-chrome' } },
      ]);
    });

    it('a no after the tap is mic_denied then mic_recovery_shown, with the reason', () => {
      expect(
        record(atMic, [{ type: 'micChecked', env: IOS_SAFARI, permission: 'prompt' }, { type: 'micAsk' }, { type: 'micFailed', reason: 'dismissed' }]).slice(1),
      ).toEqual([
        { name: 'mic_denied', props: { reason: 'dismissed', via: 'prompt', browser: 'ios-safari' } },
        { name: 'mic_recovery_shown', props: { reason: 'dismissed', browser: 'ios-safari' } },
      ]);
    });

    it('a microphone already blocked goes straight to recovery: mic_denied "via: already", no prompt screen', () => {
      expect(record(atMic, [{ type: 'micChecked', env: ANDROID_CHROME, permission: 'denied' }])).toEqual([
        { name: 'mic_denied', props: { reason: 'denied', via: 'already', browser: 'android-chrome' } },
        { name: 'mic_recovery_shown', props: { reason: 'denied', browser: 'android-chrome' } },
      ]);
    });

    it('Try again that works is a grant; one that fails again logs the denial again', () => {
      const denied = run([{ type: 'micChecked', env: IOS_SAFARI, permission: 'denied' }], atMic);
      expect(record(denied, [{ type: 'micAsk' }, { type: 'micGranted' }])).toEqual([{ name: 'mic_granted', props: { via: 'prompt', browser: 'ios-safari' } }]);
      expect(record(denied, [{ type: 'micAsk' }, { type: 'micFailed', reason: 'denied' }]).map((e) => e.name)).toEqual(['mic_denied', 'mic_recovery_shown']);
    });

    it('inside Instagram it logs which app, before the prompt screen if the singer tries anyway', () => {
      expect(record(atMic, [{ type: 'micChecked', env: INSTAGRAM, permission: 'prompt' }, { type: 'micTryHere' }])).toEqual([
        { name: 'inapp_browser_detected', props: { app: 'instagram', browser: 'ios-other' } },
        { name: 'mic_prompt_shown', props: { browser: 'ios-other' } },
      ]);
    });

    it('logs nothing while the step only looks, opens or waits, and nothing for a late answer', () => {
      expect(record(atMic, [{ type: 'micChecked', env: IOS_SAFARI, permission: 'granted' }])).toEqual([]);
      expect(record(atMic, [{ type: 'micGranted' }, { type: 'micFailed', reason: 'denied' }])).toEqual([]);
    });

    it('carries no account or song data: only the browser, the app, the reason and via', () => {
      const all = record(atMic, [
        { type: 'micChecked', env: INSTAGRAM, permission: 'prompt' },
        { type: 'micTryHere' },
        { type: 'micAsk' },
        { type: 'micFailed', reason: 'denied' },
      ]);
      const keys = new Set(all.flatMap((e) => Object.keys(e.props ?? {})));
      expect([...keys].sort()).toEqual(['app', 'browser', 'reason', 'via']);
    });
  });

  it('records results, and the songs opened and rated with the tuner they were found in', () => {
    const atResults = run([{ type: 'booted', me: me({ low: 45, high: 72, source: 'test' }), progress: null, wantsPick: false }]);
    expect(eventsFor(atResults, { type: 'allLoaded', page: allMatches() })).toEqual([
      { name: 'list_view', props: { mode: 'library', matchCount: 8, maybeCount: 2 } },
    ]);
    const empty = { ...allMatches(0) };
    expect(names(atResults, { type: 'allLoaded', page: empty })).toEqual(['list_view', 'results_empty']);
    const loaded = run([{ type: 'allLoaded', page: allMatches() }], atResults);
    // An untouched tuner, signed in or not: Difficulty and Popularity on at their defaults; History, Tempo and Era start off.
    const untouched = {
      mode: 'library',
      difficulty: DEFAULTS.difficulty / 100,
      familiarity: null,
      popularity: DEFAULTS.popularity / 100,
      tempo: null,
      eras: null,
    };
    expect(eventsFor(loaded, { type: 'select', trackId: 't3', position: 4 })).toEqual([{ name: 'song_open', props: { ...untouched, position: 4 } }]);
    expect(eventsFor(loaded, { type: 'feedback', trackId: 't3', thumbs: 'down' })).toEqual([{ name: 'feedback_tapped', props: { thumbs: 'down', ...untouched } }]);
    expect(eventsFor(loaded, { type: 'loadMore' })).toEqual([{ name: 'generate_more_pressed', props: { shown: SHOW_STEP, ...untouched } }]);
  });

  it('records a library the server could not read as catalogue results, and says so (QWW-55)', () => {
    const atResults = run([{ type: 'booted', me: me({ low: 45, high: 72, source: 'test' }), progress: null, wantsPick: false }]);
    const page = { ...allMatches(), libraryUnavailable: true };
    expect(eventsFor(atResults, { type: 'allLoaded', page })).toEqual([
      { name: 'list_view', props: { mode: 'catalogue', matchCount: 8, maybeCount: 2, libraryUnavailable: true } },
    ]);
    expect(eventsFor(atResults, { type: 'allLoaded', page: { ...allMatches(0), libraryUnavailable: true } })).toEqual([
      { name: 'list_view', props: { mode: 'catalogue', matchCount: 0, maybeCount: 0, libraryUnavailable: true } },
      { name: 'results_empty', props: { mode: 'catalogue' } },
    ]);
  });

  it('never puts a Spotify track id in an event; catalogue songs carry their catalogue key', () => {
    const atResults = run([{ type: 'booted', me: me({ low: 45, high: 72, source: 'test' }), progress: null, wantsPick: false }]);
    const library = eventsFor(atResults, { type: 'select', trackId: '4uLU6hMCjMI75M1A2tKUQC', position: 1 });
    expect(JSON.stringify(library)).not.toContain('4uLU6hMCjMI75M1A2tKUQC');
    const catalogue = eventsFor(atResults, { type: 'select', trackId: 'cat:queen|bohemian rhapsody', position: 1 });
    expect(catalogue[0]!.props!.songKey).toBe('queen|bohemian rhapsody');
    expect(catalogueKey('t1')).toBeNull();
  });

  it('a second answer while finishing a slow load is not a new results view', () => {
    const atResults = run([{ type: 'booted', me: me({ low: 45, high: 72, source: 'test' }), progress: null, wantsPick: false }]);
    const partial = run([{ type: 'allLoaded', page: { ...allMatches(3), complete: false } }], atResults);
    expect(names(partial, { type: 'allLoaded', page: allMatches() })).toEqual([]);
  });

  it("records a preview that started playing with its place in the list, and a catalogue song's key only (QWW-48)", () => {
    expect(rowPlayEvent('cat:queen|bohemian rhapsody', 3)).toEqual({ name: 'row_play', props: { position: 3, songKey: 'queen|bohemian rhapsody' } });
    // A library song carries only its place: nothing that names it.
    const library = rowPlayEvent('4uLU6hMCjMI75M1A2tKUQC', 5);
    expect(library).toEqual({ name: 'row_play', props: { position: 5 } });
    expect(JSON.stringify(library)).not.toContain('4uLU6h');
    expect(rowPlayEvent('t1')).toEqual({ name: 'row_play', props: { position: null } });
    for (const e of [rowPlayEvent('cat:a|b', 1), rowPlayEvent('t1', 2)]) {
      for (const key of Object.keys(e.props!)) expect(POSTHOG_PROPS.has(key), key).toBe(true);
    }
  });

  it('records only props that PostHog may have (POSTHOG_PROPS), so a new prop is a conscious choice', () => {
    const seen = new Set<string>();
    let state = initialState;
    const walk: FlowEvent[] = [
      signedOut,
      { type: 'start' },
      { type: 'quietDone' },
      // The mic step: inside another app's browser, tried anyway, refused, then allowed (QWW-50).
      { type: 'micChecked', env: INSTAGRAM, permission: 'prompt' },
      { type: 'micTryHere' },
      { type: 'micAsk' },
      { type: 'micFailed', reason: 'denied' },
      { type: 'micAsk' },
      { type: 'micGranted' },
      { type: 'holdStart' },
      { type: 'holdEnd', midi: null },
      { type: 'holdEnd', midi: 45 },
      { type: 'holdEnd', midi: 40 },
      { type: 'holdEnd', midi: 72 },
      { type: 'showCatalogue' },
      { type: 'loadFailed' },
      { type: 'retryLoad' },
      { type: 'allLoaded', page: { ...allMatches(), libraryUnavailable: true } },
      { type: 'loadMore' },
      tuner({ type: 'input', gear: 'difficulty', value: 30 }),
      gearDone('difficulty'),
      tuner({ type: 'reset', gear: 'difficulty' }),
      tuner({ type: 'era', era: 's80' }),
      tuner({ type: 'reset', gear: 'era' }),
      { type: 'select', trackId: 'cat:queen|bohemian rhapsody', position: 2 },
      { type: 'feedback', trackId: 'cat:queen|bohemian rhapsody', thumbs: 'up' },
      { type: 'deselect' },
      { type: 'redoEnd', end: 'low' },
      { type: 'redo' },
      { type: 'pickStart' },
    ];
    for (const action of walk) {
      for (const e of eventsFor(state, action)) for (const key of Object.keys(e.props ?? {})) seen.add(key);
      state = flowReducer(state, action);
    }
    expect([...seen].filter((key) => !POSTHOG_PROPS.has(key))).toEqual([]);
    // The walk reached the events that carry props, so the check above means something.
    for (const key of ['step', 'midi', 'low', 'high', 'spanSemitones', 'mode', 'matchCount', 'libraryUnavailable', 'shown', 'gear', 'value', 'on', 'era', 'picked', 'eras', 'position', 'songKey', 'thumbs', 'end', 'from', 'signedIn', 'browser', 'via', 'reason', 'app']) {
      expect(seen.has(key), key).toBe(true);
    }
  });
});

describe('the Setlist tuner events', () => {
  const signedInRange = { low: 45, high: 72, source: 'test' as const };
  const atResults = run([{ type: 'booted', me: me(signedInRange), progress: null, wantsPick: false }]);
  const loaded = run([{ type: 'allLoaded', page: allMatches() }], atResults);

  describe('while a control is being dragged or pressed', () => {
    it.each<[string, TunerAction]>([
      ['a slider moving', { type: 'input', gear: 'difficulty', value: 33 }],
      ['a press on an off slider', { type: 'touch', gear: 'tempo' }],
      ['a tab', { type: 'open', gear: 'era' }],
      ['the handle', { type: 'mini', mini: true }],
      ['the test hook', { type: 'patch', patch: { tempo: 10 } }],
    ])('%s records nothing', (_what, action) => {
      expect(eventsFor(loaded, tuner(action))).toEqual([]);
    });

    it('a whole drag of one slider, value by value, records nothing', () => {
      let s = loaded;
      for (const value of [21, 25, 30, 33, 38, 40]) {
        expect(eventsFor(s, tuner({ type: 'input', gear: 'popularity', value }))).toEqual([]);
        s = flowReducer(s, tuner({ type: 'input', gear: 'popularity', value }));
      }
    });
  });

  describe('gear_change', () => {
    it('is one record per adjustment, when the thumb is let go, with where it ended and that the gear is on', () => {
      const dragged = run(tune({ type: 'input', gear: 'difficulty', value: 33 }), loaded);
      expect(eventsFor(dragged, gearDone('difficulty'))).toEqual([
        { name: 'gear_change', props: { gear: 'difficulty', value: 33, on: true, mode: 'library' } },
      ]);
    });

    it('a tap that moved nothing on an off slider is recorded at the default value, on', () => {
      const pressed = run(tune({ type: 'touch', gear: 'tempo' }), loaded);
      expect(eventsFor(pressed, gearDone('tempo'))).toEqual([
        { name: 'gear_change', props: { gear: 'tempo', value: DEFAULTS.tempo, on: true, mode: 'library' } },
      ]);
    });

    it('says a gear is off when it is still off at the end of the adjustment', () => {
      expect(eventsFor(loaded, gearDone('tempo'))).toEqual([
        { name: 'gear_change', props: { gear: 'tempo', value: DEFAULTS.tempo, on: false, mode: 'library' } },
      ]);
    });

    it('a reset is a gear going off at its default value, recorded when it is pressed', () => {
      const moved = run(tune({ type: 'input', gear: 'difficulty', value: 80 }), loaded);
      expect(eventsFor(moved, tuner({ type: 'reset', gear: 'difficulty' }))).toEqual([
        { name: 'gear_change', props: { gear: 'difficulty', value: DEFAULTS.difficulty, on: false, mode: 'library' } },
      ]);
      expect(eventsFor(loaded, tuner({ type: 'reset', gear: 'history' }))[0]!.props).toMatchObject({ gear: 'history', value: DEFAULTS.history, on: false });
    });

    it('carries the results mode the singer is in', () => {
      const catalogue = run([{ type: 'booted', me: null, progress: null, wantsPick: false, savedRange: { low: 45, high: 72 } }, { type: 'allLoaded', page: allMatches() }]);
      expect(eventsFor(catalogue, gearDone('difficulty'))[0]!.props).toMatchObject({ mode: 'catalogue' });
      expect(eventsFor(catalogue, tuner({ type: 'reset', gear: 'popularity' }))[0]!.props).toMatchObject({ mode: 'catalogue' });
    });
  });

  describe('era_change', () => {
    it('records the first tap on an era as that era alone, picked, with Era now on', () => {
      expect(eventsFor(loaded, tuner({ type: 'era', era: 's80' }))).toEqual([
        { name: 'era_change', props: { era: 's80', picked: true, on: true, eras: 's80', mode: 'library' } },
      ]);
    });

    it('records the picks after a tap as one comma string, in the order they were picked', () => {
      const one = run(tune({ type: 'era', era: 's80' }), loaded);
      expect(eventsFor(one, tuner({ type: 'era', era: 's00' }))).toEqual([
        { name: 'era_change', props: { era: 's00', picked: true, on: true, eras: 's80,s00', mode: 'library' } },
      ]);
    });

    it('says picked is false when the tap took the era out', () => {
      const picked = run(tune({ type: 'era', era: 's80' }, { type: 'era', era: 's90' }), loaded);
      expect(eventsFor(picked, tuner({ type: 'era', era: 's90' }))).toEqual([
        { name: 'era_change', props: { era: 's90', picked: false, on: true, eras: 's80', mode: 'library' } },
      ]);
    });

    it('takes the last pick out to an empty string, with Era still on (an empty list, not an off gear)', () => {
      const one = run(tune({ type: 'era', era: 's80' }), loaded);
      expect(eventsFor(one, tuner({ type: 'era', era: 's80' }))).toEqual([
        { name: 'era_change', props: { era: 's80', picked: false, on: true, eras: '', mode: 'library' } },
      ]);
    });

    it('a reset has no era, no pick, Era off, and the default picks (there are none)', () => {
      const picked = run(tune({ type: 'era', era: 's80' }), loaded);
      expect(DEFAULTS.eras).toEqual([]);
      expect(eventsFor(picked, tuner({ type: 'reset', gear: 'era' }))).toEqual([
        { name: 'era_change', props: { era: null, picked: false, on: false, eras: '', mode: 'library' } },
      ]);
    });
  });

  describe('the tuner on song_open, feedback_tapped and generate_more_pressed', () => {
    const tuned = run(
      tune(
        { type: 'input', gear: 'difficulty', value: 33 },
        { type: 'input', gear: 'history', value: 80 },
        { type: 'input', gear: 'tempo', value: 35 },
        { type: 'reset', gear: 'popularity' },
        { type: 'era', era: 's80' },
      ),
      loaded,
    );
    // Each gear's target as 0 to 1, null when it is not factored in; the eras only while Era is on.
    const props = { mode: 'library', difficulty: 0.33, familiarity: 0.8, popularity: null, tempo: 0.35, eras: 's80' };

    it('viewProps reads the tuner as it stands', () => {
      expect(viewProps(tuned)).toEqual(props);
      expect(viewProps(loaded)).toEqual({ mode: 'library', difficulty: 0, familiarity: null, popularity: 1, tempo: null, eras: null });
    });

    it('all three carry it', () => {
      expect(eventsFor(tuned, { type: 'select', trackId: 't2', position: 3 })).toEqual([{ name: 'song_open', props: { ...props, position: 3 } }]);
      expect(eventsFor(tuned, { type: 'feedback', trackId: 't2', thumbs: 'up' })).toEqual([{ name: 'feedback_tapped', props: { thumbs: 'up', ...props } }]);
      expect(eventsFor(tuned, { type: 'loadMore' })).toEqual([{ name: 'generate_more_pressed', props: { shown: SHOW_STEP, ...props } }]);
    });

    it('a song with no position says so, and a catalogue song carries its catalogue key but never a Spotify id', () => {
      expect(eventsFor(tuned, { type: 'select', trackId: 't2' })[0]!.props).toEqual({ ...props, position: null });
      expect(eventsFor(tuned, { type: 'select', trackId: 'cat:queen|bohemian rhapsody', position: 1 })[0]!.props).toEqual({
        ...props,
        position: 1,
        songKey: 'queen|bohemian rhapsody',
      });
    });

    it('does not count History when there is no listening data, even if the gear is on', () => {
      // A signed-in singer who switched History on, whose library then could not be read: the songs are the catalogue's.
      const on = run([{ type: 'allLoaded', page: allMatches() }, ...tune({ type: 'input', gear: 'history', value: 80 })], atResults);
      expect(viewProps(on).familiarity).toBe(0.8);
      const unreadable = run([{ type: 'allLoaded', page: { ...allMatches(), libraryUnavailable: true } }], on);
      expect(isOn(unreadable.tuner, 'history')).toBe(true);
      expect(viewProps(unreadable)).toMatchObject({ mode: 'catalogue', familiarity: null, difficulty: 0 });
      // Signed out: History is off, so it is null for that reason too.
      const catalogue = run([{ type: 'booted', me: null, progress: null, wantsPick: false, savedRange: { low: 45, high: 72 } }]);
      expect(viewProps(catalogue)).toEqual({ mode: 'catalogue', difficulty: 0, familiarity: null, popularity: 1, tempo: null, eras: null });
    });

    it('Era on with nothing picked is an empty string, not null: the filter is on', () => {
      const none = run(tune({ type: 'era', era: 's90' }, { type: 'era', era: 's90' }), loaded);
      expect(none.tuner.eras).toEqual([]);
      expect(viewProps(none).eras).toBe('');
    });
  });

  describe('feedbackView, the shape the feedback API still checks', () => {
    it('is the tuner as the old results view: gears as 0 to 1 or null, and no chips', () => {
      const tuned = run(
        tune(
          { type: 'input', gear: 'difficulty', value: 33 },
          { type: 'input', gear: 'history', value: 80 },
          { type: 'input', gear: 'tempo', value: 35 },
          { type: 'reset', gear: 'popularity' },
          { type: 'era', era: 's80' },
        ),
        loaded,
      );
      expect(feedbackView(tuned)).toEqual({
        difficulty: 0.33,
        familiarity: 0.8,
        popularity: null,
        tempo: 0.35,
        decade: null,
        mood: null,
        duetsOnly: false,
      });
      // Era has no place in it: the feedback API has never had one.
      expect(feedbackView(loaded)).not.toHaveProperty('eras');
    });

    it('has History null when there is no library, even if the gear is on', () => {
      const on = run([{ type: 'allLoaded', page: allMatches() }, ...tune({ type: 'input', gear: 'history', value: 80 })], atResults);
      expect(feedbackView(on).familiarity).toBe(0.8);
      const unreadable = run([{ type: 'allLoaded', page: { ...allMatches(), libraryUnavailable: true } }], on);
      expect(feedbackView(unreadable).familiarity).toBeNull();
    });
  });
});
