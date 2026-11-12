// The forwarder behind POSTHOG_PROXY_PATH (QWW-63): what the screen sends to our own origin goes on to PostHog, so ad and
// privacy blockers that refuse *.posthog.com do not hide it. Written by hand rather than as a Next.js rewrite because a
// rewrite passes the browser's headers on whole, and our session cookie (kd_session) holds the Spotify id of someone
// signed in: PostHog would get it with every event, against what /credits promises. Here nothing is forwarded that is not
// named below, and nothing PostHog sends back is passed on but a type and two caching rules, so no cookie moves either way.
// The browser's cookies do arrive here (the call is same-origin), so never log this request's headers.
//
// It is not a relay either: it answers only the calls posthog-js makes with our settings, to our own project, and 404 to
// everything else. PostHog's hosts also serve source maps of several MB and a REST API, which a free relay on our domain
// would hand to anyone at our cost.

import { fromProxyPath, POSTHOG_PROXY_PATH } from '../postHogProxy';
import type { PostHogUpstream } from './config';

/**
 * What of the browser's request goes to PostHog: what the body is, the browser's name (PostHog reads it for the device
 * and to tell bots apart) and the address the request came from, as it would see it from a browser that called it directly.
 */
const FORWARDED = ['content-type', 'accept', 'user-agent', 'x-forwarded-for'];
/** What of PostHog's answer goes back besides its type: not its cookies, and not its encoding or length, which fetch has already undone. */
const RETURNED = ['cache-control', 'retry-after'];
/**
 * The types PostHog really sends: JSON for its answers, JavaScript for its scripts, plain text for its errors. The type that
 * goes back is ours for the family PostHog's belongs to, and plain text for anything else (a page above all, or a header
 * that says two things), with nosniff: nothing PostHog says can be shown as a page on our origin, where a script would
 * act as the signed-in visitor.
 */
const TYPES: [RegExp, string][] = [
  [/^application\/json\s*(;|,|$)/i, 'application/json'],
  [/^(application|text)\/javascript\s*(;|,|$)/i, 'application/javascript'],
  [/^text\/plain\s*(;|,|$)/i, 'text/plain; charset=utf-8'],
];
const PLAIN = 'text/plain; charset=utf-8';
/** Long enough for PostHog to start answering a replay chunk, short enough to stay under Vercel's 10 s function default and answer 502 ourselves. */
const TIMEOUT_MS = 8_000;
/** Vercel refuses a function's request body above 4.5 MB; so do we, anywhere else. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** What posthog-js POSTs to PostHog's ingest host: events, replay and feature flags (and the newer capture path for events). */
const POST_PATH = /^\/(e|s|flags|i\/v0\/e)\/?$/;
/** A version number, as in PostHog's /static/1.447.7/ folder. */
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
/** The scripts it loads from PostHog's asset host: the recorder and the like, a .js file and never a source map. */
const SCRIPT_PATH = new RegExp(String.raw`^/static/(?:${VERSION}/)?[A-Za-z0-9_-][A-Za-z0-9._-]*\.js$`);

/** The path PostHog is asked for, and which of its hosts has it; null when the screen has no business asking. */
function route(method: string, path: string, upstream: PostHogUpstream): { host: string; path: string } | null {
  if (method === 'POST') return POST_PATH.test(path) ? { host: upstream.api, path } : null;
  // The project's config, ours alone: another project's would be a script of theirs served from our origin.
  if (path === `/array/${upstream.key}/config` || path === `/array/${upstream.key}/config.js`) return { host: upstream.assets, path };
  return SCRIPT_PATH.test(path) ? { host: upstream.assets, path } : null;
}

export async function proxyToPostHog(
  req: Request,
  upstream: PostHogUpstream,
  doFetch: typeof fetch = fetch,
  timeoutMs: number = TIMEOUT_MS,
): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
  // Our own screen is same-origin. Another site's page calling this route would be borrowing it.
  if (req.headers.get('sec-fetch-site') === 'cross-site') return new Response(null, { status: 403 });
  const url = new URL(req.url);
  if (!url.pathname.startsWith(`${POSTHOG_PROXY_PATH}/`)) return new Response(null, { status: 404 });

  const wanted = route(req.method, fromProxyPath(url.pathname.slice(POSTHOG_PROXY_PATH.length)), upstream);
  if (!wanted) return new Response(null, { status: 404 });
  // The path is set on a fixed origin, never resolved against it, so nothing in it (a "//host" or a "..") can name another host.
  const target = new URL(wanted.host);
  target.pathname = wanted.path;
  target.search = url.search;

  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }

  let answer: Response;
  try {
    let body: ArrayBuffer | undefined;
    if (req.method === 'POST') {
      if (Number(req.headers.get('content-length')) > MAX_BODY_BYTES) return new Response(null, { status: 413 });
      body = await req.arrayBuffer();
      if (body.byteLength > MAX_BODY_BYTES) return new Response(null, { status: 413 });
    }
    // Not followed: a redirect would send the visitor's address and browser name to wherever it points.
    answer = await doFetch(target, { method: req.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // PostHog down, slow or unreachable: the screen's own retries and our own event log carry on. The line is the only
    // sign of a host that is mistyped in the environment, when every call comes back 502.
    console.error(`[posthog] could not forward ${req.method} ${target.host}${target.pathname}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return new Response(null, { status: 502 });
  }
  if (answer.status >= 300 && answer.status < 400 && answer.status !== 304) {
    console.error(`[posthog] ${target.host}${target.pathname} answered ${answer.status}, a redirect, which is not followed`);
    return new Response(null, { status: 502 });
  }

  const out = new Headers();
  for (const name of RETURNED) {
    const value = answer.headers.get(name);
    if (value) out.set(name, value);
  }
  const type = answer.headers.get('content-type') ?? '';
  out.set('content-type', TYPES.find(([family]) => family.test(type))?.[1] ?? PLAIN);
  out.set('x-content-type-options', 'nosniff');
  return new Response([204, 205, 304].includes(answer.status) ? null : answer.body, { status: answer.status, headers: out });
}
