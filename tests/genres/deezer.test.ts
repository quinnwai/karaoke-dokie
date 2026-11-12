import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGenreClient, GENRE_SOURCE, RECHECK_DAYS, runGenreFetch, type Fetch } from '../../src/lib/genres/deezer';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import type { Store } from '../../src/lib/server/store';

// Deezer is stubbed in every test: the real fetch throws, so a test that reached the network would fail.
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('tests must not call the network');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

type Reply = { status?: number; body?: unknown };

/**
 * A stand-in for Deezer's API: tracks by id (their album id, or 'gone'), albums by id (their genre names, or 'gone').
 * `override` answers a path first (a quota error, a 403); every request is kept in `requests`.
 */
function fakeDeezer(tracks: Record<number, number | 'gone'>, albums: Record<number, string[] | 'gone'>, override?: (path: string) => Reply | undefined) {
  const requests: string[] = [];
  const noData = { error: { type: 'DataException', message: 'no data', code: 800 } };
  const fetch: Fetch = async (url) => {
    const path = url.replace('https://api.deezer.com/', '');
    requests.push(path);
    const [, kind, id] = path.match(/^(track|album)\/(\d+)$/) ?? [];
    const reply: Reply = override?.(path) ?? {
      body:
        kind === 'track'
          ? tracks[Number(id)] === undefined || tracks[Number(id)] === 'gone'
            ? noData
            : { id: Number(id), title: 'A Song', album: { id: tracks[Number(id)], title: 'An Album' } }
          : albums[Number(id)] === undefined || albums[Number(id)] === 'gone'
            ? noData
            : { id: Number(id), genre_id: 132, genres: { data: (albums[Number(id)] as string[]).map((name, i) => ({ id: i, name, type: 'genre' })) } },
    };
    const status = reply.status ?? 200;
    return { ok: status === 200, status, json: async () => reply.body };
  };
  return { requests, client: createGenreClient({ fetch, sleep: async () => {}, tries: 2 }) };
}

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-12T00:00:00.000Z');
const at = (ms: number) => () => new Date(ms);
const quiet = { log: () => {} };

/** A memory store with these songs matched to Deezer tracks (song_deezer), and USDB genres for some. */
async function storeWith(songs: { key: string; deezerId?: number; rank?: number; usdbGenre?: string }[]): Promise<Store> {
  const store = createMemoryStore();
  await store.putSongDeezer(songs.map((s) => ({ key: s.key, checkedAt: '2026-11-06T00:00:00.000Z', ...(s.deezerId !== undefined ? { deezerId: s.deezerId, rank: s.rank ?? 1000 } : {}) })));
  await store.putUsdbSongs(
    songs.flatMap((s, i) => (s.usdbGenre === undefined ? [] : [{ id: i + 1, key: s.key, artist: s.key.split('|')[0]!, title: s.key.split('|')[1]!, genre: s.usdbGenre }])),
  );
  return store;
}

describe('Deezer genre client (QWW-61)', () => {
  it("reads a track's album, and an album's genre names in Deezer's order", async () => {
    const { client, requests } = fakeDeezer({ 65759979: 6446668 }, { 6446668: ['Pop', ' Rock ', ''] });
    expect(await client.trackAlbum(65759979)).toBe(6446668);
    expect(await client.albumGenres(6446668)).toEqual(['Pop', 'Rock']); // trimmed, blanks dropped
    expect(requests).toEqual(['track/65759979', 'album/6446668']);
  });

  it('answers null for a track or album Deezer no longer has, and an empty list for an album with no genres', async () => {
    const { client } = fakeDeezer({ 1: 'gone' }, { 2: 'gone', 3: [] });
    expect(await client.trackAlbum(1)).toBeNull();
    expect(await client.albumGenres(2)).toBeNull();
    expect(await client.albumGenres(3)).toEqual([]);
  });

  it('waits out a quota error and asks again, and gives up at once when the CDN refuses us (403)', async () => {
    let quota = 1;
    const { client, requests } = fakeDeezer({ 5: 50 }, {}, (path) => {
      if (path === 'track/5' && quota-- > 0) return { body: { error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } } };
      if (path === 'album/50') return { status: 403 };
      return undefined;
    });
    expect(await client.trackAlbum(5)).toBe(50);
    expect(requests).toEqual(['track/5', 'track/5']);
    await expect(client.albumGenres(50)).rejects.toThrow('HTTP 403');
    expect(requests.filter((r) => r === 'album/50')).toHaveLength(1);
  });
});

describe('npm run genres:deezer (runGenreFetch, QWW-61)', () => {
  it('writes each song the genres of its track\'s album, joined by ", ", and a miss row when there are none', async () => {
    const store = await storeWith([
      { key: 'wet leg|chaise longue', deezerId: 1 },
      { key: 'gone|track', deezerId: 2 },
      { key: 'gone|album', deezerId: 3 },
      { key: 'no|genres', deezerId: 4 },
      { key: 'never|matched' }, // a Deezer miss: no track to read
    ]);
    const { client } = fakeDeezer({ 1: 100, 2: 'gone', 3: 300, 4: 400 }, { 100: ['Alternative', 'Rock'], 300: 'gone', 400: [] });
    const result = await runGenreFetch(store, client, { now: at(T0), ...quiet });
    expect(result).toMatchObject({ songs: 4, todo: 4, hits: 1, misses: 3, errors: 0 });
    const checkedAt = new Date(T0).toISOString();
    const rows = await store.listSongGenres();
    expect(rows.get('wet leg|chaise longue')).toStrictEqual({ key: 'wet leg|chaise longue', genres: 'Alternative, Rock', albumId: 100, source: GENRE_SOURCE, checkedAt });
    expect(rows.get('gone|track')).toStrictEqual({ key: 'gone|track', source: GENRE_SOURCE, checkedAt }); // no album, no genres
    expect(rows.get('gone|album')).toStrictEqual({ key: 'gone|album', albumId: 300, source: GENRE_SOURCE, checkedAt });
    expect(rows.get('no|genres')).toStrictEqual({ key: 'no|genres', albumId: 400, source: GENRE_SOURCE, checkedAt });
    expect(rows.has('never|matched')).toBe(false);
  });

  it('reads each album once, however many songs are on it, songs looked up at the same time included', async () => {
    // seven songs on album 100, more than are looked up at a time, and one on album 200
    const songs = Array.from({ length: 7 }, (_, i) => ({ key: `artist|song ${i}`, deezerId: i + 1 }));
    const store = await storeWith([...songs, { key: 'other|song', deezerId: 99 }]);
    const tracks = Object.fromEntries([...songs.map((s) => [s.deezerId, 100]), [99, 200]]);
    const { client, requests } = fakeDeezer(tracks, { 100: ['Pop'], 200: ['Jazz'] });
    const result = await runGenreFetch(store, client, { now: at(T0), ...quiet });
    expect(requests.filter((r) => r === 'album/100')).toHaveLength(1);
    expect(requests.filter((r) => r === 'album/200')).toHaveLength(1);
    expect(requests.filter((r) => r.startsWith('track/'))).toHaveLength(8);
    expect(result).toMatchObject({ hits: 8, albumsRead: 2 });
    expect([...(await store.listSongGenres()).values()].map((g) => g.genres)).toEqual([...Array(7).fill('Pop'), 'Jazz']);
  });

  it('reuses album genres an earlier run found: a song on that album needs only its track read', async () => {
    const store = await storeWith([
      { key: 'a|first', deezerId: 1, rank: 900 },
      { key: 'a|second', deezerId: 2, rank: 100 },
    ]);
    const first = fakeDeezer({ 1: 100, 2: 100 }, { 100: ['Rock'] });
    await runGenreFetch(store, first.client, { limit: 1, now: at(T0), ...quiet });
    expect(first.requests).toEqual(['track/1', 'album/100']);
    const second = fakeDeezer({ 1: 100, 2: 100 }, { 100: ['Rock'] });
    const result = await runGenreFetch(store, second.client, { now: at(T0), ...quiet });
    expect(second.requests).toEqual(['track/2']);
    expect(result).toMatchObject({ hits: 1, albumsRead: 0 });
    expect((await store.listSongGenres()).get('a|second')?.genres).toBe('Rock');
  });

  it('is idempotent: a rerun has nothing due, asks Deezer nothing and writes nothing', async () => {
    const store = await storeWith([
      { key: 'a|hit', deezerId: 1 },
      { key: 'a|miss', deezerId: 2 },
    ]);
    const { client, requests } = fakeDeezer({ 1: 100, 2: 'gone' }, { 100: ['Pop'] });
    await runGenreFetch(store, client, { now: at(T0), ...quiet });
    const before = requests.length;
    const rows = await store.listSongGenres();
    const putSongGenre = vi.spyOn(store, 'putSongGenre');
    const rerun = await runGenreFetch(store, client, { now: at(T0 + 60_000), ...quiet });
    expect(rerun).toMatchObject({ due: [], todo: 0, hits: 0, misses: 0, errors: 0, albumsRead: 0 });
    expect(requests).toHaveLength(before);
    expect(putSongGenre).not.toHaveBeenCalled();
    expect(await store.listSongGenres()).toEqual(rows);
  });

  it(`asks again about a miss after ${RECHECK_DAYS} days, and never about a song whose genres it has`, async () => {
    const store = await storeWith([
      { key: 'a|hit', deezerId: 1 },
      { key: 'a|miss', deezerId: 2 },
    ]);
    const { client } = fakeDeezer({ 1: 100, 2: 200 }, { 100: ['Pop'], 200: [] });
    await runGenreFetch(store, client, { now: at(T0), ...quiet });
    expect((await runGenreFetch(store, client, { dryRun: true, now: at(T0 + (RECHECK_DAYS - 1) * DAY), ...quiet })).due).toEqual([]);
    const later = await runGenreFetch(store, client, { dryRun: true, now: at(T0 + (RECHECK_DAYS + 1) * DAY), ...quiet });
    expect(later.due.map((s) => s.key)).toEqual(['a|miss']);
  });

  it('looks up the songs USDB gives no genre first, the most popular first, and --limit takes them from the top', async () => {
    const store = await storeWith([
      { key: 'named|popular', deezerId: 1, rank: 900_000, usdbGenre: 'Rock' },
      { key: 'blank|named', deezerId: 2, rank: 1_000, usdbGenre: ' ' }, // an empty USDB genre is none
      { key: 'unnamed|less popular', deezerId: 3, rank: 50_000 },
      { key: 'unnamed|popular', deezerId: 4, rank: 700_000 },
    ]);
    const { client, requests } = fakeDeezer({ 1: 10, 2: 20, 3: 30, 4: 40 }, { 10: ['Rock'], 20: ['Pop'], 30: ['Pop'], 40: ['Pop'] });
    const dry = await runGenreFetch(store, client, { dryRun: true, ...quiet });
    expect(dry.due.map((s) => s.key)).toEqual(['unnamed|popular', 'unnamed|less popular', 'blank|named', 'named|popular']);
    const run = await runGenreFetch(store, client, { limit: 2, ...quiet });
    expect(run.todo).toBe(2);
    expect([...(await store.listSongGenres()).keys()].sort()).toEqual(['unnamed|less popular', 'unnamed|popular']);
    expect(requests.filter((r) => r.startsWith('track/')).sort()).toEqual(['track/3', 'track/4']);
  });

  it('a dry run counts what is due and stops: nothing asked of Deezer, nothing written', async () => {
    const store = await storeWith([{ key: 'a|b', deezerId: 1 }, { key: 'c|d', deezerId: 2, usdbGenre: 'Pop' }, { key: 'e|f' }]);
    const { client, requests } = fakeDeezer({ 1: 100, 2: 100 }, { 100: ['Pop'] });
    const putSongGenre = vi.spyOn(store, 'putSongGenre');
    const lines: string[] = [];
    const result = await runGenreFetch(store, client, { dryRun: true, log: (l) => lines.push(l) });
    expect(result).toMatchObject({ songs: 2, todo: 0, hits: 0, misses: 0, errors: 0 });
    expect(result.due.map((s) => [s.key, s.usdbGenre])).toEqual([['a|b', false], ['c|d', true]]);
    expect(requests).toEqual([]);
    expect(putSongGenre).not.toHaveBeenCalled();
    expect(lines[0]).toBe('2 songs with a Deezer track: 0 done, 2 due (1 with no USDB genre, looked up first); dry run, nothing fetched or written');
  });

  it('reads a missing song_genre table as no rows (a dry run on a database the table has not reached), and throws any other failure', async () => {
    const store = await storeWith([{ key: 'a|b', deezerId: 1 }]);
    const { client } = fakeDeezer({}, {});
    vi.spyOn(store, 'listSongGenres').mockRejectedValueOnce(Object.assign(new Error('relation "song_genre" does not exist'), { code: '42P01' }));
    expect((await runGenreFetch(store, client, { dryRun: true, ...quiet })).due.map((s) => s.key)).toEqual(['a|b']);
    vi.spyOn(store, 'listSongGenres').mockRejectedValueOnce(new Error('fetch failed'));
    await expect(runGenreFetch(store, client, { dryRun: true, ...quiet })).rejects.toThrow('fetch failed');
  });

  it('records nothing for a failed lookup, so the next run tries it again', async () => {
    const store = await storeWith([{ key: 'a|flaky', deezerId: 1 }]);
    const down = fakeDeezer({ 1: 100 }, { 100: ['Pop'] }, (path) => (path === 'album/100' ? { status: 500 } : undefined));
    expect(await runGenreFetch(store, down.client, { ...quiet })).toMatchObject({ hits: 0, misses: 0, errors: 1 });
    expect((await store.listSongGenres()).size).toBe(0);
    const up = fakeDeezer({ 1: 100 }, { 100: ['Pop'] });
    expect(await runGenreFetch(store, up.client, { ...quiet })).toMatchObject({ hits: 1, errors: 0 });
    expect((await store.listSongGenres()).get('a|flaky')?.genres).toBe('Pop');
  });

  it('stops after 20 failures in a row, and starts no song after the deadline', async () => {
    const songs = Array.from({ length: 40 }, (_, i) => ({ key: `artist|song ${i}`, deezerId: i + 1 }));
    const refused = fakeDeezer({}, {}, () => ({ status: 403 }));
    const lines: string[] = [];
    const stopped = await runGenreFetch(await storeWith(songs), refused.client, { log: (l) => lines.push(l) });
    expect(stopped.errors).toBeGreaterThanOrEqual(20);
    expect(stopped.errors).toBeLessThan(40);
    expect(lines.at(-1)).toMatch(/stopped after \d+ failures in a row; \d+ left, run again to carry on$/);

    const late = fakeDeezer({}, {});
    const result = await runGenreFetch(await storeWith(songs), late.client, { deadline: Date.now() - 1, ...quiet });
    expect(result).toMatchObject({ todo: 40, hits: 0, misses: 0, errors: 0 });
    expect(late.requests).toEqual([]);
  });
});
