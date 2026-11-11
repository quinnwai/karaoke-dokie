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
import type { SongPopularityRecord, SongRangeRecord, Store, UsdbIndexEntry } from './store';
import { hasLittleSinging } from '../songs/resolve';
import { effectiveTempo } from '../tempo/feel';
import { readSongFeels } from './songFeel';
import { withKaraokePopularity, type KaraokePopularity } from '../songs/score';

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
  /** Uncached lookups run this many at a time. Default DEFAULT_LOOKUP_CONCURRENCY. */
  concurrency?: number;
  /** Max songs returned by knownSongs. Default 50. */
  maxKnownSongs?: number;
  now?: () => Date;
}

/** Most songs a whole-list response carries: the best-ranked ones; any past it are left out. */
export const MAX_ALL_MATCHES = 1000;

/**
 * Uncached lookups at a time. A first load of an 11,000 song library is mostly database round
 * trips, so this sets how long it takes (QWW-31 bench: 116 s at 5, 35 s at 16, 19 s at 32, with
 * 25 ms per query).
 */
export const DEFAULT_LOOKUP_CONCURRENCY = 20;

export interface SongService {
  /**
   * One page of the ranked library. With `all`, every match in one response instead (offset and
   * limit are ignored), with its year and genre, and scored with its USDB and karaoke popularity,
   * for the results screen to sort and filter on the phone.
   */
  recommend(
    tracks: Track[],
    userRange: VocalRange,
    offset: number,
    limit: number,
    opts?: { all?: boolean },
  ): Promise<RecommendationsResponse>;
  knownSongs(tracks: Track[]): Promise<KnownSongsResponse>;
  /**
   * Every library song that fits `userRange`, scored and with its year, genre, tempo and popularity, but not ranked, cut
   * or stripped of its pitch histograms: the Setlist tuner ranks them itself (QWW-47). A song the library has twice under
   * different Spotify ids is listed once, as its most played one.
   */
  libraryMatches(tracks: Track[], userRange: VocalRange): Promise<LibraryMatches>;
}

/** What libraryMatches returns. */
export interface LibraryMatches {
  matches: Match[];
  /** Each match's song key, by track id (to tell a song the catalogue also has). */
  keys: Map<string, string>;
  /** The data-source line of each match, by track id. */
  logs: Map<string, DataSourceLogEntry>;
  /** False while lookups have run out of budget (a first visit to a very large library) or one failed: asking again carries on. */
  complete: boolean;
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
 * counts as USDB's. A song with neither gets the year of its best Billboard Year-End rank, which
 * can be a year after release (a hit from late in a year charts in the next), so only then.
 */
function songFacts(
  track: Track,
  row: UsdbIndexEntry | undefined,
  popularity: SongPopularityRecord | undefined,
): Pick<Match, 'year' | 'yearSource' | 'genre'> {
  const facts: Pick<Match, 'year' | 'yearSource' | 'genre'> = {};
  const usdb = row?.year;
  const spotify = track.releaseYear;
  if (usdb !== undefined && (spotify === undefined || usdb <= spotify)) {
    facts.year = usdb;
    facts.yearSource = 'usdb';
  } else if (spotify !== undefined) {
    facts.year = spotify;
    facts.yearSource = 'spotify';
  } else if (popularity?.chartYear !== undefined) {
    facts.year = popularity.chartYear;
    facts.yearSource = 'chart';
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

/**
 * The match as the whole-list response sends it: no pitch histograms, for the song or its duet
 * parts, and none of the karaoke popularity it was scored with.
 */
export function compact(m: Match): Match {
  const scored: SongRange & KaraokePopularity = m.range;
  const { karaokeViews: _views, chartRank: _rank, deezerRank: _deezer, ...range } = withoutPitchShare(scored);
  if (range.parts) range.parts = range.parts.map(withoutPitchShare);
  return { ...m, range };
}

export function createSongService(store: Store, deps: SongDeps, opts: SongServiceOptions = {}): SongService {
  const maxResolves = opts.maxResolvesPerRequest ?? 1000;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_LOOKUP_CONCURRENCY);
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
   * visit returns true. Returns true when every track was visited, one whose lookup failed (and is skipped, to be
   * retried next time) included: `stats.failed`, when given, says how many of those there were.
   */
  async function walk(tracks: Track[], visit: (w: Walked) => boolean, stats?: { failed: number }): Promise<boolean> {
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
      if (resolves >= maxResolves) {
        if (stats) stats.failed = failed.size;
        return false; // budget spent; the client can ask again
      }

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
    if (stats) stats.failed = failed.size;
    return true;
  }

  /**
   * The library's songs that fit `userRange`, in play order (the order `walk` visits them). With `all`, each carries
   * song facts from our USDB index and is scored with our karaoke popularity (QWW-6) and tempo (QWW-40), each read once
   * for every candidate. Pages leave both out, so they stay exactly as they were.
   */
  async function collect(tracks: Track[], userRange: VocalRange, all: boolean) {
    const candidates: { track: Track; key: string; range: SongRange; log: DataSourceLogEntry }[] = [];
    const stats = { failed: 0 };
    const exhausted = await walk(
      tracks,
      ({ track, key, record }) => {
        if (!record.range) return false; // skipped songs never match
        if (hasLittleSinging(track.title)) return false; // a dub or instrumental shares the original's key
        candidates.push({ track, key, range: record.range, log: record.log });
        return false;
      },
      stats,
    );

    const keys = candidates.map((c) => c.key);
    const [index, popularity, tempos, feels] = all
      ? await Promise.all([store.findUsdbSongs(keys), store.getSongPopularity(keys), store.getSongTempos(keys), readSongFeels(store, keys)])
      : [null, null, null, null];
    const matches: Match[] = [];
    const logs = new Map<string, DataSourceLogEntry>();
    const keyOf = new Map<string, string>();
    for (const { track, key, range, log } of candidates) {
      const row = index?.get(key);
      const pop = popularity?.get(key);
      const m = deps.matchSong(track, index ? withKaraokePopularity(withIndexPopularity(range, row), pop) : range, userRange);
      if (!m) continue;
      const tempo = effectiveTempo({ key, record: tempos?.get(key), feel: feels?.get(key)?.feel })?.tempo;
      matches.push(index ? { ...m, ...songFacts(track, row, pop), ...(tempo !== undefined ? { tempo } : {}) } : m);
      logs.set(track.id, log);
      keyOf.set(track.id, key);
    }
    return { matches, logs, keyOf, exhausted, failed: stats.failed };
  }

  return {
    async recommend(tracks, userRange, offset, limit, { all = false } = {}) {
      const { matches, logs, keyOf, exhausted } = await collect(tracks, userRange, all);
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
      // A song can be in a library twice under different Spotify ids (the single and the album
      // track): it is listed once, where it ranks best.
      const seen = new Set<string>();
      const ranked = deps.rankMatches(matches).filter((m) => {
        const key = keyOf.get(m.track.id) ?? m.track.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (all) {
        const items = ranked.slice(0, MAX_ALL_MATCHES).map(compact);
        if (ranked.length > MAX_ALL_MATCHES) console.info(`[songs] ${ranked.length} songs fit; the whole-list response carries the best ${MAX_ALL_MATCHES}`);
        // Not complete while lookups have run out of budget: nextOffset is then set, and asking for
        // the whole list again carries on with them. Paging on from it would not line up, since
        // pages rank without the index's or karaoke popularity. A list cut at MAX_ALL_MATCHES is
        // not complete either, but has nothing more to ask for: nextOffset is null.
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

    async libraryMatches(tracks, userRange) {
      const { matches, logs, keyOf, exhausted, failed } = await collect(tracks, userRange, true);
      // Matches come in play order, so the first of a song under two Spotify ids is the one played more.
      const seen = new Set<string>();
      const unique = matches.filter((m) => {
        const key = keyOf.get(m.track.id) ?? m.track.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      // A song whose lookup failed is left out and tried again next time, so a list with one is not complete.
      return { matches: unique, keys: keyOf, logs, complete: exhausted && failed === 0 };
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
