// @vitest-environment jsdom
// Session replay in the real posthog-js (QWW-51). Its own file because the library keeps one instance per window: this
// file gets a window of its own, told by the project (as PostHog would be) that replay is on. The recorder is only
// ever asked for after the screen says the visitor is signed out.
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { PostHogSettings } from '../../src/lib/contracts';
import { createPostHogSink } from '../../src/lib/client/posthog';
import { POSTHOG_PROXY_PATH } from '../../src/lib/postHogProxy';

const ANON = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SETTINGS: PostHogSettings = { key: 'phc_replaytoken', host: POSTHOG_PROXY_PATH, uiHost: 'https://us.posthog.com', environment: 'preview' };

const requested: string[] = [];
const fetchMock = vi.fn(async (input: unknown) => {
  requested.push(String(input));
  return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
});
// The scripts the library asks for: its recorder, from /static/ (its remote config would be too, had it not been preloaded below).
const scripts = () => Array.from(document.querySelectorAll('script')).map((s) => s.src).filter(Boolean);

beforeAll(() => {
  vi.stubGlobal('fetch', fetchMock);
  (window as unknown as { _POSTHOG_REMOTE_CONFIG: unknown })._POSTHOG_REMOTE_CONFIG = {
    // As PostHog's cloud tells it: the recorder is "posthog-recorder", the file name the block lists match (QWW-63).
    [SETTINGS.key]: {
      config: { token: SETTINGS.key, supportedCompression: ['gzip', 'gzip-js'], sessionRecording: { endpoint: '/s/', scriptConfig: { script: 'posthog-recorder' } } },
      siteApps: [],
    },
  };
});
afterAll(() => {
  vi.unstubAllGlobals();
});

it('does not ask for the recorder until the screen says the visitor is signed out', async () => {
  const sink = createPostHogSink(SETTINGS, ANON, async () => (await import('posthog-js')).default);
  sink.setReplay(false); // signed in, or not known yet
  sink.capture({ name: 'replay_probe', at: '2026-11-10T12:01:00.000Z' });
  // The library is up and sending once its events request has gone out.
  await vi.waitFor(() => expect(requested).toContain(`${location.origin}${POSTHOG_PROXY_PATH}/e/`), { timeout: 3000 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(scripts()).toEqual([]);

  sink.setReplay(true); // the visitor is known to be signed out
  await vi.waitFor(() => expect(scripts().length).toBeGreaterThan(0), { timeout: 3000 });
  // From our own origin, under a file name the block lists do not match: PostHog's own name for it is posthog-recorder.js.
  expect(scripts()).toEqual([expect.stringMatching(new RegExp(`^${location.origin}${POSTHOG_PROXY_PATH}/static/[^/]+/reel\\.js$`))]);
  for (const src of scripts()) expect(src).not.toMatch(/posthog/i);
});
