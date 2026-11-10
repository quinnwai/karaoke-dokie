// A Spotify Web API that answers `fetch`, counts every request, and can be switched to the 429 of 10 Nov 2026
// (reason QUOTA_EXCEEDED, retry-after 12098 s), for tests of what the site asks of Spotify (QWW-55).
// Its library is `liked` saved songs, newest first: the first 25 are the offline mock's songs (so the placeholder
// seeds give them ranges and they match), the rest are filler.
import { MOCK_TRACKS } from '../../src/lib/server/mockSpotify';
import type { FetchFn } from '../../src/lib/server/spotify';

export const QUOTA_BODY = '{"error":{"status":429,"message":"Too many requests","reason":"QUOTA_EXCEEDED"}}';

export interface FakeSpotify {
  fetch: FetchFn;
  /** Every request so far, as "METHOD path?query", the token endpoint's included. */
  requests: string[];
  /** The requests to the Web API (not the token endpoint). */
  apiRequests(): string[];
  /** While `on`, every Web API request is answered 429 QUOTA_EXCEEDED with this Retry-After (seconds; null sends none). */
  quota: { on: boolean; retryAfter: number | null };
  /** The next `times` requests whose "path?query" contains `match` are answered 429 (not a quota one) with this Retry-After, then it passes. */
  shortLimit: { match: string; times: number; retryAfter: number } | null;
  /** The liked songs by index into the song pool, newest first. `like` adds a new song on top; `unlike` removes one wherever it is. */
  liked: number[];
  like(): number;
  unlike(index: number): void;
  /** The user's own playlist "p1": its snapshot_id and songs. Change both to simulate an edit. */
  playlist: { snapshotId: string; items: number[] };
}

const apiTrack = (i: number) => {
  const mock = MOCK_TRACKS[i];
  return mock
    ? {
        id: mock.id,
        name: mock.title,
        artists: [{ id: mock.artistId, name: mock.artist }],
        external_urls: { spotify: mock.spotifyUrl },
        album: { release_date: String(mock.releaseYear) },
      }
    : {
        id: `filler-${i}`,
        name: `Filler Song ${i}`,
        artists: [{ id: `filler-artist-${i % 40}`, name: `Filler Artist ${i % 40}` }],
        external_urls: { spotify: `https://open.spotify.com/track/filler-${i}` },
        album: { release_date: '2001' },
      };
};

export function fakeSpotify({ liked = 1750 }: { liked?: number } = {}): FakeSpotify {
  const requests: string[] = [];
  let nextNew = 100_000;
  const fake: FakeSpotify = {
    requests,
    liked: Array.from({ length: liked }, (_, i) => i),
    like: () => {
      fake.liked.unshift(nextNew);
      return nextNew++;
    },
    unlike: (index) => {
      fake.liked = fake.liked.filter((i) => i !== index);
    },
    playlist: { snapshotId: 'snap-1', items: [15] },
    apiRequests: () => requests.filter((r) => !r.includes('accounts.spotify.com')),
    quota: { on: false, retryAfter: 12098 },
    shortLimit: null,
    fetch: async (input, init) => {
      const url = new URL(input);
      requests.push(`${init?.method ?? 'GET'} ${url.hostname === 'accounts.spotify.com' ? 'accounts.spotify.com' : ''}${url.pathname}${url.search}`);
      const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

      if (url.hostname === 'accounts.spotify.com') {
        return json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 });
      }
      if (fake.quota.on) return json(QUOTA_BODY, 429, fake.quota.retryAfter === null ? {} : { 'retry-after': String(fake.quota.retryAfter) });
      const short = fake.shortLimit;
      if (short && short.times > 0 && `${url.pathname}${url.search}`.includes(short.match)) {
        short.times--;
        return json('{"error":{"status":429,"message":"rate limit"}}', 429, { 'retry-after': String(short.retryAfter) });
      }

      const path = url.pathname.replace(/^\/v1/, '');
      if (path === '/me') return json({ id: 'real-singer', display_name: 'Real Singer' });
      if (path === '/me/top/tracks') return json({ items: MOCK_TRACKS.slice(0, 6).map((_, i) => apiTrack(i)) });
      if (path === '/me/player/recently-played') return json({ items: [3, 7, 3].map((i) => ({ track: apiTrack(i) })) });
      if (path === '/me/tracks') {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const page = fake.liked.slice(offset, offset + 50);
        return json({ items: page.map((i) => ({ track: apiTrack(i) })), total: fake.liked.length, next: null });
      }
      if (path === '/me/playlists') return json({ items: [{ id: 'p1', snapshot_id: fake.playlist.snapshotId, owner: { id: 'real-singer' } }], next: null });
      if (path.startsWith('/playlists/')) return json({ items: fake.playlist.items.map((i) => ({ item: apiTrack(i) })), next: null });
      return json('not found', 404);
    },
  };
  return fake;
}
