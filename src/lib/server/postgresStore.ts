// Postgres store using raw SQL through an injected query function, so the same code
// runs on Neon (production) and pg-mem (tests).
import type { DataSourceLogEntry, FeedbackEntry, Mood, SongRange, VocalRange } from '../contracts';
import { catalogueRank, pickCatalogue } from '../songs/score';
import { isMeasured, MEASURED_RANK, SOURCE_RANK } from '../songs/sourceRank';
import { SCHEMA_SQL } from './schema';
import {
  DEFAULT_EVENTS_LIMIT,
  DEFAULT_LIST_LIMIT,
  MAX_EVENTS_LIMIT,
  type CatalogueSong,
  type SongMoodsRecord,
  type SongPopularityRecord,
  type SongRangeRecord,
  type Store,
  type StoredEvent,
  type UsdbIndexEntry,
  type UserRecord,
} from './store';

export type Row = Record<string, unknown>;
export type QueryFn = (text: string, params?: unknown[]) => Promise<Row[]>;

/** Splits the schema into single statements (Neon's HTTP driver runs one per call). */
export function schemaStatements(schema: string = SCHEMA_SQL): string[] {
  return schema
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Creates the tables. Idempotent on real Postgres. */
export async function migrate(query: QueryFn): Promise<void> {
  for (const stmt of schemaStatements()) await query(stmt);
}

const str = (v: unknown): string => String(v);
const num = (v: unknown): number => Number(v);

function toUser(r: Row): UserRecord {
  return {
    id: str(r.id),
    displayName: str(r.display_name),
    spotify: {
      accessToken: str(r.access_token),
      refreshToken: str(r.refresh_token),
      expiresAt: num(r.expires_at),
    },
  };
}

function toSongRecord(r: Row): SongRangeRecord {
  return {
    range: r.skipped || r.range_json == null ? null : JSON.parse(str(r.range_json)),
    log: JSON.parse(str(r.log_json)),
  };
}

function toUsdbEntry(r: Row): UsdbIndexEntry {
  const e: UsdbIndexEntry = { id: num(r.id), key: str(r.song_key), artist: str(r.artist), title: str(r.title) };
  if (r.views !== null && r.views !== undefined) e.views = num(r.views);
  if (r.rating !== null && r.rating !== undefined) e.rating = num(r.rating);
  if (r.last_change !== null && r.last_change !== undefined) e.lastChange = num(r.last_change);
  if (r.year !== null && r.year !== undefined) e.year = num(r.year);
  if (r.genre !== null && r.genre !== undefined) e.genre = str(r.genre);
  if (r.language !== null && r.language !== undefined) e.language = str(r.language);
  return e;
}

function toLog(r: Row): DataSourceLogEntry {
  return {
    trackId: str(r.track_id),
    title: str(r.title),
    artist: str(r.artist),
    outcome: str(r.outcome) as DataSourceLogEntry['outcome'],
    reason: str(r.reason),
    at: str(r.at),
  };
}

const isSet = (v: unknown) => v !== null && v !== undefined;

function toFeedback(r: Row): FeedbackEntry {
  const f: FeedbackEntry = {
    userId: str(r.user_id),
    trackId: str(r.track_id),
    thumbs: str(r.thumbs) as FeedbackEntry['thumbs'],
    userRange: {
      low: num(r.user_low),
      high: num(r.user_high),
      source: str(r.user_range_source) as VocalRange['source'],
    },
    difficulty: str(r.difficulty) as FeedbackEntry['difficulty'],
    octave: str(r.octave) as FeedbackEntry['octave'],
    at: str(r.at),
  };
  if (isSet(r.range_source)) {
    const s: NonNullable<FeedbackEntry['songRange']> = { source: str(r.range_source) as DataSourceLogEntry['outcome'] };
    if (isSet(r.range_method)) s.method = str(r.range_method);
    if (isSet(r.range_low)) s.low = num(r.range_low);
    if (isSet(r.range_high)) s.high = num(r.range_high);
    f.songRange = s;
  }
  if (isSet(r.view_json)) f.view = JSON.parse(str(r.view_json));
  return f;
}

function toEvent(r: Row): StoredEvent {
  const e: StoredEvent = { anonId: str(r.anon_id), name: str(r.name), at: str(r.at) };
  if (isSet(r.props_json)) e.props = JSON.parse(str(r.props_json));
  return e;
}

/** Range sources measured from the song itself (note files, recordings): the catalogue's rows. */
const MEASURED_SOURCES = Object.entries(SOURCE_RANK)
  .filter(([, rank]) => rank >= MEASURED_RANK)
  .map(([source]) => source);

function toSongMoods(r: Row): SongMoodsRecord {
  return {
    key: str(r.song_key),
    moods: str(r.moods).split(',').filter(Boolean) as Mood[],
    method: str(r.method),
    source: str(r.source),
  };
}

function toSongPopularity(r: Row): SongPopularityRecord {
  const p: SongPopularityRecord = { key: str(r.song_key), source: str(r.source) };
  if (isSet(r.karaoke_views)) p.karaokeViews = num(r.karaoke_views);
  if (isSet(r.chart_rank)) p.chartRank = num(r.chart_rank);
  if (isSet(r.chart_year)) p.chartYear = num(r.chart_year);
  return p;
}

export interface PostgresStoreOptions {
  /** Run migrate() before the first query (default true). */
  autoMigrate?: boolean;
}

export function createPostgresStore(rawQuery: QueryFn, opts: PostgresStoreOptions = {}): Store {
  let ready: Promise<void> | null = opts.autoMigrate === false ? Promise.resolve() : null;
  const query: QueryFn = async (text, params) => {
    if (!ready) {
      ready = migrate(rawQuery).catch((err) => {
        ready = null; // retry on the next request
        throw err;
      });
    }
    await ready;
    return rawQuery(text, params);
  };

  return {
    async getUser(id) {
      const rows = await query('SELECT * FROM users WHERE id = $1', [id]);
      return rows[0] ? toUser(rows[0]) : null;
    },
    async upsertUser(u) {
      await query(
        `INSERT INTO users (id, display_name, access_token, refresh_token, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name,
           access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
           expires_at = EXCLUDED.expires_at`,
        [u.id, u.displayName, u.spotify.accessToken, u.spotify.refreshToken, u.spotify.expiresAt],
      );
    },
    async saveRange(userId, r) {
      await query(
        `INSERT INTO vocal_ranges (user_id, low, high, source) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET low = EXCLUDED.low, high = EXCLUDED.high, source = EXCLUDED.source`,
        [userId, r.low, r.high, r.source],
      );
    },
    async getRange(userId) {
      const rows = await query('SELECT * FROM vocal_ranges WHERE user_id = $1', [userId]);
      const r = rows[0];
      return r ? { low: num(r.low), high: num(r.high), source: str(r.source) as VocalRange['source'] } : null;
    },
    async getSongRange(songKey) {
      const rows = await query('SELECT * FROM song_ranges WHERE song_key = $1', [songKey]);
      return rows[0] ? toSongRecord(rows[0]) : null;
    },
    async getSongRanges(songKeys) {
      const out = new Map<string, SongRangeRecord>();
      const unique = [...new Set(songKeys)];
      // IN lists rather than ANY($1): pg-mem does not support array parameters.
      for (let i = 0; i < unique.length; i += 200) {
        const chunk = unique.slice(i, i + 200);
        const placeholders = chunk.map((_, j) => `$${j + 1}`).join(', ');
        const rows = await query(`SELECT * FROM song_ranges WHERE song_key IN (${placeholders})`, chunk);
        for (const r of rows) out.set(str(r.song_key), toSongRecord(r));
      }
      return out;
    },
    async putSongRange(songKey, rec) {
      await query(
        `INSERT INTO song_ranges (song_key, skipped, range_json, log_json) VALUES ($1, $2, $3, $4)
         ON CONFLICT (song_key) DO UPDATE SET skipped = EXCLUDED.skipped,
           range_json = EXCLUDED.range_json, log_json = EXCLUDED.log_json`,
        [songKey, rec.range === null, rec.range === null ? null : JSON.stringify(rec.range), JSON.stringify(rec.log)],
      );
    },
    async listUserIds() {
      return (await query(`SELECT id FROM users ORDER BY id`, [])).map((r) => str(r.id));
    },
    async listMeasuredRangesByArtist(artistKey) {
      // LIKE narrows the scan; the exact prefix check below guards against % or _ in names.
      const rows = await query(`SELECT * FROM song_ranges WHERE song_key LIKE $1 AND skipped = false`, [`${artistKey}|%`]);
      return rows
        .filter((r) => str(r.song_key).startsWith(`${artistKey}|`))
        .map((r) => toSongRecord(r).range)
        .filter((r): r is SongRange => r !== null && isMeasured(r));
    },
    async listSongRangesByArtist(artistKey) {
      const rows = await query(`SELECT * FROM song_ranges WHERE song_key LIKE $1 AND skipped = false`, [`${artistKey}|%`]);
      const out = new Map<string, SongRangeRecord>();
      for (const r of rows) {
        const key = str(r.song_key);
        const rec = toSongRecord(r);
        if (key.startsWith(`${artistKey}|`) && rec.range) out.set(key, rec);
      }
      return out;
    },
    async putUsdbSongs(entries) {
      // Multi-row inserts, 100 at a time, so a full index (about 32k songs) is a few hundred queries.
      for (let i = 0; i < entries.length; i += 100) {
        const chunk = entries.slice(i, i + 100);
        const params: unknown[] = [];
        const rows = chunk.map((e) => {
          const values = [e.id, e.key, e.artist, e.title, e.views ?? null, e.rating ?? null, e.lastChange ?? null, e.year ?? null, e.genre ?? null, e.language ?? null];
          const first = params.length + 1;
          params.push(...values);
          return `(${values.map((_, j) => `$${first + j}`).join(', ')})`;
        });
        await query(
          `INSERT INTO usdb_songs (id, song_key, artist, title, views, rating, last_change, year, genre, language) VALUES ${rows.join(', ')}
           ON CONFLICT (id) DO UPDATE SET song_key = EXCLUDED.song_key, artist = EXCLUDED.artist, title = EXCLUDED.title,
             views = EXCLUDED.views, rating = EXCLUDED.rating, last_change = EXCLUDED.last_change,
             year = EXCLUDED.year, genre = EXCLUDED.genre, language = EXCLUDED.language`,
          params,
        );
      }
    },
    async findUsdbSongs(songKeys) {
      const out = new Map<string, UsdbIndexEntry>();
      const unique = [...new Set(songKeys)];
      for (let i = 0; i < unique.length; i += 200) {
        const chunk = unique.slice(i, i + 200);
        const placeholders = chunk.map((_, j) => `$${j + 1}`).join(', ');
        const rows = await query(`SELECT * FROM usdb_songs WHERE song_key IN (${placeholders})`, chunk);
        for (const r of rows) {
          const e = toUsdbEntry(r);
          const best = out.get(e.key);
          if (!best || (e.views ?? 0) > (best.views ?? 0)) out.set(e.key, e);
        }
      }
      return out;
    },
    async listUsdbSongs() {
      return (await query('SELECT * FROM usdb_songs ORDER BY COALESCE(views, 0) DESC, id ASC', [])).map(toUsdbEntry);
    },
    async usdbIndexStats() {
      const [r] = await query('SELECT COUNT(*) AS n, MAX(last_change) AS newest FROM usdb_songs', []);
      return { count: num(r?.n ?? 0), newestChange: r?.newest === null || r?.newest === undefined ? null : num(r.newest) };
    },
    async appendLog(e) {
      await query(
        `INSERT INTO source_log (track_id, title, artist, outcome, reason, at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [e.trackId, e.title, e.artist, e.outcome, e.reason, e.at],
      );
    },
    async listLog(limit = DEFAULT_LIST_LIMIT) {
      const rows = await query('SELECT * FROM source_log ORDER BY at DESC, id DESC LIMIT $1', [limit]);
      return rows.map(toLog);
    },
    async saveFeedback(f) {
      const s = f.songRange;
      await query(
        `INSERT INTO feedback (user_id, track_id, thumbs, user_low, user_high, user_range_source, difficulty, octave, at,
           range_source, range_method, range_low, range_high, view_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          f.userId, f.trackId, f.thumbs, f.userRange.low, f.userRange.high, f.userRange.source, f.difficulty, f.octave, f.at,
          s?.source ?? null, s?.method ?? null, s?.low ?? null, s?.high ?? null, f.view ? JSON.stringify(f.view) : null,
        ],
      );
    },
    async listFeedback(o = {}) {
      const limit = o.limit ?? DEFAULT_LIST_LIMIT;
      const rows = o.userId
        ? await query('SELECT * FROM feedback WHERE user_id = $1 ORDER BY at DESC, id DESC LIMIT $2', [o.userId, limit])
        : await query('SELECT * FROM feedback ORDER BY at DESC, id DESC LIMIT $1', [limit]);
      return rows.map(toFeedback);
    },
    // ---- catalogue (QWW-2 Track B) ----
    async listCatalogue(limit) {
      // Three steps, so no response carries thousands of ranges (the table can hold tens of
      // thousands; one query for 6,000 songs would be about 6 MB). First a few numbers for every
      // measured song: the range's own USDB views, its most-viewed USDB row's (DISTINCT
      // ON; a tie goes to the lower id) and its karaoke popularity. Those are ranked here with
      // catalogueRank, the formula the catalogue scores with (SQL would need a copy of it), and cut
      // to the limit, keeping every Year-End song (pickCatalogue). Then the chosen songs' ranges and log lines, and their USDB rows, 1,000 a
      // query, all at once. Artist estimates stay out: they exist only because a tester's library had the song.
      // The join is on `b.song_key || ''` because pg-mem otherwise reads usdb_songs through its
      // song_key index and skips the DISTINCT ON.
      const sources = MEASURED_SOURCES.map((_, i) => `$${i + 1}`).join(', ');
      const candidates = await query(
        `SELECT s.song_key, s.range_json::json ->> 'usdbViews' AS range_views,
           b.id AS usdb_id, b.views, p.karaoke_views, p.chart_rank
         FROM song_ranges s
         LEFT JOIN (SELECT DISTINCT ON (song_key) song_key, id, views FROM usdb_songs ORDER BY song_key, COALESCE(views, 0) DESC, id) b
           ON (b.song_key || '') = s.song_key
         LEFT JOIN song_popularity p ON p.song_key = s.song_key
         WHERE s.skipped = false AND (s.range_json::json ->> 'source') IN (${sources})`,
        MEASURED_SOURCES,
      );
      const opt = (v: unknown): number | undefined => (isSet(v) ? num(v) : undefined);
      const chosen = pickCatalogue(
        candidates.map((r) => ({
          key: str(r.song_key),
          usdbId: opt(r.usdb_id),
          rank: catalogueRank(
            { usdbViews: opt(r.range_views) },
            { views: opt(r.views) },
            { karaokeViews: opt(r.karaoke_views), chartRank: opt(r.chart_rank) },
          ),
          charted: isSet(r.chart_rank),
        })),
        Math.max(0, limit),
      );
      const inList = (n: number) => Array.from({ length: n }, (_, j) => `$${j + 1}`).join(', ');
      const records = new Map<string, SongRangeRecord>();
      const usdbRows = new Map<number, UsdbIndexEntry>();
      const chunks: (typeof chosen)[] = [];
      for (let i = 0; i < chosen.length; i += 1000) chunks.push(chosen.slice(i, i + 1000));
      // Every chunk's reads at once: each is its own request to Neon, so this takes about as long as one.
      await Promise.all(
        chunks.map(async (chunk) => {
          const keys = chunk.map((c) => c.key);
          const ids = chunk.flatMap((c) => (c.usdbId === undefined ? [] : [c.usdbId]));
          const [ranges, usdb] = await Promise.all([
            query(`SELECT * FROM song_ranges WHERE song_key IN (${inList(keys.length)})`, keys),
            ids.length ? query(`SELECT * FROM usdb_songs WHERE id IN (${inList(ids.length)})`, ids) : [],
          ]);
          for (const r of ranges) records.set(str(r.song_key), toSongRecord(r));
          for (const r of usdb) usdbRows.set(num(r.id), toUsdbEntry(r));
        }),
      );
      const out: CatalogueSong[] = [];
      for (const { key, usdbId } of chosen) {
        const { range, log } = records.get(key) ?? {};
        if (!range || !log || !isMeasured(range)) continue; // replaced between the reads
        const song: CatalogueSong = { key, artist: log.artist, title: log.title, range, log };
        const usdb = usdbId === undefined ? undefined : usdbRows.get(usdbId);
        if (usdb) song.usdb = usdb;
        out.push(song);
      }
      return out;
    },

    // ---- beta event log (QWW-16) ----
    async appendEvents(anonId, events) {
      // One multi-row insert per 100 events (a request carries at most 50). Rows get ids in
      // VALUES order, which keeps events with the same time in the order they arrived.
      for (let i = 0; i < events.length; i += 100) {
        const params: unknown[] = [];
        const rows = events.slice(i, i + 100).map((e) => {
          params.push(anonId, e.name, e.at, e.props ? JSON.stringify(e.props) : null);
          const n = params.length;
          return `($${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
        });
        await query(`INSERT INTO events (anon_id, name, at, props_json) VALUES ${rows.join(', ')}`, params);
      }
    },
    async listEvents(o = {}) {
      const limit = Math.min(o.limit ?? DEFAULT_EVENTS_LIMIT, MAX_EVENTS_LIMIT);
      // The newest `limit` rows, turned back to oldest first.
      const rows = o.anonId
        ? await query('SELECT * FROM events WHERE anon_id = $1 ORDER BY at DESC, id DESC LIMIT $2', [o.anonId, limit])
        : await query('SELECT * FROM events ORDER BY at DESC, id DESC LIMIT $1', [limit]);
      return rows.reverse().map(toEvent);
    },

    // ---- mood labels (QWW-11) ----
    async putSongMoods(entries) {
      // One row per key, the last entry winning as in the memory store: Postgres refuses an
      // upsert that touches the same row twice in one statement.
      const unique = [...new Map(entries.map((e) => [e.key, e])).values()];
      for (let i = 0; i < unique.length; i += 100) {
        const chunk = unique.slice(i, i + 100);
        const params: unknown[] = [];
        const rows = chunk.map((e) => {
          params.push(e.key, e.moods.join(','), e.method, e.source);
          const n = params.length;
          return `($${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
        });
        await query(
          `INSERT INTO song_moods (song_key, moods, method, source) VALUES ${rows.join(', ')}
           ON CONFLICT (song_key) DO UPDATE SET moods = EXCLUDED.moods, method = EXCLUDED.method, source = EXCLUDED.source`,
          params,
        );
      }
    },
    async getSongMoods(songKeys) {
      const out = new Map<string, SongMoodsRecord>();
      const unique = [...new Set(songKeys)];
      for (let i = 0; i < unique.length; i += 200) {
        const chunk = unique.slice(i, i + 200);
        const placeholders = chunk.map((_, j) => `$${j + 1}`).join(', ');
        const rows = await query(`SELECT * FROM song_moods WHERE song_key IN (${placeholders})`, chunk);
        for (const r of rows) out.set(str(r.song_key), toSongMoods(r));
      }
      return out;
    },

    // ---- song popularity (QWW-6) ----
    async putSongPopularity(entries) {
      // One row per key, the last entry winning, as for mood labels.
      const unique = [...new Map(entries.map((e) => [e.key, e])).values()];
      for (let i = 0; i < unique.length; i += 100) {
        const params: unknown[] = [];
        const rows = unique.slice(i, i + 100).map((e) => {
          params.push(e.key, e.karaokeViews ?? null, e.chartYear ?? null, e.chartRank ?? null, e.source);
          const n = params.length;
          return `($${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
        });
        await query(
          `INSERT INTO song_popularity (song_key, karaoke_views, chart_year, chart_rank, source) VALUES ${rows.join(', ')}
           ON CONFLICT (song_key) DO UPDATE SET karaoke_views = EXCLUDED.karaoke_views, chart_year = EXCLUDED.chart_year,
             chart_rank = EXCLUDED.chart_rank, source = EXCLUDED.source`,
          params,
        );
      }
    },
    async getSongPopularity(songKeys) {
      // 1,000 keys a query: the catalogue asks for all of its songs at once.
      const out = new Map<string, SongPopularityRecord>();
      const unique = [...new Set(songKeys)];
      for (let i = 0; i < unique.length; i += 1000) {
        const chunk = unique.slice(i, i + 1000);
        const placeholders = chunk.map((_, j) => `$${j + 1}`).join(', ');
        const rows = await query(`SELECT * FROM song_popularity WHERE song_key IN (${placeholders})`, chunk);
        for (const r of rows) out.set(str(r.song_key), toSongPopularity(r));
      }
      return out;
    },
  };
}
