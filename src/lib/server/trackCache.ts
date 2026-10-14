import type { Track } from '../contracts';

/** Per-process cache of each user's Spotify library, so paging does not refetch 500 songs. */
export interface TrackCache {
  get(userId: string, load: () => Promise<Track[]>): Promise<Track[]>;
  invalidate(userId: string): void;
}

export function createTrackCache(ttlMs = 10 * 60_000, now: () => number = Date.now): TrackCache {
  const entries = new Map<string, { tracks: Track[]; expires: number }>();
  return {
    async get(userId, load) {
      const hit = entries.get(userId);
      if (hit && hit.expires > now()) return hit.tracks;
      const tracks = await load();
      entries.set(userId, { tracks, expires: now() + ttlMs });
      return tracks;
    },
    invalidate(userId) {
      entries.delete(userId);
    },
  };
}
