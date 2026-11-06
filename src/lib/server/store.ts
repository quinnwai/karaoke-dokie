// Persistence interface for the backend. Two implementations:
// memoryStore.ts (dev, tests, e2e) and postgresStore.ts (Neon in production, pg-mem in tests).
import type { AppEvent, DataSourceLogEntry, FeedbackEntry, Mood, SongRange, VocalRange } from '../contracts';

export interface UserRecord {
  id: string;
  displayName: string;
  spotify: SpotifyTokens;
}

export interface SpotifyTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number;
}

/** A cached song lookup, by songKey. `range` is null when the song was skipped. */
export interface SongRangeRecord {
  range: SongRange | null;
  log: DataSourceLogEntry;
}

/** One song in our copy of USDB's song list (no note text), keyed by USDB id. */
export interface UsdbIndexEntry {
  id: number;
  /** songKey(artist, title). */
  key: string;
  artist: string;
  title: string;
  views?: number;
  rating?: number;
  /** USDB's last-changed time, epoch seconds. */
  lastChange?: number;
  /** Year, genre and language as listed on USDB's song list (the note file's #YEAR, #GENRE, #LANGUAGE). */
  year?: number;
  genre?: string;
  language?: string;
}

/** One catalogue song for the no-Spotify mode: a song with a usable range, and its most-viewed USDB row. */
export interface CatalogueSong {
  key: string;
  /** Display names from the range record's log line, not the normalised key. */
  artist: string;
  title: string;
  range: SongRange;
  log: DataSourceLogEntry;
  /** The most-viewed USDB index row with this key, when there is one (views, rating, year, genre). */
  usdb?: UsdbIndexEntry;
}

/** A stored beta event: what a device did, keyed by its random id. */
export interface StoredEvent extends AppEvent {
  anonId: string;
}

/** listEvents returns this many events unless asked for another number, and never more than the max. */
export const DEFAULT_EVENTS_LIMIT = 5_000;
export const MAX_EVENTS_LIMIT = 20_000;

/** Mood labels for one song (QWW-11), from one labelling method. */
export interface SongMoodsRecord {
  key: string;
  moods: Mood[];
  /** Labelling method and version, e.g. "claude-haiku-5-5/moods-v1"; a newer method replaces an older one's row. */
  method: string;
  /** Where the label came from, e.g. "claude" or "hand". */
  source: string;
}

/**
 * How well known one song is, from our own karaoke data (QWW-6): the YouTube views of its KaraFun
 * karaoke videos and its best Billboard Year-End Hot 100 rank. Only for scoring; never stored with
 * the song's range.
 */
export interface SongPopularityRecord {
  /** songKey(artist, title). */
  key: string;
  /** Total YouTube views of the song's KaraFun karaoke videos. */
  karaokeViews?: number;
  /** The song's best (lowest) Billboard Year-End Hot 100 rank, 1 to 100, and the year of that chart. */
  chartRank?: number;
  chartYear?: number;
  /** Which files the numbers came from: "karafun", "billboard" or "karafun+billboard". */
  source: string;
}

export interface Store {
  getUser(id: string): Promise<UserRecord | null>;
  upsertUser(user: UserRecord): Promise<void>;
  listUserIds(): Promise<string[]>;

  saveRange(userId: string, range: VocalRange): Promise<void>;
  getRange(userId: string): Promise<VocalRange | null>;

  getSongRange(songKey: string): Promise<SongRangeRecord | null>;
  /** Batch read; the map only has keys that are cached. */
  getSongRanges(songKeys: string[]): Promise<Map<string, SongRangeRecord>>;
  putSongRange(songKey: string, record: SongRangeRecord): Promise<void>;
  /**
   * Measured ranges (note files and full recordings, never estimates) for one artist (the artist
   * part of songKey), for the artist fallback.
   */
  listMeasuredRangesByArtist(artistKey: string): Promise<SongRange[]>;
  /** Every stored (not skipped) song range for one artist (the artist part of songKey), by song key; for the octave fix. */
  listSongRangesByArtist(artistKey: string): Promise<Map<string, SongRangeRecord>>;

  /** Adds or updates songs in the USDB song index. */
  putUsdbSongs(entries: UsdbIndexEntry[]): Promise<void>;
  /** The most-viewed indexed USDB song for each key; the map only has keys that are indexed. */
  findUsdbSongs(songKeys: string[]): Promise<Map<string, UsdbIndexEntry>>;
  /** Every indexed USDB song, most-viewed first. */
  listUsdbSongs(): Promise<UsdbIndexEntry[]>;
  /** Size of the USDB index and its newest last-changed time (null when empty). */
  usdbIndexStats(): Promise<{ count: number; newestChange: number | null }>;

  appendLog(entry: DataSourceLogEntry): Promise<void>;
  /** Newest first. */
  listLog(limit?: number): Promise<DataSourceLogEntry[]>;

  saveFeedback(entry: FeedbackEntry): Promise<void>;
  /** Newest first, optionally for one user. */
  listFeedback(opts?: { userId?: string; limit?: number }): Promise<FeedbackEntry[]>;

  // ---- catalogue: results without Spotify (QWW-2 Track B) ----
  /**
   * Songs with a measured range (note file or recording), one per song key, each with its
   * most-viewed USDB row, most popular first by catalogueRank (songs/score.ts: USDB views, karaoke
   * views, Year-End rank; songs with none of them last, by key): the `limit` most popular, plus
   * every Year-End Hot 100 song below them (pickCatalogue).
   */
  listCatalogue(limit: number): Promise<CatalogueSong[]>;

  // ---- beta event log (QWW-16, QWW-20) ----
  appendEvents(anonId: string, events: AppEvent[]): Promise<void>;
  /** Oldest first within a device; at most `limit` events overall, the newest ones. */
  listEvents(opts?: { anonId?: string; limit?: number }): Promise<StoredEvent[]>;

  // ---- mood labels (QWW-11) ----
  putSongMoods(entries: SongMoodsRecord[]): Promise<void>;
  /** The map only has keys that have a label. */
  getSongMoods(songKeys: string[]): Promise<Map<string, SongMoodsRecord>>;

  // ---- song popularity from karaoke data (QWW-6) ----
  /** Adds rows, or replaces a key's whole row; within one call the last entry for a key wins. */
  putSongPopularity(entries: SongPopularityRecord[]): Promise<void>;
  /** Batch read; the map only has keys that have a row. */
  getSongPopularity(songKeys: string[]): Promise<Map<string, SongPopularityRecord>>;
}

export const DEFAULT_LIST_LIMIT = 200;
