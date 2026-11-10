import type { SpotifyConfig } from './spotify';

export interface ServerConfig {
  sessionSecret: string;
  /** Empty = admin log disabled (always 403). */
  adminToken: string;
  spotifyMock: boolean;
  spotify: SpotifyConfig;
}

export function readConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  return {
    sessionSecret: env.SESSION_SECRET ?? '',
    adminToken: env.ADMIN_TOKEN ?? '',
    spotifyMock: env.SPOTIFY_MOCK === '1',
    spotify: {
      clientId: env.SPOTIFY_CLIENT_ID ?? '',
      clientSecret: env.SPOTIFY_CLIENT_SECRET ?? '',
      redirectUri: env.SPOTIFY_REDIRECT_URI ?? '',
    },
  };
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
