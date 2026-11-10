import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { fillCatalogue } from '../../src/lib/usdb/fillCatalogue';

const noteFile = (pitches: number[]) =>
  `#TITLE:x\n#ARTIST:y\n#BPM:120\n#GAP:0\n${pitches.map((p, i) => `: ${i * 4} 4 ${p} la`).join('\n')}\nE\n`;
const log = { trackId: '', title: 't', artist: 'a', outcome: 'note-file' as const, reason: 'r', at: 'x' };

describe('fillCatalogue', () => {
  it('downloads songs without a note-file range, most-viewed first, once per song key', async () => {
    const store = createMemoryStore();
    await store.putUsdbSongs([
      { id: 1, key: 'a|one', artist: 'A', title: 'One', views: 10 },
      { id: 2, key: 'a|two', artist: 'A', title: 'Two', views: 500, rating: 4 },
      { id: 3, key: 'a|two', artist: 'A', title: 'Two (dupe)', views: 5 },
      { id: 4, key: 'a|known', artist: 'A', title: 'Known', views: 900 },
      { id: 5, key: 'a|bad', artist: 'A', title: 'Bad', views: 1 },
    ]);
    const known = { low: 50, high: 60, tessitura: 55, source: 'note-file' as const, confidence: 'high' as const, fastLyrics: false };
    await store.putSongRange('a|known', { range: known, log });
    const downloads: number[] = [];
    const usdb = { downloadById: async (id: number) => (downloads.push(id), id === 5 ? null : noteFile([0, 4, 7])) };

    const summary = await fillCatalogue({ store, usdb });
    expect(downloads).toEqual([2, 1, 5]);
    expect(summary).toEqual({ candidates: 3, stored: 2, failed: 1 });
    expect((await store.getSongRange('a|two'))!.range).toMatchObject({ usdbId: 2, usdbViews: 500, usdbRating: 4, source: 'note-file' });
    expect((await store.getSongRange('a|known'))!.range).toEqual(known);
    expect(await store.getSongRange('a|bad')).toBeNull();
  });

  it('replaces measured recordings and estimates with the note file', async () => {
    const store = createMemoryStore();
    await store.putUsdbSongs([
      { id: 1, key: 'a|recorded', artist: 'A', title: 'Recorded', views: 10 },
      { id: 2, key: 'a|guessed', artist: 'A', title: 'Guessed', views: 5 },
    ]);
    const base = { low: 50, high: 60, tessitura: 55, fastLyrics: false };
    await store.putSongRange('a|recorded', { range: { ...base, source: 'audio-full', confidence: 'high', method: 'm' }, log: { ...log, outcome: 'audio-full' } });
    await store.putSongRange('a|guessed', { range: { ...base, source: 'artist-typical', confidence: 'low' }, log: { ...log, outcome: 'artist-typical' } });
    const usdb = { downloadById: async () => noteFile([0, 4, 7]) };
    expect(await fillCatalogue({ store, usdb })).toEqual({ candidates: 2, stored: 2, failed: 0 });
    for (const key of ['a|recorded', 'a|guessed']) {
      expect((await store.getSongRange(key))!).toMatchObject({ range: { source: 'note-file', low: 60, high: 67 }, log: { outcome: 'note-file' } });
    }
  });

  it('stops after the limit, and a rerun picks up where it left off', async () => {
    const store = createMemoryStore();
    await store.putUsdbSongs([1, 2, 3].map((id) => ({ id, key: `a|${id}`, artist: 'A', title: String(id), views: 10 - id })));
    const downloads: number[] = [];
    const usdb = { downloadById: async (id: number) => (downloads.push(id), noteFile([0, 4])) };
    await fillCatalogue({ store, usdb, limit: 2 });
    await fillCatalogue({ store, usdb });
    expect(downloads).toEqual([1, 2, 3]);
  });

  it('with recheckFast, re-reads only flagged USDB songs and clears flags the rule no longer gives', async () => {
    const store = createMemoryStore();
    await store.putUsdbSongs([1, 2, 3].map((id) => ({ id, key: `a|${id}`, artist: 'A', title: String(id), views: 10 - id })));
    const base = { low: 50, high: 60, tessitura: 55, source: 'note-file' as const, confidence: 'high' as const };
    await store.putSongRange('a|1', { range: { ...base, fastLyrics: true, usdbId: 1 }, log });
    await store.putSongRange('a|2', { range: { ...base, fastLyrics: false, usdbId: 2 }, log });
    await store.putSongRange('a|3', { range: { ...base, fastLyrics: true, collection: 'singmania' }, log });
    const downloads: number[] = [];
    const usdb = { downloadById: async (id: number) => (downloads.push(id), noteFile([0, 4, 7])) };
    const summary = await fillCatalogue({ store, usdb, recheckFast: true });
    expect(downloads).toEqual([1]);
    expect(summary).toEqual({ candidates: 1, stored: 1, failed: 0 });
    expect((await store.getSongRange('a|1'))!.range).toEqual({ ...base, fastLyrics: false, usdbId: 1 });
  });
});
