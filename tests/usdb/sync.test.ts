import { describe, expect, it } from 'vitest';
import type { Track } from '../../src/lib/contracts';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { songKey } from '../../src/lib/songs/resolve';
import { syncNoteFiles } from '../../src/lib/usdb/sync';

const track = (id: string, artist: string, title: string): Track => ({
  id, artist, title, artistId: 'a', spotifyUrl: '', playRank: Number(id),
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
    const usdb = { findNoteFile: async (a: string, t: string) => files[`${a}|${t}`] ?? null };
    const tracks = [
      track('1', 'Queen', 'Bohemian Rhapsody'),
      track('2', 'Queen', 'Somebody to Love'),
      track('3', 'Queen', 'Rare B-Side'),
      track('4', 'Omar Apollo', 'Evergreen'),
    ];

    const summary = await syncNoteFiles({ store, usdb, tracks, now: () => new Date(0) });

    expect(summary).toEqual({ checked: 4, noteFile: 2, artistTypical: 1, skipped: 1, alreadyKnown: 0, errors: 0 });
    expect((await store.getSongRange(songKey('Queen', 'Bohemian Rhapsody')))?.range).toMatchObject({ low: 55, high: 67, source: 'note-file' });
    expect((await store.getSongRange(songKey('Queen', 'Rare B-Side')))?.range).toMatchObject({ source: 'artist-typical' });
    expect((await store.getSongRange(songKey('Omar Apollo', 'Evergreen')))?.range).toBeNull();
    expect((await store.listLog()).map((e) => e.outcome).sort()).toEqual(['artist-typical', 'note-file', 'note-file', 'skipped']);
  });

  it('skips songs that already have a note-file range and replaces earlier guesses', async () => {
    const store = createMemoryStore();
    const nf = { low: 50, high: 60, tessitura: 55, source: 'note-file' as const, confidence: 'high' as const, fastLyrics: false };
    await store.putSongRange(songKey('A', 'Known'), { range: nf, log: {} as never });
    await store.putSongRange(songKey('A', 'Guessed'), { range: null, log: {} as never });
    let asked: string[] = [];
    const usdb = { findNoteFile: async (_a: string, t: string) => { asked.push(t); return noteFile([0, 4]); } };

    const summary = await syncNoteFiles({ store, usdb, tracks: [track('1', 'A', 'Known'), track('2', 'A', 'Guessed')] });

    expect(asked).toEqual(['Guessed']);
    expect(summary).toMatchObject({ alreadyKnown: 1, noteFile: 1 });
    expect((await store.getSongRange(songKey('A', 'Guessed')))?.range?.source).toBe('note-file');
  });

  it('keeps going when one lookup fails, and counts it', async () => {
    const store = createMemoryStore();
    const usdb = { findNoteFile: async (_a: string, t: string) => { if (t === 'Bad') throw new Error('boom'); return null; } };
    const summary = await syncNoteFiles({ store, usdb, tracks: [track('1', 'A', 'Bad'), track('2', 'B', 'Fine')] });
    expect(summary).toMatchObject({ errors: 1, skipped: 1 });
    expect(await store.getSongRange(songKey('A', 'Bad'))).toBeNull();
  });
});
