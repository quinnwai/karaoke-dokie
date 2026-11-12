import { describe, expect, it, vi } from 'vitest';
import { readSongGenres, shownGenre } from '../../src/lib/genres/genres';
import { createMemoryStore } from '../../src/lib/server/memoryStore';

describe('shownGenre (QWW-61)', () => {
  it("shows USDB's genre when the song has one, else Deezer's album genres, else none", () => {
    expect(shownGenre('Synthpop', 'Pop, Electro')).toBe('Synthpop'); // USDB's is the richer label
    expect(shownGenre('Synthpop', undefined)).toBe('Synthpop');
    expect(shownGenre(undefined, 'Pop, Electro')).toBe('Pop, Electro');
    expect(shownGenre(undefined, undefined)).toBeUndefined();
  });

  it('treats an empty USDB genre as none, so Deezer fills it, and never shows an empty one', () => {
    expect(shownGenre('', 'Rock')).toBe('Rock');
    expect(shownGenre('  ', 'Rock')).toBe('Rock');
    expect(shownGenre('', undefined)).toBeUndefined();
    expect(shownGenre(undefined, '')).toBeUndefined();
  });
});

describe('readSongGenres (QWW-61)', () => {
  const at = '2026-11-12T00:00:00.000Z';

  it("gives each key's Deezer genres, leaving out misses and keys with no row", async () => {
    const store = createMemoryStore();
    await store.putSongGenre([
      { key: 'wet leg|chaise longue', genres: 'Alternative, Rock', albumId: 1, source: 'deezer-album', checkedAt: at },
      { key: 'gone|track', source: 'deezer-album', checkedAt: at }, // a miss
    ]);
    const read = await readSongGenres(store, ['wet leg|chaise longue', 'gone|track', 'never|looked up']);
    expect(read).toEqual(new Map([['wet leg|chaise longue', 'Alternative, Rock']]));
  });

  it('reads nothing for no keys, and works with a store that has no genre method', async () => {
    const store = createMemoryStore();
    const getSongGenres = vi.spyOn(store, 'getSongGenres');
    expect(await readSongGenres(store, [])).toEqual(new Map());
    expect(getSongGenres).not.toHaveBeenCalled();
    expect(await readSongGenres({}, ['a|b'])).toEqual(new Map()); // a store with no genre method
  });

  it('reads a missing song_genre table as no genres, and throws any other failure', async () => {
    const store = createMemoryStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const err of [Object.assign(new Error('relation "song_genre" does not exist\nat somewhere'), { code: '42P01' }), new Error('relation "song_genre" does not exist')]) {
      vi.spyOn(store, 'getSongGenres').mockRejectedValueOnce(err);
      expect(await readSongGenres(store, ['a|b'])).toEqual(new Map());
    }
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).not.toContain('somewhere');
    warn.mockRestore();
    vi.spyOn(store, 'getSongGenres').mockRejectedValueOnce(new Error('fetch failed (timeout)'));
    await expect(readSongGenres(store, ['a|b'])).rejects.toThrow('fetch failed');
  });
});
