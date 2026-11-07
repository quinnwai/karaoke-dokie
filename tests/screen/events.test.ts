// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsRequest, EventValue } from '../../src/lib/contracts';
import {
  BATCH_SIZE,
  createTracker,
  EVENTS_PATH,
  FLUSH_MS,
  flushWhenHidden,
  loadAnonId,
  sendEvents,
} from '../../src/lib/client/events';
import { ANON_ID } from '../../src/lib/eventRules';
import { validateEvents } from '../../src/lib/server/validate';

const ANON = '0f8fad5b-d9cb-469f-a165-70867728950e';
const T0 = Date.parse('2026-11-03T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** A tracker with a fake send that records each batch. */
function setup(send?: (body: EventsRequest) => Promise<void>) {
  const sent: EventsRequest[] = [];
  const fake = vi.fn(send ?? (async (body: EventsRequest) => void sent.push(body)));
  return { tracker: createTracker({ anonId: ANON, send: fake }), send: fake, sent };
}

describe('createTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it('sends queued events as one batch 3 s after the first, each stamped when it happened', () => {
    const { tracker, sent } = setup();
    tracker.track('landing_viewed');
    vi.advanceTimersByTime(1000);
    tracker.track('start_pressed', { from: 'landing' });
    vi.advanceTimersByTime(FLUSH_MS - 1001);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([
      {
        anonId: ANON,
        events: [
          { name: 'landing_viewed', at: iso(T0) },
          { name: 'start_pressed', at: iso(T0 + 1000), props: { from: 'landing' } },
        ],
      },
    ]);
    expect(sent[0]!.events[0]).not.toHaveProperty('props');

    // The next event starts a new 3 s wait.
    tracker.track('range_shown');
    vi.advanceTimersByTime(FLUSH_MS - 1);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent[1]!.events.map((e) => e.name)).toEqual(['range_shown']);
  });

  it(`sends at once when ${BATCH_SIZE} events are queued`, () => {
    const { tracker, send, sent } = setup();
    for (let i = 0; i < BATCH_SIZE - 1; i++) tracker.track('tap', { i });
    expect(send).not.toHaveBeenCalled();
    tracker.track('tap', { i: BATCH_SIZE - 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sent[0]!.events.map((e) => e.props?.i)).toEqual(Array.from({ length: BATCH_SIZE }, (_, i) => i));
    vi.advanceTimersByTime(FLUSH_MS);
    expect(send).toHaveBeenCalledTimes(1); // the batch's timer was stopped
  });

  it('flush() sends what is queued straight away, and nothing when the queue is empty', async () => {
    const { tracker, send } = setup();
    await tracker.flush();
    expect(send).not.toHaveBeenCalled();
    tracker.track('results_viewed');
    const done = tracker.flush();
    // Called before flush() returns, as a pagehide handler needs.
    expect(send).toHaveBeenCalledTimes(1);
    await done;
    vi.advanceTimersByTime(FLUSH_MS);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('uses the injected clock', async () => {
    let clock = Date.parse('2026-01-02T03:04:05.000Z');
    const sent: EventsRequest[] = [];
    const tracker = createTracker({ anonId: ANON, send: async (b) => void sent.push(b), now: () => new Date(clock) });
    tracker.track('first');
    clock += 500;
    tracker.track('second');
    await tracker.flush();
    expect(sent[0]!.events.map((e) => e.at)).toEqual(['2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.500Z']);
  });

  it('drops forbidden props, whatever their case or underscores', async () => {
    const { tracker, sent } = setup();
    tracker.track('song_opened', {
      sort: 'top',
      position: 2,
      trackId: 'spotify:track:1',
      TRACKID: 'spotify:track:2',
      track_id: 'spotify:track:3',
      spotifyId: 'spotify:user:4',
      userId: 'user-5',
      displayName: 'Ann Singer',
      display_name: 'Ann Singer',
      Email: 'ann@example.com',
    });
    await tracker.flush();
    expect(sent[0]!.events[0]!.props).toEqual({ sort: 'top', position: 2 });
    expect(JSON.stringify(sent)).not.toMatch(/spotify:|user-5|Ann|example\.com/);
  });

  it('drops what the server would reject, so the rest of the batch still lands', async () => {
    const { tracker, sent } = setup();
    tracker.track('Bad Name');
    tracker.track('x');
    tracker.track(undefined as unknown as string);
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${i}`, i]));
    const odd = { nested: { a: 1 }, list: [1], fn: () => 1, nan: NaN, inf: Infinity } as unknown as Record<string, EventValue>;
    tracker.track('song_opened', { note: 'n'.repeat(250), 'bad-key': 1, _x: 1, ...odd, ok: true, none: null, ...many });
    await tracker.flush();
    expect(sent).toHaveLength(1);
    const [event] = sent[0]!.events;
    expect(sent[0]!.events).toHaveLength(1);
    expect(event!.props).toEqual({
      note: 'n'.repeat(200),
      ok: true,
      none: null,
      ...Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, i])),
    });
    // Whatever the tracker sends passes the server's own check.
    expect(validateEvents(sent[0], T0).ok).toBe(true);
  });

  it('never surfaces a send that throws or rejects, or a broken clock', async () => {
    const throwing = setup(() => {
      throw new Error('boom');
    });
    expect(() => {
      for (let i = 0; i < BATCH_SIZE; i++) throwing.tracker.track('tap');
    }).not.toThrow();
    expect(throwing.send).toHaveBeenCalledTimes(1);
    throwing.tracker.track('tap');
    await expect(throwing.tracker.flush()).resolves.toBeUndefined();

    const rejecting = setup(async () => {
      throw new Error('offline');
    });
    rejecting.tracker.track('tap');
    await vi.advanceTimersByTimeAsync(FLUSH_MS); // the timer's flush rejects inside; nothing escapes
    expect(rejecting.send).toHaveBeenCalledTimes(1);
    rejecting.tracker.track('tap');
    await expect(rejecting.tracker.flush()).resolves.toBeUndefined();

    const send = vi.fn(async () => {});
    const broken = createTracker({ anonId: ANON, send, now: () => new Date(NaN) });
    expect(() => broken.track('tap')).not.toThrow();
    await broken.flush();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('sendEvents', () => {
  const body: EventsRequest = { anonId: ANON, events: [{ name: 'landing_viewed', at: iso(T0) }] };
  const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 204 }));
  const withBeacon = (impl: (url: string, data: string) => boolean) => {
    const beacon = vi.fn(impl);
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true, writable: true });
    return beacon;
  };

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as { sendBeacon?: unknown }).sendBeacon;
  });

  it('uses navigator.sendBeacon with the batch as JSON text when there is one', async () => {
    const beacon = withBeacon(() => true);
    await sendEvents(body);
    expect(beacon).toHaveBeenCalledWith(EVENTS_PATH, JSON.stringify(body));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to fetch with keepalive when there is no beacon, or it refuses the batch', async () => {
    await sendEvents(body);
    const beacon = withBeacon(() => false);
    await sendEvents(body);
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(EVENTS_PATH);
      expect(init).toMatchObject({ method: 'POST', keepalive: true, body: JSON.stringify(body) });
    }
  });

  it('swallows every failure', async () => {
    withBeacon(() => {
      throw new TypeError('beacon broke');
    });
    await expect(sendEvents(body)).resolves.toBeUndefined();
    delete (navigator as { sendBeacon?: unknown }).sendBeacon;
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    await expect(sendEvents(body)).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce(new Response('{"error":"bad-request"}', { status: 400 }));
    await expect(sendEvents(body)).resolves.toBeUndefined();
  });
});

describe('flushWhenHidden', () => {
  const setVisibility = (state: DocumentVisibilityState) =>
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  afterEach(() => {
    delete (document as { visibilityState?: unknown }).visibilityState;
  });

  it('flushes when the page is hidden or unloaded, until cleaned up', () => {
    const flush = vi.fn(async () => {});
    const stop = flushWhenHidden({ flush });
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(flush).not.toHaveBeenCalled();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(flush).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('pagehide'));
    expect(flush).toHaveBeenCalledTimes(2);
    stop();
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    expect(flush).toHaveBeenCalledTimes(2);
  });
});

describe('loadAnonId', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('makes a random id the server accepts, keeps it, and returns it again', () => {
    const id = loadAnonId();
    expect(id).toMatch(ANON_ID);
    expect(localStorage.getItem('kd.anonId')).toBe(id);
    expect(loadAnonId()).toBe(id);
    localStorage.clear();
    expect(loadAnonId()).not.toBe(id);
  });

  it('replaces a stored value that is not a valid id', () => {
    localStorage.setItem('kd.anonId', 'not valid!');
    const id = loadAnonId();
    expect(id).toMatch(ANON_ID);
    expect(localStorage.getItem('kd.anonId')).toBe(id);
  });

  it('falls back to random bytes where crypto.randomUUID is missing (plain http)', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) });
    const id = loadAnonId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).toMatch(ANON_ID);
  });

  it('keeps one id for the page when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const id = loadAnonId();
    expect(id).toMatch(ANON_ID);
    expect(loadAnonId()).toBe(id);
  });
});
