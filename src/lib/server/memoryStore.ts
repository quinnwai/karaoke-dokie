import type { DataSourceLogEntry, FeedbackEntry, VocalRange } from '../contracts';
import { DEFAULT_LIST_LIMIT, type SongRangeRecord, type Store, type UserRecord } from './store';

const clone = <T>(v: T): T => structuredClone(v);

/** In-process store. Everything is copied in and out so callers cannot mutate stored data. */
export function createMemoryStore(): Store {
  const users = new Map<string, UserRecord>();
  const ranges = new Map<string, VocalRange>();
  const songs = new Map<string, SongRangeRecord>();
  const log: DataSourceLogEntry[] = [];
  const feedback: FeedbackEntry[] = [];

  const newestFirst = <T extends { at: string }>(items: T[]): T[] =>
    items
      .map((item, i) => ({ item, i }))
      .sort((a, b) => (a.item.at === b.item.at ? b.i - a.i : a.item.at < b.item.at ? 1 : -1))
      .map(({ item }) => item);

  return {
    async getUser(id) {
      const u = users.get(id);
      return u ? clone(u) : null;
    },
    async upsertUser(user) {
      users.set(user.id, clone(user));
    },
    async saveRange(userId, range) {
      ranges.set(userId, clone(range));
    },
    async getRange(userId) {
      const r = ranges.get(userId);
      return r ? clone(r) : null;
    },
    async getSongRange(songKey) {
      const s = songs.get(songKey);
      return s ? clone(s) : null;
    },
    async getSongRanges(songKeys) {
      const out = new Map<string, SongRangeRecord>();
      for (const k of songKeys) {
        const s = songs.get(k);
        if (s) out.set(k, clone(s));
      }
      return out;
    },
    async putSongRange(songKey, record) {
      songs.set(songKey, clone(record));
    },
    async appendLog(entry) {
      log.push(clone(entry));
    },
    async listLog(limit = DEFAULT_LIST_LIMIT) {
      return newestFirst(log).slice(0, limit).map(clone);
    },
    async saveFeedback(entry) {
      feedback.push(clone(entry));
    },
    async listFeedback(opts = {}) {
      const items = opts.userId ? feedback.filter((f) => f.userId === opts.userId) : feedback;
      return newestFirst(items).slice(0, opts.limit ?? DEFAULT_LIST_LIMIT).map(clone);
    },
  };
}
