import { describe, expect, it } from 'vitest';
import type { Track } from '../../src/lib/contracts';
import { AuditStop, PACE_MS, parseArgs, readLibraryStrictly, slimListening, sourcesOf, UsageError } from '../../src/lib/report/identityAuditRun';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import type { FetchFn } from '../../src/lib/server/spotify';

const config = { clientId: 'cid', clientSecret: 'secret', redirectUri: '' };
const sTrack = (n: number) => ({
  id: `id${n}`,
  name: `Song ${n}`,
  artists: [{ id: 'a1', name: 'Artist' }, { id: 'a2', name: 'Guest' }],
  external_ids: { isrc: `XX000000${String(n).padStart(4, '0')}` },
  duration_ms: 200_000 + n,
});

async function storeWithUsers(...users: { id: string; name: string; expiresAt?: number }[]) {
  const store = createMemoryStore();
  for (const u of users) {
    await store.upsertUser({ id: u.id, displayName: u.name, spotify: { accessToken: 'tok', refreshToken: 'ref', expiresAt: u.expiresAt ?? Date.now() + 3_600_000 } });
  }
  return store;
}

/** A Spotify that answers the library reads; `override` can answer a path differently (e.g. with a 429). */
function fakeSpotify(override: (path: string, call: number) => Response | undefined = () => undefined) {
  const paths: string[] = [];
  const concurrency = { now: 0, max: 0 };
  const fetchFn: FetchFn = async (input) => {
    const url = new URL(input);
    paths.push(url.pathname);
    concurrency.now++;
    concurrency.max = Math.max(concurrency.max, concurrency.now);
    await new Promise((done) => setTimeout(done, 0)); // let any request that is not waiting its turn start
    concurrency.now--;
    const special = override(url.pathname, paths.length);
    if (special) return special;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/api/token') return json({ access_token: 'fresh', expires_in: 3600 });
    if (url.pathname === '/v1/me') return json({ id: 'me', display_name: 'Me' });
    if (url.pathname === '/v1/me/tracks') return json({ items: [{ track: sTrack(1) }, { track: sTrack(2) }], total: 2, next: null });
    if (url.pathname === '/v1/me/top/tracks') return json({ items: [sTrack(1)] });
    if (url.pathname === '/v1/me/player/recently-played') return json({ items: [{ track: sTrack(3) }] });
    if (url.pathname === '/v1/me/playlists') return json({ items: [{ id: 'p1', owner: { id: 'me' } }, { id: 'p2', owner: { id: 'me' } }], next: null });
    if (url.pathname.startsWith('/v1/playlists/')) return json({ items: [{ item: sTrack(4) }], next: null });
    return new Response('not found', { status: 404 });
  };
  return { fetchFn, paths, concurrency };
}
const read = async (over: Partial<Parameters<typeof readLibraryStrictly>[0]> & { fetchFn: FetchFn }, ...users: Parameters<typeof storeWithUsers>) =>
  readLibraryStrictly({ store: await storeWithUsers(...(users.length ? users : [{ id: 'u1', name: 'Ann' }])), config, paceMs: 0, ...over });

describe('readLibraryStrictly', () => {
  it('reads every list of the library, keeping ISRC, length and all credited artists, and counts the requests', async () => {
    const { fetchFn, paths } = fakeSpotify();
    const announced: string[] = [];
    const result = await read({ fetchFn, announce: (w) => announced.push(w) });
    expect(announced).toEqual(['Ann']);
    expect(result.who).toBe('Ann');
    expect(result.requests).toBe(paths.length);
    expect(result.problems).toEqual([]);
    expect(result.listening.saved).toHaveLength(2);
    expect(result.listening.playlists).toHaveLength(1); // the same song in two playlists is read once
    expect(result.listening.saved[0]).toMatchObject({ isrc: 'XX0000000001', durationMs: 200_001, artists: [{ id: 'a1', name: 'Artist' }, { id: 'a2', name: 'Guest' }] });
  });

  it('sends one request at a time, with a pause between them', async () => {
    const { fetchFn, concurrency } = fakeSpotify();
    const pauses: number[] = [];
    const result = await readLibraryStrictly({ store: await storeWithUsers({ id: 'u1', name: 'Ann' }), config, fetchFn, sleep: async (ms) => void pauses.push(ms) });
    expect(concurrency.max).toBe(1);
    expect(pauses).toHaveLength(result.requests - 1);
    expect(new Set(pauses)).toEqual(new Set([PACE_MS]));
    expect(PACE_MS).toBeGreaterThanOrEqual(200);
  });

  it('refreshes an expired token once, then reads', async () => {
    const { fetchFn, paths } = fakeSpotify();
    await read({ fetchFn }, { id: 'u1', name: 'Ann', expiresAt: 0 });
    expect(paths.filter((p) => p === '/api/token')).toHaveLength(1);
  });

  it('stops at the first 429 and sends no more requests, even when the client would skip the failed read', async () => {
    const { fetchFn, paths } = fakeSpotify((path) => (path.startsWith('/v1/playlists/') ? new Response('', { status: 429, headers: { 'retry-after': '85659' } }) : undefined));
    const run = read({ fetchFn });
    await expect(run).rejects.toThrow(AuditStop);
    await expect(run).rejects.toThrow(/HTTP 429 \(Retry-After 85659 s\)/);
    expect(paths.filter((p) => p.startsWith('/v1/playlists/'))).toHaveLength(1); // the second playlist was never requested
  });

  it('stops on a 429 from a core read too, and says so when Spotify sent no Retry-After', async () => {
    const { fetchFn } = fakeSpotify((path) => (path === '/v1/me/tracks' ? new Response('', { status: 429 }) : undefined));
    await expect(read({ fetchFn })).rejects.toThrow(/HTTP 429 \(no Retry-After given\)/);
  });

  it('counts every read that failed another way, so a partial library cannot look complete', async () => {
    const { fetchFn } = fakeSpotify((path) => (path === '/v1/playlists/p1/items' ? new Response('', { status: 500 }) : undefined));
    expect((await read({ fetchFn })).problems).toEqual(['1 x HTTP 500 on /v1/playlists/:id/items']);

    const denied = fakeSpotify((path) => (path === '/v1/me/player/recently-played' ? new Response('', { status: 403 }) : undefined));
    const result = await read({ fetchFn: denied.fetchFn });
    expect(result.problems).toEqual(['1 x HTTP 403 on /v1/me/player/recently-played']);
    expect(result.listening.recent).toEqual([]);
  });

  it('does not count the expected fallback from a playlist\'s /items to /tracks', async () => {
    const { fetchFn } = fakeSpotify((path) => (path.endsWith('/items') ? new Response('', { status: 404 }) : undefined));
    expect((await read({ fetchFn })).problems).toEqual([]);
  });

  it('counts a network failure, and still returns what it read', async () => {
    const { fetchFn } = fakeSpotify();
    const flaky: FetchFn = async (input, init) => {
      if (new URL(input).pathname === '/v1/playlists/p2/items') throw new TypeError('fetch failed');
      return fetchFn(input, init);
    };
    const result = await read({ fetchFn: flaky });
    expect(result.problems).toEqual(['1 x network error on /v1/playlists/:id/items']);
    expect(result.listening.saved).toHaveLength(2);
  });

  it('explains a refused sign-in, a revoked refresh token or bad app keys instead of calling it a rate limit', async () => {
    const top = fakeSpotify((path) => (path === '/v1/me/top/tracks' ? new Response('', { status: 401 }) : undefined));
    await expect(read({ fetchFn: top.fetchFn })).rejects.toThrow(/refused the saved sign-in or the app keys \(HTTP 401\)/);
    const revoked = fakeSpotify((path) => (path === '/api/token' ? new Response('', { status: 400 }) : undefined));
    await expect(read({ fetchFn: revoked.fetchFn }, { id: 'u1', name: 'Ann', expiresAt: 0 })).rejects.toThrow(/refused the saved sign-in or the app keys \(HTTP 400\)/);
  });

  it('refuses to guess which of several signed-in users to read, and lists them', async () => {
    const store = await storeWithUsers({ id: 'u1', name: 'Ann' }, { id: 'u2', name: 'Bob' });
    const { fetchFn, paths } = fakeSpotify();
    await expect(readLibraryStrictly({ store, config, fetchFn, paceMs: 0 })).rejects.toThrow(/u1 \(Ann\), u2 \(Bob\)/);
    expect(paths).toHaveLength(0);
    await expect(readLibraryStrictly({ store, config, fetchFn, paceMs: 0, userId: 'u2' })).resolves.toMatchObject({ who: 'Bob' });
  });

  it('stops before any request when there is no user, no such user or no Spotify keys', async () => {
    const { fetchFn, paths } = fakeSpotify();
    await expect(readLibraryStrictly({ store: createMemoryStore(), config, fetchFn })).rejects.toThrow('No signed-in users yet');
    await expect(readLibraryStrictly({ store: createMemoryStore(), config, fetchFn, userId: 'nobody' })).rejects.toThrow('No user nobody');
    await expect(readLibraryStrictly({ store: await storeWithUsers({ id: 'u1', name: 'Ann' }), config: { ...config, clientSecret: '' }, fetchFn })).rejects.toThrow(/SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET/);
    expect(paths).toHaveLength(0);
  });
});

describe('parseArgs', () => {
  it('reads value flags, boolean flags and one user id', () => {
    const { flags, userId } = parseArgs(['me', '--env', 'x.env', '--out', 'dir', '--library', 'l.json', '--refresh', '--no-database']);
    expect(userId).toBe('me');
    expect(Object.fromEntries(flags)).toEqual({ '--env': 'x.env', '--out': 'dir', '--library': 'l.json', '--refresh': true, '--no-database': true });
    expect(parseArgs([]).userId).toBeUndefined();
  });

  it('rejects an unknown flag, a flag without its value and a second user id', () => {
    expect(() => parseArgs(['--verbose'])).toThrow(UsageError);
    expect(() => parseArgs(['--out'])).toThrow('--out needs a value');
    expect(() => parseArgs(['--out', '--refresh'])).toThrow('--out needs a value');
    expect(() => parseArgs(['a', 'b'])).toThrow('Give at most one Spotify user id');
  });
});

describe('the saved library', () => {
  const full: Track = { id: 't', title: 'S', artist: 'A', artistId: 'a', spotifyUrl: 'https://open.spotify.com/t', albumArtUrl: 'img', playRank: 3, familiarity: 0.9, known: true, popularity: 50, isrc: 'XX1', durationMs: 200_000, artists: [{ id: 'a', name: 'A' }] };

  it('keeps only what the audit needs of each track', () => {
    const slim = slimListening({ top: { short_term: [full] }, recent: [full], saved: [full], playlists: [full] });
    expect(slim.saved[0]).toEqual({ id: 't', title: 'S', artist: 'A', artistId: 'a', spotifyUrl: '', playRank: 3, popularity: 50, isrc: 'XX1', durationMs: 200_000, artists: [{ id: 'a', name: 'A' }] });
    expect(slim.top.short_term).toHaveLength(1);
    expect(slimListening({ top: {}, recent: [], saved: [] }).playlists).toEqual([]);
  });

  it('names the library\'s lists for the per-list coverage, with the spans the right way round', () => {
    const [a, b, c] = [{ ...full, id: 'a' }, { ...full, id: 'b' }, { ...full, id: 'c' }];
    const names = Object.fromEntries(sourcesOf({ top: { short_term: [a], medium_term: [b], long_term: [c] }, recent: [], saved: [], playlists: [] }).map((s) => [s.name, s.tracks.map((t) => t.id)]));
    expect(names).toMatchObject({ 'top tracks, 4 weeks': ['a'], 'top tracks, 6 months': ['b'], 'top tracks, all time': ['c'] });
  });
});
