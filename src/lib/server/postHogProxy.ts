// The forwarder behind POSTHOG_PROXY_PATH (QWW-63): what the screen sends to our own origin goes on to PostHog, so ad and
// privacy blockers that refuse *.posthog.com do not hide it. Written by hand rather than as a Next.js rewrite because a
// rewrite passes the browser's headers on whole, and our session cookie (kd_session) holds the Spotify id of someone
// signed in: PostHog would get it with every event, against what /credits promises. Here nothing is forwarded that is not
// named below, and nothing PostHog sends back is passed on but a type and a caching rule, so no cookie moves either way.
// It also serves PostHog's answers from our origin, so what it says can never be shown there as a page (see SAFE_TYPE).

import { fromProxyPath, POSTHOG_PROXY_PATH } from '../postHogProxy';
import type { PostHogUpstream } from './config';

/**
 * What of the browser's request goes to PostHog: what the body is, the browser's name (PostHog reads it for the device
 * and to tell bots apart) and the address the request came from, as it would see it from a browser that called it directly.
 */
const FORWARDED = ['content-type', 'accept', 'user-agent', 'x-forwarded-for'];
/** What of PostHog's answer goes back besides its type: not its cookies, and not its encoding or length, which fetch has already undone. */
const RETURNED = ['cache-control'];
/**
 * The types PostHog really sends: JSON for its answers, JavaScript for its scripts, plain text for its errors. Any other
 * type, a page above all, goes back as plain text (and with nosniff), so nothing PostHog says, or a path someone makes up
 * for it to answer, can be shown as a page on our origin, where a script would act as the signed-in visitor.
 */
const SAFE_TYPE = /^(application\/(json|javascript)|text\/(javascript|plain))\s*(;|$)/i;
/** Long enough for PostHog to take a replay chunk, short enough to stay under Vercel's 10 s function default and answer 502 ourselves. */
const TIMEOUT_MS = 8_000;

/** PostHog's scripts and config come from its asset host; events, replay and flags go to its ingest host. */
const ASSET_PATH = /^\/(static|array)\//;

export async function proxyToPostHog(req: Request, upstream: PostHogUpstream, doFetch: typeof fetch = fetch): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
  const url = new URL(req.url);
  if (!url.pathname.startsWith(`${POSTHOG_PROXY_PATH}/`)) return new Response(null, { status: 404 });

  const path = fromProxyPath(url.pathname.slice(POSTHOG_PROXY_PATH.length));
  const origin = ASSET_PATH.test(path) ? upstream.assets : upstream.api;
  // The path is set on a fixed origin, never resolved against it, so nothing in it (a "//host" or a "..") can name another host.
  const target = new URL(origin);
  target.pathname = path;
  target.search = url.search;

  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }

  let answer: Response;
  try {
    const body = req.method === 'POST' ? await req.arrayBuffer() : undefined;
    answer = await doFetch(target, { method: req.method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    // PostHog down, slow or unreachable: the screen's own retries and our own event log carry on.
    return new Response(null, { status: 502 });
  }

  const out = new Headers();
  for (const name of RETURNED) {
    const value = answer.headers.get(name);
    if (value) out.set(name, value);
  }
  const type = answer.headers.get('content-type') ?? '';
  out.set('content-type', SAFE_TYPE.test(type) ? type : 'text/plain; charset=utf-8');
  out.set('x-content-type-options', 'nosniff');
  return new Response([204, 205, 304].includes(answer.status) ? null : answer.body, { status: answer.status, headers: out });
}
