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
  /** Share of sung time on each pitch, [midi, share] sorted by pitch, shares summing to 1. Note files only. */
  pitchShare?: [Midi, number][];
  /** USDB page views and star rating (0-5) for this song's note file, when known. */
  usdbViews?: number;
  usdbRating?: number;
  /** USDB song id the note file came from, for a link to its page. */
  usdbId?: number;
  /** Where the note file came from when it was not USDB directly, e.g. "singmania". */
  collection?: string;
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
  /** 0-1: how much the user listens to this song (top tracks over 3 time spans, recent plays, saved). */
  familiarity?: number;
  /** Spotify's 0-100 track popularity, when Spotify returns it. */
  popularity?: number;
}

export interface ScoreParts {
  /** 0-1: share of the song in the middle of the user's range. */
  comfort: number;
  /** 0-1: how much the user listens to it. */
  familiarity: number;
  /** 0-1: how well known the song is. */
  popularity: number;
  /** Total subtracted for octave shift, artist-estimated range and fast lyrics. */
  penalty: number;
}

export interface Match {
  track: Track;
  range: SongRange;
  difficulty: Difficulty;
  octave: OctaveShift;
  /** Ranking score, higher first: 0.50 comfort + 0.35 familiarity + 0.15 popularity - penalties. */
  score?: number;
  parts?: ScoreParts;
  /** One or two short reasons for the rank, e.g. "In your sweet spot". */
  reasons?: string[];
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
  /** When the sync last searched USDB for this song and found no note file. Unset = never searched. */
  usdbMissAt?: string;
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
