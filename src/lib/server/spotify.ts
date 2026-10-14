// Spotify Web API client: authorization code flow, token refresh, library reads.
// `fetch` is injected so tests run offline; SPOTIFY_MOCK=1 swaps in mockSpotify.ts.
import type { Track } from '../contracts';
import type { SpotifyTokens, Store, UserRecord } from './store';

export const SPOTIFY_SCOPES = 'user-library-read user-top-read';
export const SPOTIFY_ACCOUNTS = 'https://accounts.spotify.com';
export const SPOTIFY_API = 'https://api.spotify.com/v1';
export const MAX_SAVED_TRACKS = 500;
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
  /** Saved songs in Spotify's order (newest saved first), up to `max`. playRank is the saved position. */
  getSavedTracks(accessToken: string, max?: number): Promise<Track[]>;
  /** Medium-term top tracks, most played first. playRank is the top position. */
  getTopTracks(accessToken: string): Promise<Track[]>;
}

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
  name: string;
  is_local?: boolean;
  artists: { id: string; name: string }[];
  external_urls?: { spotify?: string };
  album?: { images?: SpotifyImage[] };
}

function pickImage(images: SpotifyImage[] | undefined): string | undefined {
  if (!images?.length) return undefined;
  // Phone-sized art: the image closest to 300px wide.
  const sorted = [...images].sort((a, b) => Math.abs((a.width ?? 300) - 300) - Math.abs((b.width ?? 300) - 300));
  return sorted[0]?.url;
}

export function mapTrack(t: SpotifyTrackObject | null | undefined, playRank: number): Track | null {
  if (!t || !t.id || t.is_local || !t.artists?.[0]) return null;
  const artist = t.artists[0];
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
  return track;
}

/** Top tracks first (playRank 0..), then saved songs not in the top list, in saved order. */
export function mergeTracks(top: Track[], saved: Track[]): Track[] {
  const out: Track[] = [];
  const seen = new Set<string>();
  for (const t of [...top, ...saved]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push({ ...t, playRank: out.length });
  }
  return out;
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
      const out: Track[] = [];
      let url: string | null = `/me/tracks?limit=50&offset=0`;
      while (url && out.length < max) {
        const page: { items: { track: SpotifyTrackObject | null }[]; next: string | null } = await api(accessToken, url);
        for (const item of page.items) {
          const t = mapTrack(item.track, out.length);
          if (t && out.length < max) out.push(t);
        }
        url = page.items.length ? page.next : null;
      }
      return out;
    },
    async getTopTracks(accessToken) {
      const page = await api<{ items: SpotifyTrackObject[] }>(accessToken, '/me/top/tracks?time_range=medium_term&limit=50');
      const out: Track[] = [];
      for (const item of page.items) {
        const t = mapTrack(item, out.length);
        if (t) out.push(t);
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

/** The user's library as contract Tracks, ordered by playRank. */
export async function getUserTracks(client: SpotifyClient, accessToken: string): Promise<Track[]> {
  const [top, saved] = await Promise.all([client.getTopTracks(accessToken), client.getSavedTracks(accessToken)]);
  return mergeTracks(top, saved);
}
