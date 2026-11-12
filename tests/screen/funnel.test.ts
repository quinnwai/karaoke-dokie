import { describe, expect, it } from 'vitest';
import { catalogueKey, eventsFor, rowPlayEvent } from '../../src/lib/client/funnel';
import { flowReducer, initialState, type FlowEvent, type FlowState } from '../../src/lib/client/flow';
import { POSTHOG_PROPS } from '../../src/lib/eventNames';
import { allMatches, me } from '../fixtures/screen';
import { ANDROID_CHROME, INSTAGRAM, IOS_SAFARI, micOn } from '../helpers/micFlow';

const run = (events: FlowEvent[], from: FlowState = initialState) => events.reduce(flowReducer, from);
const names = (prev: FlowState, action: FlowEvent) => eventsFor(prev, action).map((e) => e.name);
const signedOut: FlowEvent = { type: 'booted', me: null, progress: null, wantsPick: false };

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

  it('records results, views and opened songs with the view they came from', () => {
    const atResults = run([{ type: 'booted', me: me({ low: 45, high: 72, source: 'test' }), progress: null, wantsPick: false }]);
    expect(eventsFor(atResults, { type: 'allLoaded', page: allMatches() })).toEqual([
      { name: 'list_view', props: { mode: 'library', matchCount: 8, maybeCount: 2 } },
    ]);
    const empty = { ...allMatches(0) };
    expect(names(atResults, { type: 'allLoaded', page: empty })).toEqual(['list_view', 'results_empty']);
    const loaded = run([{ type: 'allLoaded', page: allMatches() }], atResults);
    // Dragging records nothing; letting go records the adjustment once, with the view it left.
    expect(names(loaded, { type: 'setSlider', slider: 'difficulty', value: 0.333 })).toEqual([]);
    const tuned = run([{ type: 'setSlider', slider: 'difficulty', value: 0.333 }], loaded);
    expect(eventsFor(tuned, { type: 'sliderDone', slider: 'difficulty' })).toEqual([
      {
        name: 'slider_changed',
        props: { slider: 'difficulty', mode: 'library', difficulty: 0.33, familiarity: null, popularity: null, tempo: null, decade: null, mood: null, duetsOnly: false },
      },
    ]);
    expect(eventsFor(tuned, { type: 'resetSliders' })).toEqual([
      { name: 'sliders_reset', props: { mode: 'library', difficulty: null, familiarity: null, popularity: null, tempo: null, decade: null, mood: null, duetsOnly: false } },
    ]);
    expect(eventsFor(loaded, { type: 'pickDecade', decade: '80s' })[0]!.props).toMatchObject({ kind: 'decade', value: '80s', on: true, decade: '80s' });
    expect(eventsFor(loaded, { type: 'select', trackId: 't3', position: 4 })).toEqual([
      {
        name: 'song_open',
        props: { mode: 'library', difficulty: null, familiarity: null, popularity: null, tempo: null, decade: null, mood: null, duetsOnly: false, position: 4 },
      },
    ]);
    expect(eventsFor(loaded, { type: 'feedback', trackId: 't3', thumbs: 'down' })[0]).toMatchObject({ name: 'feedback_tapped', props: { thumbs: 'down' } });
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
      { type: 'setSlider', slider: 'difficulty', value: 0.3 },
      { type: 'sliderDone', slider: 'difficulty' },
      { type: 'resetSliders' },
      { type: 'pickDecade', decade: '80s' },
      { type: 'pickMood', mood: 'upbeat' },
      { type: 'toggleDuets' },
      { type: 'clearFilters' },
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
    for (const key of ['step', 'midi', 'low', 'high', 'spanSemitones', 'mode', 'matchCount', 'libraryUnavailable', 'shown', 'slider', 'kind', 'value', 'on', 'decade', 'position', 'songKey', 'thumbs', 'end', 'from', 'signedIn', 'browser', 'via', 'reason', 'app']) {
      expect(seen.has(key), key).toBe(true);
    }
  });
});
