// Turns a user's library into paged recommendations. Song-data logic (range lookup, matching,
// ranking, paging) is injected so this file only owns caching, logging and lazy resolution.
import type {
  DataSourceLogEntry,
  KnownSongsResponse,
  Match,
  RecommendationsResponse,
  SongRange,
  Track,
  VocalRange,
} from '../contracts';
import type { SongRangeRecord, Store } from './store';
import { hasLittleSinging } from '../songs/resolve';

export interface ResolveResult {
  /** null = skipped (no usable data). */
  range: SongRange | null;
  log: DataSourceLogEntry;
}

/** The parts of src/lib/songs this service needs, already bound to their own dependencies. */
export interface SongDeps {
  songKey(artist: string, title: string): string;
  resolveSongRange(track: Track): Promise<ResolveResult>;
  /** null when the song does not fit the user's range at all. */
  matchSong(track: Track, range: SongRange, userRange: VocalRange): Match | null;
  rankMatches(matches: Match[]): Match[];
  paginate<T>(items: T[], offset: number, limit: number): { items: T[]; nextOffset: number | null };
}

export interface SongServiceOptions {
  /** Max uncached lookups per request. Lookups only read the database, and ranking needs the
   * whole library, so the default (1000) covers a full library. */
  maxResolvesPerRequest?: number;
  /** Uncached lookups run this many at a time. Default 5. */
  concurrency?: number;
  /** Max songs returned by knownSongs. Default 50. */
  maxKnownSongs?: number;
  now?: () => Date;
}

export interface SongService {
  recommend(tracks: Track[], userRange: VocalRange, offset: number, limit: number): Promise<RecommendationsResponse>;
  knownSongs(tracks: Track[]): Promise<KnownSongsResponse>;
}

interface Walked {
  track: Track;
  record: SongRangeRecord;
}

export function createSongService(store: Store, deps: SongDeps, opts: SongServiceOptions = {}): SongService {
  const maxResolves = opts.maxResolvesPerRequest ?? 1000;
  const concurrency = Math.max(1, opts.concurrency ?? 5);
  const maxKnown = opts.maxKnownSongs ?? 50;
  const now = opts.now ?? (() => new Date());

  async function resolveAndCache(track: Track, key: string): Promise<SongRangeRecord | null> {
    let result: ResolveResult;
    try {
      result = await deps.resolveSongRange(track);
    } catch (err) {
      // A failed lookup is logged but not cached, so it is retried next time.
      await store.appendLog({
        trackId: track.id,
        title: track.title,
        artist: track.artist,
        outcome: 'skipped',
        reason: `Lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        at: now().toISOString(),
      });
      return null;
    }
    const log: DataSourceLogEntry = { ...result.log, trackId: track.id };
    if (result.range === null) log.outcome = 'skipped';
    const record: SongRangeRecord = { range: result.range, log };
    await store.putSongRange(key, record);
    await store.appendLog(log);
    return record;
  }

  /**
   * Visits tracks in playRank order, using cached ranges and resolving uncached ones (at most
   * maxResolves per call), calling `visit` for each track that has a record. Stops early when
   * visit returns true. Returns true only when every track was visited.
   */
  async function walk(tracks: Track[], visit: (w: Walked) => boolean): Promise<boolean> {
    const ordered = [...tracks].sort((a, b) => a.playRank - b.playRank);
    const keys = ordered.map((t) => deps.songKey(t.artist, t.title));
    const cache = await store.getSongRanges(keys);
    const failed = new Set<string>();
    let resolves = 0;

    let i = 0;
    while (i < ordered.length) {
      // Visit every track we already know about, in order.
      while (i < ordered.length && (cache.has(keys[i]!) || failed.has(keys[i]!))) {
        const track = ordered[i]!;
        const record = cache.get(keys[i]!);
        i++;
        if (record && visit({ track, record: { ...record, log: { ...record.log, trackId: track.id } } })) return false;
      }
      if (i >= ordered.length) break;
      if (resolves >= maxResolves) return false; // budget spent; the client can ask again

      // Look up the next few unknown songs in parallel (lookahead of `concurrency`).
      const batch: { track: Track; key: string }[] = [];
      const budget = Math.min(concurrency, maxResolves - resolves);
      for (let j = i; j < ordered.length && batch.length < budget; j++) {
        const key = keys[j]!;
        if (!cache.has(key) && !failed.has(key) && !batch.some((b) => b.key === key)) batch.push({ track: ordered[j]!, key });
      }
      resolves += batch.length;
      await Promise.all(
        batch.map(async ({ track, key }) => {
          const rec = await resolveAndCache(track, key);
          if (rec) cache.set(key, rec);
          else failed.add(key);
        }),
      );
    }
    return true;
  }

  return {
    async recommend(tracks, userRange, offset, limit) {
      const matches: Match[] = [];
      const logs = new Map<string, DataSourceLogEntry>();
      const exhausted = await walk(tracks, ({ track, record }) => {
        if (!record.range) return false; // skipped songs never match
        if (hasLittleSinging(track.title)) return false; // a dub or instrumental shares the original's key
        const m = deps.matchSong(track, record.range, userRange);
        if (m) {
          matches.push(m);
          logs.set(track.id, record.log);
        }
        return false;
      });

      // Rank the whole library, then page it. The order is the same on every request (same
      // tracks, same cached ranges), so pages never repeat or skip a song.
      const ranked = deps.rankMatches(matches);
      const page = deps.paginate(ranked, offset, limit);
      const items = page.items;
      // Lookup budget spent before the end of the library (only on a first visit to a very large
      // library): let the client ask again, which continues the lookups.
      const nextOffset = page.nextOffset ?? (exhausted ? null : offset + items.length);

      const sources: Record<string, DataSourceLogEntry> = {};
      for (const m of items) {
        const log = logs.get(m.track.id);
        if (log) sources[m.track.id] = log;
      }
      return { matches: items, nextOffset, sources };
    },

    async knownSongs(tracks) {
      const songs: KnownSongsResponse['songs'] = [];
      await walk(tracks, ({ track, record }) => {
        if (record.range && !hasLittleSinging(track.title)) songs.push({ track, range: record.range });
        return songs.length >= maxKnown;
      });
      return { songs };
    },
  };
}
