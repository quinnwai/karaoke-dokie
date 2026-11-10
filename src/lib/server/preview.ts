// The play button in each song row (QWW-48) plays the song's 30 s Deezer preview. Deezer's preview links expire
// 15 minutes after its API hands them out (the `exp` in their `hdnea` token), so none is ever stored: the row sets
// its <audio> to GET /api/preview/<deezerId>, which makes one Deezer /track call and redirects (302) to the link.
// The address is ours and known when the row is drawn, so the tap handler can set it and call play() without
// waiting for anything, which is what iOS needs before it will play.
//
// Caching: this server instance and Vercel's CDN keep a link until 5 minutes before it expires (about 10 minutes),
// and the browser for at most a minute of that, so whoever hands a link out, it has 5 minutes or more to run and a
// preview lasts 30 s. A track Deezer has no preview for is remembered for 10 minutes here only. Deezer's own terms
// forbid storing its audio; nothing here touches the audio, only the link to it.

/** No cache hands out a link with less than this left (seconds). */
export const LINK_MARGIN_S = 300;
/** A link whose expiry cannot be read (Deezer changed its format) is kept this long at most (seconds). */
export const UNKNOWN_EXPIRY_KEEP_S = 60;
/** The browser keeps a redirect at most this long (seconds). */
export const BROWSER_MAX_AGE_S = 60;
/** A track with no preview is not asked about again for this long. */
export const MISS_TTL_MS = 10 * 60_000;
/** Deezer answers in about 100 ms; a tap waits at most this long. */
export const DEEZER_TIMEOUT_MS = 5_000;
/** Links kept per server instance; the oldest go first. */
export const MAX_CACHED = 5_000;

/** Deezer track ids are positive whole numbers. */
const TRACK_ID = /^[1-9][0-9]{0,15}$/;

/** A preview link and when it expires (epoch ms), or null when Deezer has no preview for the track. */
export type PreviewLookup = { url: string; expiresAt: number } | null;

/** Deezer could not be asked: down, slow, over its quota, or an answer we cannot read. Not cached. */
export class PreviewUnavailableError extends Error {}

/** True for an https link on Deezer's CDN (dzcdn.net), the only place a preview redirect may point. */
export function isDeezerPreviewLink(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'dzcdn.net' || u.hostname.endsWith('.dzcdn.net'));
  } catch {
    return false;
  }
}

/**
 * When a Deezer preview link expires (epoch ms): the `exp=` in its token. A link that does not say is treated as
 * expiring just after the margin, so every cache keeps it UNKNOWN_EXPIRY_KEEP_S at most.
 */
export function linkExpiry(url: string, now: number): number {
  const exp = /[?&~]hdnea=exp=(\d+)/.exec(url) ?? /exp=(\d{9,})/.exec(url);
  const at = exp ? Number(exp[1]) * 1000 : NaN;
  return Number.isFinite(at) && at > 0 ? at : now + (LINK_MARGIN_S + UNKNOWN_EXPIRY_KEEP_S) * 1000;
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface PreviewResolverOptions {
  fetch?: Fetch;
  now?: () => number;
  timeoutMs?: number;
  maxCached?: number;
}

export interface PreviewResolver {
  /** The track's preview link, from the cache or one Deezer call. Throws PreviewUnavailableError. */
  lookup(id: string): Promise<PreviewLookup>;
}

export function createPreviewResolver(opts: PreviewResolverOptions = {}): PreviewResolver {
  const doFetch: Fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DEEZER_TIMEOUT_MS;
  const maxCached = opts.maxCached ?? MAX_CACHED;
  const cache = new Map<string, { lookup: PreviewLookup; until: number }>();
  // Requests for a track that arrive while its call runs share it (Safari asks for a preview more than once).
  const running = new Map<string, Promise<PreviewLookup>>();

  async function ask(id: string): Promise<PreviewLookup> {
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await doFetch(`https://api.deezer.com/track/${id}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new PreviewUnavailableError(`Deezer track ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new PreviewUnavailableError(`Deezer track ${id}: HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as { preview?: unknown; error?: { code?: number; message?: string } } | null;
    if (!body || typeof body !== 'object') throw new PreviewUnavailableError(`Deezer track ${id}: an answer that is not JSON`);
    if (body.error) {
      if (body.error.code === 800) return null; // no such track
      throw new PreviewUnavailableError(`Deezer track ${id}: error ${body.error.code}: ${body.error.message}`);
    }
    // Deezer sends "" for a track it has no preview for.
    const url = typeof body.preview === 'string' ? body.preview : '';
    return url && isDeezerPreviewLink(url) ? { url, expiresAt: linkExpiry(url, now()) } : null;
  }

  function keep(id: string, lookup: PreviewLookup) {
    const until = lookup ? lookup.expiresAt - LINK_MARGIN_S * 1000 : now() + MISS_TTL_MS;
    if (until <= now()) return;
    cache.delete(id); // re-inserted last, so the Map's order is oldest first
    cache.set(id, { lookup, until });
    while (cache.size > maxCached) cache.delete(cache.keys().next().value!);
  }

  return {
    async lookup(id) {
      const hit = cache.get(id);
      if (hit && hit.until > now()) return hit.lookup;
      let call = running.get(id);
      if (!call) {
        call = ask(id).then((lookup) => {
          keep(id, lookup);
          return lookup;
        });
        running.set(id, call);
        // Settled either way, the next request starts afresh: a failure is never cached.
        call.then(
          () => running.delete(id),
          () => running.delete(id),
        );
      }
      return call;
    },
  };
}

function problem(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * GET /api/preview/<id>: a redirect to the track's preview, 400 for an id that is not a Deezer track id, 404 when
 * Deezer has no preview for it, 502 when Deezer cannot be asked. The <audio> element treats every answer but the
 * redirect as a failed load, and the row's button turns disabled.
 */
export async function previewResponse(id: string, resolver: PreviewResolver, now: () => number = Date.now): Promise<Response> {
  if (!TRACK_ID.test(id)) return problem(400, 'bad-id');
  let lookup: PreviewLookup;
  try {
    lookup = await resolver.lookup(id);
  } catch (err) {
    console.warn(`[preview] ${err instanceof Error ? err.message : String(err)}`);
    return problem(502, 'deezer-unavailable');
  }
  if (!lookup) return problem(404, 'no-preview');
  // How long a cache may keep this redirect: until the link has LINK_MARGIN_S left.
  const keepS = Math.floor((lookup.expiresAt - now()) / 1000) - LINK_MARGIN_S;
  const headers = new Headers({ location: lookup.url });
  if (keepS > 0) {
    headers.set('cache-control', `public, max-age=${Math.min(BROWSER_MAX_AGE_S, keepS)}`);
    // Read by Vercel's CDN only and not passed on to the browser (https://vercel.com/docs/caching/cache-control-headers).
    headers.set('vercel-cdn-cache-control', `max-age=${keepS}`);
  } else {
    headers.set('cache-control', 'no-store');
  }
  return new Response(null, { status: 302, headers });
}
