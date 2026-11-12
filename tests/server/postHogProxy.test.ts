// The forwarder behind POSTHOG_PROXY_PATH (QWW-63). What matters most: the browser's cookies (kd_session holds the Spotify
// id of someone signed in) never reach PostHog, PostHog's never reach the browser, nothing the browser sends can name
// another host, and the route answers only the calls posthog-js makes, to our own project (it is not a free relay for
// PostHog's source maps and REST API). The rest is plumbing: which of PostHog's two hosts gets which path, and what happens
// when it is down.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as proxyRoute from '../../app/roadie/[...path]/route';
import { fromProxyPath, POSTHOG_PROXY_PATH, toProxyPath } from '../../src/lib/postHogProxy';
import type { PostHogUpstream } from '../../src/lib/server/config';
import { proxyToPostHog } from '../../src/lib/server/postHogProxy';

const KEY = 'phc_testtoken';
const UPSTREAM: PostHogUpstream = { api: 'https://us.i.posthog.com', assets: 'https://us-assets.i.posthog.com', key: KEY };
const SITE = 'https://karaoke-dokie-two.vercel.app';
const SESSION = 'kd_session=bXkuc3BvdGlmeS5pZA.c2lnbmF0dXJl';

/** A fake fetch that records what it is asked and answers with `answer`. */
function fakeFetch(answer: () => Response | Promise<Response> = () => new Response('{"status":1}', { status: 200, headers: { 'content-type': 'application/json' } })) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const doFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init: init ?? {} });
    return answer();
  }) as unknown as typeof fetch;
  return { doFetch, calls };
}

const request = (pathAndQuery: string, init: RequestInit = {}) => new Request(`${SITE}${pathAndQuery}`, init);
const post = (p: string, init: RequestInit = {}) => request(`${POSTHOG_PROXY_PATH}${p}`, { method: 'POST', body: 'x', ...init });
const sentHeaders = (init: RequestInit) => Object.fromEntries(new Headers(init.headers).entries());

// The route reads its settings from the environment: start each test with PostHog off, whatever the shell has, and put it back.
const ENV_NAMES = ['NEXT_PUBLIC_POSTHOG_KEY', 'NEXT_PUBLIC_POSTHOG_HOST'] as const;
const was = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
beforeEach(() => {
  for (const name of ENV_NAMES) delete process.env[name];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const name of ENV_NAMES) {
    if (was[name] === undefined) delete process.env[name];
    else process.env[name] = was[name];
  }
});

describe('proxyToPostHog: where each path goes', () => {
  it('sends events, replay and flags to the ingest host, body and query as they came', async () => {
    const { doFetch, calls } = fakeFetch();
    const body = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 250]); // gzip bytes, as posthog-js sends them
    for (const p of ['/e/', '/s/', '/flags/', '/i/v0/e/', '/e']) {
      const res = await proxyToPostHog(post(`${p}?v=2&compression=gzip-js&retry_count=1`, { body, headers: { 'content-type': 'text/plain' } }), UPSTREAM, doFetch);
      expect(res.status, p).toBe(200);
    }
    expect(calls.map((c) => c.url.href)).toEqual([
      'https://us.i.posthog.com/e/?v=2&compression=gzip-js&retry_count=1',
      'https://us.i.posthog.com/s/?v=2&compression=gzip-js&retry_count=1',
      'https://us.i.posthog.com/flags/?v=2&compression=gzip-js&retry_count=1',
      'https://us.i.posthog.com/i/v0/e/?v=2&compression=gzip-js&retry_count=1',
      'https://us.i.posthog.com/e?v=2&compression=gzip-js&retry_count=1',
    ]);
    for (const c of calls) {
      expect(c.init.method).toBe('POST');
      expect(new Uint8Array(c.init.body as ArrayBuffer)).toEqual(body);
      expect(sentHeaders(c.init)['content-type']).toBe('text/plain');
    }
  });

  it('sends the project\'s config and its scripts to the asset host, and puts the recorder\'s own file name back', async () => {
    const { doFetch, calls } = fakeFetch();
    for (const p of [
      `/array/${KEY}/config.js`,
      `/array/${KEY}/config`,
      '/static/1.447.7/reel.js',
      '/static/reel.js?v=1.447.7',
      '/static/1.447.7/web-vitals-with-attribution.js',
      '/static/1.447.7/lazy-recorder.js',
      '/static/2.0.0-beta.1/recorder-v2.js',
    ]) {
      expect((await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}${p}`), UPSTREAM, doFetch)).status, p).toBe(200);
    }
    expect(calls.map((c) => c.url.href)).toEqual([
      `https://us-assets.i.posthog.com/array/${KEY}/config.js`,
      `https://us-assets.i.posthog.com/array/${KEY}/config`,
      'https://us-assets.i.posthog.com/static/1.447.7/posthog-recorder.js',
      'https://us-assets.i.posthog.com/static/posthog-recorder.js?v=1.447.7',
      'https://us-assets.i.posthog.com/static/1.447.7/web-vitals-with-attribution.js',
      'https://us-assets.i.posthog.com/static/1.447.7/lazy-recorder.js',
      'https://us-assets.i.posthog.com/static/2.0.0-beta.1/recorder-v2.js',
    ]);
    for (const c of calls) {
      expect(c.init.method).toBe('GET');
      expect(c.init.body).toBeUndefined();
    }
  });

  it('follows PostHog\'s region: the eu hosts when that is where the project lives', async () => {
    const { doFetch, calls } = fakeFetch();
    const eu: PostHogUpstream = { api: 'https://eu.i.posthog.com', assets: 'https://eu-assets.i.posthog.com', key: KEY };
    await proxyToPostHog(post('/e/'), eu, doFetch);
    await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}/static/1.447.7/reel.js`), eu, doFetch);
    expect(calls.map((c) => c.url.origin)).toEqual(['https://eu.i.posthog.com', 'https://eu-assets.i.posthog.com']);
  });
});

describe('proxyToPostHog: it is not a relay', () => {
  it('answers 404, and calls nobody, for what posthog-js never asks: source maps, PostHog\'s REST API, other folders', async () => {
    const { doFetch } = fakeFetch();
    for (const p of [
      '/static/1.447.7/array.full.js.map', // 3 MB of source map for a 100-byte request
      '/static/1.447.7/recorder.js.map',
      '/static/1.447.7/', // a folder, not a script
      '/static/1.447.7/sub/dir.js',
      '/static/notaversion/x/y.js',
      '/api/projects/',
      '/api/public_hog_function_templates/',
      '/api/schema/swagger-ui/',
      '/decide/',
      '/nothing-here',
      '/',
      '/static',
      '/array',
      '/array/',
      '/e/extra',
      '/s//',
    ]) {
      expect((await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}${p}`), UPSTREAM, doFetch)).status, `GET ${p}`).toBe(404);
      expect((await proxyToPostHog(post(p), UPSTREAM, doFetch)).status, `POST ${p}`).toBe(404);
    }
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('serves only our own project\'s config: another project\'s would be its script, served from our origin', async () => {
    const { doFetch, calls } = fakeFetch();
    for (const p of ['/array/phc_someoneelse/config.js', '/array/phc_someoneelse/config', `/array/${KEY}x/config.js`, `/array/${KEY}/config.js/x`, `/array/${KEY.toUpperCase()}/config.js`, '/array//config.js']) {
      expect((await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}${p}`), UPSTREAM, doFetch)).status, p).toBe(404);
    }
    expect(doFetch).not.toHaveBeenCalled();
    expect((await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}/array/${KEY}/config.js`), UPSTREAM, doFetch)).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('keeps each method to its own paths: GET fetches scripts and config, POST sends events, and not the other way round', async () => {
    const { doFetch } = fakeFetch();
    for (const p of ['/e/', '/s/', '/flags/']) expect((await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}${p}`), UPSTREAM, doFetch)).status, `GET ${p}`).toBe(404);
    for (const p of [`/array/${KEY}/config.js`, '/static/1.447.7/reel.js']) expect((await proxyToPostHog(post(p), UPSTREAM, doFetch)).status, `POST ${p}`).toBe(404);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('takes GET and POST and nothing else', async () => {
    const { doFetch } = fakeFetch();
    for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
      const res = await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}/e/`, { method }), UPSTREAM, doFetch);
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, POST');
    }
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('refuses a page of another site calling it (a browser says so in Sec-Fetch-Site), and answers our own', async () => {
    const { doFetch } = fakeFetch();
    expect((await proxyToPostHog(post('/e/', { headers: { 'sec-fetch-site': 'cross-site' } }), UPSTREAM, doFetch)).status).toBe(403);
    expect((await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}/static/1.447.7/reel.js`, { headers: { 'sec-fetch-site': 'cross-site' } }), UPSTREAM, doFetch)).status).toBe(403);
    expect(doFetch).not.toHaveBeenCalled();
    for (const site of ['same-origin', 'same-site', 'none', undefined]) {
      const headers: Record<string, string> = site ? { 'sec-fetch-site': site } : {};
      expect((await proxyToPostHog(post('/e/', { headers }), UPSTREAM, doFetch)).status, String(site)).toBe(200);
    }
  });

  it('answers 404 for anything that is not under its own path', async () => {
    const { doFetch } = fakeFetch();
    for (const p of ['/', '/api/me', POSTHOG_PROXY_PATH, `${POSTHOG_PROXY_PATH}x/e/`, `/other${POSTHOG_PROXY_PATH}/e/`]) {
      expect((await proxyToPostHog(request(p), UPSTREAM, doFetch)).status, p).toBe(404);
    }
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('can only ever call the two hosts it was given, whatever the path or query says', async () => {
    const { doFetch, calls } = fakeFetch();
    const sneaky = [
      '//evil.example.com/steal',
      '/..//evil.example.com/steal',
      '/%2F%2Fevil.example.com/steal',
      '/static//evil.example.com/steal.js',
      '/\\evil.example.com/steal',
      '/@evil.example.com',
      '/e/@evil.example.com',
      '/array/..%2F..%2Fevil.example.com',
      '/https://evil.example.com/steal',
      '/static/1.447.7/..%2f..%2f..%2fevil.js',
      '/static/1.447.7/..\\..\\evil.js',
      '/static/1.447.7/%2e%2e/%2e%2e/api/projects/',
    ];
    for (const p of sneaky) {
      await proxyToPostHog(post(p), UPSTREAM, doFetch);
      await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}${p}`), UPSTREAM, doFetch);
    }
    // The ones that are allowed, with a query that tries the same.
    for (const p of ['/e/?next=https://evil.example.com', '/e/?x=//evil.example.com', '/s/?%0d%0aSet-Cookie:%20a=b', '/e/#@evil.example.com/x']) await proxyToPostHog(post(p), UPSTREAM, doFetch);
    await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}/static/1.447.7/reel.js?cb=//evil.example.com`), UPSTREAM, doFetch);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect([UPSTREAM.api, UPSTREAM.assets], c.url.href).toContain(c.url.origin);
    for (const c of calls) expect(c.url.hostname, c.url.href).toMatch(/\.posthog\.com$/);
  });

  it('refuses a body above 4 MB, as Vercel does, whether it says so or not', async () => {
    const { doFetch } = fakeFetch();
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    expect((await proxyToPostHog(post('/s/', { body: big }), UPSTREAM, doFetch)).status).toBe(413);
    expect((await proxyToPostHog(post('/s/', { body: 'x', headers: { 'content-length': String(big.length) } }), UPSTREAM, doFetch)).status).toBe(413);
    expect(doFetch).not.toHaveBeenCalled();
    const ok = new Uint8Array(4 * 1024 * 1024);
    expect((await proxyToPostHog(post('/s/', { body: ok }), UPSTREAM, doFetch)).status).toBe(200);
  });
});

describe('proxyToPostHog: no cookie moves, in either direction', () => {
  it('forwards only the headers it names: never a cookie, a login header or where the page was', async () => {
    const { doFetch, calls } = fakeFetch();
    await proxyToPostHog(
      post('/e/', {
        headers: {
          cookie: `${SESSION}; kd_oauth_state=abc`,
          authorization: 'Bearer secret-token',
          'proxy-authorization': 'Basic abc',
          referer: `${SITE}/?signedIn=1`,
          origin: SITE,
          'content-type': 'text/plain',
          accept: '*/*',
          'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
          'x-forwarded-for': '203.0.113.9',
          'x-vercel-id': 'iad1::abc',
          'x-real-ip': '203.0.113.9',
          'accept-language': 'en-GB',
          'sec-ch-ua': '"Chromium";v="141"',
        },
      }),
      UPSTREAM,
      doFetch,
    );
    const headers = sentHeaders(calls[0]!.init);
    expect(Object.keys(headers).sort()).toEqual(['accept', 'content-type', 'user-agent', 'x-forwarded-for']);
    expect(headers['user-agent']).toMatch(/iPhone/);
    expect(headers['x-forwarded-for']).toBe('203.0.113.9');
    // Nothing of the session anywhere in what was sent: not the header, not the url.
    expect(JSON.stringify([calls[0]!.url.href, headers])).not.toContain('kd_session');
    expect(JSON.stringify(headers)).not.toMatch(/secret-token|signedIn|bXkuc3BvdGlmeS5pZA/);
  });

  it('sends nothing at all of a cookie on a GET for a script either', async () => {
    const { doFetch, calls } = fakeFetch();
    await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}/static/1.447.7/reel.js`, { headers: { cookie: SESSION } }), UPSTREAM, doFetch);
    expect(sentHeaders(calls[0]!.init).cookie).toBeUndefined();
  });

  it('passes back only a type, two caching rules and nosniff: not PostHog\'s cookies, its encoding or length, or its CORS headers', async () => {
    const { doFetch } = fakeFetch(
      () =>
        new Response('{"status":1}', {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'public, max-age=300',
            'retry-after': '7',
            'set-cookie': 'ph_phc_x_posthog=abc; Path=/; Domain=.karaoke-dokie-two.vercel.app',
            'content-encoding': 'gzip',
            'access-control-allow-origin': '*',
            'access-control-allow-credentials': 'true',
            location: 'https://evil.example.com/',
            server: 'envoy',
            'x-posthog-secret': 'nope',
          },
        }),
    );
    const res = await proxyToPostHog(post('/e/'), UPSTREAM, doFetch);
    expect(Object.fromEntries(res.headers.entries())).toEqual({
      'content-type': 'application/json',
      'cache-control': 'public, max-age=300',
      'retry-after': '7', // posthog-js reads it to back off
      'x-content-type-options': 'nosniff',
    });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toBe('{"status":1}');
  });
});

describe('proxyToPostHog: answers', () => {
  /** The type that goes back for one that PostHog (or something pretending to be it) sends. */
  async function typeFor(upstreamTypes: string[]): Promise<string | null> {
    const headers = new Headers();
    for (const type of upstreamTypes) headers.append('content-type', type);
    // Bytes, not a string: a string body would give the response a plain-text type of its own.
    const { doFetch } = fakeFetch(() => new Response(new TextEncoder().encode('<script>alert(document.domain)</script>'), { status: 200, headers }));
    const res = await proxyToPostHog(post('/e/'), UPSTREAM, doFetch);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    return res.headers.get('content-type');
  }

  it('says JSON, JavaScript or plain text, as PostHog\'s answers, scripts and errors are, and nothing a browser would show as a page', async () => {
    expect(await typeFor(['application/json'])).toBe('application/json');
    expect(await typeFor(['application/json; charset=utf-8'])).toBe('application/json');
    expect(await typeFor(['application/javascript'])).toBe('application/javascript');
    expect(await typeFor(['text/javascript; charset=utf-8'])).toBe('application/javascript');
    expect(await typeFor(['text/plain; charset=utf-8'])).toBe('text/plain; charset=utf-8');
    expect(await typeFor(['TEXT/PLAIN'])).toBe('text/plain; charset=utf-8');
    for (const type of ['text/html', 'text/html; charset=utf-8', 'application/xhtml+xml', 'image/svg+xml', 'application/xml', 'text/xml', 'application/pdf', 'multipart/x-mixed-replace', 'text/plain-ish', 'application/jsonp', 'application/json-seq']) {
      expect(await typeFor([type]), type).toBe('text/plain; charset=utf-8');
    }
    // No type at all.
    expect(await typeFor([])).toBe('text/plain; charset=utf-8');
  });

  it('never repeats what the upstream said, so a header that names two types cannot smuggle the second', async () => {
    // Two Content-Type headers read as one comma-joined value: the type that goes back is ours for the first, whole.
    expect(await typeFor(['text/plain; charset=utf-8', 'text/html'])).toBe('text/plain; charset=utf-8');
    expect(await typeFor(['application/json', 'text/html'])).toBe('application/json');
    expect(await typeFor(['text/html', 'application/json'])).toBe('text/plain; charset=utf-8');
  });

  it('passes PostHog\'s status through, an error included, so the library\'s own retry rules apply', async () => {
    for (const status of [200, 400, 401, 413, 429, 500, 503]) {
      const { doFetch } = fakeFetch(() => new Response('{"type":"x"}', { status, headers: { 'content-type': 'application/json' } }));
      const res = await proxyToPostHog(post('/e/'), UPSTREAM, doFetch);
      expect(res.status).toBe(status);
    }
  });

  it('gives a no-content answer no body', async () => {
    for (const status of [204, 304]) {
      const { doFetch } = fakeFetch(() => new Response(null, { status }));
      const res = await proxyToPostHog(post('/e/'), UPSTREAM, doFetch);
      expect(res.status).toBe(status);
      expect(res.body).toBeNull();
    }
  });

  it('does not follow a redirect, and answers 502: it would send the visitor\'s address and browser to wherever it points', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const status of [301, 302, 307, 308]) {
      const { doFetch, calls } = fakeFetch(() => new Response(null, { status, headers: { location: 'https://evil.example.com/' } }));
      const res = await proxyToPostHog(post('/e/'), UPSTREAM, doFetch);
      expect(res.status, String(status)).toBe(502);
      expect(res.headers.get('location')).toBeNull();
      expect(calls[0]!.init.redirect).toBe('manual');
    }
    expect(log).toHaveBeenCalled();
  });

  it('answers 502, not an error page and not a throw, when PostHog is down, and logs which host and why', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const down = await proxyToPostHog(post('/e/', { headers: { cookie: SESSION } }), UPSTREAM, (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    expect(down.status).toBe(502);
    expect(down.body).toBeNull();
    // The one sign of a host mistyped in the environment, when every call comes back 502.
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain('us.i.posthog.com/e/');
    expect(String(log.mock.calls[0]![0])).toContain('fetch failed');
    // And never the browser's cookie, which arrives with the request.
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/kd_session|bXkuc3BvdGlmeS5pZA/);
  });

  it('answers 502 when PostHog does not start answering within the time limit', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A PostHog that never answers: the fetch ends only when the time limit aborts it, as a real one does.
    const stalled = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
    const started = Date.now();
    const res = await proxyToPostHog(post('/e/'), UPSTREAM, stalled, 25);
    expect(res.status).toBe(502);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(String(log.mock.calls[0]![0])).toMatch(/TimeoutError/);
  });

  it('gives each call to PostHog the 8 s limit unless told otherwise, under Vercel\'s 10 s', async () => {
    const { doFetch, calls } = fakeFetch();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await proxyToPostHog(post('/e/'), UPSTREAM, doFetch);
    expect(timeout).toHaveBeenCalledWith(8_000);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('POSTHOG_PROXY_PATH and the names the browser asks for', () => {
  it('is the folder under app/ that answers it', () => {
    expect(existsSync(path.join('app', POSTHOG_PROXY_PATH, '[...path]', 'route.ts'))).toBe(true);
  });

  it('is not a name the block lists are known to match: PostHog\'s own suggestion, or the words trackers use', () => {
    expect(POSTHOG_PROXY_PATH).toMatch(/^\/[a-z][a-z-]*$/);
    expect(POSTHOG_PROXY_PATH).not.toMatch(/ingest|ingress|hog|posthog|analytic|track|collect|telemetry|metric|event|beacon|stat|log|ph\b|pixel/i);
  });

  it('renames the recorder\'s file for our origin and back, and leaves every other path alone', () => {
    const theirs = `${POSTHOG_PROXY_PATH}/static/1.447.7/posthog-recorder.js`;
    const ours = `${POSTHOG_PROXY_PATH}/static/1.447.7/reel.js`;
    expect(toProxyPath(theirs)).toBe(ours);
    expect(fromProxyPath(ours)).toBe(theirs);
    expect(toProxyPath('/static/posthog-recorder.js')).toBe('/static/reel.js');
    for (const other of ['/e/', '/s/', '/flags/', '/array/phc_x/config.js', '/static/1.447.7/lazy-recorder.js', '/static/1.447.7/web-vitals-with-attribution.js']) {
      expect(toProxyPath(other), other).toBe(other);
      expect(fromProxyPath(other), other).toBe(other);
    }
  });

  it('keeps PostHog\'s own name for the recorder off our origin', () => {
    expect(toProxyPath(`${POSTHOG_PROXY_PATH}/static/1.447.7/posthog-recorder.js`)).not.toMatch(/posthog|record/i);
  });
});

describe('the route under app/roadie', () => {
  const env = { NEXT_PUBLIC_POSTHOG_KEY: 'phc_AbCdEf0123456789', NEXT_PUBLIC_POSTHOG_HOST: 'https://us.i.posthog.com' } as const;

  it('answers 404, and calls nobody, while PostHog is off here: it is no relay for anything else', async () => {
    const { doFetch } = fakeFetch();
    vi.stubGlobal('fetch', doFetch);
    for (const handler of [proxyRoute.GET, proxyRoute.POST]) {
      expect((await handler(post('/e/'))).status).toBe(404);
    }
    process.env.NEXT_PUBLIC_POSTHOG_KEY = env.NEXT_PUBLIC_POSTHOG_KEY; // a key and no host is still off
    expect((await proxyRoute.POST(post('/e/'))).status).toBe(404);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('forwards once PostHog is on, to the host in the environment, and serves the config of the key in the environment, read at request time', async () => {
    const { doFetch, calls } = fakeFetch();
    vi.stubGlobal('fetch', doFetch);
    process.env.NEXT_PUBLIC_POSTHOG_KEY = env.NEXT_PUBLIC_POSTHOG_KEY;
    process.env.NEXT_PUBLIC_POSTHOG_HOST = env.NEXT_PUBLIC_POSTHOG_HOST;
    expect((await proxyRoute.POST(post('/e/', { headers: { cookie: SESSION } }))).status).toBe(200);
    expect(calls[0]!.url.href).toBe('https://us.i.posthog.com/e/');
    expect(sentHeaders(calls[0]!.init).cookie).toBeUndefined();
    // Changed between two requests, with no rebuild in between.
    process.env.NEXT_PUBLIC_POSTHOG_HOST = 'https://eu.i.posthog.com';
    expect((await proxyRoute.GET(request(`${POSTHOG_PROXY_PATH}/array/${env.NEXT_PUBLIC_POSTHOG_KEY}/config.js`))).status).toBe(200);
    expect(calls[1]!.url.href).toBe(`https://eu-assets.i.posthog.com/array/${env.NEXT_PUBLIC_POSTHOG_KEY}/config.js`);
    // Not the config of any other project.
    expect((await proxyRoute.GET(request(`${POSTHOG_PROXY_PATH}/array/phc_someoneelse/config.js`))).status).toBe(404);
    expect(calls).toHaveLength(2);
  });

  it('is never cached: it answers each request as it comes', () => {
    expect(proxyRoute.dynamic).toBe('force-dynamic');
  });
});
