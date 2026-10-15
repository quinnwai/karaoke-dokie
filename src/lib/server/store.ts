// Persistence interface for the backend. Two implementations:
// memoryStore.ts (dev, tests, e2e) and postgresStore.ts (Neon in production, pg-mem in tests).
import type { DataSourceLogEntry, FeedbackEntry, SongRange, VocalRange } from '../contracts';

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
  /** Ranges read from note files for one artist (the artist part of songKey), for the artist fallback. */
  listNoteFileRangesByArtist(artistKey: string): Promise<SongRange[]>;

  /** Adds or updates songs in the USDB song index. */
  putUsdbSongs(entries: UsdbIndexEntry[]): Promise<void>;
  /** The most-viewed indexed USDB song for each key; the map only has keys that are indexed. */
  findUsdbSongs(songKeys: string[]): Promise<Map<string, UsdbIndexEntry>>;
  /** Size of the USDB index and its newest last-changed time (null when empty). */
  usdbIndexStats(): Promise<{ count: number; newestChange: number | null }>;

  appendLog(entry: DataSourceLogEntry): Promise<void>;
  /** Newest first. */
  listLog(limit?: number): Promise<DataSourceLogEntry[]>;

  saveFeedback(entry: FeedbackEntry): Promise<void>;
  /** Newest first, optionally for one user. */
  listFeedback(opts?: { userId?: string; limit?: number }): Promise<FeedbackEntry[]>;
}

export const DEFAULT_LIST_LIMIT = 200;
