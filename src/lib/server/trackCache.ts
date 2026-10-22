import type { Track } from '../contracts';

/** Per-process cache of each user's Spotify library, so paging does not refetch 500 songs. */
export interface TrackCache {
  get(userId: string, load: () => Promise<Track[]>): Promise<Track[]>;
  /** The cached library, or null when there is none (or it expired). Never loads. */
  peek(userId: string): Track[] | null;
  invalidate(userId: string): void;
}

export function createTrackCache(ttlMs = 10 * 60_000, now: () => number = Date.now): TrackCache {
  const entries = new Map<string, { tracks: Track[]; expires: number }>();
  const peek = (userId: string) => {
    const hit = entries.get(userId);
    return hit && hit.expires > now() ? hit.tracks : null;
  };
  return {
    async get(userId, load) {
      const hit = peek(userId);
      if (hit) return hit;
      const tracks = await load();
      entries.set(userId, { tracks, expires: now() + ttlMs });
      return tracks;
    },
    peek,
    invalidate(userId) {
      entries.delete(userId);
    },
  };
}
