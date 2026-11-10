// QWW-55 PR 2: the stored library and its incremental sync, from a fake Spotify Web API that counts its requests.
// Acceptance: a return visit makes at most 5 requests; after one QUOTA_EXCEEDED 429, 10 loads make 0; a script without
// --live makes 0 real requests; a song un-liked on Spotify is gone after the next sync; disconnect deletes the rows.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disconnectUser,
  IDLE_DELETE_MS,
  INCREMENTAL_BUDGET,
  loadLibrary,
  purgeIdleLibraries,
  resetPurgeForTests,
  TOP_REFRESH_MS,
} from '../../src/lib/server/library';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { readScriptLibrary } from '../../src/lib/server/scriptLibrary';
import { createSpotifyClient } from '../../src/lib/server/spotify';
import { countingFetch, utcDay, withCaller } from '../../src/lib/server/spotifyCalls';
import type { UserRecord } from '../../src/lib/server/store';
import { fakeSpotify, type FakeSpotify } from '../helpers/fakeSpotify';

const cfg = { clientId: 'x', clientSecret: 'y', redirectUri: 'http://localhost/cb' };
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const user: UserRecord = { id: 'real-singer', displayName: 'Real Singer', spotify: { accessToken: 'tok', refreshToken: 'ref', expiresAt: NOW + 400 * DAY } };

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  resetPurgeForTests();
});
afterEach(() => vi.restoreAllMocks());

function setup(liked = 120) {
  const store = createMemoryStore();
  const fake = fakeSpotify({ liked });
  const spotify = createSpotifyClient(cfg, countingFetch(fake.fetch, store, () => NOW), async () => {});
  const visit = async (at = NOW) => {
    const before = fake.apiRequests().length;
    const tracks = await loadLibrary(user, { store, spotify, sleep: async () => {} }, at);
    return { tracks, calls: fake.apiRequests().length - before };
  };
  return { store, fake, spotify, visit };
}

const ids = (tracks: { id: string }[]) => new Set(tracks.map((t) => t.id));
const likedIds = (fake: FakeSpotify) => fake.liked.map((i) => (i < 25 ? undefined : `filler-${i}`)).filter(Boolean) as string[];

describe('the first read', () => {
  it('reads every liked song, however many: there is no cap', async () => {
    const { fake, visit, store } = setup(1750);
    const { tracks } = await visit();
    const stored = await store.listSavedTracks(user.id);
    expect(stored).toHaveLength(1750);
    for (const id of likedIds(fake)) expect(ids(tracks).has(id)).toBe(true);
    expect(tracks.length).toBeGreaterThanOrEqual(1750);
    // 35 pages of liked songs, 3 top lists, recent plays, the playlist list and its one playlist.
    expect(fake.apiRequests()).toHaveLength(35 + 3 + 1 + 1 + 1);
  });

  it('keeps what it got when it is cut off, serves it, and resumes on the next visit', async () => {
    const { fake, visit, store } = setup(1000);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.shortLimit = { match: 'offset=500', times: 99, retryAfter: 2 }; // a rate limit that outlasts the retries
    const cut = await visit();
    expect(cut.tracks.length).toBeGreaterThan(0); // the stored part is served, not an error
    const part = (await store.listSavedTracks(user.id)).length;
    expect(part).toBe(300); // the first page and one group of five pages; the group holding offset 500 failed as a whole
    expect(part).toBeLessThan(1000);
    expect((await store.getLibraryState(user.id))!.state.savedComplete).toBe(false);

    fake.shortLimit = null;
    const resumed = await visit();
    expect(await store.listSavedTracks(user.id)).toHaveLength(1000);
    expect((await store.getLibraryState(user.id))!.state.savedComplete).toBe(true);
    expect(resumed.calls).toBeLessThan(25); // the second half, not all 20 pages again plus the rest
  });
});

describe('a return visit', () => {
  it('makes at most 5 requests, and with nothing changed only the likes check and the playlist list', async () => {
    const { visit, fake } = setup();
    await visit();
    const same = await visit(NOW + HOUR);
    expect(same.calls).toBe(2);
    expect(fake.apiRequests().slice(-2)).toEqual(['GET /v1/me/tracks?limit=50&offset=0', 'GET /v1/me/playlists?limit=50']);
  });

  it('stays within the budget on the first visit of a new day, when the top lists and recent plays are due, and finishes the rest on the next', async () => {
    const { visit, store, fake } = setup();
    await visit();
    const day2 = await visit(NOW + TOP_REFRESH_MS + HOUR);
    expect(day2.calls).toBe(INCREMENTAL_BUDGET); // likes check, three top lists, recent plays
    const state = (await store.getLibraryState(user.id))!.state;
    expect(state.top.long_term!.at).toBe(NOW + TOP_REFRESH_MS + HOUR);
    expect(state.recent!.at).toBe(NOW + TOP_REFRESH_MS + HOUR);
    expect(fake.apiRequests().slice(-5).some((r) => r.includes('/me/playlists'))).toBe(false); // the playlist check waited for the next visit
    const next = await visit(NOW + TOP_REFRESH_MS + 2 * HOUR);
    expect(next.calls).toBe(2); // likes check, playlist list
  });

  it('adds a song liked since, in a likes check and nothing more', async () => {
    const { visit, fake } = setup();
    const first = await visit();
    const added = fake.like();
    const again = await visit(NOW + HOUR);
    expect(again.calls).toBe(2);
    expect(ids(again.tracks).has(`filler-${added}`)).toBe(true);
    expect(again.tracks.length).toBe(first.tracks.length + 1);
  });

  it('drops a song un-liked on Spotify at the next sync, wherever it is in the list', async () => {
    const { visit, fake, store } = setup();
    const first = await visit();
    const gone = fake.liked[100]!; // far down, past the first page
    fake.unlike(gone);
    expect(ids(first.tracks).has(`filler-${gone}`)).toBe(true);
    const again = await visit(NOW + HOUR);
    expect(ids(again.tracks).has(`filler-${gone}`)).toBe(false);
    expect((await store.listSavedTracks(user.id)).map((t) => t.id)).not.toContain(`filler-${gone}`);
    expect(await store.listSavedTracks(user.id)).toHaveLength(119);
    // The count is settled: the visit after is a plain likes check again.
    expect((await visit(NOW + 2 * HOUR)).calls).toBe(2);
  });

  it('finds one un-like in a library of 11,139 likes without any visit going over 5 requests, and drops it when the check pass ends', async () => {
    const { visit, fake, store } = setup(11_139);
    const first = await visit();
    expect(first.calls).toBeGreaterThan(200); // the first read is the one visit that is not limited
    const gone = fake.liked[6000]!;
    fake.unlike(gone);
    let at = NOW;
    let visits = 0;
    let removedAt = 0;
    const calls: number[] = [];
    while (visits < 120) {
      visits++;
      at += 60_000;
      const v = await visit(at);
      calls.push(v.calls);
      if (!ids(v.tracks).has(`filler-${gone}`)) {
        removedAt = visits;
        break;
      }
    }
    expect(Math.max(...calls)).toBeLessThanOrEqual(INCREMENTAL_BUDGET);
    expect(removedAt).toBeGreaterThan(1); // spread over visits, not in one
    expect(removedAt).toBeLessThan(120);
    expect(await store.listSavedTracks(user.id)).toHaveLength(11_138);
    expect((await store.getLibraryState(user.id))!.state.verify).toBeNull();
    // Afterwards a visit is a plain likes check again.
    expect((await visit(at + 60_000)).calls).toBe(2);
  });

  it('one like and one un-like between visits (the count does not move) is still found', async () => {
    const { visit, fake, store } = setup(120);
    await visit();
    const gone = fake.liked[30]!;
    fake.unlike(gone);
    const added = fake.like();
    const again = await visit(NOW + HOUR);
    expect(ids(again.tracks).has(`filler-${added}`)).toBe(true);
    expect(ids(again.tracks).has(`filler-${gone}`)).toBe(false);
    expect(await store.listSavedTracks(user.id)).toHaveLength(120);
  });

  it('counts real requests: more than 50 playlists, all changed, never take a visit over 5', async () => {
    const { visit, fake } = setup(60);
    fake.playlistCount = 120;
    await visit(); // the first read
    fake.playlist.snapshotId = 'snap-2';
    const perVisit: number[] = [];
    for (let i = 1; i <= 5; i++) perVisit.push((await visit(NOW + i * 60_000)).calls);
    expect(Math.max(...perVisit)).toBeLessThanOrEqual(INCREMENTAL_BUDGET);
    expect(perVisit[0]).toBe(5); // likes check, three pages of playlists, one playlist's songs
  });

  it('drops every liked song when the user has un-liked them all', async () => {
    const { visit, fake, store } = setup(60);
    await visit();
    for (const i of [...fake.liked]) fake.unlike(i);
    await visit(NOW + HOUR);
    expect(await store.listSavedTracks(user.id)).toEqual([]);
  });

  it('reads a playlist only when its snapshot_id changed', async () => {
    const { visit, fake } = setup();
    await visit();
    const playlistReads = () => fake.apiRequests().filter((r) => r.includes('/playlists/p1')).length;
    expect(playlistReads()).toBe(1);
    await visit(NOW + HOUR);
    expect(playlistReads()).toBe(1);
    fake.playlist.snapshotId = 'snap-2';
    fake.playlist.items = [15, 16, 17];
    const changed = await visit(NOW + 2 * HOUR);
    expect(playlistReads()).toBe(2);
    expect(changed.tracks.filter((t) => t.inPlaylist)).toHaveLength(3);
  });
});

describe('after Spotify says wait', () => {
  it('makes no request on 10 more loads after one QUOTA_EXCEEDED 429, and serves the stored library', async () => {
    const { visit, fake, store } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = await visit();
    fake.quota.on = true;
    const hit = await visit(NOW + TOP_REFRESH_MS + HOUR); // the first request of this visit gets the 429
    expect(hit.calls).toBe(1);
    expect(hit.tracks).toHaveLength(first.tracks.length);
    expect(await store.getSpotifyBlock()).toBeGreaterThan(NOW + 12_000_000);
    const spent = fake.requests.length;
    for (let i = 0; i < 10; i++) {
      const load = await visit(NOW + TOP_REFRESH_MS + HOUR + (i + 1) * 60_000);
      expect(load.tracks).toHaveLength(first.tracks.length);
    }
    expect(fake.requests).toHaveLength(spent);
  });

  it('gives a user with nothing stored an error for the route to answer with the catalogue, still without a request', async () => {
    const { visit, fake, store } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await store.setSpotifyBlock(NOW + 3 * HOUR);
    for (let i = 0; i < 10; i++) await expect(visit()).rejects.toThrow(/asked the app to wait/);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('when the stored state cannot be read', () => {
  it('is an error and writes nothing, so a stored library is not replaced by a new first read', async () => {
    const { visit, store, fake } = setup();
    await visit();
    vi.spyOn(store, 'getLibraryState').mockRejectedValue(new Error('connection reset'));
    const put = vi.spyOn(store, 'putLibraryState');
    const before = fake.requests.length;
    await expect(visit(NOW + HOUR)).rejects.toThrow('connection reset');
    expect(put).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(before);
  });
});

describe('a library that changes while it is read', () => {
  it('drops nothing when the read does not account for every liked item', async () => {
    const { visit, store, fake } = setup(120);
    await visit();
    const before = (await store.listSavedTracks(user.id)).length;
    // Spotify counts 3 more liked items than the pages hold (a song moved across a page boundary and was missed).
    const real = fake.fetch;
    fake.fetch = async (input, init) => {
      const res = await real(input, init);
      if (!new URL(input).pathname.endsWith('/me/tracks')) return res;
      const body = (await res.json()) as { total: number };
      return new Response(JSON.stringify({ ...body, total: body.total + 3 }), { status: 200 });
    };
    const spotify = createSpotifyClient(cfg, fake.fetch, async () => {});
    fake.unlike(fake.liked[5]!); // so the count no longer matches and the likes are read in full
    await loadLibrary(user, { store, spotify, sleep: async () => {} }, NOW + HOUR);
    expect((await store.listSavedTracks(user.id)).length).toBe(before); // the un-liked song is kept for now, none dropped by mistake
  });
});

describe('Spotify terms', () => {
  it('disconnect deletes the stored library', async () => {
    const { visit, store } = setup();
    await visit();
    expect((await store.listSavedTracks(user.id)).length).toBeGreaterThan(0);
    await disconnectUser(store, user.id);
    expect(await store.listSavedTracks(user.id)).toEqual([]);
    expect(await store.getLibraryState(user.id)).toBeNull();
  });

  it('deletes a library after 30 days without a visit, and keeps one seen since', async () => {
    const { visit, store } = setup();
    await visit();
    await store.putSavedTracks('idle-user', [{ track: { id: 't', title: 'T', artist: 'A', artistId: 'a', spotifyUrl: '', playRank: 0 }, pos: 1 }]);
    await store.putLibraryState('idle-user', (await store.getLibraryState(user.id))!.state, NOW - IDLE_DELETE_MS - HOUR);
    resetPurgeForTests(); // the visit above ran the hourly purge
    expect(await purgeIdleLibraries(store, NOW)).toBe(1);
    expect(await store.listSavedTracks('idle-user')).toEqual([]);
    expect(await store.getLibraryState('idle-user')).toBeNull();
    expect((await store.listSavedTracks(user.id)).length).toBeGreaterThan(0);
  });

  it('never deletes the library of the user who is visiting, even one not seen for 40 days', async () => {
    const { visit, store } = setup();
    await visit();
    const kept = (await store.listSavedTracks(user.id)).length;
    resetPurgeForTests();
    const back = await visit(NOW + 40 * DAY);
    expect(back.tracks.length).toBeGreaterThanOrEqual(kept);
    expect(back.calls).toBeLessThanOrEqual(INCREMENTAL_BUDGET); // an incremental sync, not a new first read
    expect(await store.listSavedTracks(user.id)).toHaveLength(kept);
    expect((await store.getLibraryState(user.id))!.lastSeenAt).toBe(NOW + 40 * DAY);
  });

  it('a visit counts as a visit: a library seen every few weeks is never deleted', async () => {
    const { visit, store } = setup();
    await visit();
    await visit(NOW + 20 * DAY);
    resetPurgeForTests();
    expect(await purgeIdleLibraries(store, NOW + 40 * DAY)).toBe(0); // last seen 20 days before
  });
});

describe('requests counted per day and caller', () => {
  it('counts Web API requests (not the token endpoint) for the caller that made them', async () => {
    const { fake, store, spotify } = setup();
    await withCaller('site:/api/recommendations', () => loadLibrary(user, { store, spotify, sleep: async () => {} }, NOW));
    await withCaller('script:usdb-sync', () => spotify.getMe('tok'));
    await spotify.getMe('tok');
    const rows = await store.listSpotifyCalls(utcDay(NOW));
    expect(rows).toEqual([
      { day: '2026-11-10', caller: 'script:usdb-sync', calls: 1 },
      { day: '2026-11-10', caller: 'site:/api/recommendations', calls: fake.apiRequests().length - 2 },
      { day: '2026-11-10', caller: 'unknown', calls: 1 },
    ]);
  });
});

describe('scripts', () => {
  const opts = (fake: FakeSpotify, argv: string[], store = createMemoryStore()) => ({ script: 'usdb-sync', argv, env: {}, store, fetch: fake.fetch });

  it('without --live make no real request: the offline mock', async () => {
    const fake = fakeSpotify();
    const { tracks, source } = await readScriptLibrary(user, opts(fake, []));
    expect(source).toBe('mock');
    expect(tracks.length).toBeGreaterThan(0);
    expect(fake.requests).toHaveLength(0);
  });

  it('without --live read a saved snapshot when given one, still with no request', async () => {
    const fake = fakeSpotify();
    const dir = await mkdtemp(join(tmpdir(), 'snapshot-'));
    const file = join(dir, 'library.json');
    await writeFile(file, JSON.stringify([{ id: 's1', title: 'Song', artist: 'Artist', artistId: 'a1', spotifyUrl: '', playRank: 0 }]));
    const { tracks, source } = await readScriptLibrary(user, opts(fake, ['--snapshot', file]));
    expect(source).toBe('snapshot');
    expect(tracks.map((t) => t.id)).toEqual(['s1']);
    await expect(readScriptLibrary(user, { ...opts(fake, []), env: { SPOTIFY_SNAPSHOT: file } })).resolves.toMatchObject({ source: 'snapshot' });
    expect(fake.requests).toHaveLength(0);
  });

  it('with --live read the stored library from Spotify, count the requests under the script, and can save a snapshot', async () => {
    const fake = fakeSpotify({ liked: 80 });
    const store = createMemoryStore();
    const dir = await mkdtemp(join(tmpdir(), 'snapshot-'));
    const file = join(dir, 'out.json');
    const { tracks, source } = await readScriptLibrary(user, opts(fake, ['--live', '--save-snapshot', file], store));
    expect(source).toBe('live');
    expect(tracks.length).toBeGreaterThanOrEqual(80);
    expect(fake.apiRequests().length).toBeGreaterThan(0);
    const rows = await store.listSpotifyCalls();
    expect(rows).toEqual([{ day: utcDay(), caller: 'script:usdb-sync', calls: fake.apiRequests().length }]);
    const again = await readScriptLibrary(user, opts(fake, ['--snapshot', file]));
    expect(again.tracks).toHaveLength(tracks.length);
  });
});
