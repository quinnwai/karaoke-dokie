// Contract-shaped API fixtures shared by the screen's unit and e2e tests.

import type {
  DataSourceLogEntry,
  KnownSongsResponse,
  Label,
  Match,
  MeResponse,
  OctaveShift,
  RecommendationsResponse,
  SongRange,
  Track,
} from '../../src/lib/contracts';

// The last two are low-confidence ranges, so the server lists them last, in the Maybe group.
const SONGS: [string, string, Label, OctaveShift, number, number, boolean][] = [
  ['Plastic Love', 'Mariya Takeuchi', 'easy', 'none', 50, 64, false],
  ['Lemon', 'Kenshi Yonezu', 'medium', 'down', 55, 74, false],
  ['Yoru ni Kakeru', 'YOASOBI', 'hard', 'down', 58, 77, true],
  ['Fly Me to the Moon', 'Frank Sinatra', 'easy', 'none', 46, 62, false],
  ['Dancing Queen', 'ABBA', 'medium', 'up', 40, 52, false],
  ['Mr. Brightside', 'The Killers', 'hard', 'none', 52, 69, true],
  ['Bohemian Rhapsody', 'Queen', 'hard', 'none', 46, 72, false],
  ['Take On Me', 'a-ha', 'medium', 'none', 48, 70, false],
  ['Linda Linda', 'The Blue Hearts', 'maybe', 'none', 50, 64, true],
  ['Sukiyaki', 'Kyu Sakamoto', 'maybe', 'none', 48, 62, false],
];

/** Note files and measured recordings alternate; Maybe songs are an artist estimate and a thin recording. */
function sourceOf(i: number): Pick<SongRange, 'source' | 'confidence'> {
  const maybe = SONGS[i % SONGS.length]![2] === 'maybe';
  if (i % 2) return { source: 'audio-full', confidence: maybe ? 'low' : 'high' };
  return maybe ? { source: 'artist-typical', confidence: 'low' } : { source: 'note-file', confidence: 'high' };
}

/** Ranking reasons for some songs, by index; the rest have none. */
const REASONS: Record<number, string[]> = {
  0: ['In your sweet spot', 'You play this a lot'],
  2: ['You play this a lot'],
  4: ['In your sweet spot'],
};

export function track(i: number): Track {
  const [title, artist] = SONGS[i % SONGS.length]!;
  return {
    id: `t${i}`,
    title,
    artist,
    artistId: `a${i}`,
    spotifyUrl: `https://open.spotify.com/track/t${i}`,
    playRank: i,
  };
}

export function match(i: number): Match {
  const [, , difficulty, octave, low, high, fastLyrics] = SONGS[i % SONGS.length]!;
  const range: SongRange = {
    low,
    high,
    tessitura: Math.round((low + high) / 2),
    ...sourceOf(i),
    fastLyrics,
  };
  const reasons = REASONS[i];
  return { track: track(i), range, difficulty, octave, ...(reasons ? { reasons } : {}) };
}

export function source(i: number): DataSourceLogEntry {
  const t = track(i);
  const { source: outcome, confidence } = sourceOf(i);
  const reason =
    outcome === 'note-file'
      ? 'Matched a note file by title and artist.'
      : outcome === 'audio-full'
        ? `Measured from the full recording: vocals separated and pitch-tracked, ${confidence === 'high' ? 74 : 9} s of clear singing.`
        : `No note file found, used ${t.artist}'s usual range.`;
  return { trackId: t.id, title: t.title, artist: t.artist, outcome, reason, at: '2026-10-14T00:00:00.000Z' };
}

export const TOTAL = SONGS.length;

export function recommendationsPage(offset: number, limit = 5): RecommendationsResponse {
  const ids = Array.from({ length: Math.max(0, Math.min(limit, TOTAL - offset)) }, (_, k) => offset + k);
  return {
    matches: ids.map(match),
    nextOffset: offset + limit < TOTAL ? offset + limit : null,
    sources: Object.fromEntries(ids.map((i) => [`t${i}`, source(i)])),
  };
}

export function me(range: MeResponse['range'] = null): MeResponse {
  return { userId: 'u1', displayName: 'Quinn', range };
}

export function knownSongs(): KnownSongsResponse {
  return { songs: [0, 1, 3, 4].map((i) => ({ track: track(i), range: match(i).range })) };
}
