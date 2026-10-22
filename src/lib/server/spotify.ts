// Spotify Web API client: authorization code flow, token refresh, library reads.
// `fetch` is injected so tests run offline; SPOTIFY_MOCK=1 swaps in mockSpotify.ts.
import type { Track } from '../contracts';
import type { SpotifyTokens, Store, UserRecord } from './store';

export const SPOTIFY_SCOPES = 'user-library-read user-top-read user-read-recently-played playlist-read-private playlist-read-collaborative';
export const SPOTIFY_ACCOUNTS = 'https://accounts.spotify.com';
export const SPOTIFY_API = 'https://api.spotify.com/v1';
export const MAX_SAVED_TRACKS = 2000;
/** Playlists and playlist songs read per sign-in. */
export const MAX_PLAYLISTS = 100;
export const MAX_PLAYLIST_TRACKS = 3000;
/** Saved-song pages fetched at once (50 songs each). */
const SAVED_PAGE_CONCURRENCY = 5;
/** Refresh this long before the access token actually expires. */
const REFRESH_MARGIN_MS = 60_000;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

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
  /** Top tracks for one time span (about 4 weeks, 6 months, or all time), most played first. */
  getTopTracks(accessToken: string, timeRange?: TimeRange): Promise<Track[]>;
  /** The last 50 plays, newest first (a song can appear more than once). */
  getRecentlyPlayed(accessToken: string): Promise<Track[]>;
  /** Songs in playlists the user made or collaborates on (not ones they only follow), deduplicated. */
  getPlaylistTracks(accessToken: string): Promise<Track[]>;
}

export type TimeRange = 'short_term' | 'medium_term' | 'long_term';
export const TIME_RANGES: TimeRange[] = ['short_term', 'medium_term', 'long_term'];

export class SpotifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SpotifyError';
  }
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
  album?: { images?: SpotifyImage[] };
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
  return track;
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
 * playRank is the order by familiarity (0 = most familiar).
 */
export function buildLibrary({ top, recent, saved, playlists = [] }: Listening): Track[] {
  const byId = new Map<string, Track>();
  const best = new Map<string, number>();
  const windows = new Map<string, number>();
  const plays = new Map<string, number>();
  const savedIds = new Set(saved.map((t) => t.id));
  const playlistIds = new Set(playlists.map((t) => t.id));
  const order: string[] = [];
  const add = (t: Track) => {
    if (!byId.has(t.id)) {
      byId.set(t.id, t);
      order.push(t.id);
    } else if (t.popularity !== undefined && byId.get(t.id)!.popularity === undefined) {
      byId.set(t.id, { ...byId.get(t.id)!, popularity: t.popularity });
    }
  };
  for (const range of TIME_RANGES) {
    (top[range] ?? []).forEach((t, i) => {
      add(t);
      best.set(t.id, Math.max(best.get(t.id) ?? 0, topPositionScore(i)));
      windows.set(t.id, (windows.get(t.id) ?? 0) + 1);
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
  return order
    .map((id, i) => ({ track: byId.get(id)!, f: familiarity(id), i }))
    .sort((a, b) => b.f - a.f || a.i - b.i)
    .map(({ track, f }, playRank) => ({ ...track, familiarity: f, known: known(track.id), playRank }));
}

// ---- real client ----

export function createSpotifyClient(cfg: SpotifyConfig, fetchFn: FetchFn = (i, init) => fetch(i, init)): SpotifyClient {
  async function tokenRequest(body: Record<string, string>, previousRefresh?: string): Promise<SpotifyTokens> {
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    const res = await fetchFn(`${SPOTIFY_ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    if (!res.ok) throw new SpotifyError(`Spotify token request failed (${res.status})`, res.status);
    const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    const refreshToken = j.refresh_token ?? previousRefresh;
    if (!j.access_token || !refreshToken) throw new SpotifyError('Spotify token response was incomplete', 502);
    return { accessToken: j.access_token, refreshToken, expiresAt: Date.now() + j.expires_in * 1000 };
  }

  async function api<T>(accessToken: string, url: string): Promise<T> {
    const res = await fetchFn(url.startsWith('http') ? url : `${SPOTIFY_API}${url}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new SpotifyError(`Spotify API ${url} failed (${res.status})`, res.status);
    return (await res.json()) as T;
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
      const first: Page = await api(accessToken, pageUrl(0));
      const pages: Page[] = [first];
      if (typeof first.total === 'number') {
        // The first page says how many songs there are, so fetch the rest a few pages at a time.
        const offsets: number[] = [];
        for (let o = 50; o < Math.min(first.total, max); o += 50) offsets.push(o);
        for (let i = 0; i < offsets.length; i += SAVED_PAGE_CONCURRENCY) {
          pages.push(...(await Promise.all(offsets.slice(i, i + SAVED_PAGE_CONCURRENCY).map((o) => api<Page>(accessToken, pageUrl(o))))));
        }
      } else {
        let page = first;
        while (page.items.length && page.next && pages.length * 50 < max) {
          page = await api<Page>(accessToken, page.next);
          pages.push(page);
        }
      }
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
  // have not granted; without them we skip that signal rather than fail.
  const optional = (p: Promise<Track[]>) =>
    p.catch((err) => {
      if (err instanceof SpotifyError && (err.status === 401 || err.status === 403)) return [] as Track[];
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
