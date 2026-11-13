// The forwarder behind POSTHOG_PROXY_PATH (QWW-63): what the screen sends to our own origin goes on to PostHog, so ad and
// privacy blockers that refuse *.posthog.com do not hide it. Written by hand rather than as a Next.js rewrite because a
// rewrite passes the browser's headers on whole, and our session cookie (kd_session) holds the Spotify id of someone
// signed in: PostHog would get it with every event, against what /credits promises. Here nothing is forwarded that is not
// named below, and nothing PostHog sends back is passed on but a type and two caching rules, so no cookie moves either way.
// The browser's cookies do arrive here (the call is same-origin), so never log this request's headers.
//
// It is not a relay either: it answers only the calls posthog-js makes with our settings, to our own project, and 404 to
// everything else. PostHog's hosts also serve source maps and whole-library bundles of several hundred KB to MB and a REST
// API, which a free relay on our domain would hand to anyone at our cost.

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
/** Vercel refuses a function's request body above 4.5 MB; so do we, counted as it arrives, wherever this runs. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** What posthog-js POSTs to PostHog's ingest host: events, replay and feature flags (and the newer capture path for events). */
const POST_PATH = /^\/(e|s|flags|i\/v0\/e)\/?$/;
/**
 * The scripts posthog-js loads from PostHog's asset host with our settings: the replay recorder (the project's config says
 * which of these it is) and web vitals (a project setting; our beforeSend drops what they make). Its other lazy scripts
 * (surveys, conversations, dead clicks, exceptions...) are switched off in postHogConfig, and its whole-library bundles
 * (array.full.js and the like, 400 to 800 KB) are never fetched, so none of those is served from here.
 */
export const SCRIPT_NAMES = ['posthog-recorder', 'lazy-recorder', 'recorder-v2', 'recorder', 'web-vitals', 'web-vitals-with-attribution', 'web-vitals-soft-navs', 'web-vitals-with-attribution-soft-navs'];
/** A version number, as in PostHog's /static/1.447.7/ folder. */
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
/** /static/<version>/<name>.js, or the older /static/<name>.js?v=<version>. */
const SCRIPT_PATH = new RegExp(String.raw`^/static/(?:${VERSION}/)?(?:${SCRIPT_NAMES.join('|')})\.js$`);

/** The path PostHog is asked for, and which of its hosts has it; null when the screen has no business asking. */
function route(method: string, path: string, upstream: PostHogUpstream): { host: string; path: string } | null {
  if (method === 'POST') return POST_PATH.test(path) ? { host: upstream.api, path } : null;
  // The project's config, ours alone: another project's would be a script of theirs served from our origin.
  if (path === `/array/${upstream.key}/config` || path === `/array/${upstream.key}/config.js`) return { host: upstream.assets, path };
  return SCRIPT_PATH.test(path) ? { host: upstream.assets, path } : null;
}

/** The request's body, or null once it is over `max` bytes: counted as it arrives, so a body with no length cannot fill memory first. */
async function readBody(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
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
    let body: Uint8Array<ArrayBuffer> | undefined;
    if (req.method === 'POST') {
      if (Number(req.headers.get('content-length')) > MAX_BODY_BYTES) return new Response(null, { status: 413 });
      const read = await readBody(req, MAX_BODY_BYTES);
      if (!read) return new Response(null, { status: 413 });
      body = read;
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
