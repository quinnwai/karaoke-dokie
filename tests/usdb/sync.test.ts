import { describe, expect, it } from 'vitest';
import type { Track } from '../../src/lib/contracts';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { songKey } from '../../src/lib/songs/resolve';
import { syncNoteFiles } from '../../src/lib/usdb/sync';

const track = (id: string, artist: string, title: string): Track => ({
  id, artist, title, artistId: 'a', spotifyUrl: '', playRank: Number(id),
});
/** A fake USDB: note text by "artist|title"; every hit has 2000 views and 4 stars. */
const fakeUsdb = (lookup: (artist: string, title: string) => string | null, calls: { title: string; download: boolean }[] = []) => ({
  findSong: async (artist: string, title: string, opts: { download?: boolean } = {}) => {
    const download = opts.download ?? true;
    calls.push({ title, download });
    const text = lookup(artist, title);
    return text === null ? null : { noteText: download ? text : null, views: 2000, rating: 4 };
  },
});
const noteFile = (pitches: number[]) =>
  `#TITLE:x\n#ARTIST:y\n#BPM:120\n#GAP:0\n${pitches.map((p, i) => `: ${i * 4} 4 ${p} la`).join('\n')}\nE\n`;

describe('syncNoteFiles', () => {
  it('stores note-file ranges, then resolves the rest with the artist fallback, and logs every song', async () => {
    const store = createMemoryStore();
    const files: Record<string, string> = {
      'Queen|Bohemian Rhapsody': noteFile([-5, 0, 7]),
      'Queen|Somebody to Love': noteFile([-3, 2, 9]),
    };
    const usdb = fakeUsdb((a, t) => files[`${a}|${t}`] ?? null);
    const tracks = [
      track('1', 'Queen', 'Bohemian Rhapsody'),
      track('2', 'Queen', 'Somebody to Love'),
      track('3', 'Queen', 'Rare B-Side'),
      track('4', 'Omar Apollo', 'Evergreen'),
    ];

    const summary = await syncNoteFiles({ store, usdb, tracks, now: () => new Date(0) });

    expect(summary).toEqual({ checked: 4, noteFile: 2, artistTypical: 1, skipped: 1, alreadyKnown: 0, updated: 0, errors: 0 });
    expect((await store.getSongRange(songKey('Queen', 'Bohemian Rhapsody')))?.range).toMatchObject({
      low: 55,
      high: 67,
      source: 'note-file',
      usdbViews: 2000,
      usdbRating: 4,
      pitchShare: [[55, 0.333], [60, 0.333], [67, 0.333]],
    });
    expect((await store.getSongRange(songKey('Queen', 'Rare B-Side')))?.range).toMatchObject({ source: 'artist-typical' });
    expect((await store.getSongRange(songKey('Omar Apollo', 'Evergreen')))?.range).toBeNull();
    expect((await store.listLog()).map((e) => e.outcome).sort()).toEqual(['artist-typical', 'note-file', 'note-file', 'skipped']);
  });

  it('skips songs that already have a note-file range and replaces earlier guesses', async () => {
    const store = createMemoryStore();
    const nf = { low: 50, high: 60, tessitura: 55, source: 'note-file' as const, confidence: 'high' as const, fastLyrics: false, usdbViews: 10 };
    await store.putSongRange(songKey('A', 'Known'), { range: nf, log: {} as never });
    await store.putSongRange(songKey('A', 'Guessed'), { range: null, log: {} as never });
    const calls: { title: string; download: boolean }[] = [];
    const usdb = fakeUsdb(() => noteFile([0, 4]), calls);

    const summary = await syncNoteFiles({ store, usdb, tracks: [track('1', 'A', 'Known'), track('2', 'A', 'Guessed')] });

    expect(calls.map((c) => c.title)).toEqual(['Guessed']);
    expect(summary).toMatchObject({ alreadyKnown: 1, noteFile: 1 });
    expect((await store.getSongRange(songKey('A', 'Guessed')))?.range?.source).toBe('note-file');
  });

  it('keeps going when one lookup fails, and counts it', async () => {
    const store = createMemoryStore();
    const usdb = { findSong: async (_a: string, t: string) => { if (t === 'Bad') throw new Error('boom'); return null; } };
    const summary = await syncNoteFiles({ store, usdb, tracks: [track('1', 'A', 'Bad'), track('2', 'B', 'Fine')] });
    expect(summary).toMatchObject({ errors: 1, skipped: 1 });
    expect(await store.getSongRange(songKey('A', 'Bad'))).toBeNull();
  });

  it('backfills views and rating for songs synced earlier with a search only', async () => {
    const store = createMemoryStore();
    const old = { low: 50, high: 60, tessitura: 55, source: 'note-file' as const, confidence: 'high' as const, fastLyrics: false };
    await store.putSongRange(songKey('A', 'Old'), { range: old, log: { reason: 'kept' } as never });
    const calls: { title: string; download: boolean }[] = [];
    const summary = await syncNoteFiles({ store, usdb: fakeUsdb(() => noteFile([0, 4]), calls), tracks: [track('1', 'A', 'Old')] });
    expect(calls).toEqual([{ title: 'Old', download: false }]);
    expect(summary).toMatchObject({ alreadyKnown: 1, updated: 1 });
    const rec = await store.getSongRange(songKey('A', 'Old'));
    expect(rec?.range).toEqual({ ...old, usdbViews: 2000, usdbRating: 4 });
    expect(rec?.log).toEqual({ reason: 'kept' });
  });

  it('re-downloads note files for the pitch histogram only with rescan', async () => {
    const store = createMemoryStore();
    const old = { low: 50, high: 60, tessitura: 55, source: 'note-file' as const, confidence: 'high' as const, fastLyrics: false, usdbViews: 5 };
    await store.putSongRange(songKey('A', 'Old'), { range: old, log: {} as never });
    const calls: { title: string; download: boolean }[] = [];
    await syncNoteFiles({ store, usdb: fakeUsdb(() => noteFile([0, 4]), calls), tracks: [track('1', 'A', 'Old')] });
    expect(calls).toEqual([]);
    await syncNoteFiles({ store, usdb: fakeUsdb(() => noteFile([0, 4]), calls), tracks: [track('1', 'A', 'Old')], rescan: true });
    expect(calls).toEqual([{ title: 'Old', download: true }]);
    expect((await store.getSongRange(songKey('A', 'Old')))?.range).toMatchObject({ low: 60, high: 64, pitchShare: [[60, 0.5], [64, 0.5]], usdbViews: 2000 });
  });
});
