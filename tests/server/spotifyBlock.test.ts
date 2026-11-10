// QWW-55: after Spotify says wait (on 10 Nov 2026: 429, reason QUOTA_EXCEEDED, retry-after 12098 s, to the whole app for
// 3.4 hours) the app keeps "blocked until" in the store, where every server instance and every script reads it, and makes
// no request until it passes. The routes' side of this is in routes.test.ts; here is the rule and the shared read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import {
  assertSpotifyOpen,
  blockedUntilOf,
  createSpotifyClient,
  getUserTracks,
  noteSpotifyLimit,
  readUserTracks,
  SpotifyBlockedError,
  SpotifyError,
} from '../../src/lib/server/spotify';
import { fakeSpotify, QUOTA_BODY } from '../helpers/fakeSpotify';

const cfg = { clientId: 'x', clientSecret: 'y', redirectUri: 'http://localhost/cb' };
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const HOUR = 3_600_000;
const user = { id: 'u1', displayName: 'U', spotify: { accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 10 * HOUR } };

beforeEach(() => void vi.spyOn(console, 'info').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

const tooMany = (retryAfter?: string, detail = '') => new SpotifyError('Spotify API /me failed (429)', 429, detail, retryAfter);

describe('what makes a block', () => {
  it('is a 429 with reason QUOTA_EXCEEDED, for as long as Spotify says', () => {
    expect(blockedUntilOf(tooMany('12098', QUOTA_BODY), NOW)).toBe(NOW + 12_098_000);
    expect(blockedUntilOf(tooMany('85029', QUOTA_BODY), NOW)).toBe(NOW + 85_029_000);
    expect(blockedUntilOf(tooMany('5', QUOTA_BODY), NOW)).toBe(NOW + 5_000); // what Spotify says, even when short
  });

  it('is an hour when a quota 429 says nothing about how long, or says it unreadably', () => {
    for (const said of [undefined, '', '  ', 'soon', 'Wed, 21 Oct 2026 07:28:00 GMT', '-5']) {
      expect(blockedUntilOf(tooMany(said, QUOTA_BODY), NOW), JSON.stringify(said)).toBe(NOW + HOUR);
    }
  });

  it('is any other 429 with a Retry-After over 30 s', () => {
    expect(blockedUntilOf(tooMany('31', '{"error":{"status":429}}'), NOW)).toBe(NOW + 31_000);
    expect(blockedUntilOf(tooMany('48000'), NOW)).toBe(NOW + 48_000_000);
  });

  it('is not a plain rate limit of 30 s or less, which a request waits out itself, nor a 429 that says nothing', () => {
    for (const said of ['30', '10', '2', '0', undefined, '', 'soon']) {
      expect(blockedUntilOf(tooMany(said, '{"error":{"status":429,"message":"rate limit"}}'), NOW), JSON.stringify(said)).toBeNull();
    }
  });

  it('is never more than a day, so a bogus value cannot lock the app for good', () => {
    expect(blockedUntilOf(tooMany('999999999'), NOW)).toBe(NOW + 24 * HOUR);
    expect(blockedUntilOf(tooMany('999999999', QUOTA_BODY), NOW)).toBe(NOW + 24 * HOUR);
  });

  it('is nothing for an error that is not a 429', () => {
    expect(blockedUntilOf(new SpotifyError('Spotify API /me failed (502)', 502), NOW)).toBeNull();
    expect(blockedUntilOf(new SpotifyError('Spotify API /me failed (403)', 403, QUOTA_BODY, '12098'), NOW)).toBeNull();
    expect(blockedUntilOf(new Error('fetch failed'), NOW)).toBeNull();
    expect(blockedUntilOf('429', NOW)).toBeNull();
  });

  it('reads a quota 429 from the token endpoint too, which used to lose its Retry-After', async () => {
    const f = async () => new Response(QUOTA_BODY, { status: 429, headers: { 'retry-after': '12098' } });
    const err = await createSpotifyClient(cfg, f).refresh('ref').catch((e) => e);
    expect(err).toMatchObject({ name: 'SpotifyError', status: 429, retryAfter: '12098' });
    expect(blockedUntilOf(err, NOW)).toBe(NOW + 12_098_000);
  });
});

describe('keeping and checking the block', () => {
  it('keeps what a 429 asked for and nothing for an error that is not one', async () => {
    const store = createMemoryStore();
    await noteSpotifyLimit(store, new Error('fetch failed'), NOW);
    await noteSpotifyLimit(store, tooMany('2'), NOW);
    expect(await store.getSpotifyBlock()).toBeNull();
    await noteSpotifyLimit(store, tooMany('12098', QUOTA_BODY), NOW);
    expect(await store.getSpotifyBlock()).toBe(NOW + 12_098_000);
    await noteSpotifyLimit(store, tooMany('40'), NOW); // a shorter wait arriving later never shortens it
    expect(await store.getSpotifyBlock()).toBe(NOW + 12_098_000);
  });

  it('throws before any request while the wait holds, and says until when; it is open the moment it ends', async () => {
    const store = createMemoryStore();
    await assertSpotifyOpen(store, NOW); // nothing kept
    await store.setSpotifyBlock(NOW + HOUR);
    const err = await assertSpotifyOpen(store, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(SpotifyBlockedError);
    expect(err.until).toBe(NOW + HOUR);
    expect(err.message).toBe('Spotify asked the app to wait until 2026-11-10T13:00:00.000Z; no request was made');
    await expect(assertSpotifyOpen(store, NOW + HOUR - 1)).rejects.toBeInstanceOf(SpotifyBlockedError);
    await expect(assertSpotifyOpen(store, NOW + HOUR)).resolves.toBeUndefined();
  });

  it('counts a block that cannot be read as none, and one more than a day away as a day', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { getSpotifyBlock: async () => Promise.reject(new Error('relation "spotify_block" does not exist')) };
    await expect(assertSpotifyOpen(broken, NOW)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('[spotify] could not read the rate limit: Error: relation "spotify_block" does not exist');
    // a clock that was a day and more ahead when it was written, or a hand-edited row
    const far = { getSpotifyBlock: async () => NOW + 30 * 24 * HOUR };
    const err = await assertSpotifyOpen(far, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(SpotifyBlockedError);
    expect(err.until).toBe(NOW + 24 * HOUR);
  });

  it('logs a block it could not keep and carries on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { setSpotifyBlock: async () => Promise.reject(new Error('read-only transaction')) };
    await expect(noteSpotifyLimit(broken, tooMany('12098', QUOTA_BODY), NOW)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('[spotify] could not keep the rate limit: Error: read-only transaction');
  });
});

describe('reading a library, for the site and for scripts', () => {
  const setup = (liked = 120) => {
    const spotify = fakeSpotify({ liked });
    const store = createMemoryStore();
    return { spotify, store, client: createSpotifyClient(cfg, spotify.fetch, async () => {}) };
  };

  it('reads exactly what getUserTracks reads: the library is not capped or trimmed by this', async () => {
    const { spotify, store, client } = setup(120);
    const tracks = await readUserTracks(store, client, user);
    // 3 top lists, the last plays, 3 pages of saved songs, then /me, the playlist list and the playlist.
    expect(spotify.apiRequests()).toHaveLength(3 + 1 + 3 + 3);
    const direct = fakeSpotify({ liked: 120 });
    expect(tracks).toEqual(await getUserTracks(createSpotifyClient(cfg, direct.fetch, async () => {}), user.spotify.accessToken));
  });

  it('makes no request at all while Spotify says wait, whoever asks: the site, a second instance, a script', async () => {
    const { spotify, store, client } = setup();
    await store.setSpotifyBlock(Date.now() + HOUR);
    await expect(readUserTracks(store, client, user)).rejects.toBeInstanceOf(SpotifyBlockedError);
    await expect(readUserTracks(store, createSpotifyClient(cfg, spotify.fetch, async () => {}), { ...user, id: 'u2' })).rejects.toBeInstanceOf(SpotifyBlockedError);
    expect(spotify.requests).toHaveLength(0);
  });

  it('keeps the wait after a quota 429 for everyone else, and a script sees it', async () => {
    const { spotify, store, client } = setup();
    spotify.quota.on = true;
    await expect(readUserTracks(store, client, user)).rejects.toMatchObject({ status: 429, retryAfter: '12098' });
    const spent = spotify.requests.length;
    expect(await store.getSpotifyBlock()).toBeGreaterThan(Date.now() + 12_000_000);
    spotify.quota.on = false;
    await expect(readUserTracks(store, client, { ...user, id: 'u2' })).rejects.toBeInstanceOf(SpotifyBlockedError);
    expect(spotify.requests).toHaveLength(spent);
  });

  it('keeps no wait for a rate limit of a few seconds, or for another failure', async () => {
    const { spotify, store, client } = setup();
    spotify.shortLimit = { match: '/me/top/tracks', times: 99, retryAfter: 2 };
    await expect(readUserTracks(store, client, user)).rejects.toMatchObject({ status: 429, retryAfter: '2' });
    expect(await store.getSpotifyBlock()).toBeNull();
    spotify.shortLimit = null;
    const down = createSpotifyClient(cfg, async (input) => (input.includes('/me/top/tracks') ? new Response('bad gateway', { status: 502 }) : spotify.fetch(input)), async () => {});
    await expect(readUserTracks(store, down, user)).rejects.toMatchObject({ status: 502 });
    expect(await store.getSpotifyBlock()).toBeNull();
    await expect(readUserTracks(store, client, user)).resolves.toBeDefined(); // and Spotify is asked again
  });
});
