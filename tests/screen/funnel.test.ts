import { describe, expect, it } from 'vitest';
import { catalogueKey, eventsFor } from '../../src/lib/client/funnel';
import { flowReducer, initialState, type FlowEvent, type FlowState } from '../../src/lib/client/flow';
import { allMatches, me } from '../fixtures/screen';

const run = (events: FlowEvent[], from: FlowState = initialState) => events.reduce(flowReducer, from);
const names = (prev: FlowState, action: FlowEvent) => eventsFor(prev, action).map((e) => e.name);
const signedOut: FlowEvent = { type: 'booted', me: null, progress: null, wantsPick: false };

describe('funnel events', () => {
  it('follows the onboarding: landing, start, quiet spot, both notes, range', () => {
    expect(names(initialState, signedOut)).toEqual(['landing_viewed']);
    const landing = run([signedOut]);
    expect(names(landing, { type: 'start' })).toEqual(['start_pressed', 'quiet_shown']);
    const low = run([{ type: 'start' }, { type: 'quietDone' }], landing);
    expect(eventsFor(low, { type: 'holdEnd', midi: null })).toEqual([{ name: 'hold_too_short', props: { step: 'low' } }]);
    expect(eventsFor(low, { type: 'holdEnd', midi: 45 })).toEqual([{ name: 'note_detected', props: { step: 'low', midi: 45 } }]);
    const high = run([{ type: 'holdEnd', midi: 45 }], low);
    expect(names(high, { type: 'holdEnd', midi: 40 })).toEqual(['note_out_of_order']);
    expect(eventsFor(high, { type: 'holdEnd', midi: 72 })).toEqual([
      { name: 'note_detected', props: { step: 'high', midi: 72 } },
      { name: 'range_shown', props: { low: 45, high: 72, spanSemitones: 27 } },
    ]);
    expect(names(high, { type: 'micDenied' })).toEqual(['mic_denied']);
  });

  it('records results, views and opened songs with the view they came from', () => {
    const atResults = run([{ type: 'booted', me: me({ low: 45, high: 72, source: 'test' }), progress: null, wantsPick: false }]);
    expect(eventsFor(atResults, { type: 'allLoaded', page: allMatches() })).toEqual([
      { name: 'results_viewed', props: { mode: 'library', matchCount: 8, maybeCount: 2 } },
    ]);
    const empty = { ...allMatches(0) };
    expect(names(atResults, { type: 'allLoaded', page: empty })).toEqual(['results_viewed', 'results_empty']);
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
        name: 'song_opened',
        props: { mode: 'library', difficulty: null, familiarity: null, popularity: null, tempo: null, decade: null, mood: null, duetsOnly: false, position: 4 },
      },
    ]);
    expect(eventsFor(loaded, { type: 'feedback', trackId: 't3', thumbs: 'down' })[0]).toMatchObject({ name: 'feedback_tapped', props: { thumbs: 'down' } });
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
});
