// PostHog as the beta tracker's second sink (QWW-51): createTracker hands each event it accepts to this sink
// (its `mirror` option), so one track() call reaches our own log and PostHog. Our log stays the one that counts;
// this sink may fail, be blocked or be switched off (no key) and the screen and the log carry on.
//
// What the sink promises:
// - The device's own random id (loadAnonId) is the PostHog distinct id, on every load. Nobody is identified, no
//   person profile is made, and PostHog stores nothing on the device (no cookie, no localStorage).
// - Only events our tracker named reach PostHog. Whatever posthog-js makes up itself (pageviews, autocapture and
//   its click text, heatmaps, web vitals) is switched off and, as a backstop, dropped in beforeSend. Props that
//   could name a Spotify account or a song from a library are dropped there too, whoever added them.
// - Every event says which environment sent it, because previews and production share one PostHog project.
// - Session replay masks inputs and is on only while the visitor is known to be signed out (setReplay): a signed-in
//   screen shows their Spotify name and songs from their library.
// - posthog-js loads on demand, after the screen is up, and every call is guarded.

import type { CaptureResult, PostHog, PostHogConfig } from 'posthog-js';
import type { AppEvent } from '../contracts';
import { EVENT_NAME, isForbiddenProp } from '../eventRules';
import type { EventSink } from './events';

export interface PostHogSettings {
  /** The project token ("phc_..."), public by design: it ships to every browser. */
  key: string;
  /** The ingest origin, e.g. https://us.i.posthog.com. */
  host: string;
  /** production, preview or local. Sent on every event so the release funnel can leave the rest out. */
  environment: string;
}

/** The slice of posthog-js the sink drives. Tests pass a fake. */
export type PostHogClient = Pick<PostHog, 'init' | 'capture' | 'startSessionRecording' | 'stopSessionRecording'>;

export interface PostHogSink extends EventSink {
  /**
   * Whether the screen may be recorded now. Replay stays off until this says true, and a false stops it. The
   * screen says true only once it knows the visitor is signed out.
   */
  setReplay(on: boolean): void;
}

/** posthog-js sends the recording itself as events of this name. */
const REPLAY_EVENT = '$snapshot';
/** Events kept while posthog-js loads. A load that never finishes must not grow memory. */
const WAITING_MAX = 100;

/**
 * Runs just before posthog-js sends anything. Keeps our own named events and the replay's data, drops the rest, strips
 * props that could name a Spotify account or library song, and adds the environment.
 */
export function beforeSend(environment: string): (event: CaptureResult) => CaptureResult | null {
  return (event) => {
    const isReplay = event.event === REPLAY_EVENT;
    if (!isReplay && !EVENT_NAME.test(event.event)) return null;
    const properties = isReplay
      ? { ...event.properties }
      : Object.fromEntries(Object.entries(event.properties).filter(([key]) => !isForbiddenProp(key)));
    properties.environment = environment;
    return { ...event, properties };
  };
}

/** posthog-js's settings for this device. Exported so a test can pin down every privacy-relevant choice. */
export function postHogConfig(settings: PostHogSettings, anonId: string): Partial<PostHogConfig> {
  return {
    api_host: settings.host,
    // The device id is the distinct id, set at every load; with memory persistence PostHog keeps nothing on the device.
    bootstrap: { distinctID: anonId },
    persistence: 'memory',
    person_profiles: 'identified_only',
    // Only our own events, so no clicks with their text, no pageviews with their URLs and nothing the PostHog project
    // settings could switch on later. beforeSend drops these again if one slips through.
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
    // Off until setReplay(true); inputs are masked whatever the project's own setting says.
    disable_session_recording: true,
    session_recording: { maskAllInputs: true },
    before_send: beforeSend(settings.environment),
  };
}

async function loadPostHog(): Promise<PostHogClient> {
  return (await import('posthog-js')).default;
}

/**
 * The sink. `load` brings in posthog-js on the first event (a fake in tests). Events that arrive meanwhile wait, and keep
 * the time they happened. It never throws.
 */
export function createPostHogSink(settings: PostHogSettings, anonId: string, load: () => Promise<PostHogClient> = loadPostHog): PostHogSink {
  let client: PostHogClient | null = null;
  let loading = false;
  let gone = false;
  let replay = false;
  let recording = false;
  let waiting: AppEvent[] = [];

  function send(c: PostHogClient, event: AppEvent): void {
    try {
      c.capture(event.name, event.props ?? {}, { timestamp: new Date(event.at) });
    } catch {
      // PostHog failing is its own loss.
    }
  }

  function applyReplay(c: PostHogClient): void {
    if (replay === recording) return;
    try {
      if (replay) c.startSessionRecording();
      else c.stopSessionRecording();
      recording = replay;
    } catch {
      // Replay stays as it was.
    }
  }

  function ready(c: PostHogClient): void {
    try {
      c.init(settings.key, postHogConfig(settings, anonId));
    } catch {
      gone = true;
      waiting = [];
      return;
    }
    client = c;
    const queued = waiting;
    waiting = [];
    for (const event of queued) send(c, event);
    applyReplay(c);
  }

  return {
    capture(event) {
      if (gone) return;
      if (client) {
        send(client, event);
        return;
      }
      if (waiting.length < WAITING_MAX) waiting.push(event);
      if (loading) return;
      loading = true;
      Promise.resolve()
        .then(load)
        .then(ready, () => {
          // Blocked or offline: our log carries on alone.
          gone = true;
          waiting = [];
        });
    },
    setReplay(on) {
      replay = on;
      if (client) applyReplay(client);
    },
  };
}
