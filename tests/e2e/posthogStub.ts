// A stand-in for PostHog's cloud, for tests/e2e/posthog-proxy.spec.ts (QWW-63): the app's third server (playwright.config.ts)
// forwards what arrives at /roadie to this, so the whole path the browser's traffic takes (screen, our route, PostHog) runs
// without the internet and without sending a test event to the real project. It answers as PostHog does where the library
// looks (events, replay, flags, the remote config that turns replay on, the recorder script itself) and writes down
// every request, headers included, for the spec to read back at GET /__requests.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

export interface StubEvent {
  event: string;
  distinct_id?: string;
  properties: Record<string, unknown>;
}

export interface Seen {
  method: string;
  /** Path and query, as the stand-in was asked. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** The events in the body, when it was one of the library's event batches (gzip and base64 undone). */
  events: StubEvent[];
}

const port = Number(process.env.E2E_POSTHOG_STUB_PORT ?? 3003);
const RECORDER = path.resolve('node_modules/posthog-js/dist/posthog-recorder.js');

let seen: Seen[] = [];

/** The body as JSON, however the library sent it: gzip (compression=gzip-js), form-encoded base64 ("data=..."), or plain. */
function parseBody(body: Buffer): unknown {
  try {
    let bytes = body;
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
    let text = bytes.toString('utf8');
    if (text.startsWith('data=')) text = Buffer.from(decodeURIComponent(text.slice(5)), 'base64').toString('utf8');
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function eventsIn(payload: unknown): StubEvent[] {
  const list = Array.isArray(payload) ? payload : Array.isArray((payload as { batch?: unknown })?.batch) ? (payload as { batch: unknown[] }).batch : payload ? [payload] : [];
  return list.filter((e): e is StubEvent => typeof (e as StubEvent)?.event === 'string');
}

/** What PostHog's cloud tells a project that has session replay on, and nothing else on (the real one's other settings are off here too). */
function remoteConfig(token: string) {
  return {
    token,
    supportedCompression: ['gzip-js'],
    hasFeatureFlags: false,
    sessionRecording: { endpoint: '/s/', scriptConfig: { script: 'posthog-recorder' } },
    surveys: false,
    heatmaps: false,
    captureDeadClicks: false,
    capturePerformance: false,
    autocapture_opt_out: true,
  };
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const send = (status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': type, ...extra });
      res.end(body);
    };

    if (url.pathname === '/__requests') return send(200, 'application/json', JSON.stringify(seen));
    if (url.pathname === '/__reset') {
      seen = [];
      return send(200, 'application/json', '{}');
    }

    seen.push({ method: req.method ?? 'GET', path: url.pathname + url.search, headers: req.headers, events: eventsIn(parseBody(Buffer.concat(chunks))) });

    // A cookie, as a canary: the route must not pass it on, or the browser would keep a PostHog cookie on our own origin.
    const cookie = { 'set-cookie': 'ph_stub=1; Path=/; Max-Age=3600', 'access-control-allow-origin': '*' };
    const config = /^\/array\/([^/]+)\/config(\.js)?$/.exec(url.pathname);
    if (config) {
      const body = JSON.stringify(remoteConfig(config[1]!));
      if (config[2]) {
        const script = `window._POSTHOG_REMOTE_CONFIG = window._POSTHOG_REMOTE_CONFIG || {}; window._POSTHOG_REMOTE_CONFIG[${JSON.stringify(config[1])}] = { config: ${body}, siteApps: [] };`;
        return send(200, 'application/javascript', script, cookie);
      }
      return send(200, 'application/json', body, cookie);
    }
    // The recorder is only ever asked for by PostHog's own name: our route puts it back (the browser asks for reel.js).
    if (/^\/static\/[^/]+\/posthog-recorder\.js$/.test(url.pathname)) return send(200, 'application/javascript', readFileSync(RECORDER), cookie);
    if (url.pathname.startsWith('/static/')) return send(404, 'text/plain', 'not here', cookie);
    if (url.pathname === '/flags/') return send(200, 'application/json', JSON.stringify({ featureFlags: {}, flags: {}, errorsWhileComputingFlags: false }), cookie);
    return send(200, 'application/json', '{"status":1}', cookie);
  });
}).listen(port, '127.0.0.1', () => console.log(`PostHog stand-in on ${port}`));
