// Postgres store using raw SQL through an injected query function, so the same code
// runs on Neon (production) and pg-mem (tests).
import type { DataSourceLogEntry, FeedbackEntry, SongRange, VocalRange } from '../contracts';
import { SCHEMA_SQL } from './schema';
import { DEFAULT_LIST_LIMIT, type SongRangeRecord, type Store, type UserRecord } from './store';

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

function toFeedback(r: Row): FeedbackEntry {
  return {
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
    async listNoteFileRangesByArtist(artistKey) {
      // LIKE narrows the scan; the exact prefix check below guards against % or _ in names.
      const rows = await query(`SELECT * FROM song_ranges WHERE song_key LIKE $1 AND skipped = false`, [`${artistKey}|%`]);
      return rows
        .filter((r) => str(r.song_key).startsWith(`${artistKey}|`))
        .map((r) => toSongRecord(r).range)
        .filter((r): r is SongRange => r !== null && r.source === 'note-file');
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
      await query(
        `INSERT INTO feedback (user_id, track_id, thumbs, user_low, user_high, user_range_source, difficulty, octave, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [f.userId, f.trackId, f.thumbs, f.userRange.low, f.userRange.high, f.userRange.source, f.difficulty, f.octave, f.at],
      );
    },
    async listFeedback(o = {}) {
      const limit = o.limit ?? DEFAULT_LIST_LIMIT;
      const rows = o.userId
        ? await query('SELECT * FROM feedback WHERE user_id = $1 ORDER BY at DESC, id DESC LIMIT $2', [o.userId, limit])
        : await query('SELECT * FROM feedback ORDER BY at DESC, id DESC LIMIT $1', [limit]);
      return rows.map(toFeedback);
    },
  };
}
