import type { Mood } from '../contracts';
import { parseShippedMoods } from './moods';
import { pickStoreKind } from './getStore';
import type { SpotifyConfig } from './spotify';

export interface ServerConfig {
  sessionSecret: string;
  /** Empty = admin pages disabled (always 403). */
  adminToken: string;
  spotifyMock: boolean;
  spotify: SpotifyConfig;
  /** Whether POST /api/events stores the beta events it is sent (EVENTS; see eventsOn). */
  collectEvents: boolean;
  /** Duets and moods on screen at all (DUETS_AND_MOODS; see duetsAndMoodsOn and features.ts). Off by default. */
  duetsAndMoods: boolean;
  /** Moods allowed on screen (MOODS_SHIPPED), once they pass the QWW-11 gate, and only while duetsAndMoods is on. Empty = no mood chips. */
  moodsShipped: Mood[];
}

export function readConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  return {
    sessionSecret: env.SESSION_SECRET ?? '',
    adminToken: env.ADMIN_TOKEN ?? '',
    spotifyMock: env.SPOTIFY_MOCK === '1' || !liveSpotifyAllowed(env),
    spotify: {
      clientId: env.SPOTIFY_CLIENT_ID ?? '',
      clientSecret: env.SPOTIFY_CLIENT_SECRET ?? '',
      redirectUri: env.SPOTIFY_REDIRECT_URI ?? '',
    },
    collectEvents: eventsOn(env),
    duetsAndMoods: duetsAndMoodsOn(env),
    moodsShipped: parseShippedMoods(env.MOODS_SHIPPED),
  };
}

/**
 * Whether this process may call the real Spotify (QWW-55 PR 2): a deployed preview or production (Vercel sets
 * VERCEL_ENV), or SPOTIFY_LIVE=1 for a run that means it (a script's --live sets it). Everywhere else (local dev, CI,
 * an agent's run) the offline mock is used, so nothing takes from the quota that testers share.
 */
export function liveSpotifyAllowed(env: Record<string, string | undefined>): boolean {
  return env.VERCEL_ENV === 'preview' || env.VERCEL_ENV === 'production' || env.SPOTIFY_LIVE === '1';
}

/**
 * The one switch for duets and moods (QWW-43), off by default. Only DUETS_AND_MOODS=on turns them
 * on; unset, empty or any other value (a typo, "1", "true") leaves them off, so a mistake never
 * shows a half-finished feature to testers.
 */
export function duetsAndMoodsOn(env: Record<string, string | undefined>): boolean {
  return env.DUETS_AND_MOODS?.trim().toLowerCase() === 'on';
}

/**
 * The title screen's "or pick songs you sing well" link (QWW-55), off by default: the first tester release
 * has one onboarding flow (title, mic, low note, high note, list). Only PICK_SONGS=on shows it; unset,
 * empty or any other value (a typo, "1", "true") hides it, like DUETS_AND_MOODS. The screen code stays.
 * It is read by app/page.tsx, not by an API route, because the link is the only thing it changes.
 */
export function pickSongsOn(env: Record<string, string | undefined>): boolean {
  return env.PICK_SONGS?.trim().toLowerCase() === 'on';
}

/**
 * The beta event log's kill switch. EVENTS=on or EVENTS=off decides; any other value counts as
 * off, so a typo never turns collection on. Unset, events are kept only by a production build
 * with real Spotify and Postgres, so tests, e2e (production build, mock Spotify, memory store)
 * and local dev collect nothing.
 */
export function eventsOn(env: Record<string, string | undefined>): boolean {
  const v = env.EVENTS?.trim().toLowerCase();
  if (v) return v === 'on';
  return env.NODE_ENV === 'production' && env.SPOTIFY_MOCK !== '1' && pickStoreKind(env) === 'postgres';
}

/** Problems that stop sign-in from working, for a clear 500 instead of a confusing failure. */
export function configProblems(c: ServerConfig): string[] {
  const out: string[] = [];
  if (c.sessionSecret.length < 16) out.push('SESSION_SECRET must be set (16+ characters)');
  if (!c.spotifyMock) {
    if (!c.spotify.clientId) out.push('SPOTIFY_CLIENT_ID is not set');
    if (!c.spotify.clientSecret) out.push('SPOTIFY_CLIENT_SECRET is not set');
    if (!c.spotify.redirectUri) out.push('SPOTIFY_REDIRECT_URI is not set');
  }
  return out;
}
