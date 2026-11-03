// Turns a user's library into recommendations, paged or as one whole list. Song-data logic (range
// lookup, matching, ranking, paging) is injected so this file only owns caching, logging, lazy
// resolution and the song facts the whole list carries.
import type {
  DataSourceLogEntry,
  KnownSongsResponse,
  Match,
  RecommendationsResponse,
  SongRange,
  Track,
  VocalRange,
} from '../contracts';
import type { SongRangeRecord, Store, UsdbIndexEntry } from './store';
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

/** Most songs a whole-list response carries: the best-ranked ones; any past it are left out. */
export const MAX_ALL_MATCHES = 1000;

export interface SongService {
  /**
   * One page of the ranked library. With `all`, every match in one response instead (offset and
   * limit are ignored), with its year, genre and USDB popularity, for the results screen to sort
   * and filter on the phone.
   */
  recommend(
    tracks: Track[],
    userRange: VocalRange,
    offset: number,
    limit: number,
    opts?: { all?: boolean },
  ): Promise<RecommendationsResponse>;
  knownSongs(tracks: Track[]): Promise<KnownSongsResponse>;
}

interface Walked {
  track: Track;
  key: string;
  record: SongRangeRecord;
}

/**
 * The range to score: when it has no USDB views or stars of its own (a range from a bulk collection
 * or a measured recording never had a USDB lookup), the index row's. A copy for scoring only; it is
 * never stored.
 */
function withIndexPopularity(range: SongRange, row: UsdbIndexEntry | undefined): SongRange {
  if (!row || range.usdbViews !== undefined || range.usdbRating !== undefined) return range;
  const scored = { ...range };
  if (row.views !== undefined) scored.usdbViews = row.views;
  if (row.rating !== undefined) scored.usdbRating = row.rating;
  return scored;
}

/**
 * Year and genre for the decade filter and the song info. The year is the earlier of USDB's (the
 * note file's #YEAR) and Spotify's album year, since a reissue only ever makes a date later; a tie
 * counts as USDB's.
 */
function songFacts(track: Track, row: UsdbIndexEntry | undefined): Pick<Match, 'year' | 'yearSource' | 'genre'> {
  const facts: Pick<Match, 'year' | 'yearSource' | 'genre'> = {};
  const usdb = row?.year;
  const spotify = track.releaseYear;
  if (usdb !== undefined && (spotify === undefined || usdb <= spotify)) {
    facts.year = usdb;
    facts.yearSource = 'usdb';
  } else if (spotify !== undefined) {
    facts.year = spotify;
    facts.yearSource = 'spotify';
  }
  if (row?.genre !== undefined) facts.genre = row.genre;
  return facts;
}

/** A copy without the pitch histogram, most of a range's size. */
function withoutPitchShare<T extends { pitchShare?: [number, number][] }>(x: T): T {
  const copy = { ...x };
  delete copy.pitchShare;
  return copy;
}

/** The match as the whole-list response sends it: no pitch histograms, for the song or its duet parts. */
function compact(m: Match): Match {
  const range = withoutPitchShare(m.range);
  if (range.parts) range.parts = range.parts.map(withoutPitchShare);
  return { ...m, range };
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
        const key = keys[i]!;
        const record = cache.get(key);
        i++;
        if (record && visit({ track, key, record: { ...record, log: { ...record.log, trackId: track.id } } })) return false;
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
    async recommend(tracks, userRange, offset, limit, { all = false } = {}) {
      const candidates: { track: Track; key: string; range: SongRange; log: DataSourceLogEntry }[] = [];
      const exhausted = await walk(tracks, ({ track, key, record }) => {
        if (!record.range) return false; // skipped songs never match
        if (hasLittleSinging(track.title)) return false; // a dub or instrumental shares the original's key
        candidates.push({ track, key, range: record.range, log: record.log });
        return false;
      });

      // The whole list also carries song facts from our USDB index, read once for every candidate.
      // Pages leave it out, so they stay exactly as they were.
      const index = all ? await store.findUsdbSongs(candidates.map((c) => c.key)) : null;
      const matches: Match[] = [];
      const logs = new Map<string, DataSourceLogEntry>();
      for (const { track, key, range, log } of candidates) {
        const row = index?.get(key);
        const m = deps.matchSong(track, index ? withIndexPopularity(range, row) : range, userRange);
        if (!m) continue;
        matches.push(index ? { ...m, ...songFacts(track, row) } : m);
        logs.set(track.id, log);
      }
      const sourcesOf = (items: Match[]) => {
        const sources: Record<string, DataSourceLogEntry> = {};
        for (const m of items) {
          const log = logs.get(m.track.id);
          if (log) sources[m.track.id] = log;
        }
        return sources;
      };

      // Rank the whole library, then page it. The order is the same on every request (same
      // tracks, same cached ranges), so pages never repeat or skip a song.
      const ranked = deps.rankMatches(matches);
      if (all) {
        const items = ranked.slice(0, MAX_ALL_MATCHES).map(compact);
        // Not complete while lookups have run out of budget: nextOffset is then set, and asking for
        // the whole list again carries on with them. Paging on from it would not line up, since
        // pages rank without the index's popularity. A list cut at MAX_ALL_MATCHES is not complete
        // either, but has nothing more to ask for: nextOffset is null.
        const complete = exhausted && items.length === ranked.length;
        return { matches: items, nextOffset: exhausted ? null : items.length, sources: sourcesOf(items), complete };
      }
      const page = deps.paginate(ranked, offset, limit);
      const items = page.items;
      // Lookup budget spent before the end of the library (only on a first visit to a very large
      // library): let the client ask again, which continues the lookups.
      const nextOffset = page.nextOffset ?? (exhausted ? null : offset + items.length);
      return { matches: items, nextOffset, sources: sourcesOf(items) };
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
