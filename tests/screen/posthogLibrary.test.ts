// @vitest-environment jsdom
// The real posthog-js behind the sink (QWW-51), with only the network faked: what the library really puts on the wire
// when it is set up with postHogConfig. The fake client in posthog.test.ts shows what the sink asks for; this shows
// what the library does with it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPostHogSink, type PostHogClient, type PostHogSettings } from '../../src/lib/client/posthog';

const ANON = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SETTINGS: PostHogSettings = { key: 'phc_testtoken', host: 'https://posthog.test', environment: 'preview' };

interface Sent {
  url: string;
  events: { event: string; properties: Record<string, unknown>; timestamp?: string }[];
}

/** Every batch of events the library sent, read back from the requests it made. */
const sent: Sent[] = [];
const fetchMock = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
  const url = String(input);
  if (url.startsWith(SETTINGS.host) && typeof init?.body === 'string') {
    try {
      const parsed = JSON.parse(init.body) as { batch?: Sent['events'] };
      if (Array.isArray(parsed.batch)) sent.push({ url, events: parsed.batch });
    } catch {
      // Not an events request (the library's other calls): not ours to read.
    }
  }
  return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
});

/** The real library, with compression and batching off so the test can read and wait for each request. */
async function realClient(): Promise<PostHogClient> {
  const { default: posthog } = await import('posthog-js');
  return {
    init: (token, config) => posthog.init(token, { ...config, disable_compression: true, request_batching: false }),
    capture: (...args) => posthog.capture(...args),
    startSessionRecording: () => posthog.startSessionRecording(),
    stopSessionRecording: () => posthog.stopSessionRecording(),
  };
}

const allEvents = () => sent.flatMap((s) => s.events);
const named = (name: string) => allEvents().filter((e) => e.event === name);

describe('posthog-js as the sink sets it up', () => {
  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchMock);
    localStorage.clear();
    const sink = createPostHogSink(SETTINGS, ANON, realClient);
    sink.capture({ name: 'title_view', at: '2026-11-10T12:00:00.000Z' });
    sink.capture({
      name: 'list_view',
      at: '2026-11-10T12:00:07.000Z',
      props: { mode: 'catalogue', matchCount: 8, trackId: 'spotify:track:abc', displayName: 'Ann Singer', email: 'ann@example.com' },
    });
    // Things the library does on its own, if it is allowed to: a click with text, a page change, a person it knows.
    const button = document.createElement('button');
    button.textContent = 'Ann Singer, sign in';
    document.body.append(button);
    button.click();
    window.history.pushState(null, '', '/?signedIn=1');
    // Someone calling the library directly, around the tracker, with a prop that names an account.
    const { default: posthog } = await import('posthog-js');
    await vi.waitFor(() => expect(named('list_view')).toHaveLength(1), { timeout: 5000 });
    posthog.capture('song_open', { position: 1, userId: 'user-5', Spotify_ID: 'ann.singer' });
    await vi.waitFor(() => expect(named('song_open')).toHaveLength(1), { timeout: 5000 });
  });

  afterAll(() => vi.unstubAllGlobals());

  it('sends our events to the configured host, with the time they happened', () => {
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) expect(s.url.startsWith('https://posthog.test/')).toBe(true);
    expect(named('title_view')).toHaveLength(1);
    expect(named('list_view')[0]!.properties).toMatchObject({ mode: 'catalogue', matchCount: 8 });
    expect(new Date(named('list_view')[0]!.timestamp!).toISOString()).toBe('2026-11-10T12:00:07.000Z');
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

  it('sends nothing but our own named events: no autocapture, pageviews, identifies or click text', () => {
    const names = allEvents().map((e) => e.event);
    expect(names.filter((n) => n.startsWith('$'))).toEqual([]);
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
