// Shared types between the song data, backend and screen code.
// Pitches are MIDI note numbers everywhere (C4 = 60). Convert to names only for display.

export type Midi = number;

/** A user's comfortable singing range. */
export interface VocalRange {
  low: Midi;
  high: Midi;
  /** How we got it: the hold-to-record test, or songs the user picked. */
  source: 'test' | 'songs';
}

/** Where a song's range numbers came from. */
export type RangeSource = 'note-file' | 'artist-typical' | 'artist-external';

export interface SongRange {
  low: Midi;
  high: Midi;
  /** Length-weighted average pitch: where the song mostly sits. */
  tessitura: Midi;
  source: RangeSource;
  confidence: 'high' | 'low';
  /** True when sung syllables come faster than a comfortable pace. */
  fastLyrics: boolean;
}

export type Difficulty = 'easy' | 'medium' | 'hard';

/** 'none' = fits as written; 'up'/'down' = fits if sung an octave higher/lower than the artist. */
export type OctaveShift = 'none' | 'up' | 'down';

/** A Spotify track from the user's library. */
export interface Track {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  spotifyUrl: string;
  albumArtUrl?: string;
  /** Lower = played more. Top tracks rank first, then saved-songs order. */
  playRank: number;
}

export interface Match {
  track: Track;
  range: SongRange;
  difficulty: Difficulty;
  octave: OctaveShift;
}

export type LogOutcome = RangeSource | 'skipped';

/** One line of the data-source log (info button + hidden admin page). */
export interface DataSourceLogEntry {
  trackId: string;
  title: string;
  artist: string;
  outcome: LogOutcome;
  reason: string;
  at: string; // ISO time
}

export interface FeedbackEntry {
  userId: string;
  trackId: string;
  thumbs: 'up' | 'down';
  userRange: VocalRange;
  difficulty: Difficulty;
  octave: OctaveShift;
  at: string; // ISO time
}

// ---------- HTTP API (app/api) ----------
// GET  /api/auth/login                 -> redirect to Spotify
// GET  /api/auth/callback              -> sets session cookie, redirect to /?signedIn=1
// POST /api/auth/logout                -> clears session
// GET  /api/me                         -> MeResponse (401 when signed out)
// PUT  /api/me/range   body VocalRange -> { ok: true }
// GET  /api/recommendations?offset=0&limit=5 -> RecommendationsResponse
// GET  /api/songs/known                -> KnownSongsResponse (saved songs with a known range, for "pick songs you sing well")
// POST /api/feedback   body FeedbackRequest -> { ok: true }
// GET  /api/admin/log  (header x-admin-token) -> { entries: DataSourceLogEntry[] }

export interface MeResponse {
  userId: string;
  displayName: string;
  range: VocalRange | null;
}

export interface RecommendationsResponse {
  matches: Match[];
  /** Offset to ask for next, or null when there are no more. */
  nextOffset: number | null;
  /** Data-source lines for the songs in this page, keyed by track id (info button). */
  sources: Record<string, DataSourceLogEntry>;
}

export interface KnownSongsResponse {
  songs: { track: Track; range: SongRange }[];
}

export interface FeedbackRequest {
  trackId: string;
  thumbs: 'up' | 'down';
  difficulty: Difficulty;
  octave: OctaveShift;
}
