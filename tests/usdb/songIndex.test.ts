import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import type { UsdbSongRow } from '../../src/lib/usdb/client';
import { updateUsdbIndex } from '../../src/lib/usdb/songIndex';

/** A fake USDB with `n` songs; song i was last changed at time 1000 + i. */
function fakeList(n: number) {
  const songs: UsdbSongRow[] = Array.from({ length: n }, (_, i) => ({ id: i + 1, artist: `Artist ${i % 7}`, title: `Song ${i}`, views: i, lastChange: 1000 + i }));
  const calls: { order: string; descending: boolean; start: number }[] = [];
  return {
    songs,
    calls,
    usdb: {
      listSongs: async ({ order, descending = false, start }: { order: 'id' | 'lastchange'; descending?: boolean; start: number }) => {
        calls.push({ order, descending, start });
        const sorted = order === 'id' ? [...songs].sort((a, b) => a.id - b.id) : [...songs].sort((a, b) => b.lastChange! - a.lastChange!);
        return sorted.slice(start, start + 100);
      },
    },
  };
}

describe('updateUsdbIndex', () => {
  it('reads the whole list by id when the index is empty, stopping at the first short page', async () => {
    const store = createMemoryStore();
    const { usdb, calls } = fakeList(250);
    const summary = await updateUsdbIndex({ store, usdb });
    expect(summary).toEqual({ pages: 3, songs: 250, mode: 'full' });
    expect(calls.map((c) => c.start)).toEqual([0, 100, 200]);
    expect(calls.every((c) => c.order === 'id')).toBe(true);
    expect(await store.usdbIndexStats()).toEqual({ count: 250, newestChange: 1249 });
    expect((await store.findUsdbSongs(['artist 3|song 10'])).get('artist 3|song 10')?.id).toBe(11);
  });

  it('afterwards reads only songs changed since the newest one it has', async () => {
    const store = createMemoryStore();
    const list = fakeList(250);
    await updateUsdbIndex({ store, usdb: list.usdb });
    list.songs.push(...Array.from({ length: 150 }, (_, i) => ({ id: 251 + i, artist: 'New', title: `New ${i}`, lastChange: 2000 + i })));
    list.songs[0]!.lastChange = 3000; // an edited old song
    list.calls.length = 0;
    const summary = await updateUsdbIndex({ store, usdb: list.usdb });
    expect(summary.mode).toBe('update');
    expect(list.calls.every((c) => c.order === 'lastchange' && c.descending)).toBe(true);
    expect(list.calls).toHaveLength(2);
    expect((await store.usdbIndexStats()).count).toBe(400);
    expect((await store.findUsdbSongs(['artist 0|song 0'])).get('artist 0|song 0')?.lastChange).toBe(3000);
  });

  it('can be told to read everything again', async () => {
    const store = createMemoryStore();
    const list = fakeList(50);
    await updateUsdbIndex({ store, usdb: list.usdb });
    expect((await updateUsdbIndex({ store, usdb: list.usdb, full: true })).mode).toBe('full');
  });
});
