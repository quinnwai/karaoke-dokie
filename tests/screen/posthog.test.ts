// @vitest-environment jsdom
// PostHog as the event tracker's second sink (QWW-51). The tests that matter most are the privacy ones: whatever a
// caller puts in a prop, nothing that names a Spotify account or a library song reaches PostHog, and PostHog gets the
// device's own random id and nothing that identifies a person.
import type { CaptureResult } from 'posthog-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent, EventsRequest, PostHogSettings } from '../../src/lib/contracts';
import { createTracker } from '../../src/lib/client/events';
import { beforeSend, createPostHogSink, postHogConfig, type PostHogClient } from '../../src/lib/client/posthog';
import { EVENT_NAME, isForbiddenProp, PROP_KEY } from '../../src/lib/eventRules';
import { EVENT, POSTHOG_PROPS } from '../../src/lib/eventNames';

const ANON = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SETTINGS: PostHogSettings = { key: 'phc_testtoken', host: 'https://us.i.posthog.com', environment: 'preview' };
const T0 = Date.parse('2026-11-10T12:00:00.000Z');

/** A posthog-js that records what it is asked, and answers like the real one where the sink looks. */
function fakeClient() {
  const calls: { init: [string, Record<string, unknown>][]; capture: [string, Record<string, unknown> | undefined, { timestamp?: Date } | undefined][]; recording: string[] } = {
    init: [],
    capture: [],
    recording: [],
  };
  const client = {
    init: (token: string, config: Record<string, unknown>) => void calls.init.push([token, config]),
    capture: (name: string, props?: Record<string, unknown>, options?: { timestamp?: Date }) => void calls.capture.push([name, props, options]),
    startSessionRecording: () => void calls.recording.push('start'),
    stopSessionRecording: () => void calls.recording.push('stop'),
  } as unknown as PostHogClient;
  return { client, calls };
}

/** A sink whose posthog-js "loads" when the test says so. */
function sinkWithSlowLoad() {
  const fake = fakeClient();
  let finish!: (c: PostHogClient) => void;
  let fail!: (e: unknown) => void;
  const loaded = new Promise<PostHogClient>((resolve, reject) => ((finish = resolve), (fail = reject)));
  const load = vi.fn(() => loaded);
  return { ...fake, sink: createPostHogSink(SETTINGS, ANON, load), load, finish: () => finish(fake.client), fail: (e: unknown = new Error('blocked')) => fail(e) };
}

const event = (name: string, props?: AppEvent['props'], at = new Date(T0).toISOString()): AppEvent => (props ? { name, at, props } : { name, at });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('postHogConfig: the privacy-relevant choices', () => {
  const config = postHogConfig(SETTINGS, ANON);

  it('sends to the configured host with the device id as the distinct id, and keeps nothing on the device', () => {
    expect(config.api_host).toBe('https://us.i.posthog.com');
    expect(config.bootstrap).toEqual({ distinctID: ANON });
    expect(config.persistence).toBe('memory');
    expect(config.person_profiles).toBe('identified_only');
  });

  it('turns off autocapture (and the click text it carries), pageviews and everything PostHog could add by itself', () => {
    expect(config).toMatchObject({
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      rageclick: false,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      capture_exceptions: false,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
      disable_web_experiments: true,
    });
  });

  it('masks inputs in the replay, and starts it off', () => {
    expect(config.session_recording).toMatchObject({ maskAllInputs: true });
    expect(config.disable_session_recording).toBe(true);
  });
});

describe('beforeSend', () => {
  const send = beforeSend('production');
  const result = (event: string, properties: Record<string, unknown> = {}): CaptureResult => ({ uuid: 'u', event, properties });

  it('keeps our own named events and tags the environment', () => {
    const out = send(result('list_view', { mode: 'catalogue', $current_url: 'https://app.test/' }));
    expect(out?.event).toBe('list_view');
    expect(out?.properties).toEqual({ mode: 'catalogue', $current_url: 'https://app.test/', environment: 'production' });
  });

  it('tags every release-funnel event with the environment, the mic and play events included', () => {
    const preview = beforeSend('preview');
    for (const name of Object.values(EVENT)) {
      const out = preview(result(name, { browser: 'ios-safari', position: 2 }));
      expect(out, name).not.toBeNull();
      expect(out!.properties.environment, name).toBe('preview');
    }
  });

  it('keeps the replay data, tagged too, untouched', () => {
    const data = [{ type: 2 }];
    const out = send(result('$snapshot', { $snapshot_data: data, $session_id: 's' }));
    expect(out?.properties).toEqual({ $snapshot_data: data, $session_id: 's', environment: 'production' });
    expect(out?.properties.$snapshot_data).toBe(data);
  });

  it('drops everything PostHog makes up itself', () => {
    for (const name of ['$pageview', '$pageleave', '$autocapture', '$identify', '$set', '$web_vitals', '$exception', '$dead_click', '$rageclick', '$feature_flag_called', '$groupidentify']) {
      expect(send(result(name, { $el_text: 'Ann Singer' }))).toBeNull();
    }
    expect(send(result('Not Ours'))).toBeNull();
  });

  it('strips props that name a Spotify account or library song, whatever their case or underscores', () => {
    const out = send(
      result('song_open', { position: 2, trackId: 'a', track_id: 'b', TRACKID: 'c', spotifyId: 'd', Spotify_ID: 'e', userId: 'f', user_id: 'g', displayName: 'Ann', display_name: 'Ann', email: 'a@b.c', EMAIL: 'a@b.c' }),
    );
    expect(out?.properties).toEqual({ position: 2, environment: 'production' });
  });

  it('does not change the event it was given', () => {
    const given = result('song_open', { trackId: 'x', position: 1 });
    send(given);
    expect(given.properties).toEqual({ trackId: 'x', position: 1 });
  });
});

describe('createPostHogSink', () => {
  it('loads posthog-js on the first event only, then sends the events that waited, in order, with the time they happened', async () => {
    const { sink, calls, load, finish } = sinkWithSlowLoad();
    sink.capture(event('title_view', undefined, '2026-11-10T12:00:00.000Z'));
    sink.capture(event('list_view', { mode: 'catalogue' }, '2026-11-10T12:00:05.500Z'));
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(calls.capture).toEqual([]);
    finish();
    await settle();
    expect(calls.init).toHaveLength(1);
    expect(calls.init[0]![0]).toBe('phc_testtoken');
    expect(calls.capture.map((c) => c[0])).toEqual(['title_view', 'list_view']);
    expect(calls.capture[1]![1]).toEqual({ mode: 'catalogue' });
    expect(calls.capture[0]![2]?.timestamp?.toISOString()).toBe('2026-11-10T12:00:00.000Z');
    expect(calls.capture[1]![2]?.timestamp?.toISOString()).toBe('2026-11-10T12:00:05.500Z');
    // Later events go straight through, without another load.
    sink.capture(event('song_open', { position: 1 }));
    expect(calls.capture.map((c) => c[0])).toEqual(['title_view', 'list_view', 'song_open']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('starts loading posthog-js when the screen first reports in, so the first event need not wait for it', async () => {
    const { sink, calls, load, finish } = sinkWithSlowLoad();
    sink.setReplay(false);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    finish();
    await settle();
    expect(calls.init).toHaveLength(1);
    sink.capture(event('title_view'));
    expect(calls.capture.map((c) => c[0])).toEqual(['title_view']); // sent at once, nothing waited
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('is initialised with the device id as the distinct id', async () => {
    const { sink, calls, finish } = sinkWithSlowLoad();
    sink.capture(event('title_view'));
    finish();
    await settle();
    expect(calls.init[0]![1]).toMatchObject({ api_host: SETTINGS.host, bootstrap: { distinctID: ANON } });
  });

  it('gives up when posthog-js cannot load, says so once in the console, and stops keeping events', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { sink, load, fail } = sinkWithSlowLoad();
      sink.capture(event('title_view'));
      fail();
      await settle();
      expect(() => sink.capture(event('list_view'))).not.toThrow();
      expect(() => sink.setReplay(true)).not.toThrow();
      expect(load).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/PostHog is off for this page.*did not load.*event log is not affected/);
    } finally {
      warn.mockRestore();
    }
  });

  it('survives a load that throws at once, an init that throws, and a capture that throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const throwingLoad = createPostHogSink(SETTINGS, ANON, () => {
      throw new Error('boom');
    });
    expect(() => throwingLoad.capture(event('title_view'))).not.toThrow();
    await settle();

    const badInit = fakeClient();
    badInit.client.init = () => {
      throw new Error('bad token');
    };
    const afterBadInit = createPostHogSink(SETTINGS, ANON, async () => badInit.client);
    afterBadInit.capture(event('title_view'));
    await settle();
    expect(() => afterBadInit.capture(event('list_view'))).not.toThrow();
    expect(badInit.calls.capture).toEqual([]);

    const badCapture = fakeClient();
    badCapture.client.capture = () => {
      throw new Error('bad capture');
    };
    const afterBadCapture = createPostHogSink(SETTINGS, ANON, async () => badCapture.client);
    afterBadCapture.capture(event('title_view'));
    await settle();
    expect(() => afterBadCapture.capture(event('list_view'))).not.toThrow();
    // The two that could not start said so, once each; a capture that throws is not worth a line.
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('does not keep events forever while posthog-js is still loading', async () => {
    const { sink, calls, finish } = sinkWithSlowLoad();
    for (let i = 0; i < 150; i++) sink.capture(event('tap', { position: i }));
    finish();
    await settle();
    expect(calls.capture).toHaveLength(100);
    expect(calls.capture[0]![1]).toEqual({ position: 0 });
  });

  describe('session replay', () => {
    it('stays off until the screen says the visitor is signed out', async () => {
      const { sink, calls, finish } = sinkWithSlowLoad();
      sink.capture(event('title_view'));
      finish();
      await settle();
      expect(calls.recording).toEqual([]);
      sink.setReplay(false);
      expect(calls.recording).toEqual([]);
      sink.setReplay(true);
      expect(calls.recording).toEqual(['start']);
      sink.setReplay(true);
      expect(calls.recording).toEqual(['start']);
      sink.setReplay(false);
      expect(calls.recording).toEqual(['start', 'stop']);
    });

    it('starts once posthog-js is ready when it was asked for while loading', async () => {
      const { sink, calls, finish } = sinkWithSlowLoad();
      sink.capture(event('title_view'));
      sink.setReplay(true);
      expect(calls.recording).toEqual([]);
      finish();
      await settle();
      expect(calls.recording).toEqual(['start']);
    });

    it('never starts when the visitor turns out to be signed in before posthog-js is ready', async () => {
      const { sink, calls, finish } = sinkWithSlowLoad();
      sink.capture(event('title_view'));
      sink.setReplay(true);
      sink.setReplay(false);
      finish();
      await settle();
      expect(calls.recording).toEqual([]);
    });
  });
});

describe('the tracker with PostHog behind it', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  /** The tracker as the screen builds it: our log's send, and PostHog (a fake client) as the mirror. */
  function wired() {
    const fake = fakeClient();
    const sent: EventsRequest[] = [];
    const sink = createPostHogSink(SETTINGS, ANON, async () => fake.client);
    const tracker = createTracker({ anonId: ANON, send: async (body) => void sent.push(body), mirror: sink });
    return { tracker, sent, sink, ...fake };
  }

  it('one track() call reaches our log and PostHog, with the same name, props and time', async () => {
    const { tracker, sent, calls } = wired();
    tracker.track(EVENT.listView, { mode: 'catalogue', matchCount: 8 });
    await tracker.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([{ anonId: ANON, events: [{ name: 'list_view', at: new Date(T0).toISOString(), props: { mode: 'catalogue', matchCount: 8 } }] }]);
    expect(calls.capture).toHaveLength(1);
    expect(calls.capture[0]![0]).toBe('list_view');
    expect(calls.capture[0]![1]).toEqual({ mode: 'catalogue', matchCount: 8 });
    expect(calls.capture[0]![2]?.timestamp?.toISOString()).toBe(new Date(T0).toISOString());
  });

  it('sends no PII field to PostHog or to our log, however the prop is spelled', async () => {
    const { tracker, sent, calls } = wired();
    tracker.track('song_open', {
      position: 3,
      songKey: 'queen|bohemian rhapsody',
      trackId: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
      track_id: '4uLU6hMCjMI75M1A2tKUQC',
      TrackID: '4uLU6hMCjMI75M1A2tKUQC',
      spotifyId: 'spotify:user:ann.singer',
      spotify_id: 'ann.singer',
      userId: 'user-5',
      user_id: 'user-5',
      displayName: 'Ann Singer',
      display_name: 'Ann Singer',
      DISPLAYNAME: 'Ann Singer',
      email: 'ann@example.com',
      Email: 'ann@example.com',
    });
    await tracker.flush();
    await vi.advanceTimersByTimeAsync(0);

    const allowed = { position: 3, songKey: 'queen|bohemian rhapsody' };
    expect(calls.capture).toHaveLength(1);
    expect(calls.capture[0]![1]).toEqual(allowed);
    expect(sent[0]!.events[0]!.props).toEqual(allowed);
    // And no trace of the values anywhere in what either place received.
    const everything = JSON.stringify([calls.capture, sent]);
    expect(everything).not.toMatch(/spotify:|4uLU6h|ann\.singer|user-5|Ann Singer|example\.com/i);
  });

  it('gives PostHog only the props on the allowlist, whatever else a caller adds', async () => {
    const { tracker, calls } = wired();
    // A play button that passes the song it plays, the way a future emitter might.
    tracker.track(EVENT.rowPlay, {
      position: 4,
      songKey: 'abba|dancing queen',
      name: 'Dancing Queen',
      title: 'Dancing Queen',
      songTitle: 'Dancing Queen',
      trackName: 'Dancing Queen',
      artist: 'ABBA',
      spotifyUri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
      uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
      'spotify-id': '4uLU6hMCjMI75M1A2tKUQC',
      id: '4uLU6hMCjMI75M1A2tKUQC',
      playlistId: '37i9dQZF1DXcBWIGoYBM5M',
      username: 'ann.singer',
      userName: 'Ann Singer',
      fullName: 'Ann Singer',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.capture).toHaveLength(1);
    expect(calls.capture[0]![1]).toEqual({ position: 4, songKey: 'abba|dancing queen' });
    expect(JSON.stringify(calls.capture)).not.toMatch(/Dancing Queen|ABBA|spotify|4uLU6h|37i9dQ|ann\.singer|Ann Singer/);
  });

  it('gives PostHog the device id and nothing that identifies a person', async () => {
    const { tracker, calls } = wired();
    tracker.track('title_view');
    await vi.advanceTimersByTimeAsync(0);
    const [, config] = calls.init[0]!;
    expect(config.bootstrap).toEqual({ distinctID: ANON });
    expect(JSON.stringify(config)).not.toMatch(/identify|email|name/i);
    expect(JSON.stringify(calls.capture)).not.toContain(ANON); // the id is the distinct id, not a prop
  });

  it('drops an event the server would reject before either place sees it', async () => {
    const { tracker, sent, calls } = wired();
    tracker.track('Bad Name');
    tracker.track('x');
    await tracker.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
    expect(calls.capture).toEqual([]);
  });

  it('cannot change what our log recorded, even if PostHog mutates what it was given', async () => {
    const sent: EventsRequest[] = [];
    const tracker = createTracker({
      anonId: ANON,
      send: async (body) => void sent.push(body),
      mirror: {
        capture(e) {
          e.name = 'changed';
          if (e.props) e.props.extra = 'added';
        },
      },
    });
    tracker.track('list_view', { mode: 'catalogue' });
    await tracker.flush();
    expect(sent[0]!.events).toEqual([{ name: 'list_view', at: new Date(T0).toISOString(), props: { mode: 'catalogue' } }]);
  });

  it('keeps recording to our log when PostHog throws', async () => {
    const sent: EventsRequest[] = [];
    const tracker = createTracker({
      anonId: ANON,
      send: async (body) => void sent.push(body),
      mirror: {
        capture() {
          throw new Error('PostHog is down');
        },
      },
    });
    expect(() => tracker.track('title_view')).not.toThrow();
    tracker.track('list_view');
    await tracker.flush();
    expect(sent[0]!.events.map((e) => e.name)).toEqual(['title_view', 'list_view']);
  });

  it('works without a PostHog sink at all', async () => {
    const sent: EventsRequest[] = [];
    const tracker = createTracker({ anonId: ANON, send: async (body) => void sent.push(body) });
    tracker.track('title_view');
    await tracker.flush();
    expect(sent[0]!.events.map((e) => e.name)).toEqual(['title_view']);
  });
});

describe('POSTHOG_PROPS', () => {
  it('lists only valid prop names, none of which the server would drop as forbidden', () => {
    for (const key of POSTHOG_PROPS) {
      expect(key).toMatch(PROP_KEY);
      expect(isForbiddenProp(key), key).toBe(false);
    }
  });

  it('has every prop the tuner, the mic flow and the play row are documented to send', () => {
    // gear_change: gear, value, on, mode. era_change: era, picked, on, eras, mode. row_play and song_open: position (and songKey). The mic flow: step.
    for (const key of ['gear', 'value', 'on', 'era', 'picked', 'eras', 'mode', 'position', 'songKey', 'step']) expect(POSTHOG_PROPS.has(key), key).toBe(true);
  });

  it('does not keep a prop the tuner stopped sending: `off` went when gear_change and era_change said `on` instead', () => {
    expect(POSTHOG_PROPS.has('off')).toBe(false);
  });
});

describe('the release funnel names', () => {
  it('are valid event names, each different', () => {
    const names = Object.values(EVENT);
    for (const name of names) expect(name).toMatch(EVENT_NAME);
    expect(new Set(names).size).toBe(names.length);
  });

  it('are the ones the sprint asked for', () => {
    expect(Object.values(EVENT).sort()).toEqual(
      [
        'title_view',
        'mic_prompt_shown',
        'mic_granted',
        'mic_denied',
        'mic_recovery_shown',
        'inapp_browser_detected',
        'low_note_done',
        'high_note_done',
        'list_view',
        'gear_change',
        'era_change',
        'row_play',
        'song_open',
        'spotify_connect',
      ].sort(),
    );
  });
});
