import type { DataSourceLogEntry, FeedbackEntry, SongRange, Track, VocalRange } from '../contracts';
import { catalogueRank, pickCatalogue } from '../songs/score';
import { isMeasured } from '../songs/sourceRank';
import {
  DEFAULT_EVENTS_LIMIT,
  DEFAULT_LIST_LIMIT,
  MAX_EVENTS_LIMIT,
  type CatalogueSong,
  type SongMoodsRecord,
  type SongDeezerRecord,
  type SongFeelRecord,
  type SongTempoRecord,
  type SongPopularityRecord,
  type SongRangeRecord,
  type Store,
  type StoredEvent,
  type StoredLibraryState,
  type UsdbIndexEntry,
  type UserRecord,
} from './store';

const clone = <T>(v: T): T => structuredClone(v);

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
  const songPopularity = new Map<string, SongPopularityRecord>();
  const songDeezer = new Map<string, SongDeezerRecord>();
  const songTempo = new Map<string, SongTempoRecord>();
  const songFeel = new Map<string, SongFeelRecord>();
  let spotifyBlock: number | null = null;
  const libraryStates = new Map<string, StoredLibraryState>();
  const savedTracks = new Map<string, Map<string, { track: Track; pos: number; gen: number }>>();
  const spotifyCalls = new Map<string, { day: string; caller: string; calls: number }>();
  /** A song's popularity row with its Deezer rank, as getSongPopularity reads it. */
  const popularityOf = (key: string): SongPopularityRecord | undefined => {
    const p = songPopularity.get(key);
    const rank = songDeezer.get(key)?.rank;
    if (rank === undefined) return p && clone(p);
    return { ...(p ? clone(p) : { key, source: 'deezer' }), deezerRank: rank };
  };

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
    async listSongRangesByArtist(artistKey) {
      const out = new Map<string, SongRangeRecord>();
      for (const [k, rec] of songs) if (k.startsWith(`${artistKey}|`) && rec.range) out.set(k, clone(rec));
      return out;
    },
    async listSongRangesPage(afterKey, limit) {
      const keys = [...songs.keys()].filter((k) => k > afterKey && songs.get(k)!.range).sort();
      return new Map(keys.slice(0, limit).map((k) => [k, clone(songs.get(k)!)]));
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
      const out: { key: string; rank: number; charted: boolean; song: CatalogueSong }[] = [];
      for (const [key, { range, log }] of songs) {
        // Measured ranges only. Artist estimates exist only because a tester's library had the song.
        if (!range || !isMeasured(range)) continue;
        const song: CatalogueSong = { key, artist: log.artist, title: log.title, range, log };
        const usdb = best.get(key);
        if (usdb) song.usdb = usdb;
        const popularity = popularityOf(key);
        out.push({ key, rank: catalogueRank(range, usdb, popularity), charted: popularity?.chartRank !== undefined, song });
      }
      return pickCatalogue(out, limit).map(({ song }) => clone(song));
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

    // ---- song popularity (QWW-6) ----
    async putSongPopularity(entries) {
      for (const e of entries) songPopularity.set(e.key, clone(e));
    },
    async getSongPopularity(songKeys) {
      const out = new Map<string, SongPopularityRecord>();
      for (const k of songKeys) {
        const p = popularityOf(k);
        if (p) out.set(k, p);
      }
      return out;
    },

    // ---- Deezer track rank (QWW-37) ----
    async putSongDeezer(entries) {
      for (const e of entries) songDeezer.set(e.key, clone(e));
    },
    async listSongDeezer() {
      return new Map([...songDeezer].map(([k, v]) => [k, clone(v)]));
    },

    // ---- Spotify rate-limit block (QWW-55) ----
    async getSpotifyBlock() {
      return spotifyBlock;
    },
    async setSpotifyBlock(until) {
      spotifyBlock = spotifyBlock === null ? until : Math.max(spotifyBlock, until);
    },

    // ---- stored Spotify library per user (QWW-55 PR 2) ----
    async getLibraryState(userId) {
      const s = libraryStates.get(userId);
      return s ? clone(s) : null;
    },
    async putLibraryState(userId, state, lastSeenAt) {
      libraryStates.set(userId, clone({ state, lastSeenAt }));
    },
    async listSavedTracks(userId) {
      return [...(savedTracks.get(userId)?.values() ?? [])].sort((a, b) => b.pos - a.pos).map((r) => clone(r.track));
    },
    async putSavedTracks(userId, rows) {
      const m = savedTracks.get(userId) ?? new Map();
      for (const r of rows) m.set(r.track.id, clone({ track: r.track, pos: r.pos, gen: r.gen ?? 0 }));
      savedTracks.set(userId, m);
    },
    async markSavedSeen(userId, trackIds, gen) {
      for (const id of trackIds) {
        const r = savedTracks.get(userId)?.get(id);
        if (r) r.gen = gen;
      }
    },
    async countSavedFromGen(userId, gen) {
      return [...(savedTracks.get(userId)?.values() ?? [])].filter((r) => r.gen >= gen).length;
    },
    async removeSavedBeforeGen(userId, gen) {
      const m = savedTracks.get(userId);
      for (const [id, r] of m ?? []) if (r.gen < gen) m!.delete(id);
    },
    async removeSavedTracks(userId, trackIds) {
      for (const id of trackIds) savedTracks.get(userId)?.delete(id);
    },
    async deleteUserLibrary(userId) {
      libraryStates.delete(userId);
      savedTracks.delete(userId);
    },
    async deleteIdleLibraries(before) {
      let n = 0;
      for (const [id, s] of libraryStates) {
        if (s.lastSeenAt >= before) continue;
        libraryStates.delete(id);
        savedTracks.delete(id);
        n++;
      }
      return n;
    },

    // ---- Spotify request counts (QWW-55 PR 2) ----
    async addSpotifyCalls(day, caller, n) {
      const k = JSON.stringify([day, caller]);
      spotifyCalls.set(k, { day, caller, calls: (spotifyCalls.get(k)?.calls ?? 0) + n });
    },
    async listSpotifyCalls(day) {
      return [...spotifyCalls.values()]
        .filter((r) => day === undefined || r.day === day)
        .sort((a, b) => b.day.localeCompare(a.day) || a.caller.localeCompare(b.caller))
        .map((r) => ({ ...r }));
    },

    // ---- tempo (QWW-40) ----
    async putSongTempo(entries) {
      for (const e of entries) {
        const given = Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined));
        songTempo.set(e.key, { ...songTempo.get(e.key), ...clone(given) } as SongTempoRecord);
      }
    },
    async getSongTempos(songKeys) {
      const out = new Map<string, SongTempoRecord>();
      for (const k of songKeys) {
        const t = songTempo.get(k);
        if (t) out.set(k, clone(t));
      }
      return out;
    },
    async listSongTempos() {
      return new Map([...songTempo].map(([k, v]) => [k, clone(v)]));
    },

    // ---- feel labels (QWW-54) ----
    async putSongFeel(entries) {
      for (const e of entries) songFeel.set(e.key, clone(e));
    },
    async getSongFeels(songKeys) {
      const out = new Map<string, SongFeelRecord>();
      for (const k of songKeys) {
        const f = songFeel.get(k);
        if (f) out.set(k, clone(f));
      }
      return out;
    },
    async listSongFeels() {
      return new Map([...songFeel].map(([k, v]) => [k, clone(v)]));
    },
  };
}
