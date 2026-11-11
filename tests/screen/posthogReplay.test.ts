// @vitest-environment jsdom
// Session replay in the real posthog-js (QWW-51). Its own file because the library keeps one instance per window: this
// file gets a window of its own, told by the project (as PostHog would be) that replay is on. The recorder is only
// ever asked for after the screen says the visitor is signed out.
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { PostHogSettings } from '../../src/lib/contracts';
import { createPostHogSink } from '../../src/lib/client/posthog';

const ANON = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SETTINGS: PostHogSettings = { key: 'phc_replaytoken', host: 'https://posthog.test', environment: 'preview' };

const requested: string[] = [];
const fetchMock = vi.fn(async (input: unknown) => {
  requested.push(String(input));
  return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
});
const recorderScripts = () => Array.from(document.querySelectorAll('script')).map((s) => s.src).filter((src) => /recorder/.test(src));

beforeAll(() => {
  vi.stubGlobal('fetch', fetchMock);
  (window as unknown as { _POSTHOG_REMOTE_CONFIG: unknown })._POSTHOG_REMOTE_CONFIG = {
    [SETTINGS.key]: { config: { token: SETTINGS.key, supportedCompression: ['gzip', 'gzip-js'], sessionRecording: { endpoint: '/s/' } }, siteApps: [] },
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
  await vi.waitFor(() => expect(requested).toContain('https://posthog.test/e/'), { timeout: 3000 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(recorderScripts()).toEqual([]);

  sink.setReplay(true); // the visitor is known to be signed out
  await vi.waitFor(() => expect(recorderScripts().length).toBeGreaterThan(0), { timeout: 3000 });
  expect(recorderScripts()[0]).toMatch(/^https:\/\/posthog\.test\/static\/.*lazy-recorder\.js$/);
});
