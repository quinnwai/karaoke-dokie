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

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const MOCK_TRACKS: Track[] = MOCK_LIBRARY.map(([artist, title, releaseYear], i) => ({
  id: `mock-${i + 1}-${slug(title)}`,
  title,
  artist,
  artistId: `mock-artist-${slug(artist)}`,
  spotifyUrl: `https://open.spotify.com/search/${encodeURIComponent(`${artist} ${title}`)}`,
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
