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
-- The song's range at the time of the tap (its source is the log outcome). Added after launch,
-- so nullable and added to existing tables here.
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS range_source TEXT;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS range_method TEXT;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS range_low DOUBLE PRECISION;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS range_high DOUBLE PRECISION;
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
-- QWW-3 (Nov 2026). Year, genre and language from USDB's song list (QWW-6).
ALTER TABLE usdb_songs ADD COLUMN IF NOT EXISTS year INTEGER;
ALTER TABLE usdb_songs ADD COLUMN IF NOT EXISTS genre TEXT;
ALTER TABLE usdb_songs ADD COLUMN IF NOT EXISTS language TEXT;
-- The results view a thumbs tap came from (QWW-16).
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS view_json TEXT;
-- Beta event log, keyed by a random device id, never a Spotify id (QWW-16, QWW-20).
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  anon_id TEXT NOT NULL,
  name TEXT NOT NULL,
  at TEXT NOT NULL,
  props_json TEXT
);
CREATE INDEX IF NOT EXISTS events_anon ON events (anon_id);
CREATE INDEX IF NOT EXISTS events_at ON events (at);
-- Mood labels per song, one labelling method per row (QWW-11).
CREATE TABLE IF NOT EXISTS song_moods (
  song_key TEXT PRIMARY KEY,
  moods TEXT NOT NULL,
  method TEXT NOT NULL,
  source TEXT NOT NULL
);
-- Song popularity from our own karaoke data (QWW-6): KaraFun karaoke-video views and the best
-- Billboard Year-End Hot 100 rank and its year, written by npm run popularity:import.
CREATE TABLE IF NOT EXISTS song_popularity (
  song_key TEXT PRIMARY KEY,
  karaoke_views BIGINT,
  chart_year INTEGER,
  chart_rank INTEGER,
  source TEXT NOT NULL
);
