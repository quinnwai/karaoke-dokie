// Persistence interface for the backend. Two implementations:
// memoryStore.ts (dev, tests, e2e) and postgresStore.ts (Neon in production, pg-mem in tests).
import type { AppEvent, DataSourceLogEntry, FeedbackEntry, Mood, SongRange, TimeRange, Track, VocalRange } from '../contracts';

/**
 * What the sync knows about one user's stored library (QWW-55 PR 2). The liked songs are rows of their own;
 * the rest is small and kept here. Times are epoch ms.
 */
export interface LibrarySyncState {
  /** Spotify's count of liked items (unreadable ones included) at the last sync. */
  savedTotal: number;
  /** False while the first read is unfinished (cut off by an error, a 429 or the deadline); the next visit resumes it. */
  savedComplete: boolean;
  /** Where the first read resumes: the offset of the next page of liked songs. */
  savedNextOffset: number;
  top: Partial<Record<TimeRange, { at: number; tracks: Track[] }>>;
  recent: { at: number; tracks: Track[] } | null;
  /** Own playlists by id, each with the snapshot_id its songs were read at. */
  playlists: Record<string, { snapshotId: string; tracks: Track[] }>;
  /**
   * A check pass over all likes that runs a few pages per visit, started when Spotify's count of liked songs does not
   * add up (something was un-liked). Songs it has not seen when it ends are removed. `gen` is the pass's number.
   */
  verify?: { gen: number; offset: number; unreadable: number; attempt: number } | null;
  /** The number of the last check pass started, so the next is larger. */
  lastGen?: number;
  /** Playlists are not asked for again before this (a user who never granted the scope), or 0. */
  playlistsRetryAt: number;
}

export interface StoredLibraryState {
  state: LibrarySyncState;
  lastSeenAt: number;
}

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
  /** Deezer's track rank (QWW-37), from song_deezer; higher is more popular. */
  deezerRank?: number;
  /**
   * Which files the numbers came from: "karafun", "billboard" or "karafun+billboard"; "deezer"
   * when a song has only a Deezer rank.
   */
  source: string;
}

/** One Deezer lookup (QWW-37): the best-ranked matching track, or a miss (no rank). */
export interface SongDeezerRecord {
  /** songKey(artist, title). */
  key: string;
  rank?: number;
  deezerId?: number;
  /** ISO time of the lookup. */
  checkedAt: string;
}

import type { SongTempoRecord } from '../tempo/tempo';
export type { SongTempoRecord };

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
  /**
   * Up to `limit` stored (not skipped) song ranges whose song key sorts after `afterKey`, in key
   * order; pass the last key of one page to get the next. Empty when the table is done. For walking
   * every range, such as the octave fix.
   */
  listSongRangesPage(afterKey: string, limit: number): Promise<Map<string, SongRangeRecord>>;

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
  /**
   * Batch read; the map only has keys that have a row or a Deezer rank. Carries the song's Deezer
   * rank (song_deezer) as well.
   */
  getSongPopularity(songKeys: string[]): Promise<Map<string, SongPopularityRecord>>;

  // ---- Deezer track rank (QWW-37) ----
  /** Adds or replaces lookups; within one call the last entry for a key wins. */
  putSongDeezer(entries: SongDeezerRecord[]): Promise<void>;
  /** Every lookup, hits and misses, by song key. */
  listSongDeezer(): Promise<Map<string, SongDeezerRecord>>;

  // ---- Spotify rate-limit block (QWW-55) ----
  /**
   * Epoch ms until which Spotify has told the app to stop calling it (a 429's Retry-After), or null when it
   * has not. One value for the whole app, shared by every server instance and script: Spotify's quota is the
   * app's, not a user's.
   */
  getSpotifyBlock(): Promise<number | null>;
  /** Blocks Spotify until `until`. A later block wins; an earlier one never shortens it. */
  setSpotifyBlock(until: number): Promise<void>;

  // ---- stored Spotify library per user (QWW-55 PR 2) ----
  /** The sync state of a user's stored library, or null when none is stored. */
  getLibraryState(userId: string): Promise<StoredLibraryState | null>;
  /** Replaces the sync state and sets when the user was last seen (a visit). */
  putLibraryState(userId: string, state: LibrarySyncState, lastSeenAt: number): Promise<void>;
  /** The user's liked songs, newest first. */
  listSavedTracks(userId: string): Promise<Track[]>;
  /** Adds or replaces liked songs; `pos` orders them (higher = liked later). */
  putSavedTracks(userId: string, rows: { track: Track; pos: number; gen?: number }[]): Promise<void>;
  /** Marks stored liked songs as seen by the check pass `gen` (ids that are not stored are ignored). */
  markSavedSeen(userId: string, trackIds: string[], gen: number): Promise<void>;
  /** How many liked songs were seen by the check pass `gen` or a later one. */
  countSavedFromGen(userId: string, gen: number): Promise<number>;
  /** Removes the liked songs no check pass from `gen` on has seen: the ones un-liked on Spotify. */
  removeSavedBeforeGen(userId: string, gen: number): Promise<void>;
  /** Removes liked songs by track id (the ones un-liked on Spotify). */
  removeSavedTracks(userId: string, trackIds: string[]): Promise<void>;
  /** Deletes everything stored about the user's library (disconnect). */
  deleteUserLibrary(userId: string): Promise<void>;
  /** Deletes the library of every user not seen since `before` (epoch ms); returns how many users. */
  deleteIdleLibraries(before: number): Promise<number>;

  // ---- Spotify request counts (QWW-55 PR 2) ----
  /** Adds `n` Web API requests to the count for this UTC day ("2026-11-10") and caller. */
  addSpotifyCalls(day: string, caller: string, n: number): Promise<void>;
  /** The counts, newest day first; for one day when given. */
  listSpotifyCalls(day?: string): Promise<{ day: string; caller: string; calls: number }[]>;

  // ---- tempo (QWW-40) ----
  /** Adds rows, or sets the fields given on a key's row: a field left unset keeps its stored value. */
  putSongTempo(entries: SongTempoRecord[]): Promise<void>;
  /** Batch read; the map only has keys that have a row. */
  getSongTempos(songKeys: string[]): Promise<Map<string, SongTempoRecord>>;
  /** Every row, for the fill script's skip list. */
  listSongTempos(): Promise<Map<string, SongTempoRecord>>;
}

export const DEFAULT_LIST_LIMIT = 200;
