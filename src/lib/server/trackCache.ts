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
  // A load in progress, so two requests that arrive together (the list and the known songs) share one
  // read of the library instead of reading it twice: for 11,000 liked songs that is 223 Spotify requests, not 446.
  const loading = new Map<string, Promise<Track[]>>();
  const peek = (userId: string) => {
    const hit = entries.get(userId);
    return hit && hit.expires > now() ? hit.tracks : null;
  };
  return {
    async get(userId, load) {
      const hit = peek(userId);
      if (hit) return hit;
      const running = loading.get(userId);
      if (running) return running;
      const started = (async () => {
        const tracks = await load();
        entries.set(userId, { tracks, expires: now() + ttlMs });
        return tracks;
      })();
      loading.set(userId, started);
      try {
        return await started;
      } finally {
        loading.delete(userId);
      }
    },
    peek,
    invalidate(userId) {
      entries.delete(userId);
    },
  };
}
