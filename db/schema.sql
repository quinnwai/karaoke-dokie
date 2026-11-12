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
-- When the singer sang the account's range, in milliseconds since 1970 (QWW-66): the range sung last is the one kept, so
-- signing in on a device with a newer range replaces the account's, and an older device range does not. Null on a range saved before this was recorded.
ALTER TABLE vocal_ranges ADD COLUMN IF NOT EXISTS measured_at BIGINT;
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
-- Deezer track rank per song (QWW-37), written by npm run popularity:deezer. Its own table, so
-- popularity:import, which replaces whole song_popularity rows, leaves it alone. A null rank is a
-- miss: Deezer had no matching track when checked_at, so a rerun skips it for a while.
CREATE TABLE IF NOT EXISTS song_deezer (
  song_key TEXT PRIMARY KEY,
  rank INTEGER,
  deezer_id BIGINT,
  checked_at TEXT NOT NULL
);
-- Tempo per song (QWW-40), one column per source, written by npm run tempo:fill (Deezer, beat
-- tracker) and npm run tempo:ultrastar (note files). Raw values: the one tempo shown is worked out
-- when read (src/lib/tempo/tempo.ts). A row with no bpm at all is a miss, kept so a rerun skips it.
CREATE TABLE IF NOT EXISTS song_tempo (
  song_key TEXT PRIMARY KEY,
  deezer_bpm DOUBLE PRECISION,
  deezer_versions INTEGER,
  tracker_bpm DOUBLE PRECISION,
  ultrastar_bpm DOUBLE PRECISION,
  preview_url TEXT,
  checked_at TEXT
);
-- Feel label per song (QWW-54): slow, mid or upbeat, made offline and imported by npm run tempo:feel, never worked
-- out while a page loads. The label decides which end of the Tempo gear a song sits at (src/lib/tempo/feel.ts); a
-- song with no row keeps its measured tempo.
CREATE TABLE IF NOT EXISTS song_feel (
  song_key TEXT PRIMARY KEY,
  feel TEXT NOT NULL,
  source TEXT NOT NULL,
  labeled_at TEXT
);
-- When Spotify said the app may call it again after a 429 (QWW-55): one row (id 1), shared by every server
-- instance and script. Spotify's quota is the app's, so a 429 for one user stops calls for all of them until it passes.
CREATE TABLE IF NOT EXISTS spotify_block (
  id INTEGER PRIMARY KEY,
  blocked_until BIGINT NOT NULL
);
-- A signed-in user's stored Spotify library (QWW-55 PR 2), so a visit reads only what changed. user_library holds the
-- sync state (what was read when, the top lists, recent plays and playlists) as JSON; user_saved has one row per liked
-- song, pos higher = liked later. Deleted when the user disconnects and after 30 days without a visit.
CREATE TABLE IF NOT EXISTS user_library (
  user_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  last_seen_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_saved (
  user_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  pos BIGINT NOT NULL,
  track_json TEXT NOT NULL,
  gen BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, track_id)
);
-- Spotify Web API requests per day and caller (QWW-55 PR 2): "site:/api/recommendations", "script:usdb-sync".
CREATE TABLE IF NOT EXISTS spotify_calls (
  day TEXT NOT NULL,
  caller TEXT NOT NULL,
  calls INTEGER NOT NULL,
  PRIMARY KEY (day, caller)
);
-- Which row is shown for a song, with its clean title and artist line (QWW-49), written by npm run titles:build. Every
-- measured song has a row once the build has run; a variant folded into another song points at the row shown
-- (canonical_key). source_title and source_artist are what the row had when the record was worked out: the app uses the
-- record only while the row still has them. A song with no usable row is shown as it is stored, so the table may be empty or half written.
CREATE TABLE IF NOT EXISTS song_canonical (
  song_key TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  method TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_title TEXT NOT NULL,
  source_artist TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS song_canonical_canonical ON song_canonical (canonical_key);
-- Deezer's genres per song (QWW-61), written by npm run genres:deezer: the genres of the album of the song's Deezer track
-- (song_deezer.deezer_id), joined by ", ". A null genres is a miss (the track or album is gone, or the album lists no
-- genre), kept so a rerun skips it for a while. The genre shown is USDB's when the song has one (src/lib/genres/genres.ts).
CREATE TABLE IF NOT EXISTS song_genre (
  song_key TEXT PRIMARY KEY,
  genres TEXT,
  album_id BIGINT,
  source TEXT NOT NULL,
  checked_at TEXT NOT NULL
);
