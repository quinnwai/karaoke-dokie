// Request handlers behind app/api/*/route.ts. Each takes the request and the app context,
// so integration tests can call the route files directly with the memory store and mock Spotify.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  FeedbackEntry,
  KnownSongsResponse,
  MeResponse,
  RecommendationsResponse,
  Track,
} from '../contracts';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  STATE_COOKIE,
  clearCookie,
  parseCookies,
  readSessionUserId,
  serializeCookie,
  signSession,
} from './session';
import { ensureFreshTokens, getUserTracks, SpotifyError } from './spotify';
import type { UserRecord } from './store';
import { intParam, validateFeedback, validateVocalRange } from './validate';
import type { AppContext } from './wiring';

const STATE_MAX_AGE_S = 600;

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set('content-type', 'application/json');
  h.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers: h });
}

const errorJson = (status: number, error: string, message?: string) => json({ error, ...(message ? { message } : {}) }, status);

function redirect(location: string, cookies: string[] = []): Response {
  const h = new Headers({ location, 'cache-control': 'no-store' });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(null, { status: 302, headers: h });
}

/**
 * The origin the browser used. Next rewrites req.url's host (127.0.0.1 becomes localhost), and a
 * redirect to a different host loses the cookies just set, so prefer the forwarded/Host headers.
 */
export function requestOrigin(req: Request): string {
  const url = new URL(req.url);
  const first = (v: string | null) => v?.split(',')[0]?.trim() || null;
  const host = first(req.headers.get('x-forwarded-host')) ?? first(req.headers.get('host')) ?? url.host;
  const proto = first(req.headers.get('x-forwarded-proto')) ?? url.protocol.replace(':', '');
  return `${proto}://${host}`;
}
const isSecure = (req: Request) => requestOrigin(req).startsWith('https:');
const origin = requestOrigin;

function configError(ctx: AppContext): Response | null {
  return ctx.problems.length ? errorJson(500, 'server-misconfigured', ctx.problems.join('; ')) : null;
}

async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false };
  }
}

/** The signed-in user, or a 401 response (clearing a stale cookie). */
async function requireUser(req: Request, ctx: AppContext): Promise<UserRecord | Response> {
  const userId = readSessionUserId(req, ctx.config.sessionSecret);
  const user = userId ? await ctx.store.getUser(userId) : null;
  if (user) return user;
  const h = new Headers();
  if (userId) h.append('set-cookie', clearCookie(SESSION_COOKIE, { secure: isSecure(req) }));
  return json({ error: 'signed-out' }, 401, h);
}

/** The user's library (cached per process), or an error response. */
async function loadTracks(user: UserRecord, ctx: AppContext): Promise<Track[] | Response> {
  try {
    return await ctx.tracks.get(user.id, async () => {
      const fresh = await ensureFreshTokens(user, ctx.spotify, ctx.store);
      return getUserTracks(ctx.spotify, fresh.spotify.accessToken);
    });
  } catch (err) {
    if (err instanceof SpotifyError && (err.status === 400 || err.status === 401)) {
      return errorJson(401, 'signed-out', 'Spotify access expired; sign in again');
    }
    return errorJson(502, 'spotify-unavailable', err instanceof Error ? err.message : undefined);
  }
}

// ---------- auth ----------

export async function login(req: Request, ctx: AppContext): Promise<Response> {
  const bad = configError(ctx);
  if (bad) return bad;
  const state = randomBytes(16).toString('base64url');
  return redirect(ctx.spotify.authorizeUrl(state, origin(req)), [
    serializeCookie(STATE_COOKIE, state, { maxAge: STATE_MAX_AGE_S, secure: isSecure(req) }),
  ]);
}

export async function callback(req: Request, ctx: AppContext): Promise<Response> {
  const bad = configError(ctx);
  if (bad) return bad;
  const url = new URL(req.url);
  const home = origin(req);
  const secure = isSecure(req);
  const clearState = clearCookie(STATE_COOKIE, { secure });
  const fail = (reason: string) => redirect(`${home}/?authError=${encodeURIComponent(reason)}`, [clearState]);

  const expected = parseCookies(req.headers.get('cookie'))[STATE_COOKIE];
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (url.searchParams.get('error')) return fail(url.searchParams.get('error')!);
  if (!expected || !state || !safeEqual(state, expected)) return fail('state');
  if (!code) return fail('missing-code');

  try {
    const tokens = await ctx.spotify.exchangeCode(code);
    const me = await ctx.spotify.getMe(tokens.accessToken);
    await ctx.store.upsertUser({ id: me.id, displayName: me.displayName, spotify: tokens });
    ctx.tracks.invalidate(me.id);
    return redirect(`${home}/?signedIn=1`, [
      clearState,
      serializeCookie(SESSION_COOKIE, signSession(me.id, ctx.config.sessionSecret), { maxAge: SESSION_MAX_AGE_S, secure }),
    ]);
  } catch {
    return fail('spotify');
  }
}

export async function logout(req: Request): Promise<Response> {
  return json({ ok: true }, 200, [['set-cookie', clearCookie(SESSION_COOKIE, { secure: isSecure(req) })]]);
}

// ---------- me ----------

export async function getMe(req: Request, ctx: AppContext): Promise<Response> {
  const user = await requireUser(req, ctx);
  if (user instanceof Response) return user;
  const body: MeResponse = { userId: user.id, displayName: user.displayName, range: await ctx.store.getRange(user.id) };
  return json(body);
}

export async function putRange(req: Request, ctx: AppContext): Promise<Response> {
  const user = await requireUser(req, ctx);
  if (user instanceof Response) return user;
  const parsed = await readJson(req);
  if (!parsed.ok) return errorJson(400, 'bad-request', 'Body must be JSON');
  const v = validateVocalRange(parsed.body);
  if (!v.ok) return errorJson(400, 'bad-request', v.error);
  await ctx.store.saveRange(user.id, v.value);
  return json({ ok: true });
}

// ---------- songs ----------

export async function recommendations(req: Request, ctx: AppContext): Promise<Response> {
  const user = await requireUser(req, ctx);
  if (user instanceof Response) return user;
  const params = new URL(req.url).searchParams;
  const offset = intParam(params.get('offset'), 0, 0, 100_000);
  const limit = intParam(params.get('limit'), 5, 1, 50);
  if (offset === null || limit === null) return errorJson(400, 'bad-request', 'offset must be >= 0 and limit 1..50');
  const range = await ctx.store.getRange(user.id);
  if (!range) return errorJson(409, 'no-range', 'Save a vocal range first (PUT /api/me/range)');
  const tracks = await loadTracks(user, ctx);
  if (tracks instanceof Response) return tracks;
  const body: RecommendationsResponse = await ctx.songs.recommend(tracks, range, offset, limit);
  return json(body);
}

export async function knownSongs(req: Request, ctx: AppContext): Promise<Response> {
  const user = await requireUser(req, ctx);
  if (user instanceof Response) return user;
  const tracks = await loadTracks(user, ctx);
  if (tracks instanceof Response) return tracks;
  const body: KnownSongsResponse = await ctx.songs.knownSongs(tracks);
  return json(body);
}

// ---------- feedback ----------

export async function postFeedback(req: Request, ctx: AppContext): Promise<Response> {
  const user = await requireUser(req, ctx);
  if (user instanceof Response) return user;
  const parsed = await readJson(req);
  if (!parsed.ok) return errorJson(400, 'bad-request', 'Body must be JSON');
  const v = validateFeedback(parsed.body);
  if (!v.ok) return errorJson(400, 'bad-request', v.error);
  const userRange = await ctx.store.getRange(user.id);
  if (!userRange) return errorJson(409, 'no-range', 'Save a vocal range first (PUT /api/me/range)');
  const entry: FeedbackEntry = { userId: user.id, ...v.value, userRange, at: new Date().toISOString() };
  await ctx.store.saveFeedback(entry);
  return json({ ok: true });
}

// ---------- admin ----------

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function adminLog(req: Request, ctx: AppContext): Promise<Response> {
  const token = req.headers.get('x-admin-token') ?? '';
  if (!ctx.config.adminToken || !safeEqual(token, ctx.config.adminToken)) return errorJson(403, 'forbidden');
  const limit = intParam(new URL(req.url).searchParams.get('limit'), 200, 1, 1000);
  if (limit === null) return errorJson(400, 'bad-request', 'limit must be 1..1000');
  return json({ entries: await ctx.store.listLog(limit) });
}
