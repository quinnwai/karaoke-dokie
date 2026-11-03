import type { DataSourceLogEntry, FeedbackEntry, SongRange, VocalRange } from '../contracts';
import { isMeasured } from '../songs/sourceRank';
import {
  DEFAULT_EVENTS_LIMIT,
  DEFAULT_LIST_LIMIT,
  MAX_EVENTS_LIMIT,
  type CatalogueSong,
  type SongMoodsRecord,
  type SongRangeRecord,
  type Store,
  type StoredEvent,
  type UsdbIndexEntry,
  type UserRecord,
} from './store';

const clone = <T>(v: T): T => structuredClone(v);

/** Catalogue order: songs with a USDB row first, most views then most stars; then the rest by key. */
function byCatalogueOrder(a: CatalogueSong, b: CatalogueSong): number {
  return (
    Number(!a.usdb) - Number(!b.usdb) ||
    (b.usdb?.views ?? 0) - (a.usdb?.views ?? 0) ||
    (b.usdb?.rating ?? 0) - (a.usdb?.rating ?? 0) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/** In-process store. Everything is copied in and out so callers cannot mutate stored data. */
export function createMemoryStore(): Store {
  const users = new Map<string, UserRecord>();
  const ranges = new Map<string, VocalRange>();
  const songs = new Map<string, SongRangeRecord>();
  const log: DataSourceLogEntry[] = [];
  const feedback: FeedbackEntry[] = [];
  const usdbSongs = new Map<number, UsdbIndexEntry>();
  const events: StoredEvent[] = [];
  const songMoods = new Map<string, SongMoodsRecord>();

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
    async listUserIds() {
      return [...users.keys()];
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
    async listMeasuredRangesByArtist(artistKey) {
      const out: SongRange[] = [];
      for (const [k, rec] of songs) {
        if (k.startsWith(`${artistKey}|`) && rec.range && isMeasured(rec.range)) out.push(clone(rec.range));
      }
      return out;
    },
    async putUsdbSongs(entries) {
      for (const e of entries) usdbSongs.set(e.id, clone(e));
    },
    async findUsdbSongs(songKeys) {
      const wanted = new Set(songKeys);
      const out = new Map<string, UsdbIndexEntry>();
      for (const e of usdbSongs.values()) {
        if (!wanted.has(e.key)) continue;
        const best = out.get(e.key);
        if (!best || (e.views ?? 0) > (best.views ?? 0)) out.set(e.key, clone(e));
      }
      return out;
    },
    async listUsdbSongs() {
      return [...usdbSongs.values()].sort((a, b) => (b.views ?? 0) - (a.views ?? 0) || a.id - b.id).map(clone);
    },
    async usdbIndexStats() {
      let newest: number | null = null;
      for (const e of usdbSongs.values()) if (e.lastChange !== undefined && (newest === null || e.lastChange > newest)) newest = e.lastChange;
      return { count: usdbSongs.size, newestChange: newest };
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
    // ---- catalogue (QWW-2 Track B) ----
    async listCatalogue(limit) {
      // The most-viewed USDB row per key, as findUsdbSongs picks it; a tie goes to the lower id.
      const best = new Map<string, UsdbIndexEntry>();
      for (const e of usdbSongs.values()) {
        const b = best.get(e.key);
        const more = (e.views ?? 0) - (b?.views ?? 0);
        if (!b || more > 0 || (more === 0 && e.id < b.id)) best.set(e.key, e);
      }
      const out: CatalogueSong[] = [];
      for (const [key, { range, log }] of songs) {
        // Measured ranges only. Artist estimates exist only because a tester's library had the song.
        if (!range || !isMeasured(range)) continue;
        const song: CatalogueSong = { key, artist: log.artist, title: log.title, range, log };
        const usdb = best.get(key);
        if (usdb) song.usdb = usdb;
        out.push(song);
      }
      return out.sort(byCatalogueOrder).slice(0, limit).map(clone);
    },

    // ---- beta event log (QWW-16) ----
    async appendEvents(anonId, list) {
      // Only the fields the Postgres table keeps, so both stores read back the same thing.
      for (const e of list) {
        const stored: StoredEvent = { anonId, name: e.name, at: e.at };
        if (e.props) stored.props = clone(e.props);
        events.push(stored);
      }
    },
    async listEvents(opts = {}) {
      const items = opts.anonId ? events.filter((e) => e.anonId === opts.anonId) : events;
      const limit = Math.min(opts.limit ?? DEFAULT_EVENTS_LIMIT, MAX_EVENTS_LIMIT);
      return newestFirst(items).slice(0, limit).reverse().map(clone);
    },

    // ---- mood labels (QWW-11) ----
    async putSongMoods(entries) {
      for (const e of entries) songMoods.set(e.key, clone(e));
    },
    async getSongMoods(songKeys) {
      const out = new Map<string, SongMoodsRecord>();
      for (const k of songKeys) {
        const m = songMoods.get(k);
        if (m) out.set(k, clone(m));
      }
      return out;
    },
  };
}
