// @vitest-environment jsdom
// The real posthog-js behind the sink (QWW-51), with only the network faked: what the library really does when it is set
// up with postHogConfig. The fake client in posthog.test.ts shows what the sink asks for; this shows what the library does
// with it.
import type { BeforeSendFn } from 'posthog-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PostHogSettings } from '../../src/lib/contracts';
import { createPostHogSink, type PostHogClient } from '../../src/lib/client/posthog';
import { POSTHOG_PROXY_PATH } from '../../src/lib/postHogProxy';

const ANON = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SETTINGS: PostHogSettings = { key: 'phc_testtoken', host: POSTHOG_PROXY_PATH, uiHost: 'https://us.posthog.com', environment: 'preview' };

interface Sent {
  url: string;
  events: { event: string; properties: Record<string, unknown>; timestamp?: string }[];
}

/** Every batch of events the library sent, read back from the requests it made. */
const sent: Sent[] = [];
/** Every event the library made before our own filter ran: what its settings let it produce on its own. */
const attempted: string[] = [];
/** Every request the library made, of any kind. */
const requested: string[] = [];
const fetchMock = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
  const url = String(input);
  requested.push(url);
  if (url.startsWith(`${location.origin}${SETTINGS.host}/`) && typeof init?.body === 'string') {
    try {
      const parsed = JSON.parse(init.body) as { batch?: Sent['events'] };
      if (Array.isArray(parsed.batch)) sent.push({ url, events: parsed.batch });
    } catch {
      // Not an events request (the library's other calls): not ours to read.
    }
  }
  return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
});

/**
 * The real library, with compression and batching off so each request can be read, and a look at everything it makes
 * before our filter runs (so a setting that is wrong shows up even though the filter would hide it on the wire).
 */
async function realClient(): Promise<PostHogClient> {
  const { default: posthog } = await import('posthog-js');
  return {
    init: (token, config = {}) => {
      const ours = ([] as BeforeSendFn[]).concat(config.before_send ?? []);
      const look: BeforeSendFn = (event) => {
        attempted.push(event.event);
        return event;
      };
      return posthog.init(token, { ...config, disable_compression: true, request_batching: false, before_send: [look, ...ours] });
    },
    capture: (...args) => posthog.capture(...args),
    startSessionRecording: () => posthog.startSessionRecording(),
    stopSessionRecording: () => posthog.stopSessionRecording(),
  };
}

const allEvents = () => sent.flatMap((s) => s.events);
const named = (name: string) => allEvents().filter((e) => e.event === name);

beforeAll(() => {
  vi.stubGlobal('fetch', fetchMock);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe('posthog-js as the sink sets it up', () => {
  beforeAll(async () => {
    localStorage.clear();
    const sink = createPostHogSink(SETTINGS, ANON, realClient);
    sink.setReplay(false); // the screen reports in, and the library loads
    sink.capture({ name: 'title_view', at: '2026-11-10T12:00:00.000Z' });
    await vi.waitFor(() => expect(named('title_view')).toHaveLength(1), { timeout: 5000 });

    // The library is up and sending. Now what it would do on its own if it were allowed to: a click on text, a page change.
    const button = document.createElement('button');
    button.textContent = 'Ann Singer, sign in';
    document.body.append(button);
    button.click();
    window.history.pushState(null, '', '/?signedIn=1');
    sink.capture({
      name: 'list_view',
      at: '2026-11-10T12:00:07.000Z',
      props: { mode: 'catalogue', matchCount: 8, trackId: 'spotify:track:abc', displayName: 'Ann Singer', email: 'ann@example.com' },
    });
    // And someone calling the library directly, around the tracker, with props that name an account.
    const { default: posthog } = await import('posthog-js');
    posthog.capture('song_open', { position: 1, userId: 'user-5', Spotify_ID: 'ann.singer' });
    await vi.waitFor(() => expect(named('list_view')).toHaveLength(1), { timeout: 5000 });
    await vi.waitFor(() => expect(named('song_open')).toHaveLength(1), { timeout: 5000 });
    // Long enough for autocapture or a pageview to show up, had they been on.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  it('sends our events to our own origin, with the time they happened', () => {
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) expect(s.url.startsWith(`${location.origin}${POSTHOG_PROXY_PATH}/`)).toBe(true);
    expect(named('title_view')).toHaveLength(1);
    expect(named('list_view')[0]!.properties).toMatchObject({ mode: 'catalogue', matchCount: 8 });
    expect(new Date(named('list_view')[0]!.timestamp!).toISOString()).toBe('2026-11-10T12:00:07.000Z');
  });

  it('talks to no other origin (QWW-63): a blocker that refuses *.posthog.com sees nothing to block', () => {
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.filter((url) => new URL(url, location.href).origin !== location.origin)).toEqual([]);
    // Nor does it ask for a script from anywhere else (the remote config, and the recorder later, are scripts).
    const scripts = Array.from(document.querySelectorAll('script')).map((el) => el.src).filter(Boolean);
    expect(scripts.filter((src) => new URL(src, location.href).origin !== location.origin)).toEqual([]);
  });

  it('uses the device id as the distinct id, with no person profile', () => {
    for (const e of allEvents()) {
      expect(e.properties.distinct_id).toBe(ANON);
      expect(e.properties.$process_person_profile).toBe(false);
      expect(e.properties.$is_identified).not.toBe(true);
    }
  });

  it('tags every event with the environment', () => {
    for (const e of allEvents()) expect(e.properties.environment).toBe('preview');
  });

  it('makes no autocapture, pageview or other event of its own: the settings are off, whatever the filter would hide', () => {
    expect(attempted).toContain('title_view'); // the look at what the library makes is working
    expect(attempted).toContain('list_view');
    expect(attempted.filter((name) => name.startsWith('$'))).toEqual([]);
    expect(allEvents().map((e) => e.event).filter((name) => name.startsWith('$'))).toEqual([]);
    expect(JSON.stringify(allEvents())).not.toContain('sign in');
  });

  it('strips props that name a Spotify account, even from a call that goes around the tracker', () => {
    const everything = JSON.stringify(allEvents());
    expect(everything).not.toMatch(/spotify:track|ann@example|Ann Singer|user-5|ann\.singer/i);
    for (const key of ['trackId', 'displayName', 'email', 'userId', 'Spotify_ID']) expect(everything).not.toContain(`"${key}"`);
    expect(named('song_open')[0]!.properties.position).toBe(1);
  });

  it('keeps nothing on the device: no cookie, no stored PostHog state', () => {
    expect(document.cookie).toBe('');
    const stored = Object.keys(localStorage).concat(Object.keys(sessionStorage));
    expect(stored.filter((k) => /ph_|posthog/i.test(k))).toEqual([]);
  });
});
