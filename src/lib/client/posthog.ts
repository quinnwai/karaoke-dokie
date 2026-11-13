// PostHog as the beta tracker's second sink (QWW-51): createTracker hands each event it accepts to this sink
// (its `mirror` option), so one track() call reaches our own log and PostHog. Our log stays the one that counts;
// this sink may fail, be blocked or be switched off (no key) and the screen and the log carry on.
//
// What the sink promises:
// - The device's own random id (loadAnonId) is the PostHog distinct id, on every load. Nobody is identified, no
//   person profile is made, and PostHog stores nothing on the device (no cookie, no localStorage).
// - Only events our tracker named reach PostHog, and only with props on the allowlist (POSTHOG_PROPS in
//   eventNames.ts). Whatever posthog-js makes up itself (pageviews, autocapture and its click text, heatmaps, dead
//   clicks, exceptions, surveys) is switched off, and anything else it might send (web vitals, say) is dropped in
//   beforeSend, which also strips props that name a Spotify account, whoever added them.
// - The browser talks to our own origin only (QWW-63): ad and privacy blockers refuse *.posthog.com, so the screen
//   sends to POSTHOG_PROXY_PATH and the server forwards it, without our cookies (src/lib/server/postHogProxy.ts).
// - Every event says which environment sent it, because previews and production share one PostHog project.
// - Session replay masks inputs and is on only while the visitor is known to be signed out (setReplay): a signed-in
//   screen shows their Spotify name and songs from their library.
// - posthog-js loads on demand, after the screen is up, and every call is guarded.

import type { CaptureResult, PostHog, PostHogConfig } from 'posthog-js';
import type { AppEvent, EventValue, PostHogSettings } from '../contracts';
import { POSTHOG_PROPS } from '../eventNames';
import { EVENT_NAME, isForbiddenProp } from '../eventRules';
import { toProxyPath } from '../postHogProxy';
import type { EventSink } from './events';

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
    // Our own origin (QWW-63): ad and privacy blockers refuse *.posthog.com, and the server forwards what arrives here.
    api_host: settings.host,
    ui_host: settings.uiHost,
    // The recorder's file name is one the block lists name; on our origin it goes by another (see postHogProxy.ts).
    rewriteRequestPath: (url) => {
      url.pathname = toProxyPath(url.pathname);
      return url;
    },
    // The device id is the distinct id, set at every load; with memory persistence PostHog keeps nothing on the device.
    bootstrap: { distinctID: anonId },
    persistence: 'memory',
    person_profiles: 'identified_only',
    // Only our own events: no clicks with their text, no pageviews with their URLs, and none of the extras the PostHog
    // project settings could switch on later. beforeSend drops whatever else slips through (web vitals, say).
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

/** The props PostHog may have: those whose names are on POSTHOG_PROPS. */
function allowedProps(props: AppEvent['props']): Record<string, EventValue> {
  return Object.fromEntries(Object.entries(props ?? {}).filter(([key]) => POSTHOG_PROPS.has(key)));
}

async function loadPostHog(): Promise<PostHogClient> {
  return (await import('posthog-js')).default;
}

/**
 * The sink. `load` brings in posthog-js (a fake in tests) as soon as the screen first reports in with setReplay, or the
 * first event arrives, whichever is first. Events that arrive meanwhile wait, and keep the time they happened; a page that
 * goes away before posthog-js is ready loses them from PostHog, not from our log. It never throws.
 */
export function createPostHogSink(settings: PostHogSettings, anonId: string, load: () => Promise<PostHogClient> = loadPostHog): PostHogSink {
  let client: PostHogClient | null = null;
  let loading = false;
  let gone = false;
  let replay = false;
  let recording = false;
  let waiting: AppEvent[] = [];

  /** PostHog cannot run on this page: say so once in the console, and our log carries on alone. */
  function giveUp(reason: string): void {
    gone = true;
    waiting = [];
    try {
      console.warn(`PostHog is off for this page (${reason}). Our own event log is not affected.`);
    } catch {
      // No console: nothing to tell.
    }
  }

  function start(): void {
    if (loading || gone) return;
    loading = true;
    Promise.resolve()
      .then(load)
      .then(ready, () => giveUp('posthog-js did not load'));
  }

  function send(c: PostHogClient, event: AppEvent): void {
    try {
      c.capture(event.name, allowedProps(event.props), { timestamp: new Date(event.at) });
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
      giveUp('posthog-js did not start');
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
      start();
    },
    setReplay(on) {
      replay = on;
      if (client) applyReplay(client);
      else start();
    },
  };
}
