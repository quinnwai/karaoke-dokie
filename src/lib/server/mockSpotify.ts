// Offline Spotify stand-in used when SPOTIFY_MOCK=1 (e2e tests, local dev without credentials).
import type { Track } from '../contracts';
import type { SpotifyClient } from './spotify';

export const MOCK_USER = { id: 'mock-test-singer', displayName: 'Test Singer' };
export const MOCK_CODE = 'mock-code';

// [artist, title, year the recording first came out]. The first MOCK_TOP_COUNT are the "top tracks";
// all are "saved". No popularity: Spotify stopped sending it to Development Mode apps in Feb 2026.
const MOCK_LIBRARY: [string, string, number][] = [
  ['Queen', 'Bohemian Rhapsody', 1975],
  ['Omar Apollo', 'Evergreen', 2022],
  ['Whitney Houston', 'I Will Always Love You', 1992],
  ['Journey', "Don't Stop Believin'", 1981],
  ['Justin Bieber', 'Baby', 2010],
  ['Adele', 'Someone Like You', 2011],
  ['Bon Jovi', "Livin' on a Prayer", 1986],
  ['Elvis Presley', "Can't Help Falling in Love", 1961],
  ['ABBA', 'Dancing Queen', 1976],
  ['Frank Sinatra', 'My Way', 1969],
  ['Queen', "Don't Stop Me Now", 1978],
  ['Whitney Houston', 'I Wanna Dance with Somebody (Who Loves Me)', 1987],
  ['Journey', 'Any Way You Want It', 1980],
  ['Justin Bieber', 'Sorry', 2015],
  ['Mariah Carey', 'All I Want for Christmas Is You', 1994],
  ['Toto', 'Africa', 1982],
  ['a-ha', 'Take On Me', 1985],
  ['Lady Gaga', 'Shallow', 2018],
  ['Ed Sheeran', 'Perfect', 2017],
  ['Billy Joel', 'Piano Man', 1973],
  ['Spice Girls', 'Wannabe', 1996],
  ['Backstreet Boys', 'I Want It That Way', 1999],
  ['Cyndi Lauper', 'Girls Just Want to Have Fun', 1983],
  ['The Killers', 'Mr. Brightside', 2003],
  ['Gloria Gaynor', 'I Will Survive', 1978],
];
const MOCK_TOP_COUNT = 6;

// Real Spotify track ids (each checked against Spotify's embed page for this title and artist), so the song
// page shows Spotify's player in the offline demo. Songs not listed keep a search link and the plain link.
const MOCK_TRACK_IDS: Record<string, string> = {
  "Queen|Bohemian Rhapsody": '7tFiyTwD0nx5a1eklYtX2J',
  "Omar Apollo|Evergreen": '2TktkzfozZifbQhXjT6I33',
  "Whitney Houston|I Will Always Love You": '4eHbdreAnSOrDDsFfc4Fpm',
  "Journey|Don't Stop Believin'": '4bHsxqR3GMrXTxEPLuK5ue',
  "Justin Bieber|Baby": '6epn3r7S14KUqlReYr77hA',
  "Adele|Someone Like You": '1zwMYTA5nlNjZxYrvBB2pV',
  "Bon Jovi|Livin' on a Prayer": '37ZJ0p5Jm13JPevGcx4SkF',
  "Elvis Presley|Can't Help Falling in Love": '44AyOl4qVkzS48vBsbNXaC',
  "ABBA|Dancing Queen": '0GjEhVFGZW8afUYGChu3Rr',
  "Frank Sinatra|My Way": '2yn2CndX7qLoKt0iWs7cy9',
  "Queen|Don't Stop Me Now": '5T8EDUDqKcs6OSOwEsfqG7',
  "Whitney Houston|I Wanna Dance with Somebody (Who Loves Me)": '2tUBqZG2AbRi7Q0BIrVrEj',
  "Justin Bieber|Sorry": '09CtPGIpYB4BrO8qb1RGsF',
  "Mariah Carey|All I Want for Christmas Is You": '0bYg9bo50gSsH3LtXe2SQn',
  "Toto|Africa": '2374M0fQpWi3dLnB54qaLX',
  "a-ha|Take On Me": '2WfaOiMkCvy7F5fcp2zZ8L',
  "Lady Gaga|Shallow": '2VxeLyX666F8uXCJ0dZF8B',
  "Ed Sheeran|Perfect": '0tgVpDi06FyKpA1z0VMD4v',
  "Billy Joel|Piano Man": '70C4NyhjD5OZUMzvWZ3njJ',
  "Spice Girls|Wannabe": '1Je1IMUlBXcx1Fz0WE7oPT',
  "Backstreet Boys|I Want It That Way": '47BBI51FKFwOMlIiX6m8ya',
  "The Killers|Mr. Brightside": '003vvx7Niy0yvhvHt4a68B',
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const MOCK_TRACKS: Track[] = MOCK_LIBRARY.map(([artist, title, releaseYear], i) => ({
  id: `mock-${i + 1}-${slug(title)}`,
  title,
  artist,
  artistId: `mock-artist-${slug(artist)}`,
  spotifyUrl: MOCK_TRACK_IDS[`${artist}|${title}`]
    ? `https://open.spotify.com/track/${MOCK_TRACK_IDS[`${artist}|${title}`]}`
    : `https://open.spotify.com/search/${encodeURIComponent(`${artist} ${title}`)}`,
  playRank: i,
  releaseYear,
}));

export function createMockSpotifyClient(): SpotifyClient {
  const tokens = () => ({ accessToken: 'mock-access', refreshToken: 'mock-refresh', expiresAt: Date.now() + 3600_000 });
  return {
    authorizeUrl(state, origin) {
      const q = new URLSearchParams({ code: MOCK_CODE, state });
      return `${origin}/api/auth/callback?${q}`;
    },
    async exchangeCode(code) {
      if (code !== MOCK_CODE) throw new Error('mock Spotify: unknown code');
      return tokens();
    },
    async refresh() {
      return tokens();
    },
    async getMe() {
      return { ...MOCK_USER };
    },
    async getSavedTracks(_token, max = 500) {
      // Saved order differs from top order: newest saved first.
      return [...MOCK_TRACKS]
        .reverse()
        .slice(0, max)
        .map((t, i) => ({ ...t, playRank: i }));
    },
    async getTopTracks(_token, timeRange = 'medium_term') {
      // Recent favourites shift a little between time spans, like real listening.
      const start = timeRange === 'short_term' ? 1 : timeRange === 'long_term' ? 2 : 0;
      return MOCK_TRACKS.slice(start, start + MOCK_TOP_COUNT).map((t, i) => ({ ...t, playRank: i }));
    },
    async getPlaylistTracks() {
      return [MOCK_TRACKS[10]!, MOCK_TRACKS[15]!].map((t, i) => ({ ...t, playRank: i }));
    },
    async getRecentlyPlayed() {
      return [MOCK_TRACKS[3]!, MOCK_TRACKS[7]!, MOCK_TRACKS[3]!].map((t, i) => ({ ...t, playRank: i }));
    },
  };
}
