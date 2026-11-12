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
      'title_view',
      'start_pressed',
      'low_note_done',
      'high_note_done',
      'range_shown',
      'list_view',
      'song_open',
      'spotify_link_pressed',
      'spotify_connect',
    ]);
  });

  it('counts distinct devices per step', () => {
    const ev = timeline();
    const events = [
      // A goes all the way, viewing the landing twice.
      ev('device-a', 'title_view'),
      ev('device-a', 'title_view'),
      ev('device-a', 'start_pressed'),
      ev('device-a', 'low_note_done', { midi: 45 }),
      ev('device-a', 'high_note_done', { midi: 72 }),
      ev('device-a', 'range_shown'),
      ev('device-a', 'list_view'),
      ev('device-a', 'song_open', { sort: 'top', position: 0 }),
      ev('device-a', 'spotify_link_pressed', { sort: 'top' }),
      // B retries the low note and stops there.
      ev('device-b', 'title_view'),
      ev('device-b', 'start_pressed'),
      ev('device-b', 'low_note_done', { midi: 45 }),
      ev('device-b', 'low_note_done', { midi: 47 }),
      // C is a returning tester: straight to results, no earlier steps.
      ev('device-c', 'list_view'),
      ev('device-c', 'song_open'),
      ev('device-c', 'spotify_connect'),
      // Events that are not funnel steps count for nothing here.
      ev('device-d', 'note_out_of_order', { step: 'low', midi: 40 }),
      ev('device-d', 'sort_selected', { sort: 'warmup' }),
    ];
    expect(counts(events)).toEqual({
      title_view: 2,
      start_pressed: 2,
      low_note_done: 2,
      high_note_done: 1,
      range_shown: 1,
      list_view: 2,
      song_open: 2,
      spotify_link_pressed: 1,
      spotify_connect: 1,
    });
  });
});

describe('summarizeEvents: byControl', () => {
  const none = { difficulty: null, familiarity: null, popularity: null, decade: null, mood: null, duetsOnly: false };

  it('counts opens, Spotify opens and thumbs per control in use, with the median position opened', () => {
    const ev = timeline();
    const events = [
      ev('device-a', 'song_open', { ...none, position: 0 }),
      ev('device-a', 'song_open', { ...none, position: 4 }),
      ev('device-b', 'song_open', { ...none, position: 1 }),
      ev('device-a', 'spotify_link_pressed', none),
      ev('device-b', 'spotify_link_pressed', none),
      ev('device-a', 'feedback_tapped', { ...none, thumbs: 'up' }),
      ev('device-b', 'feedback_tapped', { ...none, thumbs: 'up' }),
      ev('device-b', 'feedback_tapped', { ...none, thumbs: 'down' }),
      ev('device-b', 'feedback_tapped', { ...none, thumbs: 'sideways' }),
      // An open without a position counts as an open but not toward the median.
      ev('device-a', 'song_open', { ...none, difficulty: 0.2, position: 2 }),
      ev('device-a', 'song_open', { ...none, difficulty: 0.2 }),
      ev('device-a', 'spotify_link_pressed', { ...none, difficulty: 0.2 }),
      // Two controls in use count toward both. An even number of positions: the mean of the middle two.
      ...[10, 1, 3, 2].map((position) => ev('device-c', 'song_open', { ...none, familiarity: 1, decade: '80s', position })),
      // Thumbs with no opens: no median.
      ev('device-c', 'feedback_tapped', { ...none, popularity: 0.9, mood: 'upbeat', duetsOnly: true, thumbs: 'down' }),
      // A slider that is not a number is not in use.
      ev('device-a', 'song_open', { ...none, difficulty: 'high', position: 7 }),
      // Left out: events with no view (from before the sliders, or with no props), and events that are not about songs.
      ev('device-a', 'song_open', { sort: 'top', decade: null, mood: null, duetsOnly: false, position: 9 }),
      ev('device-a', 'song_open', { position: 9 }),
      ev('device-a', 'song_open'),
      ev('device-a', 'slider_changed', { ...none, slider: 'difficulty', difficulty: 0.5 }),
      ev('device-a', 'list_view', { ...none, decade: '90s' }),
    ];
    expect(summarizeEvents(events).byControl).toEqual({
      none: { opened: 4, spotify: 2, up: 2, down: 1, medianPosition: 2.5 },
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
    const { byControl } = summarizeEvents([ev('device-a', 'song_open', { ...none, decade: '__proto__', mood: 'constructor', position: 1 })]);
    expect(Object.keys(byControl).sort()).toEqual(['decade', 'mood']);
    expect(Object.getPrototypeOf(byControl)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).opened).toBeUndefined();
  });
});

describe('summarizeEvents: sessions', () => {
  it("lists each device's events in time order, the most recently active device first", () => {
    const ev = timeline();
    const a1 = ev('device-a', 'title_view');
    const b1 = ev('device-b', 'title_view');
    const a2 = ev('device-a', 'start_pressed', { from: 'landing' });
    const b2 = ev('device-b', 'start_pressed');
    const c1 = ev('device-c', 'list_view');
    const a3 = ev('device-a', 'low_note_done', { midi: 45 });
    const { sessions } = summarizeEvents([c1, a3, b2, a1, b1, a2]); // order should not matter
    expect(sessions).toEqual([
      {
        anonId: 'device-a',
        events: [
          { name: 'title_view', at: a1.at },
          { name: 'start_pressed', at: a2.at, props: { from: 'landing' } },
          { name: 'low_note_done', at: a3.at, props: { midi: 45 } },
        ],
      },
      { anonId: 'device-c', events: [{ name: 'list_view', at: c1.at }] },
      {
        anonId: 'device-b',
        events: [
          { name: 'title_view', at: b1.at },
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
    const events = Array.from({ length: MAX_SESSIONS + 5 }, (_, i) => ev(`device-${i}`, 'title_view'));
    const { sessions, funnel } = summarizeEvents(events);
    expect(sessions).toHaveLength(MAX_SESSIONS);
    expect(sessions[0]!.anonId).toBe(`device-${MAX_SESSIONS + 4}`);
    expect(sessions.at(-1)!.anonId).toBe('device-5');
    // The cap is only on the replay; the funnel counts every device.
    expect(funnel[0]).toEqual({ name: 'title_view', devices: MAX_SESSIONS + 5 });
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
