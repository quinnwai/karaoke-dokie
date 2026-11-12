// The forwarder behind POSTHOG_PROXY_PATH (QWW-63). What matters most: the browser's cookies (kd_session holds the Spotify
// id of someone signed in) never reach PostHog, PostHog's never reach the browser, and nothing the browser sends can
// name another host. The rest is plumbing: which of PostHog's two hosts gets which path, and what happens when it is down.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as proxyRoute from '../../app/roadie/[...path]/route';
import { fromProxyPath, POSTHOG_PROXY_PATH, toProxyPath } from '../../src/lib/postHogProxy';
import type { PostHogUpstream } from '../../src/lib/server/config';
import { proxyToPostHog } from '../../src/lib/server/postHogProxy';

const UPSTREAM: PostHogUpstream = { api: 'https://us.i.posthog.com', assets: 'https://us-assets.i.posthog.com' };
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
const sentHeaders = (init: RequestInit) => Object.fromEntries(new Headers(init.headers).entries());

// The route reads its settings from the environment: start each test with PostHog off, whatever the shell has, and put it back.
const ENV_NAMES = ['NEXT_PUBLIC_POSTHOG_KEY', 'NEXT_PUBLIC_POSTHOG_HOST'] as const;
const was = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
beforeEach(() => {
  for (const name of ENV_NAMES) delete process.env[name];
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of ENV_NAMES) {
    if (was[name] === undefined) delete process.env[name];
    else process.env[name] = was[name];
  }
});

describe('proxyToPostHog: where each path goes', () => {
  it('sends events, replay and flags to the ingest host, body and query as they came', async () => {
    const { doFetch, calls } = fakeFetch();
    const body = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 250]); // gzip bytes, as posthog-js sends them
    for (const p of ['/e/', '/s/', '/flags/']) {
      const res = await proxyToPostHog(
        request(`${POSTHOG_PROXY_PATH}${p}?v=2&compression=gzip-js&retry_count=1`, { method: 'POST', body, headers: { 'content-type': 'text/plain' } }),
        UPSTREAM,
        doFetch,
      );
      expect(res.status, p).toBe(200);
    }
    expect(calls.map((c) => c.url.href)).toEqual([
      'https://us.i.posthog.com/e/?v=2&compression=gzip-js&retry_count=1',
      'https://us.i.posthog.com/s/?v=2&compression=gzip-js&retry_count=1',
      'https://us.i.posthog.com/flags/?v=2&compression=gzip-js&retry_count=1',
    ]);
    for (const c of calls) {
      expect(c.init.method).toBe('POST');
      expect(new Uint8Array(c.init.body as ArrayBuffer)).toEqual(body);
      expect(sentHeaders(c.init)['content-type']).toBe('text/plain');
    }
  });

  it('sends its scripts and config to the asset host, and puts the recorder\'s own file name back', async () => {
    const { doFetch, calls } = fakeFetch();
    for (const p of [
      '/array/phc_testtoken/config.js',
      '/array/phc_testtoken/config',
      '/static/1.447.7/reel.js',
      '/static/reel.js?v=1.447.7',
      '/static/1.447.7/web-vitals-with-attribution.js',
      '/static/1.447.7/lazy-recorder.js',
    ]) {
      await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}${p}`), UPSTREAM, doFetch);
    }
    expect(calls.map((c) => c.url.href)).toEqual([
      'https://us-assets.i.posthog.com/array/phc_testtoken/config.js',
      'https://us-assets.i.posthog.com/array/phc_testtoken/config',
      'https://us-assets.i.posthog.com/static/1.447.7/posthog-recorder.js',
      'https://us-assets.i.posthog.com/static/posthog-recorder.js?v=1.447.7',
      'https://us-assets.i.posthog.com/static/1.447.7/web-vitals-with-attribution.js',
      'https://us-assets.i.posthog.com/static/1.447.7/lazy-recorder.js',
    ]);
    for (const c of calls) expect(c.init.method).toBe('GET');
    for (const c of calls) expect(c.init.body).toBeUndefined();
  });

  it('follows PostHog\'s region: the eu hosts when that is where the project lives', async () => {
    const { doFetch, calls } = fakeFetch();
    const eu: PostHogUpstream = { api: 'https://eu.i.posthog.com', assets: 'https://eu-assets.i.posthog.com' };
    await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}/e/`, { method: 'POST', body: 'x' }), eu, doFetch);
    await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}/static/1.447.7/reel.js`), eu, doFetch);
    expect(calls.map((c) => c.url.origin)).toEqual(['https://eu.i.posthog.com', 'https://eu-assets.i.posthog.com']);
  });
});

describe('proxyToPostHog: no cookie moves, in either direction', () => {
  it('forwards only the headers it names: never a cookie, a login header or where the page was', async () => {
    const { doFetch, calls } = fakeFetch();
    await proxyToPostHog(
      request(`${POSTHOG_PROXY_PATH}/e/`, {
        method: 'POST',
        body: 'x',
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
    // Nothing of the session anywhere in what was sent: not the header, not the url, not the body.
    expect(JSON.stringify([calls[0]!.url.href, headers])).not.toContain('kd_session');
    expect(JSON.stringify(headers)).not.toMatch(/secret-token|signedIn|bXkuc3BvdGlmeS5pZA/);
  });

  it('sends nothing at all of a cookie on a GET for a script either', async () => {
    const { doFetch, calls } = fakeFetch();
    await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}/static/1.447.7/reel.js`, { headers: { cookie: SESSION } }), UPSTREAM, doFetch);
    expect(sentHeaders(calls[0]!.init).cookie).toBeUndefined();
  });

  it('passes back only a type, a caching rule and nosniff: not PostHog\'s cookies, its encoding or length, or its CORS headers', async () => {
    const { doFetch } = fakeFetch(
      () =>
        new Response('{"status":1}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'public, max-age=300',
            'set-cookie': 'ph_phc_x_posthog=abc; Path=/; Domain=.karaoke-dokie-two.vercel.app',
            'content-encoding': 'gzip',
            'access-control-allow-origin': '*',
            'access-control-allow-credentials': 'true',
            server: 'envoy',
            'x-posthog-secret': 'nope',
          },
        }),
    );
    const res = await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}/e/`, { method: 'POST', body: 'x' }), UPSTREAM, doFetch);
    expect(Object.fromEntries(res.headers.entries())).toEqual({ 'content-type': 'application/json', 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toBe('{"status":1}');
  });
});

describe('proxyToPostHog: answers', () => {
  it('never lets a type that browsers show as a page through: anything but JSON, JavaScript or plain text goes back as plain text', async () => {
    const typeFor = async (type: string | null) => {
      const headers = new Headers(type ? { 'content-type': type } : {});
      // Bytes, not a string: a string body would give the response a plain-text type of its own.
      const { doFetch } = fakeFetch(() => new Response(new TextEncoder().encode('<script>alert(document.domain)</script>'), { status: 200, headers }));
      const res = await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}/anything`), UPSTREAM, doFetch);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      return res.headers.get('content-type');
    };
    // What PostHog really sends, as it is: its answers, its scripts and its errors.
    for (const type of ['application/json', 'application/javascript', 'text/javascript; charset=utf-8', 'text/plain; charset=utf-8', 'TEXT/PLAIN']) {
      expect(await typeFor(type), type).toBe(type);
    }
    for (const type of ['text/html', 'text/html; charset=utf-8', 'application/xhtml+xml', 'image/svg+xml', 'application/xml', 'text/xml', 'application/pdf', 'multipart/x-mixed-replace', 'text/plain-ish', 'application/jsonp', null]) {
      expect(await typeFor(type), String(type)).toBe('text/plain; charset=utf-8');
    }
  });

  it('passes PostHog\'s status through, an error included, so the library\'s own retry rules apply', async () => {
    for (const status of [200, 400, 401, 413, 429, 500, 503]) {
      const { doFetch } = fakeFetch(() => new Response('{"type":"x"}', { status, headers: { 'content-type': 'application/json' } }));
      const res = await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}/e/`, { method: 'POST', body: 'x' }), UPSTREAM, doFetch);
      expect(res.status).toBe(status);
    }
  });

  it('gives a no-content answer no body', async () => {
    for (const status of [204, 304]) {
      const { doFetch } = fakeFetch(() => new Response(null, { status }));
      const res = await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}/e/`, { method: 'POST', body: 'x' }), UPSTREAM, doFetch);
      expect(res.status).toBe(status);
      expect(res.body).toBeNull();
    }
  });

  it('answers 502, not an error page and not a throw, when PostHog is down or too slow', async () => {
    const down = await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}/e/`, { method: 'POST', body: 'x' }), UPSTREAM, (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    expect(down.status).toBe(502);
    expect(down.body).toBeNull();
  });

  it('gives each call to PostHog a time limit, so a stalled PostHog does not hold a function open', async () => {
    const { doFetch, calls } = fakeFetch();
    await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}/e/`, { method: 'POST', body: 'x' }), UPSTREAM, doFetch);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('proxyToPostHog: only PostHog, only what the library needs', () => {
  it('takes GET and POST and nothing else', async () => {
    const { doFetch } = fakeFetch();
    for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
      const res = await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}/e/`, { method }), UPSTREAM, doFetch);
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, POST');
    }
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('answers 404 for anything that is not under its own path', async () => {
    const { doFetch } = fakeFetch();
    for (const p of ['/', '/api/me', POSTHOG_PROXY_PATH, `${POSTHOG_PROXY_PATH}x/e/`, `/other${POSTHOG_PROXY_PATH}/e/`]) {
      expect((await proxyToPostHog(request(p), UPSTREAM, doFetch)).status, p).toBe(404);
    }
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('can only ever call the two hosts it was given, whatever the path says', async () => {
    const { doFetch, calls } = fakeFetch();
    const sneaky = [
      '//evil.example.com/steal',
      '/..//evil.example.com/steal',
      '/%2F%2Fevil.example.com/steal',
      '/static//evil.example.com/steal',
      '/\\evil.example.com/steal',
      '/@evil.example.com/steal',
      '/e/@evil.example.com',
      '/array/..%2F..%2Fevil.example.com',
      '/https://evil.example.com/steal',
      '?next=https://evil.example.com',
    ];
    for (const p of sneaky) await proxyToPostHog(request(`${POSTHOG_PROXY_PATH}${p}`, { method: 'POST', body: 'x' }), UPSTREAM, doFetch);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect([UPSTREAM.api, UPSTREAM.assets], c.url.href).toContain(c.url.origin);
    for (const c of calls) expect(c.url.hostname, c.url.href).toMatch(/\.posthog\.com$/);
  });
});

describe('POSTHOG_PROXY_PATH and the names the browser asks for', () => {
  it('is the folder under app/ that answers it', () => {
    expect(existsSync(path.join('app', POSTHOG_PROXY_PATH, '[...path]', 'route.ts'))).toBe(true);
  });

  it('is not a name the block lists are known to match: PostHog\'s own suggestion, or the words trackers use', () => {
    expect(POSTHOG_PROXY_PATH).toMatch(/^\/[a-z][a-z-]*$/);
    expect(POSTHOG_PROXY_PATH).not.toMatch(/ingest|posthog|analytic|track|collect|telemetry|metric|event|beacon|stat|log|ph\b|pixel/i);
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
      expect((await handler(request(`${POSTHOG_PROXY_PATH}/e/`, { method: 'POST', body: 'x' }))).status).toBe(404);
    }
    process.env.NEXT_PUBLIC_POSTHOG_KEY = env.NEXT_PUBLIC_POSTHOG_KEY; // a key and no host is still off
    expect((await proxyRoute.POST(request(`${POSTHOG_PROXY_PATH}/e/`, { method: 'POST', body: 'x' }))).status).toBe(404);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('forwards once PostHog is on, to the host in the environment, read at request time', async () => {
    const { doFetch, calls } = fakeFetch();
    vi.stubGlobal('fetch', doFetch);
    process.env.NEXT_PUBLIC_POSTHOG_KEY = env.NEXT_PUBLIC_POSTHOG_KEY;
    process.env.NEXT_PUBLIC_POSTHOG_HOST = env.NEXT_PUBLIC_POSTHOG_HOST;
    expect((await proxyRoute.POST(request(`${POSTHOG_PROXY_PATH}/e/`, { method: 'POST', body: 'x', headers: { cookie: SESSION } }))).status).toBe(200);
    expect(calls[0]!.url.href).toBe('https://us.i.posthog.com/e/');
    expect(sentHeaders(calls[0]!.init).cookie).toBeUndefined();
    // Changed between two requests, with no rebuild in between.
    process.env.NEXT_PUBLIC_POSTHOG_HOST = 'https://eu.i.posthog.com';
    await proxyRoute.GET(request(`${POSTHOG_PROXY_PATH}/array/phc_x/config.js`));
    expect(calls[1]!.url.href).toBe('https://eu-assets.i.posthog.com/array/phc_x/config.js');
  });

  it('is never cached: it answers each request as it comes', () => {
    expect(proxyRoute.dynamic).toBe('force-dynamic');
  });
});
