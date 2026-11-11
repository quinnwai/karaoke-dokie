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

/** Where a song's range numbers came from. 'audio-full': measured from the song's full recording. */
export type RangeSource = 'note-file' | 'audio-full' | 'artist-typical' | 'artist-external';

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
  /** How a recording was measured, e.g. "pyin-v1/app-range-v1"; a new value marks a newer export. */
  method?: string;
  /**
   * Set when a note file's octave was corrected after import (octave.ts): from this song's own
   * recording, from the artist's other recordings, or, with neither, because a typical note this
   * high is usually an octave too high ('pitch'). 'hand' is the artist's register as a person set
   * it, not measured (data/octave-hand-checked.json).
   */
  octaveFrom?: 'recording' | 'artist' | 'pitch' | 'hand';
  /** MusicBrainz recording id of a measured recording. */
  mbid?: string;
  /**
   * True for a note file with sung notes in both P1 and P2 (a duet). The fields above stay
   * P1's, so older readers keep working; `parts` has each singer's own range.
   */
  duet?: boolean;
  /** Each singer's range in a duet, P1 first. Unset for solo songs. */
  parts?: SongPart[];
}

/** One singer's part of a duet note file. */
export interface SongPart {
  /** The singer's name from the #P1/#P2 (or older #DUETSINGERP1/#DUETSINGERP2) header, when given. */
  singer?: string;
  low: Midi;
  high: Midi;
  tessitura: Midi;
  pitchShare?: [Midi, number][];
  fastLyrics: boolean;
}

export type Difficulty = 'easy' | 'medium' | 'hard';

/**
 * What a song is shown as: its difficulty, or 'maybe' for a low-confidence range that fits the
 * user's range give or take a couple of semitones (listed after the others, without a difficulty).
 */
export type Label = Difficulty | 'maybe';

/** 'none' = fits as written; 'up'/'down' = fits if sung an octave higher/lower than the artist. */
export type OctaveShift = 'none' | 'up' | 'down';

/** Spotify's top-50 lists by time span: short_term (about 4 weeks), medium_term (6 months), long_term (about a year). */
export type TimeRange = 'short_term' | 'medium_term' | 'long_term';

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
  /** True when the user knows the song: in a top list, recent plays or one of their playlists. Saved-only songs are false. */
  known?: boolean;
  // Where the user's listening shows the song (server/spotify.ts buildLibrary), so its reason can say
  // which list it is in. Each is unset when it does not apply; catalogue tracks and libraries
  // cached before these were kept have none.
  /** The top-50 lists the song is in, shortest span first. */
  topLists?: TimeRange[];
  /** How many of the user's last 50 plays were this song. */
  recentPlays?: number;
  /** True when the song is in a playlist the user made or collaborates on. */
  inPlaylist?: boolean;
  /** True when the user saved the song. */
  saved?: boolean;
  /** Spotify's 0-100 track popularity, when Spotify returns it (it no longer does for Development Mode apps). */
  popularity?: number;
  /** Year from Spotify's album.release_date. Unset for compilation albums (their date is the compilation's) and unparsable dates. */
  releaseYear?: number;
  /** ISRC from Spotify's external_ids, when sent. */
  isrc?: string;
}

export interface ScoreParts {
  /** 0-1: share of the song in the middle of the user's range. */
  comfort: number;
  /** 0-1: how much the user listens to it. */
  familiarity: number;
  /** 0-1: how well known the song is. */
  popularity: number;
  /**
   * False when popularity is the flat default because we know nothing (no Spotify popularity, no
   * USDB views or stars, no karaoke views, no Billboard Year-End entry).
   */
  popularityKnown?: boolean;
  /** Total subtracted for octave shift, artist-estimated range and fast lyrics. */
  penalty: number;
}

/** Mood labels that can ship as chips (QWW-11 decides which pass the precision gate). */
export type Mood = 'upbeat' | 'heartfelt';
export const MOODS: Mood[] = ['upbeat', 'heartfelt'];

/** Bins in Match.shape: equal slices of the singer's range. */
export const SHAPE_BINS = 12;

export interface Match {
  track: Track;
  range: SongRange;
  difficulty: Label;
  octave: OctaveShift;
  /** Ranking score, higher first: 0.85 comfort × familiarity + 0.15 popularity - penalties. */
  score?: number;
  parts?: ScoreParts;
  /** One or two short reasons for the rank, e.g. "In your sweet spot". */
  reasons?: string[];
  /**
   * How hard the song is inside its label, 0 to 3: twice the share of sung time in the edge eighths of
   * the singer's range plus the share outside the middle half. The Light work to Locked in slider
   * sorts by the label, then this (QWW-33), so the slider and the label are one measure.
   */
  strain?: number;
  /**
   * Where the song's sung time sits across the singer's range, as it is sung (octave shift applied):
   * SHAPE_BINS whole percents, lowest note first. Only notes inside the song's own range count (not the
   * outliers its range skips), so every bin with a value lies where the song is drawn. A bin with any sung
   * time is at least 1, so 0 means no notes. Unset for a song with no pitch histogram.
   */
  shape?: number[];
  /**
   * Release year: the earliest of USDB's year for the song and Spotify's album year. A song with
   * neither gets the year of its best Billboard Year-End rank ('chart'), which can be a year late.
   */
  year?: number;
  yearSource?: 'usdb' | 'spotify' | 'chart';
  /** Tempo in beats per minute, 70 to 180, from Deezer, a beat tracker or the note file (QWW-40). Unset when unknown. */
  tempo?: number;
  /** Genre as USDB lists it (free text, e.g. "Rock"). */
  genre?: string;
  /** For a duet matched on one singer's part: which part (1 = P1, 2 = P2) and that singer's name. */
  part?: number;
  partSinger?: string;
  /** Moods that passed the label gate, for the mood chips. Unset when the song has no shipped label. */
  moods?: Mood[];
}

// ---------- results view (QWW-9, QWW-13, QWW-22, QWW-23) ----------

/**
 * The continuous controls: a slider each. 'familiarity' needs listening data, so catalogue mode
 * has none; 'popularity' needs real popularity data for most songs; 'tempo' (QWW-40) is in both modes.
 */
export type SliderId = 'difficulty' | 'familiarity' | 'popularity' | 'tempo';
export const SLIDER_IDS: SliderId[] = ['difficulty', 'familiarity', 'popularity', 'tempo'];
/** Decade buckets; '60s' means "60s and earlier". */
export type Decade = '60s' | '70s' | '80s' | '90s' | '00s' | '10s' | '20s';

/**
 * What the singer has set on the results screen. Sliders are preferences, not filters: null until
 * touched, then a target from 0 (left end) to 1 (right end), and the songs closest to every set
 * target come first. Chips are filters: one pick per row, null = nothing picked.
 */
export interface ResultsView {
  difficulty: number | null;
  familiarity: number | null;
  popularity: number | null;
  tempo: number | null;
  decade: Decade | null;
  mood: Mood | null;
  duetsOnly: boolean;
}

/** Where the results come from: the signed-in user's Spotify library, or the catalogue (no Spotify). */
export type ResultsMode = 'library' | 'catalogue';

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
  difficulty: Label;
  octave: OctaveShift;
  at: string; // ISO time
  /**
   * The song's range when the tap was made (the row can be replaced later): where it came from
   * (the log outcome), how it was measured, and its notes. Unset when the song was not in the
   * cached library or had no cached range.
   */
  songRange?: { source: LogOutcome; method?: string; low?: Midi; high?: Midi };
  /** The results view the song was found in, as the client sent it. Unset for older clients. */
  view?: ResultsView;
}

// ---------- HTTP API (app/api) ----------
// GET  /api/auth/login                 -> redirect to Spotify
// GET  /api/auth/callback              -> sets session cookie, redirect to /?signedIn=1
// POST /api/auth/logout                -> clears session
// GET  /api/me                         -> MeResponse (401 when signed out)
// PUT  /api/me/range   body VocalRange -> { ok: true }
// GET  /api/recommendations?offset=0&limit=5 -> RecommendationsResponse
// GET  /api/recommendations?all=1      -> RecommendationsResponse with every match, `complete: true`
//   When the signed-in user's Spotify library cannot be read (Spotify says wait, fails or is down) these answer 200
//   with the catalogue's songs for the user's range and `libraryUnavailable: true`, never a 5xx (QWW-55).
// GET  /api/songs/known                -> KnownSongsResponse (saved songs with a known range, for "pick songs you sing well");
//   no songs and `libraryUnavailable: true` when the library cannot be read
// POST /api/feedback   body FeedbackRequest -> { ok: true }
// GET  /api/admin/log  (header x-admin-token) -> { entries: DataSourceLogEntry[] }
// No Spotify (QWW-2 Track B), no session needed:
// GET  /api/catalogue/recommendations?low=&high=&all=1 (or &offset=&limit=) -> RecommendationsResponse
// POST /api/catalogue/feedback body CatalogueFeedbackRequest -> { ok: true }
// Beta event log (QWW-16, QWW-20):
// POST /api/events     body EventsRequest -> 204 (also 204 when collection is switched off)
// GET  /api/admin/events (header x-admin-token) -> AdminEventsResponse

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
  /** True when `matches` is every match there is (an `all=1` request whose lookups all finished). */
  complete?: boolean;
  /**
   * True when a signed-in user's Spotify library could not be read, so `matches` are the catalogue's songs for
   * their range, as someone without Spotify gets them (QWW-55). The screen says so in one quiet line.
   */
  libraryUnavailable?: boolean;
}

export interface KnownSongsResponse {
  songs: { track: Track; range: SongRange }[];
  /** True when the library could not be read: `songs` is then empty (QWW-55). */
  libraryUnavailable?: boolean;
}

export interface FeedbackRequest {
  trackId: string;
  thumbs: 'up' | 'down';
  difficulty: Label;
  octave: OctaveShift;
  /** The results view the song was found in. */
  view?: ResultsView;
}

/** Feedback from someone without Spotify: no account, so the device id and range come with it. */
export interface CatalogueFeedbackRequest extends FeedbackRequest {
  /** Random id kept on the device (localStorage); never a Spotify id. */
  anonId: string;
  range: { low: Midi; high: Midi };
}

// ---------- beta event log (QWW-16, QWW-20) ----------

export type EventValue = string | number | boolean | null;

/** One thing a tester did. Never carries a Spotify id or a song from someone's Spotify library. */
export interface AppEvent {
  /** e.g. 'landing_viewed', 'range_shown', 'results_viewed', 'slider_changed', 'song_opened'. */
  name: string;
  /** ISO time on the device. */
  at: string;
  props?: Record<string, EventValue>;
}

export interface EventsRequest {
  anonId: string;
  events: AppEvent[];
}

export interface AdminEventsResponse {
  /** How many distinct devices reached each funnel step, in funnel order. */
  funnel: { name: string; devices: number }[];
  /**
   * Per control that was in use when it happened (a slider that was set, a chip that was picked, or
   * 'none'): songs opened, Spotify opens, thumbs up and down, and the median list position opened.
   */
  byControl: Record<string, { opened: number; spotify: number; up: number; down: number; medianPosition: number | null }>;
  /** Each device's events in time order, newest devices first, so a session reads as a replay. */
  sessions: { anonId: string; events: AppEvent[] }[];
}
