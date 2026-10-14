import { describe, expect, it } from 'vitest';
import {
  createSpotifyClient,
  ensureFreshTokens,
  getUserTracks,
  mapTrack,
  mergeTracks,
  SpotifyError,
  type FetchFn,
} from '../../src/lib/server/spotify';
import { createMockSpotifyClient, MOCK_CODE, MOCK_USER } from '../../src/lib/server/mockSpotify';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import type { Track } from '../../src/lib/contracts';

const cfg = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'http://127.0.0.1:3000/api/auth/callback' };

const sTrack = (n: number) => ({
  id: `id${n}`,
  name: `Song ${n}`,
  artists: [{ id: `a${n}`, name: `Artist ${n}` }],
  external_urls: { spotify: `https://open.spotify.com/track/id${n}` },
  album: { images: [{ url: `big${n}`, width: 640 }, { url: `mid${n}`, width: 300 }, { url: `small${n}`, width: 64 }] },
});

interface Call {
  url: string;
  init?: RequestInit;
}

/** Fake fetch: routes by URL prefix to handlers returning JSON. */
function fakeFetch(handlers: Record<string, (url: URL, init?: RequestInit) => unknown>, calls: Call[] = []): FetchFn {
  return async (input, init) => {
    calls.push({ url: input, init });
    const url = new URL(input);
    for (const [prefix, h] of Object.entries(handlers)) {
      if (`${url.origin}${url.pathname}` === prefix) {
        const body = h(url, init);
        if (body instanceof Response) return body;
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('not found', { status: 404 });
  };
}

describe('Spotify authorization', () => {
  it('builds the authorize URL with scopes, redirect and state', () => {
    const url = new URL(createSpotifyClient(cfg).authorizeUrl('st4te', 'http://ignored'));
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(url.searchParams.get('scope')).toBe('user-library-read user-top-read');
    expect(url.searchParams.get('state')).toBe('st4te');
    expect(url.searchParams.get('redirect_uri')).toBe(cfg.redirectUri);
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('exchanges a code and refreshes tokens with Basic auth', async () => {
    const calls: Call[] = [];
    const bodies: URLSearchParams[] = [];
    const f = fakeFetch(
      {
        'https://accounts.spotify.com/api/token': (_u, init) => {
          const b = new URLSearchParams(String(init?.body));
          bodies.push(b);
          return b.get('grant_type') === 'authorization_code'
            ? { access_token: 'acc1', refresh_token: 'ref1', expires_in: 3600 }
            : { access_token: 'acc2', expires_in: 3600 };
        },
      },
      calls,
    );
    const client = createSpotifyClient(cfg, f);
    const t1 = await client.exchangeCode('the-code');
    expect(t1).toMatchObject({ accessToken: 'acc1', refreshToken: 'ref1' });
    expect(t1.expiresAt).toBeGreaterThan(Date.now() + 3500_000);
    expect(bodies[0]!.get('code')).toBe('the-code');
    expect(bodies[0]!.get('redirect_uri')).toBe(cfg.redirectUri);
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('cid:secret').toString('base64')}`,
    );
    // Refresh responses may omit refresh_token: keep the old one.
    const t2 = await client.refresh('ref1');
    expect(t2).toMatchObject({ accessToken: 'acc2', refreshToken: 'ref1' });
  });

  it('throws SpotifyError on a failed token request', async () => {
    const f = fakeFetch({ 'https://accounts.spotify.com/api/token': () => new Response('{}', { status: 400 }) });
    await expect(createSpotifyClient(cfg, f).exchangeCode('x')).rejects.toBeInstanceOf(SpotifyError);
  });
});

describe('Spotify library reads', () => {
  it('pages saved tracks up to 500 and maps them to Tracks', async () => {
    const calls: Call[] = [];
    const f = fakeFetch(
      {
        'https://api.spotify.com/v1/me/tracks': (u) => {
          const offset = Number(u.searchParams.get('offset'));
          const items = Array.from({ length: 50 }, (_, i) => ({ track: sTrack(offset + i) }));
          return { items, next: `https://api.spotify.com/v1/me/tracks?limit=50&offset=${offset + 50}` };
        },
      },
      calls,
    );
    const tracks = await createSpotifyClient(cfg, f).getSavedTracks('tok');
    expect(tracks).toHaveLength(500);
    expect(calls).toHaveLength(10);
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(tracks[0]).toEqual({
      id: 'id0',
      title: 'Song 0',
      artist: 'Artist 0',
      artistId: 'a0',
      spotifyUrl: 'https://open.spotify.com/track/id0',
      albumArtUrl: 'mid0',
      playRank: 0,
    });
    expect(tracks[499]!.playRank).toBe(499);
  });

  it('stops at the last page and skips local or missing tracks', async () => {
    const f = fakeFetch({
      'https://api.spotify.com/v1/me/tracks': () => ({
        items: [{ track: sTrack(1) }, { track: null }, { track: { ...sTrack(2), is_local: true, id: null } }, { track: sTrack(3) }],
        next: null,
      }),
    });
    const tracks = await createSpotifyClient(cfg, f).getSavedTracks('tok');
    expect(tracks.map((t) => [t.id, t.playRank])).toEqual([
      ['id1', 0],
      ['id3', 1],
    ]);
  });

  it('reads medium-term top tracks and the profile', async () => {
    let topUrl: URL | null = null;
    const f = fakeFetch({
      'https://api.spotify.com/v1/me/top/tracks': (u) => {
        topUrl = u;
        return { items: [sTrack(7), sTrack(8)] };
      },
      'https://api.spotify.com/v1/me': () => ({ id: 'user1', display_name: 'Ann' }),
    });
    const client = createSpotifyClient(cfg, f);
    const top = await client.getTopTracks('tok');
    expect(topUrl!.searchParams.get('time_range')).toBe('medium_term');
    expect(topUrl!.searchParams.get('limit')).toBe('50');
    expect(top.map((t) => t.id)).toEqual(['id7', 'id8']);
    expect(await client.getMe('tok')).toEqual({ id: 'user1', displayName: 'Ann' });
  });

  it('throws SpotifyError with the HTTP status on API errors', async () => {
    const f = fakeFetch({ 'https://api.spotify.com/v1/me': () => new Response('', { status: 401 }) });
    await expect(createSpotifyClient(cfg, f).getMe('tok')).rejects.toMatchObject({ status: 401 });
  });

  it('maps tracks without art', () => {
    expect(mapTrack({ ...sTrack(1), album: { images: [] } }, 3)).not.toHaveProperty('albumArtUrl');
    expect(mapTrack(null, 0)).toBeNull();
  });
});

describe('play rank merge', () => {
  const t = (id: string, playRank: number): Track => ({
    id,
    title: id,
    artist: 'A',
    artistId: 'a',
    spotifyUrl: '',
    playRank,
  });

  it('ranks top tracks first, then saved songs not in the top list in saved order', () => {
    const merged = mergeTracks([t('x', 0), t('y', 1)], [t('a', 0), t('y', 1), t('b', 2), t('x', 3)]);
    expect(merged.map((m) => [m.id, m.playRank])).toEqual([
      ['x', 0],
      ['y', 1],
      ['a', 2],
      ['b', 3],
    ]);
  });
});

describe('token refresh', () => {
  const user = { id: 'u', displayName: 'U', spotify: { accessToken: 'old', refreshToken: 'r', expiresAt: 1_000_000 } };

  it('keeps a token that is still valid', async () => {
    const store = createMemoryStore();
    const client = createMockSpotifyClient();
    expect(await ensureFreshTokens(user, client, store, 0)).toBe(user);
  });

  it('refreshes an expiring token and saves it', async () => {
    const store = createMemoryStore();
    const client = createMockSpotifyClient();
    const fresh = await ensureFreshTokens(user, client, store, 999_999);
    expect(fresh.spotify.accessToken).toBe('mock-access');
    expect((await store.getUser('u'))?.spotify.accessToken).toBe('mock-access');
  });
});

describe('mock Spotify client', () => {
  it('redirects straight to the callback and serves a fixed library', async () => {
    const c = createMockSpotifyClient();
    const url = new URL(c.authorizeUrl('s1', 'http://127.0.0.1:3000'));
    expect(url.pathname).toBe('/api/auth/callback');
    expect(url.searchParams.get('code')).toBe(MOCK_CODE);
    expect(url.searchParams.get('state')).toBe('s1');
    const tokens = await c.exchangeCode(MOCK_CODE);
    expect(await c.getMe(tokens.accessToken)).toEqual(MOCK_USER);
    const tracks = await getUserTracks(c, tokens.accessToken);
    expect(tracks.length).toBeGreaterThanOrEqual(20);
    expect(new Set(tracks.map((x) => x.id)).size).toBe(tracks.length);
    expect(tracks.map((x) => x.playRank)).toEqual(tracks.map((_, i) => i));
    const names = tracks.map((x) => `${x.artist} - ${x.title}`);
    for (const want of ['Queen - Bohemian Rhapsody', 'Omar Apollo - Evergreen', 'Whitney Houston', 'Journey', 'Justin Bieber']) {
      expect(names.some((n) => n.startsWith(want))).toBe(true);
    }
  });
});
