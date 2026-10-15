// Offline Spotify stand-in used when SPOTIFY_MOCK=1 (e2e tests, local dev without credentials).
import type { Track } from '../contracts';
import type { SpotifyClient } from './spotify';

export const MOCK_USER = { id: 'mock-test-singer', displayName: 'Test Singer' };
export const MOCK_CODE = 'mock-code';

// [artist, title]. The first MOCK_TOP_COUNT are the "top tracks"; all are "saved".
const MOCK_LIBRARY: [string, string][] = [
  ['Queen', 'Bohemian Rhapsody'],
  ['Omar Apollo', 'Evergreen'],
  ['Whitney Houston', 'I Will Always Love You'],
  ['Journey', "Don't Stop Believin'"],
  ['Justin Bieber', 'Baby'],
  ['Adele', 'Someone Like You'],
  ['Bon Jovi', "Livin' on a Prayer"],
  ['Elvis Presley', "Can't Help Falling in Love"],
  ['ABBA', 'Dancing Queen'],
  ['Frank Sinatra', 'My Way'],
  ['Queen', "Don't Stop Me Now"],
  ['Whitney Houston', 'I Wanna Dance with Somebody (Who Loves Me)'],
  ['Journey', 'Any Way You Want It'],
  ['Justin Bieber', 'Sorry'],
  ['Mariah Carey', 'All I Want for Christmas Is You'],
  ['Toto', 'Africa'],
  ['a-ha', 'Take On Me'],
  ['Lady Gaga', 'Shallow'],
  ['Ed Sheeran', 'Perfect'],
  ['Billy Joel', 'Piano Man'],
  ['Spice Girls', 'Wannabe'],
  ['Backstreet Boys', 'I Want It That Way'],
  ['Cyndi Lauper', 'Girls Just Want to Have Fun'],
  ['The Killers', 'Mr. Brightside'],
  ['Gloria Gaynor', 'I Will Survive'],
];
const MOCK_TOP_COUNT = 6;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const MOCK_TRACKS: Track[] = MOCK_LIBRARY.map(([artist, title], i) => ({
  id: `mock-${i + 1}-${slug(title)}`,
  title,
  artist,
  artistId: `mock-artist-${slug(artist)}`,
  spotifyUrl: `https://open.spotify.com/search/${encodeURIComponent(`${artist} ${title}`)}`,
  playRank: i,
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
      return MOCK_TRACKS.slice(start, start + MOCK_TOP_COUNT).map((t, i) => ({ ...t, playRank: i, popularity: 90 - i * 5 }));
    },
    async getPlaylistTracks() {
      return [MOCK_TRACKS[10]!, MOCK_TRACKS[15]!].map((t, i) => ({ ...t, playRank: i }));
    },
    async getRecentlyPlayed() {
      return [MOCK_TRACKS[3]!, MOCK_TRACKS[7]!, MOCK_TRACKS[3]!].map((t, i) => ({ ...t, playRank: i }));
    },
  };
}
