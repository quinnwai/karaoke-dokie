-- karaoke-dokie schema. Kept identical to SCHEMA_SQL in src/lib/server/schema.ts (a test checks this).
-- Every statement is idempotent; migrate() runs them one at a time at startup.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS vocal_ranges (
  user_id TEXT PRIMARY KEY,
  low INTEGER NOT NULL,
  high INTEGER NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS song_ranges (
  song_key TEXT PRIMARY KEY,
  skipped BOOLEAN NOT NULL,
  range_json TEXT,
  log_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_log (
  id BIGSERIAL PRIMARY KEY,
  track_id TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS source_log_at ON source_log (at);
CREATE TABLE IF NOT EXISTS feedback (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  thumbs TEXT NOT NULL,
  user_low INTEGER NOT NULL,
  user_high INTEGER NOT NULL,
  user_range_source TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  octave TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_user ON feedback (user_id);
CREATE TABLE IF NOT EXISTS usdb_songs (
  id INTEGER PRIMARY KEY,
  song_key TEXT NOT NULL,
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  views INTEGER,
  rating DOUBLE PRECISION,
  last_change BIGINT
);
CREATE INDEX IF NOT EXISTS usdb_songs_key ON usdb_songs (song_key);
