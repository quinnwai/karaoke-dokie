import { describe, expect, it } from 'vitest';
import type { EventValue } from '../../src/lib/contracts';
import { FUNNEL, MAX_SESSIONS, median, summarizeEvents } from '../../src/lib/server/eventStats';
import type { StoredEvent } from '../../src/lib/server/store';

/** Hand-built events, one second apart in the order they are made. */
function timeline(start = Date.parse('2026-11-03T10:00:00.000Z')) {
  let t = start;
  return (anonId: string, name: string, props?: Record<string, EventValue>): StoredEvent => {
    t += 1000;
    const e: StoredEvent = { anonId, name, at: new Date(t).toISOString() };
    if (props) e.props = props;
    return e;
  };
}

const counts = (events: StoredEvent[]) => Object.fromEntries(summarizeEvents(events).funnel.map((s) => [s.name, s.devices]));

describe('summarizeEvents: funnel', () => {
  it('lists every step in funnel order, with zeros when nothing happened', () => {
    expect(summarizeEvents([])).toEqual({
      funnel: FUNNEL.map((s) => ({ name: s.label, devices: 0 })),
      byControl: {},
      sessions: [],
    });
    expect(FUNNEL.map((s) => s.label)).toEqual([
      'landing_viewed',
      'start_pressed',
      'low_note_detected',
      'high_note_detected',
      'range_shown',
      'results_viewed',
      'song_opened',
      'spotify_link_pressed',
      'spotify_connect_pressed',
    ]);
  });

  it('counts distinct devices per step, splitting note_detected by its step prop', () => {
    const ev = timeline();
    const events = [
      // A goes all the way, viewing the landing twice.
      ev('device-a', 'landing_viewed'),
      ev('device-a', 'landing_viewed'),
      ev('device-a', 'start_pressed'),
      ev('device-a', 'note_detected', { step: 'low' }),
      ev('device-a', 'note_detected', { step: 'high' }),
      ev('device-a', 'range_shown'),
      ev('device-a', 'results_viewed'),
      ev('device-a', 'song_opened', { sort: 'top', position: 0 }),
      ev('device-a', 'spotify_link_pressed', { sort: 'top' }),
      // B retries the low note and stops there.
      ev('device-b', 'landing_viewed'),
      ev('device-b', 'start_pressed'),
      ev('device-b', 'note_detected', { step: 'low' }),
      ev('device-b', 'note_detected', { step: 'low' }),
      // C is a returning tester: straight to results, no earlier steps.
      ev('device-c', 'results_viewed'),
      ev('device-c', 'song_opened'),
      ev('device-c', 'spotify_connect_pressed'),
      // A note without a step counts for neither end; other events are not funnel steps.
      ev('device-d', 'note_detected'),
      ev('device-d', 'sort_selected', { sort: 'warmup' }),
    ];
    expect(counts(events)).toEqual({
      landing_viewed: 2,
      start_pressed: 2,
      low_note_detected: 2,
      high_note_detected: 1,
      range_shown: 1,
      results_viewed: 2,
      song_opened: 2,
      spotify_link_pressed: 1,
      spotify_connect_pressed: 1,
    });
  });
});

describe('summarizeEvents: byControl', () => {
  const none = { difficulty: null, familiarity: null, popularity: null, decade: null, mood: null, duetsOnly: false };

  it('counts opens, Spotify opens and thumbs per control in use, with the median position opened', () => {
    const ev = timeline();
    const events = [
      ev('device-a', 'song_opened', { ...none, position: 0 }),
      ev('device-a', 'song_opened', { ...none, position: 4 }),
      ev('device-b', 'song_opened', { ...none, position: 1 }),
      ev('device-a', 'spotify_link_pressed', none),
      ev('device-b', 'spotify_link_pressed', none),
      ev('device-a', 'feedback_tapped', { ...none, thumbs: 'up' }),
      ev('device-b', 'feedback_tapped', { ...none, thumbs: 'up' }),
      ev('device-b', 'feedback_tapped', { ...none, thumbs: 'down' }),
      ev('device-b', 'feedback_tapped', { ...none, thumbs: 'sideways' }),
      // An open without a position counts as an open but not toward the median.
      ev('device-a', 'song_opened', { ...none, difficulty: 0.2, position: 2 }),
      ev('device-a', 'song_opened', { ...none, difficulty: 0.2 }),
      ev('device-a', 'spotify_link_pressed', { ...none, difficulty: 0.2 }),
      // Two controls in use count toward both. An even number of positions: the mean of the middle two.
      ...[10, 1, 3, 2].map((position) => ev('device-c', 'song_opened', { ...none, familiarity: 1, decade: '80s', position })),
      // Thumbs with no opens: no median.
      ev('device-c', 'feedback_tapped', { ...none, popularity: 0.9, mood: 'upbeat', duetsOnly: true, thumbs: 'down' }),
      // No view props, or a slider that is not a number: nothing in use.
      ev('device-a', 'song_opened', { position: 7 }),
      ev('device-a', 'song_opened', { difficulty: 'high', position: 7 }),
      // Left out: events that are not about songs.
      ev('device-a', 'slider_changed', { ...none, slider: 'difficulty', difficulty: 0.5 }),
      ev('device-a', 'results_viewed', { ...none, decade: '90s' }),
    ];
    expect(summarizeEvents(events).byControl).toEqual({
      none: { opened: 5, spotify: 2, up: 2, down: 1, medianPosition: 4 },
      difficulty: { opened: 2, spotify: 1, up: 0, down: 0, medianPosition: 2 },
      familiarity: { opened: 4, spotify: 0, up: 0, down: 0, medianPosition: 2.5 },
      decade: { opened: 4, spotify: 0, up: 0, down: 0, medianPosition: 2.5 },
      popularity: { opened: 0, spotify: 0, up: 0, down: 1, medianPosition: null },
      mood: { opened: 0, spotify: 0, up: 0, down: 1, medianPosition: null },
      duets: { opened: 0, spotify: 0, up: 0, down: 1, medianPosition: null },
    });
  });

  it('keys are only the fixed control names, whatever strings the props carry', () => {
    const ev = timeline();
    const { byControl } = summarizeEvents([ev('device-a', 'song_opened', { ...none, decade: '__proto__', mood: 'constructor', position: 1 })]);
    expect(Object.keys(byControl).sort()).toEqual(['decade', 'mood']);
    expect(Object.getPrototypeOf(byControl)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).opened).toBeUndefined();
  });
});

describe('summarizeEvents: sessions', () => {
  it("lists each device's events in time order, the most recently active device first", () => {
    const ev = timeline();
    const a1 = ev('device-a', 'landing_viewed');
    const b1 = ev('device-b', 'landing_viewed');
    const a2 = ev('device-a', 'start_pressed', { from: 'landing' });
    const b2 = ev('device-b', 'start_pressed');
    const c1 = ev('device-c', 'results_viewed');
    const a3 = ev('device-a', 'note_detected', { step: 'low' });
    const { sessions } = summarizeEvents([c1, a3, b2, a1, b1, a2]); // order should not matter
    expect(sessions).toEqual([
      {
        anonId: 'device-a',
        events: [
          { name: 'landing_viewed', at: a1.at },
          { name: 'start_pressed', at: a2.at, props: { from: 'landing' } },
          { name: 'note_detected', at: a3.at, props: { step: 'low' } },
        ],
      },
      { anonId: 'device-c', events: [{ name: 'results_viewed', at: c1.at }] },
      {
        anonId: 'device-b',
        events: [
          { name: 'landing_viewed', at: b1.at },
          { name: 'start_pressed', at: b2.at },
        ],
      },
    ]);
    expect(sessions[0]!.events[0]).not.toHaveProperty('anonId');
    expect(sessions[0]!.events[0]).not.toHaveProperty('props');
  });

  it('keeps the arrival order of events with the same time', () => {
    const at = '2026-11-03T10:00:00.000Z';
    const { sessions } = summarizeEvents(['first', 'second', 'third'].map((name) => ({ anonId: 'device-a', name, at })));
    expect(sessions[0]!.events.map((e) => e.name)).toEqual(['first', 'second', 'third']);
  });

  it(`stops at the ${MAX_SESSIONS} most recently active devices`, () => {
    const ev = timeline();
    const events = Array.from({ length: MAX_SESSIONS + 5 }, (_, i) => ev(`device-${i}`, 'landing_viewed'));
    const { sessions, funnel } = summarizeEvents(events);
    expect(sessions).toHaveLength(MAX_SESSIONS);
    expect(sessions[0]!.anonId).toBe(`device-${MAX_SESSIONS + 4}`);
    expect(sessions.at(-1)!.anonId).toBe('device-5');
    // The cap is only on the replay; the funnel counts every device.
    expect(funnel[0]).toEqual({ name: 'landing_viewed', devices: MAX_SESSIONS + 5 });
  });
});

describe('median', () => {
  it('is the middle value, or the mean of the middle two, and null for none', () => {
    expect(median([])).toBeNull();
    expect(median([3])).toBe(3);
    expect(median([1, 4])).toBe(2.5);
    const xs = [5, 1, 3];
    expect(median(xs)).toBe(3);
    expect(xs).toEqual([5, 1, 3]); // not sorted in place
  });
});
