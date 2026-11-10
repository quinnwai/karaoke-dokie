// Spotify Web API client: authorization code flow, token refresh, library reads.
// `fetch` is injected so tests run offline; SPOTIFY_MOCK=1 swaps in mockSpotify.ts.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TimeRange, Track } from '../contracts';
import type { SpotifyTokens, Store, UserRecord } from './store';

export const SPOTIFY_SCOPES = 'user-library-read user-top-read user-read-recently-played playlist-read-private playlist-read-collaborative';
export const SPOTIFY_ACCOUNTS = 'https://accounts.spotify.com';
export const SPOTIFY_API = 'https://api.spotify.com/v1';
/**
 * Saved (liked) songs read per sign-in: more than any real library, so all of them. It was 2,000,
 * which silently dropped the older likes of a big library (QWW-31: Easy was liked 3,283rd of 11,139).
 */
export const MAX_SAVED_TRACKS = 20_000;
/** Playlists and playlist songs read per sign-in. */
export const MAX_PLAYLISTS = 100;
export const MAX_PLAYLIST_TRACKS = 3000;
/** Saved-song pages fetched at once (50 songs each). */
const SAVED_PAGE_CONCURRENCY = 5;
/**
 * A group of saved-song pages takes at least this long, so a big library is read at about 8
 * requests a second (5 pages per 600 ms) instead of as fast as Spotify answers, which keeps clear of
 * its rate limit. An 11,000 song library is 223 pages: about 27 s.
 */
const SAVED_BATCH_MIN_MS = 600;
/** Saved songs are the library itself, so a rate limit is waited out for longer than the optional lists. */
const SAVED_RATE_LIMIT_RETRIES = 6;
const SAVED_RATE_LIMIT_MAX_WAIT_MS = 30_000;
/** Refresh this long before the access token actually expires. */
const REFRESH_MARGIN_MS = 60_000;
/**
 * When Spotify answers 429 (rate limited), a request waits the Retry-After it is given and tries
 * again, up to this many times, but only when the wait is short enough to keep the page usable.
 */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_MAX_WAIT_MS = 10_000;

/**
 * A per-visit meter of Web API requests (QWW-55 PR 2): the library sync runs inside one, and the client counts every
 * request it sends (a retry after a 429, each page of a playlist) and refuses to send more once `limit` is reached.
 */
export const requestMeter = new AsyncLocalStorage<{ count: number; limit: number }>();

/** Thrown, with nothing sent, when the visit's request budget is used up. */
export class RequestBudgetError extends Error {
  constructor() {
    super('the request budget of this visit is used up');
    this.name = 'RequestBudgetError';
  }
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number) => Promise<void>;

export interface SpotifyConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface SpotifyProfile {
  id: string;
  displayName: string;
}

export interface SpotifyClient {
  /** Where /api/auth/login sends the browser. `origin` is this site's origin (used by the mock). */
  authorizeUrl(state: string, origin: string): string;
  exchangeCode(code: string): Promise<SpotifyTokens>;
  refresh(refreshToken: string): Promise<SpotifyTokens>;
  getMe(accessToken: string): Promise<SpotifyProfile>;
  /** Saved songs in Spotify's order (newest saved first), up to `max` (default 2000). playRank is the saved position. */
  getSavedTracks(accessToken: string, max?: number): Promise<Track[]>;
  /**
   * Top tracks for one time span (about 4 weeks, 6 months, or a year), most played first.
   * Spotify computes long_term from about a year of data, so it is not all time.
   */
  getTopTracks(accessToken: string, timeRange?: TimeRange): Promise<Track[]>;
  /** The last 50 plays, newest first (a song can appear more than once). */
  getRecentlyPlayed(accessToken: string): Promise<Track[]>;
  /** Songs in playlists the user made or collaborates on (not ones they only follow), deduplicated. */
  getPlaylistTracks(accessToken: string): Promise<Track[]>;
  /**
   * One page (50) of liked songs from `offset`, newest first. An item that cannot be matched (a local file, no title)
   * is null, so positions stay Spotify's; `total` is Spotify's count of liked items, unmatched ones included.
   */
  getSavedPage(accessToken: string, offset: number): Promise<{ items: (Track | null)[]; total: number }>;
  /** The playlists the user made or collaborates on, with the snapshot_id that changes when a playlist's songs do. */
  getOwnPlaylists(accessToken: string, ownerId: string): Promise<{ id: string; snapshotId: string }[]>;
  /** One playlist's songs (the first MAX_PLAYLIST_TRACKS), deduplicated. */
  getPlaylistSongs(accessToken: string, playlistId: string): Promise<Track[]>;
}

export type { TimeRange };
export const TIME_RANGES: TimeRange[] = ['short_term', 'medium_term', 'long_term'];

export class SpotifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** What Spotify answered (its error body, shortened to one line), for the server log only. */
    readonly detail?: string,
    /** A 429's Retry-After, in seconds as Spotify sent it, for the server log only. */
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = 'SpotifyError';
  }
}

/**
 * Thrown in place of a request while Spotify has told the app to wait (QWW-55): a 429's Retry-After, kept in the
 * store so every server instance and every script honours it. No request was made.
 */
export class SpotifyBlockedError extends Error {
  constructor(readonly until: number) {
    super(`Spotify asked the app to wait until ${new Date(until).toISOString()}; no request was made`);
    this.name = 'SpotifyBlockedError';
  }
}

/** One line of a failed Spotify response's body, e.g. {"error":"invalid_grant"}; empty when it cannot be read. */
async function errorDetail(res: Response): Promise<string> {
  try {
    return (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    return '';
  }
}

/** One line for the server log saying what failed. Never includes a token, the code or the client secret. */
export function describeError(err: unknown): string {
  if (err instanceof SpotifyError) {
    return [err.message, err.detail, err.retryAfter ? `retry-after ${err.retryAfter} s` : ''].filter(Boolean).join(' | ');
  }
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

// ---- mapping ----

interface SpotifyImage {
  url: string;
  width?: number | null;
}
interface SpotifyTrackObject {
  id: string | null;
  name: string | null;
  is_local?: boolean;
  artists: { id: string; name: string | null }[];
  external_urls?: { spotify?: string };
  external_ids?: { isrc?: string | null };
  album?: { images?: SpotifyImage[]; release_date?: string | null; album_type?: string | null };
  popularity?: number;
}

function pickImage(images: SpotifyImage[] | undefined): string | undefined {
  if (!images?.length) return undefined;
  // Phone-sized art: the image closest to 300px wide.
  const sorted = [...images].sort((a, b) => Math.abs((a.width ?? 300) - 300) - Math.abs((b.width ?? 300) - 300));
  return sorted[0]?.url;
}

/** A contract Track, or null for an item that cannot be matched: no id, a local file, or no title or artist name. */
export function mapTrack(t: SpotifyTrackObject | null | undefined, playRank: number): Track | null {
  if (!t || !t.id || t.is_local || !t.artists?.[0]) return null;
  const artist = t.artists[0];
  // Spotify can send a null title or artist name; on Oct 22, 2026 one such item crashed every recommendations request.
  if (!t.name?.trim() || !artist.name?.trim()) return null;
  const track: Track = {
    id: t.id,
    title: t.name,
    artist: artist.name,
    artistId: artist.id,
    spotifyUrl: t.external_urls?.spotify ?? `https://open.spotify.com/track/${t.id}`,
    playRank,
  };
  const art = pickImage(t.album?.images);
  if (art) track.albumArtUrl = art;
  if (typeof t.popularity === 'number') track.popularity = t.popularity;
  // A compilation's date is the compilation's ("Greatest Hits", 2004), not the song's.
  const year = t.album?.album_type === 'compilation' ? undefined : releaseYear(t.album?.release_date);
  if (year !== undefined) track.releaseYear = year;
  if (t.external_ids?.isrc) track.isrc = t.external_ids.isrc;
  return track;
}

/**
 * The year of an album's release_date ("1975", "1975-10" or "1975-10-31", by its precision), or
 * undefined for anything else, such as the "0000" Spotify sends for an unknown date.
 */
function releaseYear(date: string | null | undefined): number | undefined {
  const m = /^(\d{4})(?:-\d{2}){0,2}$/.exec(date ?? '');
  const year = m ? Number(m[1]) : NaN;
  return year >= 1900 && year <= new Date().getUTCFullYear() + 1 ? year : undefined;
}

export interface Listening {
  /** Top tracks per time span, most played first. */
  top: Partial<Record<TimeRange, Track[]>>;
  /** Last plays, newest first; repeats count. */
  recent: Track[];
  saved: Track[];
  /** Songs in the user's own playlists. */
  playlists?: Track[];
}

/** Position in a top-50 list as a score: #1 = 1.0, falling to 0.2 at #50. */
const topPositionScore = (index: number) => 1 - (0.8 * Math.min(index, 49)) / 49;
const EXTRA_WINDOW_BONUS = 0.1;
const RECENT_PLAY_BONUS = 0.1;
const MAX_RECENT_BONUS = 0.3;
export const SAVED_ONLY = 0.15;
const SAVED_BONUS = 0.05;
/** A song in one of the user's own playlists that they have not played lately. */
export const PLAYLIST_ONLY = 0.4;

/**
 * The user's library with a familiarity score per song (0-1): the best top-list position across
 * the three time spans, plus a bonus for each extra span it appears in and for recent plays.
 * Songs in the user's own playlists get at least 0.4; songs that are only saved get 0.15.
 * `known` is true for songs in a top list, recent plays or a playlist: the ones the user knows.
 * Each song also keeps where it was found (topLists, recentPlays, inPlaylist, saved), so its
 * reason can name the list.
 * playRank is the order by familiarity (0 = most familiar).
 */
export function buildLibrary({ top, recent, saved, playlists = [] }: Listening): Track[] {
  const byId = new Map<string, Track>();
  const best = new Map<string, number>();
  const windows = new Map<string, number>();
  const lists = new Map<string, Set<TimeRange>>();
  const plays = new Map<string, number>();
  const savedIds = new Set(saved.map((t) => t.id));
  const playlistIds = new Set(playlists.map((t) => t.id));
  const order: string[] = [];
  // A song can come from several lists; facts one copy lacks are taken from another.
  const add = (t: Track) => {
    const kept = byId.get(t.id);
    if (!kept) {
      byId.set(t.id, t);
      order.push(t.id);
      return;
    }
    const filled = { ...kept };
    if (filled.popularity === undefined && t.popularity !== undefined) filled.popularity = t.popularity;
    if (filled.releaseYear === undefined && t.releaseYear !== undefined) filled.releaseYear = t.releaseYear;
    if (filled.isrc === undefined && t.isrc !== undefined) filled.isrc = t.isrc;
    byId.set(t.id, filled);
  };
  for (const range of TIME_RANGES) {
    (top[range] ?? []).forEach((t, i) => {
      add(t);
      best.set(t.id, Math.max(best.get(t.id) ?? 0, topPositionScore(i)));
      windows.set(t.id, (windows.get(t.id) ?? 0) + 1);
      lists.set(t.id, (lists.get(t.id) ?? new Set<TimeRange>()).add(range));
    });
  }
  for (const t of recent) {
    add(t);
    plays.set(t.id, (plays.get(t.id) ?? 0) + 1);
  }
  for (const t of saved) add(t);
  for (const t of playlists) add(t);

  const known = (id: string) => best.has(id) || plays.has(id) || playlistIds.has(id);
  const familiarity = (id: string) => {
    let f = best.get(id) ?? 0;
    f += Math.max(0, (windows.get(id) ?? 0) - 1) * EXTRA_WINDOW_BONUS;
    f += Math.min(MAX_RECENT_BONUS, (plays.get(id) ?? 0) * RECENT_PLAY_BONUS);
    if (playlistIds.has(id)) f = Math.max(f, PLAYLIST_ONLY);
    if (savedIds.has(id)) f = f === 0 ? SAVED_ONLY : f + SAVED_BONUS;
    return Math.min(1, Math.round(f * 1000) / 1000);
  };
  /** Where the song was found, leaving out the lists it is not in. */
  const foundIn = (id: string): Partial<Track> => {
    const found: Partial<Track> = {};
    const spans = lists.get(id);
    if (spans) found.topLists = [...spans];
    const n = plays.get(id);
    if (n) found.recentPlays = n;
    if (playlistIds.has(id)) found.inPlaylist = true;
    if (savedIds.has(id)) found.saved = true;
    return found;
  };
  return order
    .map((id, i) => ({ track: byId.get(id)!, f: familiarity(id), i }))
    .sort((a, b) => b.f - a.f || a.i - b.i)
    .map(({ track, f }, playRank) => ({ ...track, ...foundIn(track.id), familiarity: f, known: known(track.id), playRank }));
}

// ---- real client ----

/** Spotify's Retry-After is in seconds; a missing or unreadable one counts as 1 s. */
export function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  return header !== null && header.trim() !== '' && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000;
}

export function createSpotifyClient(
  cfg: SpotifyConfig,
  fetchFn: FetchFn = (i, init) => fetch(i, init),
  sleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): SpotifyClient {
  async function tokenRequest(body: Record<string, string>, previousRefresh?: string): Promise<SpotifyTokens> {
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    const res = await fetchFn(`${SPOTIFY_ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    if (!res.ok) {
      const retryAfter = res.status === 429 ? (res.headers.get('retry-after') ?? undefined) : undefined;
      throw new SpotifyError(`Spotify token request failed (${res.status})`, res.status, await errorDetail(res), retryAfter);
    }
    const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    const refreshToken = j.refresh_token ?? previousRefresh;
    if (!j.access_token || !refreshToken) throw new SpotifyError('Spotify token response was incomplete', 502);
    return { accessToken: j.access_token, refreshToken, expiresAt: Date.now() + j.expires_in * 1000 };
  }

  async function api<T>(
    accessToken: string,
    url: string,
    patience: { retries: number; maxWaitMs: number; onRateLimited?: () => void } = { retries: RATE_LIMIT_RETRIES, maxWaitMs: RATE_LIMIT_MAX_WAIT_MS },
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const meter = requestMeter.getStore();
      if (meter) {
        if (meter.count >= meter.limit) throw new RequestBudgetError();
        meter.count++;
      }
      const res = await fetchFn(url.startsWith('http') ? url : `${SPOTIFY_API}${url}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.status === 429) patience.onRateLimited?.();
      if (res.status === 429 && attempt < patience.retries) {
        const wait = retryAfterMs(res.headers.get('retry-after'));
        if (wait <= patience.maxWaitMs) {
          await sleep(wait);
          continue;
        }
      }
      if (!res.ok) {
        const retryAfter = res.status === 429 ? (res.headers.get('retry-after') ?? undefined) : undefined;
        throw new SpotifyError(`Spotify API ${url} failed (${res.status})`, res.status, await errorDetail(res), retryAfter);
      }
      return (await res.json()) as T;
    }
  }

  return {
    authorizeUrl(state) {
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: cfg.clientId,
        scope: SPOTIFY_SCOPES,
        redirect_uri: cfg.redirectUri,
        state,
      });
      return `${SPOTIFY_ACCOUNTS}/authorize?${q}`;
    },
    exchangeCode(code) {
      return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri });
    },
    refresh(refreshToken) {
      return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, refreshToken);
    },
    async getMe(accessToken) {
      const me = await api<{ id: string; display_name?: string | null }>(accessToken, '/me');
      return { id: me.id, displayName: me.display_name || me.id };
    },
    async getSavedTracks(accessToken, max = MAX_SAVED_TRACKS) {
      type Page = { items: { track: SpotifyTrackObject | null }[]; next: string | null; total?: number };
      const pageUrl = (offset: number) => `/me/tracks?limit=50&offset=${offset}`;
      let rateLimited = 0;
      const patience = { retries: SAVED_RATE_LIMIT_RETRIES, maxWaitMs: SAVED_RATE_LIMIT_MAX_WAIT_MS, onRateLimited: () => rateLimited++ };
      const started = Date.now();
      const first: Page = await api(accessToken, pageUrl(0), patience);
      const pages: Page[] = [first];
      if (typeof first.total === 'number') {
        // The first page says how many songs there are, so fetch the rest a few pages at a time.
        const offsets: number[] = [];
        for (let o = 50; o < Math.min(first.total, max); o += 50) offsets.push(o);
        for (let i = 0; i < offsets.length; i += SAVED_PAGE_CONCURRENCY) {
          const batchStarted = Date.now();
          pages.push(...(await Promise.all(offsets.slice(i, i + SAVED_PAGE_CONCURRENCY).map((o) => api<Page>(accessToken, pageUrl(o), patience)))));
          const pause = SAVED_BATCH_MIN_MS - (Date.now() - batchStarted);
          if (pause > 0 && i + SAVED_PAGE_CONCURRENCY < offsets.length) await sleep(pause);
        }
      } else {
        let page = first;
        while (page.items.length && page.next && pages.length * 50 < max) {
          page = await api<Page>(accessToken, page.next);
          pages.push(page);
        }
      }
      // One line per load in the server log, so a rate limit or a slow big library shows up.
      if (pages.length > 10) console.info(`[spotify] read ${pages.length} pages of saved songs in ${Date.now() - started} ms, rate limited ${rateLimited} times`);
      const out: Track[] = [];
      for (const page of pages) {
        for (const item of page.items) {
          const t = mapTrack(item.track, out.length);
          if (t && out.length < max) out.push(t);
        }
      }
      return out;
    },
    async getTopTracks(accessToken, timeRange = 'medium_term') {
      const page = await api<{ items: SpotifyTrackObject[] }>(accessToken, `/me/top/tracks?time_range=${timeRange}&limit=50`);
      const out: Track[] = [];
      for (const item of page.items) {
        const t = mapTrack(item, out.length);
        if (t) out.push(t);
      }
      return out;
    },
    async getRecentlyPlayed(accessToken) {
      const page = await api<{ items: { track: SpotifyTrackObject | null }[] }>(accessToken, '/me/player/recently-played?limit=50');
      const out: Track[] = [];
      for (const item of page.items) {
        const t = mapTrack(item.track, out.length);
        if (t) out.push(t);
      }
      return out;
    },
    async getSavedPage(accessToken, offset) {
      type Page = { items: { track: SpotifyTrackObject | null }[]; total?: number };
      const patience = { retries: SAVED_RATE_LIMIT_RETRIES, maxWaitMs: SAVED_RATE_LIMIT_MAX_WAIT_MS };
      const page = await api<Page>(accessToken, `/me/tracks?limit=50&offset=${offset}`, patience);
      return { items: page.items.map((item) => mapTrack(item.track, 0)), total: typeof page.total === 'number' ? page.total : offset + page.items.length };
    },
    async getOwnPlaylists(accessToken, ownerId) {
      type ListPage = { items: { id: string; snapshot_id?: string; collaborative?: boolean; owner?: { id?: string } }[]; next: string | null };
      const own: { id: string; snapshotId: string }[] = [];
      let list: ListPage | null = await api<ListPage>(accessToken, '/me/playlists?limit=50');
      while (list) {
        for (const p of list.items) {
          if (p && (p.owner?.id === ownerId || p.collaborative)) own.push({ id: p.id, snapshotId: p.snapshot_id ?? '' });
        }
        list = list.next && own.length < MAX_PLAYLISTS ? await api<ListPage>(accessToken, list.next) : null;
      }
      return own.slice(0, MAX_PLAYLISTS);
    },
    async getPlaylistSongs(accessToken, playlistId) {
      // Newer apps read playlist songs from /items (entries carry `item`); older ones from /tracks (`track`).
      type ItemPage = { items: { item?: SpotifyTrackObject | null; track?: SpotifyTrackObject | null }[]; next: string | null };
      let page: ItemPage;
      try {
        page = await api<ItemPage>(accessToken, `/playlists/${playlistId}/items?limit=50`);
      } catch (err) {
        if (!(err instanceof SpotifyError && (err.status === 404 || err.status === 410))) throw err;
        page = await api<ItemPage>(accessToken, `/playlists/${playlistId}/tracks?limit=50`);
      }
      const out: Track[] = [];
      const seen = new Set<string>();
      for (;;) {
        for (const entry of page.items) {
          const t = mapTrack(entry.item ?? entry.track, out.length);
          if (t && !seen.has(t.id) && out.length < MAX_PLAYLIST_TRACKS) {
            seen.add(t.id);
            out.push(t);
          }
        }
        if (!page.next || out.length >= MAX_PLAYLIST_TRACKS) return out;
        page = await api<ItemPage>(accessToken, page.next);
      }
    },
    async getPlaylistTracks(accessToken) {
      type ListPage = { items: { id: string; collaborative?: boolean; owner?: { id?: string } }[]; next: string | null };
      const me = await api<{ id: string }>(accessToken, '/me');
      const own: string[] = [];
      let list: ListPage | null = await api<ListPage>(accessToken, '/me/playlists?limit=50');
      while (list) {
        for (const p of list.items) if (p && (p.owner?.id === me.id || p.collaborative)) own.push(p.id);
        list = list.next && own.length < MAX_PLAYLISTS ? await api<ListPage>(accessToken, list.next) : null;
      }
      // Newer apps read playlist songs from /items (entries carry `item`); older ones from /tracks (`track`).
      type ItemPage = { items: { item?: SpotifyTrackObject | null; track?: SpotifyTrackObject | null }[]; next: string | null };
      const firstPage = async (id: string): Promise<ItemPage> => {
        try {
          return await api<ItemPage>(accessToken, `/playlists/${id}/items?limit=50`);
        } catch (err) {
          if (err instanceof SpotifyError && (err.status === 404 || err.status === 410)) {
            return api<ItemPage>(accessToken, `/playlists/${id}/tracks?limit=50`);
          }
          throw err;
        }
      };
      const out: Track[] = [];
      const seen = new Set<string>();
      for (const id of own.slice(0, MAX_PLAYLISTS)) {
        let page: ItemPage | null = await firstPage(id).catch(() => null);
        while (page) {
          for (const entry of page.items) {
            const t = mapTrack(entry.item ?? entry.track, out.length);
            if (t && !seen.has(t.id) && out.length < MAX_PLAYLIST_TRACKS) {
              seen.add(t.id);
              out.push(t);
            }
          }
          page = page.next && out.length < MAX_PLAYLIST_TRACKS ? await api<ItemPage>(accessToken, page.next).catch(() => null) : null;
        }
        if (out.length >= MAX_PLAYLIST_TRACKS) break;
      }
      return out;
    },
  };
}

// ---- helpers used by routes ----

/** Returns the user with a usable access token, refreshing (and saving) it when it is about to expire. */
export async function ensureFreshTokens(
  user: UserRecord,
  client: SpotifyClient,
  store: Store,
  now: number = Date.now(),
): Promise<UserRecord> {
  if (user.spotify.expiresAt - REFRESH_MARGIN_MS > now) return user;
  const spotify = await client.refresh(user.spotify.refreshToken);
  const updated = { ...user, spotify };
  await store.upsertUser(updated);
  return updated;
}

/** The user's library as contract Tracks with familiarity, ordered by playRank. */
export async function getUserTracks(client: SpotifyClient, accessToken: string): Promise<Track[]> {
  // Recently played and playlists need permissions that users who signed in before they were added
  // have not granted; without them we skip that signal rather than fail. Playlists are also the
  // most requests by far, so when Spotify still rate-limits after the retries, they are skipped too.
  const optional = (p: Promise<Track[]>) =>
    p.catch((err) => {
      if (err instanceof SpotifyError && (err.status === 401 || err.status === 403 || err.status === 429)) return [] as Track[];
      throw err;
    });
  const [short, medium, long, plays, saved, playlists] = await Promise.all([
    client.getTopTracks(accessToken, 'short_term'),
    client.getTopTracks(accessToken, 'medium_term'),
    client.getTopTracks(accessToken, 'long_term'),
    optional(client.getRecentlyPlayed(accessToken)),
    client.getSavedTracks(accessToken),
    optional(client.getPlaylistTracks(accessToken)),
  ]);
  return buildLibrary({ top: { short_term: short, medium_term: medium, long_term: long }, recent: plays, saved, playlists });
}

// ---- Spotify's "wait" (QWW-55) ----

/** However long a 429 asks, the app waits no more than a day, so a bogus value cannot lock it for good. */
const MAX_BLOCK_MS = 24 * 60 * 60_000;
/** A 429 with reason QUOTA_EXCEEDED that does not say how long: the quota resets daily, so an hour is a cautious guess. */
const QUOTA_UNSAID_BLOCK_MS = 60 * 60_000;
/** A Retry-After of no more than this is a rate limit, waited out inside the request (RATE_LIMIT_MAX_WAIT_MS), not a block. */
const BLOCK_OVER_SECONDS = 30;

/**
 * When the app may call Spotify again after this error (epoch ms), or null when there is nothing to wait for: it is
 * not a 429, or it is a short rate limit. A block follows a 429 with reason QUOTA_EXCEEDED, as on 10 Nov 2026
 * (retry-after 12098 s, the whole app locked for 3.4 hours), or any Retry-After over 30 s.
 */
export function blockedUntilOf(err: unknown, now: number = Date.now()): number | null {
  if (!(err instanceof SpotifyError) || err.status !== 429) return null;
  const said = err.retryAfter?.trim() ? Number(err.retryAfter) : NaN;
  const seconds = Number.isFinite(said) && said >= 0 ? said : null;
  const quota = err.detail?.includes('QUOTA_EXCEEDED') === true;
  if (!quota && (seconds === null || seconds <= BLOCK_OVER_SECONDS)) return null;
  return now + Math.min(MAX_BLOCK_MS, seconds === null ? QUOTA_UNSAID_BLOCK_MS : seconds * 1000);
}

/**
 * Throws SpotifyBlockedError, before any request, while Spotify has told the app to wait. A block that cannot be
 * read counts as none, and one that is more than a day away (a clock gone wrong, a hand-edited row) as a day:
 * a problem with that one row must not hide a healthy Spotify, or lock the app for good.
 */
export async function assertSpotifyOpen(store: Pick<Store, 'getSpotifyBlock'>, now: number = Date.now()): Promise<void> {
  const until = await store.getSpotifyBlock().catch((err) => {
    console.error(`[spotify] could not read the rate limit: ${describeError(err)}`);
    return null;
  });
  if (until !== null && until > now) throw new SpotifyBlockedError(Math.min(until, now + MAX_BLOCK_MS));
}

/**
 * Keeps a 429's wait in the store, so the next request, every other server instance and every script stay away
 * until it passes. Anything else is ignored. A store that cannot be written is logged, not thrown: the error
 * being handled matters more.
 */
export async function noteSpotifyLimit(store: Pick<Store, 'setSpotifyBlock'>, err: unknown, now: number = Date.now()): Promise<void> {
  const until = blockedUntilOf(err, now);
  if (until === null) return;
  await store.setSpotifyBlock(until).catch((e) => console.error(`[spotify] could not keep the rate limit: ${describeError(e)}`));
}

/**
 * The user's library for the site and for scripts: none of it when Spotify has told the app to wait, and a 429's
 * wait kept for everyone else. It reads what getUserTracks reads, which this does not change.
 */
export async function readUserTracks(store: Store, client: SpotifyClient, user: UserRecord): Promise<Track[]> {
  await assertSpotifyOpen(store);
  try {
    const fresh = await ensureFreshTokens(user, client, store);
    return await getUserTracks(client, fresh.spotify.accessToken);
  } catch (err) {
    await noteSpotifyLimit(store, err);
    throw err;
  }
}
