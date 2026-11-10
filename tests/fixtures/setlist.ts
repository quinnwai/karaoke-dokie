// The 25 mock songs of the round 5 spec (docs/setlist-round5, §5), as the server sends them (Match), for the tuner's
// acceptance tests. Each song keeps the spec's numbers in the form the server sends: difficulty is a label plus a
// strain that orders the songs as the spec's 0-100 value does, popularity and listening history are 0-1 parts, tempo
// is a bpm. The engine places songs on a gear by rank (QWW-47), so what the numbers decide is the ORDER of the songs
// on each gear; the spec's expectations (which songs are in an era, what comes first) can be read off this list.

import type { DataSourceLogEntry, Match, RecommendationsResponse, SongRange } from '../../src/lib/contracts';
import type { EraId } from '../../src/lib/setlist/types';

export interface MockSong {
  title: string;
  artist: string;
  era: EraId;
  difficulty: number;
  history: number;
  popularity: number;
  tempo: number;
}

const s = (title: string, artist: string, era: EraId, difficulty: number, history: number, popularity: number, tempo: number): MockSong => ({
  title,
  artist,
  era,
  difficulty,
  history,
  popularity,
  tempo,
});

/** The spec's SONGS array, in catalogue order. */
export const MOCK_SONGS: MockSong[] = [
  s("Can't Help Falling in Love", 'Elvis Presley', 'pre', 25, 30, 75, 10),
  s('Stand by Me', 'Ben E. King', 'pre', 20, 45, 80, 30),
  s('Respect', 'Aretha Franklin', 'pre', 70, 35, 70, 60),
  s('Sweet Caroline', 'Neil Diamond', 'pre', 30, 70, 85, 35),
  s("These Boots Are Made for Walkin'", 'Nancy Sinatra', 'pre', 15, 20, 55, 40),
  s('Dancing Queen', 'ABBA', 's70', 60, 75, 90, 50),
  s('I Will Survive', 'Gloria Gaynor', 's70', 55, 50, 85, 70),
  s('Bohemian Rhapsody', 'Queen', 's70', 95, 80, 95, 40),
  s('A Case of You', 'Joni Mitchell', 's70', 70, 15, 25, 15),
  s("Don't Stop Believin'", 'Journey', 's80', 75, 90, 95, 55),
  s('Africa', 'Toto', 's80', 50, 60, 85, 45),
  s("Livin' on a Prayer", 'Bon Jovi', 's80', 85, 65, 90, 65),
  s('Bizarre Love Triangle', 'New Order', 's80', 45, 20, 35, 85),
  s('I Will Always Love You', 'Whitney Houston', 's90', 100, 40, 90, 5),
  s('Wannabe', 'Spice Girls', 's90', 35, 55, 80, 80),
  s('I Want It That Way', 'Backstreet Boys', 's90', 45, 85, 85, 45),
  s('Harvest Moon', 'Neil Young', 's90', 30, 10, 30, 10),
  s('Mr. Brightside', 'The Killers', 's00', 40, 95, 90, 90),
  s('Since U Been Gone', 'Kelly Clarkson', 's00', 70, 60, 70, 75),
  s('Valerie', 'Mark Ronson ft. Amy Winehouse', 's00', 45, 50, 60, 70),
  s('Rolling in the Deep', 'Adele', 's10', 75, 70, 90, 55),
  s('Shallow', 'Lady Gaga and Bradley Cooper', 's10', 90, 55, 85, 20),
  s('Motion Sickness', 'Phoebe Bridgers', 's10', 40, 25, 30, 60),
  s('Levitating', 'Dua Lipa', 's20', 40, 75, 80, 65),
  s('good 4 u', 'Olivia Rodrigo', 's20', 60, 90, 85, 95),
];

const YEAR: Record<EraId, number> = { pre: 1965, s70: 1975, s80: 1985, s90: 1995, s00: 2005, s10: 2015, s20: 2022 };

/** The label and strain that score `d` (0-100) on the difficulty gear: thirds, as scores.ts lays them out. */
function difficultyFields(d: number): Pick<Match, 'difficulty' | 'strain'> {
  const band = d < 34 ? 0 : d < 67 ? 1 : 2;
  const start = [0, 34, 67][band]!;
  const span = [33, 32, 33][band]!;
  return { difficulty: (['easy', 'medium', 'hard'] as const)[band]!, strain: ((d - start) / span) * 3 };
}

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** `idPrefix` is 'cat:' for the catalogue (no Spotify) and '' for a library. */
export function mockMatch(song: MockSong, i: number, idPrefix = 'cat:'): Match {
  const range: SongRange = {
    low: 48,
    high: 56 + Math.round(song.difficulty / 10),
    tessitura: 54,
    source: 'audio-full',
    confidence: 'high',
    fastLyrics: false,
  };
  return {
    track: {
      id: `${idPrefix}${slug(song.title)}`,
      title: song.title,
      artist: song.artist,
      artistId: '',
      spotifyUrl: `https://open.spotify.com/search/${encodeURIComponent(`${song.artist} ${song.title}`)}`,
      playRank: i,
    },
    range,
    octave: 'none',
    ...difficultyFields(song.difficulty),
    year: YEAR[song.era],
    yearSource: 'usdb',
    tempo: Math.round(70 + song.tempo * 1.1),
    parts: { comfort: 1, familiarity: song.history / 100, popularity: song.popularity / 100, popularityKnown: true, penalty: 0 },
  };
}

/** The API's answer for every match at once. `extra` songs come after the 25. */
export function mockPage(opts: { idPrefix?: string; extra?: MockSong[] } = {}): RecommendationsResponse {
  const songs = [...MOCK_SONGS, ...(opts.extra ?? [])];
  const matches = songs.map((song, i) => mockMatch(song, i, opts.idPrefix ?? 'cat:'));
  const sources = Object.fromEntries(
    matches.map((m): [string, DataSourceLogEntry] => [
      m.track.id,
      { trackId: m.track.id, title: m.track.title, artist: m.track.artist, outcome: 'audio-full', reason: 'Measured from the full recording.', at: '2026-11-10T00:00:00.000Z' },
    ]),
  );
  return { matches, nextOffset: null, sources, complete: true };
}

export const titlesOf = (songs: MockSong[]) => songs.map((x) => x.title);
