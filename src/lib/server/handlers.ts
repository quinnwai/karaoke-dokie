// Request handlers behind app/api/*/route.ts. Each takes the request and the app context,
// so integration tests can call the route files directly with the memory store and mock Spotify.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  AdminEventsResponse,
  FeedbackEntry,
  KnownSongsResponse,
  MeResponse,
  RecommendationsResponse,
  SetlistResponse,
  Track,
  VocalRange,
} from '../contracts';
import { withoutForbiddenProps } from '../eventRules';
import { songKey } from '../songs/resolve';
import { summarizeEvents } from './eventStats';
import { catalogueKey, type CataloguePage } from './catalogue';
import { applyDuetsAndMoods, applyDuetsToKnownSongs } from './features';
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
import { disconnectUser, loadLibrary } from './library';
import { setlistFor } from './setlistService';
import type { LibraryMatches } from './songService';
import { assertSpotifyOpen, describeError, noteSpotifyLimit } from './spotify';
import { withCaller } from './spotifyCalls';
import { DEFAULT_EVENTS_LIMIT, MAX_EVENTS_LIMIT, type UserRecord } from './store';
import { intParam, validateEvents, validateFeedback, validateSetlistRequest, validateVocalRange } from './validate';
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

/**
 * How long a library read may take before the screen gets catalogue songs instead. The library routes have a 60 s
 * maxDuration, and a host that gives up on a slow function answers with its own 5xx, which is the error this
 * avoids: Spotify can stall, or answer 429s whose waits add up inside one request's retries.
 */
export const LIBRARY_DEADLINE_MS = 50_000;

/** `p`, or a rejection once `ms` have passed. `p` is left running, and a late failure of it has nobody to tell. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the library read took more than ${ms / 1000} s`)), ms);
  });
  p.catch(() => {});
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/**
 * The user's library (cached per process), or null when it cannot be had: Spotify said wait (nothing is requested
 * while it does), failed, stalled or refused the user's token. Spotify trouble is never the user's error
 * (QWW-55, which was a 502 and an empty screen): the caller answers with the catalogue's songs and says so.
 * A read that outlives the deadline carries on and, if it finishes, is cached for the next request.
 */
async function loadTracks(user: UserRecord, ctx: AppContext, caller: string): Promise<Track[] | null> {
  try {
    const load = () => withCaller(caller, () => loadLibrary(user, { store: ctx.store, spotify: ctx.spotify }));
    return await withDeadline(ctx.tracks.get(user.id, load), LIBRARY_DEADLINE_MS);
  } catch (err) {
    console.error(`[spotify] could not load the library: ${describeError(err)}`);
    return null;
  }
}

/** The catalogue's songs in place of a library that could not be read, with the flag the screen words its note from. */
async function withoutLibrary(range: VocalRange, page: CataloguePage, ctx: AppContext): Promise<Response> {
  return json(await withDuetsAndMoods({ ...(await ctx.catalogue.recommend(range, page)), libraryUnavailable: true }, ctx));
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
  const refused = url.searchParams.get('error');
  if (refused) {
    // Cancel is the singer's answer. Anything else is Spotify refusing on its own page (an account off the
    // allowlist may land here or on a 403 at /me, QWW-53), and this line is the only record of which.
    if (refused !== 'access_denied') console.error(`[auth] Spotify refused the sign-in on its own page: error=${JSON.stringify(refused.slice(0, 100))}`);
    return fail(refused);
  }
  if (!expected || !state || !safeEqual(state, expected)) return fail('state');
  if (!code) return fail('missing-code');

  let step = 'rate limit check';
  try {
    // While Spotify has said to wait (QWW-55) a sign-in would only be refused, and every request counts.
    await assertSpotifyOpen(ctx.store);
    step = 'token exchange';
    const tokens = await ctx.spotify.exchangeCode(code);
    step = 'profile (/me)';
    const me = await withCaller('site:/api/auth/callback', () => ctx.spotify.getMe(tokens.accessToken));
    step = 'saving the user';
    await ctx.store.upsertUser({ id: me.id, displayName: me.displayName, spotify: tokens });
    ctx.tracks.invalidate(me.id);
    return redirect(`${home}/?signedIn=1`, [
      clearState,
      serializeCookie(SESSION_COOKIE, signSession(me.id, ctx.config.sessionSecret), { maxAge: SESSION_MAX_AGE_S, secure }),
    ]);
  } catch (err) {
    // The browser only gets ?authError=spotify, so this line is the only record of why.
    console.error(`[auth] Spotify sign-in failed at the ${step} step: ${describeError(err)}`);
    await noteSpotifyLimit(ctx.store, err);
    return fail('spotify');
  }
}

/**
 * Disconnect (Spotify's terms, QWW-55 PR 2): deletes everything stored about the user's Spotify library and signs them
 * out. Their saved vocal range stays, and their sign-in tokens until they remove the app in Spotify's account settings.
 */
export async function disconnect(req: Request, ctx: AppContext): Promise<Response> {
  const user = await requireUser(req, ctx);
  if (user instanceof Response) return user;
  await disconnectUser(ctx.store, user.id);
  ctx.tracks.invalidate(user.id);
  return json({ ok: true }, 200, [['set-cookie', clearCookie(SESSION_COOKIE, { secure: isSecure(req) })]]);
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

/**
 * What the matches say about duets and moods (QWW-43): nothing unless DUETS_AND_MOODS is on, and then
 * the shipped mood labels (QWW-11, MOODS_SHIPPED) and the duet markers. After ranking, so never the order.
 */
async function withDuetsAndMoods(body: RecommendationsResponse, ctx: AppContext): Promise<RecommendationsResponse> {
  return { ...body, matches: await applyDuetsAndMoods(body.matches, ctx.store, ctx.config) };
}

export async function recommendations(req: Request, ctx: AppContext): Promise<Response> {
  const user = await requireUser(req, ctx);
  if (user instanceof Response) return user;
  const params = new URL(req.url).searchParams;
  // all=1: every match in one response, for the results screen to sort and filter; no paging.
  const all = params.get('all') === '1';
  const offset = all ? 0 : intParam(params.get('offset'), 0, 0, 100_000);
  const limit = all ? 0 : intParam(params.get('limit'), 5, 1, 50);
  if (offset === null || limit === null) return errorJson(400, 'bad-request', 'offset must be >= 0 and limit 1..50');
  const range = await ctx.store.getRange(user.id);
  if (!range) return errorJson(409, 'no-range', 'Save a vocal range first (PUT /api/me/range)');
  const tracks = await loadTracks(user, ctx, 'site:/api/recommendations');
  if (!tracks) return withoutLibrary(range, all ? { all: true } : { offset, limit }, ctx);
  const body: RecommendationsResponse = all
    ? await ctx.songs.recommend(tracks, range, offset, limit, { all: true })
    : await ctx.songs.recommend(tracks, range, offset, limit);
  return json(await withDuetsAndMoods(body, ctx));
}

export async function knownSongs(req: Request, ctx: AppContext): Promise<Response> {
  const user = await requireUser(req, ctx);
  if (user instanceof Response) return user;
  const tracks = await loadTracks(user, ctx, 'site:/api/songs/known');
  if (!tracks) return json({ songs: [], libraryUnavailable: true } satisfies KnownSongsResponse);
  const body: KnownSongsResponse = await ctx.songs.knownSongs(tracks);
  return json(applyDuetsToKnownSongs(body, ctx.config));
}

// ---------- catalogue: results without Spotify (QWW-2 Track B) ----------
// No session and no account: the range comes with every request, and feedback is stored under a
// random device id, never a Spotify id.

/** A query value of digits as a number; anything else as it is, so range validation rejects it. */
const queryInt = (raw: string | null): unknown => (raw !== null && /^\d+$/.test(raw) ? Number(raw) : raw);

/** 8 to 64 letters, digits or dashes, e.g. a random UUID kept on the device. */
const ANON_ID = /^[A-Za-z0-9-]{8,64}$/;

export async function catalogueRecommendations(req: Request, ctx: AppContext): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const range = validateVocalRange({ low: queryInt(params.get('low')), high: queryInt(params.get('high')), source: 'test' });
  if (!range.ok) return errorJson(400, 'bad-request', range.error);
  if (params.get('all') === '1') return json(await withDuetsAndMoods(await ctx.catalogue.recommend(range.value, { all: true }), ctx));
  const offset = intParam(params.get('offset'), 0, 0, 100_000);
  const limit = intParam(params.get('limit'), 5, 1, 50);
  if (offset === null || limit === null) return errorJson(400, 'bad-request', 'offset must be >= 0 and limit 1..50');
  const body: RecommendationsResponse = await ctx.catalogue.recommend(range.value, { offset, limit });
  return json(await withDuetsAndMoods(body, ctx));
}

// ---------- the Setlist tuner (QWW-47) ----------

/** The signed-in user, or null: no session, a stale one, or one for a user we no longer have. Never a 401, since using the tuner signed out is the main way. */
async function optionalUser(req: Request, ctx: AppContext): Promise<UserRecord | null> {
  const userId = readSessionUserId(req, ctx.config.sessionSecret);
  return userId ? ctx.store.getUser(userId) : null;
}

/** Library lists the tuner keeps in a process, across all singers: each is a few thousand matches with their pitch histograms. */
export const LIBRARY_LISTS_KEPT = 6;
/** How long after a library could not be read the tuner leaves Spotify alone and answers with the catalogue's list. */
export const LIBRARY_RETRY_MS = 30_000;
/** Singers remembered as "library down"; far more than the handful of signed-in testers. */
const LIBRARY_DOWN_KEPT = 100;

interface TunerState {
  /** By "user:low:high", least recently used first. `tracks` is the library the list was made from. */
  lists: Map<string, { tracks: Track[]; list: Promise<LibraryMatches> }>;
  /** Singers whose library could not be read, and until when (epoch ms) the tuner does not ask Spotify again. */
  down: Map<string, number>;
}
/** The tuner's per-process memory, one per app context, so a context made afresh (tests) starts with none. */
const tunerStates = new WeakMap<AppContext, TunerState>();
function tunerState(ctx: AppContext): TunerState {
  let state = tunerStates.get(ctx);
  if (!state) tunerStates.set(ctx, (state = { lists: new Map(), down: new Map() }));
  return state;
}

/**
 * The library's songs that fit a range. A slider moving asks again and again for the same ones, so the last few lists
 * are kept (LIBRARY_LISTS_KEPT in all, whoever's), each for as long as the track cache hands out the same library:
 * a library read again is a different array, so its list is made again. A list that is not complete (lookups ran out
 * of budget, or one failed) or that failed is not kept, so the next request carries on.
 */
function libraryFor(userId: string, tracks: Track[], range: { low: number; high: number }, ctx: AppContext): Promise<LibraryMatches> {
  const { lists } = tunerState(ctx);
  const key = `${userId}:${range.low}:${range.high}`;
  const hit = lists.get(key);
  if (hit && hit.tracks === tracks) {
    lists.delete(key);
    lists.set(key, hit); // now the most recently used
    return hit.list;
  }
  const entry = { tracks, list: ctx.songs.libraryMatches(tracks, { ...range, source: 'test' }) };
  lists.delete(key);
  lists.set(key, entry);
  if (lists.size > LIBRARY_LISTS_KEPT) lists.delete(lists.keys().next().value!);
  // Forget it only if it is still the entry for this key: a slow list settling late must not drop a newer one.
  const forget = () => void (lists.get(key) === entry && lists.delete(key));
  entry.list.then((l) => l.complete || forget(), forget);
  return entry.list;
}

/**
 * The singer's library as the tuner reads it: the songs of it that fit `range`, or null when it cannot be had (Spotify
 * said wait, failed or stalled, or looking its songs up failed). After a failure it is not asked for again for
 * LIBRARY_RETRY_MS: the tuner asks on every slider move, and an unreadable library would otherwise be a retry of
 * Spotify's calls (each with its own waits) per move, against a quota that is shared and small.
 */
async function libraryForSetlist(user: UserRecord, range: { low: number; high: number }, ctx: AppContext): Promise<LibraryMatches | null> {
  const { down } = tunerState(ctx);
  if ((down.get(user.id) ?? 0) > Date.now()) return null;
  try {
    const tracks = await loadTracks(user, ctx, 'site:/api/setlist');
    if (tracks) {
      const list = await libraryFor(user.id, tracks, range, ctx);
      down.delete(user.id);
      return list;
    }
  } catch (err) {
    console.error(`[setlist] could not match the library: ${describeError(err)}`);
  }
  down.delete(user.id);
  down.set(user.id, Date.now() + LIBRARY_RETRY_MS);
  if (down.size > LIBRARY_DOWN_KEPT) down.delete(down.keys().next().value!);
  return null;
}

/**
 * The tuner's ranked list (QWW-47). No session needed. A valid one adds the singer's library songs and lets the History
 * gear count; when the library cannot be read the catalogue's list comes back with `libraryUnavailable`, as everywhere
 * else (QWW-55). The range comes with the request, like the catalogue's.
 */
export async function setlist(req: Request, ctx: AppContext): Promise<Response> {
  const parsed = await readJson(req);
  if (!parsed.ok) return errorJson(400, 'bad-request', 'Body must be JSON');
  const v = validateSetlistRequest(parsed.body);
  if (!v.ok) return errorJson(400, 'bad-request', v.error);
  const base = await ctx.catalogue.setlist(v.value.range);
  const user = await optionalUser(req, ctx);
  const library = user ? await libraryForSetlist(user, v.value.range, ctx) : null;
  const body = setlistFor(base, library, v.value);
  if (user && !library) body.libraryUnavailable = true;
  if (library && !library.complete) body.libraryIncomplete = true;
  // After ranking, like every response (features.ts): duets and moods can never change the order.
  const matches = await applyDuetsAndMoods(body.songs.map((s) => s.match), ctx.store, ctx.config);
  return json({ ...body, songs: body.songs.map((s, i) => ({ ...s, match: matches[i]! })) } satisfies SetlistResponse);
}

export async function catalogueFeedback(req: Request, ctx: AppContext): Promise<Response> {
  const parsed = await readJson(req);
  if (!parsed.ok) return errorJson(400, 'bad-request', 'Body must be JSON');
  const v = validateFeedback(parsed.body);
  if (!v.ok) return errorJson(400, 'bad-request', v.error);
  const { anonId, range } = parsed.body as Record<string, unknown>; // an object: validateFeedback checked
  if (typeof anonId !== 'string' || !ANON_ID.test(anonId)) {
    return errorJson(400, 'bad-request', 'anonId must be 8 to 64 letters, digits or dashes');
  }
  const r = typeof range === 'object' && range !== null ? (range as Record<string, unknown>) : {};
  const userRange = validateVocalRange({ low: r.low, high: r.high, source: 'test' });
  if (!userRange.ok) return errorJson(400, 'bad-request', userRange.error);
  const key = catalogueKey(v.value.trackId);
  if (key === null) return errorJson(400, 'bad-request', 'trackId must be a catalogue id (cat:...)');
  const entry: FeedbackEntry = { userId: `anon:${anonId}`, ...v.value, userRange: userRange.value, at: new Date().toISOString() };
  const songRange = await songRangeSnapshot(key, ctx);
  if (songRange) entry.songRange = songRange;
  await ctx.store.saveFeedback(entry);
  return json({ ok: true });
}

// ---------- feedback ----------

/**
 * The song's range as the user saw it, from the cached library (never a Spotify call) and the
 * cached song range; undefined when either is missing.
 */
async function songRangeAtTap(userId: string, trackId: string, ctx: AppContext): Promise<FeedbackEntry['songRange']> {
  const track = ctx.tracks.peek(userId)?.find((t) => t.id === trackId);
  return track ? songRangeSnapshot(songKey(track.artist, track.title), ctx) : undefined;
}

/**
 * A copy of the song's stored range at tap time, so later imports cannot change what the tap was
 * about: where it came from (the log outcome), how it was measured, its notes. Undefined when not stored.
 */
async function songRangeSnapshot(key: string, ctx: AppContext): Promise<FeedbackEntry['songRange']> {
  const rec = await ctx.store.getSongRange(key);
  if (!rec) return undefined;
  const snapshot: NonNullable<FeedbackEntry['songRange']> = { source: rec.log.outcome };
  if (rec.range?.method !== undefined) snapshot.method = rec.range.method;
  if (rec.range) {
    snapshot.low = rec.range.low;
    snapshot.high = rec.range.high;
  }
  return snapshot;
}

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
  const songRange = await songRangeAtTap(user.id, v.value.trackId, ctx);
  if (songRange) entry.songRange = songRange;
  await ctx.store.saveFeedback(entry);
  return json({ ok: true });
}

// ---------- beta event log (QWW-16, QWW-20) ----------

/**
 * A batch of beta events from one device. No session: events are keyed by the device's random
 * id, never by who is signed in. Bad input gets a 400 even while collection is off, so wiring
 * mistakes show up in local dev. req.json() ignores the content type, so the text/plain body
 * navigator.sendBeacon sends parses like any other.
 */
export async function postEvents(req: Request, ctx: AppContext): Promise<Response> {
  const parsed = await readJson(req);
  if (!parsed.ok) return errorJson(400, 'bad-request', 'Body must be JSON');
  const v = validateEvents(parsed.body);
  if (!v.ok) return errorJson(400, 'bad-request', v.error);
  if (ctx.config.collectEvents) {
    await ctx.store.appendEvents(v.value.anonId, v.value.events.map(withoutForbiddenProps));
  }
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

// ---------- admin ----------

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A 403 unless the x-admin-token header matches ADMIN_TOKEN (always, when it is unset); null when it does. */
function adminDenied(req: Request, ctx: AppContext): Response | null {
  const token = req.headers.get('x-admin-token') ?? '';
  return ctx.config.adminToken && safeEqual(token, ctx.config.adminToken) ? null : errorJson(403, 'forbidden');
}

export async function adminLog(req: Request, ctx: AppContext): Promise<Response> {
  const denied = adminDenied(req, ctx);
  if (denied) return denied;
  const limit = intParam(new URL(req.url).searchParams.get('limit'), 200, 1, 1000);
  if (limit === null) return errorJson(400, 'bad-request', 'limit must be 1..1000');
  return json({ entries: await ctx.store.listLog(limit) });
}

// ---------- admin: beta events (QWW-16) ----------

/** Funnel, per-sort numbers and session replays, from the newest `limit` events. */
export async function adminEvents(req: Request, ctx: AppContext): Promise<Response> {
  const denied = adminDenied(req, ctx);
  if (denied) return denied;
  const limit = intParam(new URL(req.url).searchParams.get('limit'), DEFAULT_EVENTS_LIMIT, 1, MAX_EVENTS_LIMIT);
  if (limit === null) return errorJson(400, 'bad-request', `limit must be 1..${MAX_EVENTS_LIMIT}`);
  const body: AdminEventsResponse = summarizeEvents(await ctx.store.listEvents({ limit }));
  return json(body);
}
