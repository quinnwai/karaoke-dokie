// Beta event tracker (QWW-16, QWW-20): queues what a tester does and sends it in small batches to
// POST /api/events. Analytics must never break the screen, so nothing here throws and a failed
// send is a lost batch. Events carry this device's random id (loadAnonId), never a Spotify id,
// and props that could name an account or a song from someone's library never leave the device.

import type { AppEvent, EventsRequest, EventValue } from '../contracts';
import { ANON_ID, EVENT_NAME, isEventValue, isForbiddenProp, MAX_PROP_STRING, MAX_PROPS, PROP_KEY } from '../eventRules';

export const EVENTS_PATH = '/api/events';
/** A batch goes out at this many events, or FLUSH_MS after its first event, whichever comes first. */
export const BATCH_SIZE = 20;
export const FLUSH_MS = 3000;

export interface Tracker {
  /** Queues one event. Never throws; an event the server would reject is dropped here. */
  track(name: string, props?: Record<string, EventValue>): void;
  /** Sends what is queued, now. Never rejects. */
  flush(): Promise<void>;
}

export interface TrackerOptions {
  anonId: string;
  /** Delivers one batch: sendEvents in the browser, a fake in tests. Its failures are swallowed. */
  send: (body: EventsRequest) => Promise<void>;
  now?: () => Date;
  flushMs?: number;
}

export function createTracker({ anonId, send, now = () => new Date(), flushMs = FLUSH_MS }: TrackerOptions): Tracker {
  let queue: AppEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  // send() is called before the first await, so a flush from a pagehide handler starts the
  // beacon while the page is still there.
  async function flush(): Promise<void> {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!queue.length) return;
    const events = queue;
    queue = [];
    try {
      await send({ anonId, events });
    } catch {
      // Dropped: a few lost data points, never a broken screen.
    }
  }

  return {
    track(name, props) {
      try {
        if (typeof name !== 'string' || !EVENT_NAME.test(name)) return;
        const event: AppEvent = { name, at: now().toISOString() };
        const kept = cleanProps(props);
        if (kept) event.props = kept;
        queue.push(event);
        if (queue.length >= BATCH_SIZE) void flush();
        else if (timer === null) timer = setTimeout(() => void flush(), flushMs);
      } catch {
        // A broken clock, or props that throw when read: skip this event.
      }
    },
    flush,
  };
}

/**
 * The props the server will take: forbidden and badly named ones dropped, values that are not
 * plain strings, finite numbers, booleans or null dropped, long strings cut, at most MAX_PROPS.
 * The server rejects a whole request for one bad prop, so cleaning here keeps the rest of the batch.
 */
function cleanProps(props: Record<string, unknown> | undefined): Record<string, EventValue> | undefined {
  const kept: [string, EventValue][] = [];
  for (const [key, raw] of Object.entries(props ?? {})) {
    if (kept.length === MAX_PROPS) break;
    if (!PROP_KEY.test(key) || isForbiddenProp(key)) continue;
    const value = typeof raw === 'string' ? raw.slice(0, MAX_PROP_STRING) : raw;
    if (isEventValue(value)) kept.push([key, value]);
  }
  return kept.length ? Object.fromEntries(kept) : undefined;
}

/**
 * Sends one batch from the browser. navigator.sendBeacon keeps going after the page closes (it
 * posts the JSON as text/plain, which the server reads like any JSON); without it, or when it
 * refuses the batch, fetch with keepalive does the same job. Never rejects.
 */
export async function sendEvents(body: EventsRequest): Promise<void> {
  try {
    const text = JSON.stringify(body);
    const canBeacon = typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function';
    if (canBeacon && navigator.sendBeacon(EVENTS_PATH, text)) return;
    await fetch(EVENTS_PATH, { method: 'POST', body: text, keepalive: true, headers: { 'content-type': 'application/json' } });
  } catch {
    // Offline, blocked or the page is going away: drop the batch.
  }
}

/**
 * Flushes when the page is hidden (switching tab or app) or unloaded: on a phone that is often
 * the last moment code runs. Returns the cleanup, for a React effect.
 */
export function flushWhenHidden(tracker: Pick<Tracker, 'flush'>, win: Window = window): () => void {
  const doc = win.document;
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') void tracker.flush();
  };
  const onPageHide = () => void tracker.flush();
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', onPageHide);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pagehide', onPageHide);
  };
}

const ANON_KEY = 'kd.anonId';
let unsavedId: string | null = null;

/**
 * This device's random id for events, made on first use and kept in localStorage so a tester's
 * visits link up. It is never derived from a Spotify account, so signed-in testers send it too.
 * When storage is blocked, one id for the rest of the page's life.
 */
export function loadAnonId(): string {
  if (typeof window === 'undefined') return randomId(); // server render: never sent anywhere
  try {
    const kept = window.localStorage.getItem(ANON_KEY);
    if (kept && ANON_ID.test(kept)) return kept;
    const id = randomId();
    window.localStorage.setItem(ANON_KEY, id);
    return id;
  } catch {
    return (unsavedId ??= randomId());
  }
}

/**
 * A UUID, or 16 random bytes in hex where crypto.randomUUID is missing: it needs a secure
 * context, which a phone testing on http://192.168.x.x is not.
 */
function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}
