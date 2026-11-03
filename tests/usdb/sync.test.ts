import { describe, expect, it } from 'vitest';
import type { Track } from '../../src/lib/contracts';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { songRangeFromUltrastar } from '../../src/lib/songs/range';
import { songKey } from '../../src/lib/songs/resolve';
import { syncNoteFiles } from '../../src/lib/usdb/sync';
import { STORES } from '../helpers/stores';
import { fixture } from '../songs/fixture';

const track = (id: string, artist: string, title: string): Track => ({
  id, artist, title, artistId: 'a', spotifyUrl: '', playRank: Number(id),
});
/**
 * A fake USDB: note text by "artist|title"; every hit has 2000 views and 4 stars. `duets` answers
 * searches for an upload listed as a duet (findSong with duet: true); those hits are id 77.
 */
const fakeUsdb = (
  lookup: (artist: string, title: string) => string | null,
  calls: { title: string; download: boolean; duet?: boolean }[] = [],
  duets: (artist: string, title: string) => string | null = () => null,
) => ({
  findSong: async (artist: string, title: string, opts: { download?: boolean; duet?: boolean } = {}) => {
    const download = opts.download ?? true;
    calls.push(opts.duet ? { title, download, duet: true } : { title, download });
    const text = (opts.duet ? duets : lookup)(artist, title);
    return text === null ? null : { ...(opts.duet ? { id: 77 } : {}), noteText: download ? text : null, views: 2000, rating: 4 };
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

    expect(summary).toEqual({ checked: 4, noteFile: 2, artistTypical: 1, skipped: 1, alreadyKnown: 0, recentMiss: 0, updated: 0, errors: 0 });
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

  it.each(STORES)("stores both singers' parts of a duet note file (%s store)", async (_name, make) => {
    const store = make();
    const summary = await syncNoteFiles({ store, usdb: fakeUsdb(() => fixture('duet.txt')), tracks: [track('1', 'Duo', 'Duet Song')], now: () => new Date(0) });
    expect(summary.noteFile).toBe(1);
    const range = (await store.getSongRange(songKey('Duo', 'Duet Song')))!.range;
    expect(range).toEqual({ ...songRangeFromUltrastar(fixture('duet.txt')), usdbViews: 2000, usdbRating: 4 });
    expect(range?.parts?.map((p) => p.singer)).toEqual(['Singer One', 'Singer Two']);
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

  it('with rescanDuets, re-reads songs USDB lists as a duet to add each part, once', async () => {
    const store = createMemoryStore();
    const old = { low: 60, high: 62, tessitura: 61, source: 'note-file' as const, confidence: 'high' as const, fastLyrics: false, pitchShare: [[60, 0.5], [62, 0.5]] as [number, number][], usdbViews: 5 };
    const log = (title: string) => ({ trackId: '', title, artist: 'Duo', outcome: 'note-file' as const, reason: 'Used the UltraStar note file for this song (public collection c, originally from USDB).', at: 'x' });
    const withParts = { ...songRangeFromUltrastar(fixture('duet.txt')), usdbViews: 5 };
    for (const title of ['Duet Song', 'Solo Song', 'Listed As Duet']) await store.putSongRange(songKey('Duo', title), { range: old, log: log(title) });
    await store.putSongRange(songKey('Duo', 'Has Parts'), { range: withParts, log: log('Has Parts') });
    const calls: { title: string; download: boolean; duet?: boolean }[] = [];
    // USDB lists "Duet Song" as a duet, and "Listed As Duet" too, though its file has one sung part.
    const duetUploads: Record<string, string> = { 'Duet Song': fixture('duet.txt'), 'Listed As Duet': noteFile([0, 4]) };
    const usdb = fakeUsdb(() => noteFile([0, 4]), calls, (_a, t) => duetUploads[t] ?? null);
    const tracks = ['Duet Song', 'Solo Song', 'Listed As Duet', 'Has Parts'].map((t, i) => track(String(i + 1), 'Duo', t));

    await syncNoteFiles({ store, usdb, tracks });
    expect(calls).toEqual([]);

    const summary = await syncNoteFiles({ store, usdb, tracks, rescanDuets: true, now: () => new Date(0) });
    expect(calls).toEqual(['Duet Song', 'Solo Song', 'Listed As Duet'].map((title) => ({ title, download: true, duet: true })));
    expect(summary).toMatchObject({ alreadyKnown: 4, updated: 1, errors: 0 });
    const upgraded = (await store.getSongRange(songKey('Duo', 'Duet Song')))!;
    expect(upgraded.range).toEqual({ ...songRangeFromUltrastar(fixture('duet.txt')), usdbId: 77, usdbViews: 2000, usdbRating: 4 });
    expect(upgraded.log).toEqual({ ...log('Duet Song'), reason: 'Used the UltraStar note file for this song (from USDB).', at: '1970-01-01T00:00:00.000Z' });
    for (const title of ['Solo Song', 'Listed As Duet']) expect((await store.getSongRange(songKey('Duo', title)))!.range).toEqual(old);
    expect((await store.getSongRange(songKey('Duo', 'Has Parts')))!.range).toEqual(withParts);

    // A song that has its parts is not asked about again.
    calls.length = 0;
    await syncNoteFiles({ store, usdb, tracks, rescanDuets: true });
    expect(calls.map((c) => c.title)).toEqual(['Solo Song', 'Listed As Duet']);
  });

  it('with rescanDuets, still backfills views and stars for a song USDB does not list as a duet', async () => {
    const store = createMemoryStore();
    const old = { low: 50, high: 60, tessitura: 55, source: 'note-file' as const, confidence: 'high' as const, fastLyrics: false };
    await store.putSongRange(songKey('A', 'Old'), { range: old, log: {} as never });
    const calls: { title: string; download: boolean; duet?: boolean }[] = [];
    await syncNoteFiles({ store, usdb: fakeUsdb(() => noteFile([0, 4]), calls), tracks: [track('1', 'A', 'Old')], rescanDuets: true });
    expect(calls).toEqual([{ title: 'Old', download: true, duet: true }, { title: 'Old', download: false }]);
    expect((await store.getSongRange(songKey('A', 'Old')))!.range).toEqual({ ...old, usdbViews: 2000, usdbRating: 4 });
  });

  it('logs in before the first song and stops the run when login fails', async () => {
    const store = createMemoryStore();
    const calls: { title: string; download: boolean }[] = [];
    const usdb = { ...fakeUsdb(() => null, calls), login: async () => { throw new Error('USDB login failed: check USDB_USERNAME and USDB_PASSWORD'); } };
    await expect(syncNoteFiles({ store, usdb, tracks: [track('1', 'A', 'B')] })).rejects.toThrow(/login failed/);
    expect(calls).toEqual([]);
  });

  it('fetches one song per artist first, so other songs get artist estimates early', async () => {
    const store = createMemoryStore();
    const calls: { title: string; download: boolean }[] = [];
    const estimatesWhenA2Fetched: (string | undefined)[] = [];
    const base = fakeUsdb(() => noteFile([0, 4]), calls);
    const usdb = {
      findSong: async (a: string, t: string, o?: { download?: boolean }) => {
        if (t === 'A2') estimatesWhenA2Fetched.push((await store.getSongRange(songKey('A', 'A2')))?.range?.source);
        return base.findSong(a, t, o);
      },
    };
    const tracks = [track('1', 'A', 'A1'), track('2', 'A', 'A2'), track('3', 'B', 'B1'), track('4', 'B', 'B2')];
    const summary = await syncNoteFiles({ store, usdb, tracks });
    expect(calls.map((c) => c.title)).toEqual(['A1', 'B1', 'A2', 'B2']);
    expect(estimatesWhenA2Fetched).toEqual(['artist-typical']);
    expect(summary).toMatchObject({ noteFile: 4, artistTypical: 0, skipped: 0 });
    expect((await store.listLog()).length).toBe(4);
  });

  it('tries a second song when an artist\'s first one is not on USDB', async () => {
    const store = createMemoryStore();
    const calls: { title: string; download: boolean }[] = [];
    const usdb = fakeUsdb((_a, t) => (t === 'A1' ? null : noteFile([0, 4])), calls);
    await syncNoteFiles({ store, usdb, tracks: [track('1', 'A', 'A1'), track('2', 'A', 'A2'), track('3', 'A', 'A3')] });
    expect(calls.map((c) => c.title)).toEqual(['A1', 'A2', 'A3']);
    expect((await store.getSongRange(songKey('A', 'A1')))?.range?.source).toBe('artist-typical');
  });

  it('does not search again for 90 days after USDB had no note file', async () => {
    const store = createMemoryStore();
    const tracks = [track('1', 'A', 'Missing')];
    let day = Date.UTC(2026, 0, 1);
    const now = () => new Date(day);
    const calls: { title: string; download: boolean }[] = [];
    const usdb = fakeUsdb(() => null, calls);

    await syncNoteFiles({ store, usdb, tracks, now });
    expect(calls).toHaveLength(1);
    expect((await store.getSongRange(songKey('A', 'Missing')))?.log.usdbMissAt).toBe('2026-01-01T00:00:00.000Z');

    day += 89 * 86_400_000;
    const later = await syncNoteFiles({ store, usdb, tracks, now });
    expect(calls).toHaveLength(1);
    expect(later.recentMiss).toBe(1);
    expect((await store.getSongRange(songKey('A', 'Missing')))?.log.usdbMissAt).toBe('2026-01-01T00:00:00.000Z');

    day += 2 * 86_400_000;
    await syncNoteFiles({ store, usdb, tracks, now });
    expect(calls).toHaveLength(2);
  });

  it('keeps measured recordings through the fallback pass, but still looks them up so a note file replaces them', async () => {
    const store = createMemoryStore();
    const audio = (low: number, high: number) => ({ low, high, tessitura: (low + high) / 2, source: 'audio-full' as const, confidence: 'high' as const, fastLyrics: false, method: 'pyin-v1/app-range-v1' });
    const log = (title: string) => ({ trackId: '', title, artist: 'A', outcome: 'audio-full' as const, reason: 'Measured from the full recording.', at: 'x' });
    await store.putSongRange(songKey('A', 'On USDB'), { range: audio(50, 62), log: log('On USDB') });
    await store.putSongRange(songKey('A', 'Not On USDB'), { range: audio(52, 64), log: log('Not On USDB') });
    let day = Date.UTC(2026, 0, 1);
    const now = () => new Date(day);
    const calls: { title: string; download: boolean }[] = [];
    const usdb = fakeUsdb((_a, t) => (t === 'On USDB' ? noteFile([0, 7]) : null), calls);
    const tracks = [track('1', 'A', 'On USDB'), track('2', 'A', 'Not On USDB'), track('3', 'A', 'Unmeasured')];

    const summary = await syncNoteFiles({ store, usdb, tracks, now });

    expect(calls.map((c) => c.title).sort()).toEqual(['Not On USDB', 'On USDB', 'Unmeasured']);
    expect(summary).toMatchObject({ noteFile: 1, artistTypical: 1, skipped: 0 });
    expect((await store.getSongRange(songKey('A', 'On USDB')))?.range).toMatchObject({ source: 'note-file', low: 60, high: 67 });
    const kept = (await store.getSongRange(songKey('A', 'Not On USDB')))!;
    expect(kept.range).toEqual(audio(52, 64));
    expect(kept.log).toEqual({ ...log('Not On USDB'), usdbMissAt: '2026-01-01T00:00:00.000Z' });
    // The estimate for the unmeasured song uses both the note file and the recording.
    expect((await store.getSongRange(songKey('A', 'Unmeasured')))?.range).toMatchObject({ source: 'artist-typical', low: 56, high: 65.5 });

    day += 89 * 86_400_000;
    await syncNoteFiles({ store, usdb, tracks, now });
    expect(calls.filter((c) => c.title === 'Not On USDB')).toHaveLength(1);
    expect((await store.getSongRange(songKey('A', 'Not On USDB')))!.range).toEqual(audio(52, 64));
  });

  it('still searches songs the website only guessed at (never checked on USDB)', async () => {
    const store = createMemoryStore();
    await store.putSongRange(songKey('A', 'Guessed'), { range: null, log: { outcome: 'skipped' } as never });
    const calls: { title: string; download: boolean }[] = [];
    await syncNoteFiles({ store, usdb: fakeUsdb(() => null, calls), tracks: [track('1', 'A', 'Guessed')] });
    expect(calls.map((c) => c.title)).toEqual(['Guessed']);
  });
});

describe('syncNoteFiles with the USDB song index', () => {
  it('looks songs up in the index instead of searching: misses cost nothing, hits download by id', async () => {
    const store = createMemoryStore();
    await store.putUsdbSongs([
      { id: 42, key: songKey('Queen', 'Bohemian Rhapsody'), artist: 'Queen', title: 'Bohemian Rhapsody', views: 5000, rating: 4.5 },
    ]);
    const searches: string[] = [];
    const downloads: number[] = [];
    const usdb = {
      findSong: async (_a: string, t: string) => {
        searches.push(t);
        return null;
      },
      downloadById: async (id: number) => {
        downloads.push(id);
        return noteFile([-5, 0, 7]);
      },
    };
    const tracks = [track('1', 'Queen', 'Bohemian Rhapsody - Remastered 2011'), track('2', 'Queen', 'Not On USDB')];
    const summary = await syncNoteFiles({ store, usdb, tracks });
    expect(searches).toEqual([]);
    expect(downloads).toEqual([42]);
    expect(summary.noteFile).toBe(1);
    const range = (await store.getSongRange(songKey('Queen', 'Bohemian Rhapsody')))!.range!;
    expect(range).toMatchObject({ usdbId: 42, usdbViews: 5000, usdbRating: 4.5 });
    expect((await store.getSongRange(songKey('Queen', 'Not On USDB')))!.range?.source).toBe('artist-typical');
  });

  it('with rescanDuets, downloads the upload titled as a duet when USDB also has a solo one', async () => {
    const store = createMemoryStore();
    const key = songKey('Duo', 'Islands in the Stream');
    await store.putUsdbSongs([
      { id: 1, key, artist: 'Duo', title: 'Islands in the Stream', views: 900, rating: 4 },
      { id: 2, key, artist: 'Duo', title: 'Islands in the Stream [DUET]', views: 100, rating: 5 },
      { id: 3, key, artist: 'Duo', title: 'Islands in the Stream (duet)', views: 50 },
      { id: 4, key: songKey('Duo', 'Solo Song'), artist: 'Duo', title: 'Solo Song', views: 10 },
    ]);
    const old = { low: 60, high: 62, tessitura: 61, source: 'note-file' as const, confidence: 'high' as const, fastLyrics: false, usdbId: 1, usdbViews: 900, usdbRating: 4 };
    const log = { trackId: '1', title: 'Islands in the Stream', artist: 'Duo', outcome: 'note-file' as const, reason: 'r', at: 'x' };
    await store.putSongRange(key, { range: old, log });
    await store.putSongRange(songKey('Duo', 'Solo Song'), { range: { ...old, usdbId: 4, usdbViews: 10 }, log });
    const downloads: number[] = [];
    const usdb = {
      findSong: async () => {
        throw new Error('the index answers without a search');
      },
      downloadById: async (id: number) => (downloads.push(id), fixture('duet.txt')),
    };
    const tracks = [track('1', 'Duo', 'Islands in the Stream'), track('2', 'Duo', 'Solo Song')];

    await syncNoteFiles({ store, usdb, tracks });
    expect(downloads).toEqual([]);

    const summary = await syncNoteFiles({ store, usdb, tracks, rescanDuets: true });
    // The most-viewed upload titled as a duet, not the most-viewed upload (the solo one).
    expect(downloads).toEqual([2]);
    expect(summary).toMatchObject({ updated: 1, errors: 0 });
    expect((await store.getSongRange(key))!.range).toMatchObject({ duet: true, low: 60, high: 62, usdbId: 2, usdbViews: 100, usdbRating: 5 });
  });

  it('backfills views and stars from the index with no request', async () => {
    const store = createMemoryStore();
    const key = songKey('Queen', 'Bohemian Rhapsody');
    const base = { low: 55, high: 67, tessitura: 60, source: 'note-file' as const, confidence: 'high' as const, fastLyrics: false };
    await store.putSongRange(key, { range: base, log: { trackId: '1', title: 't', artist: 'a', outcome: 'note-file', reason: 'r', at: 'x' } });
    await store.putUsdbSongs([{ id: 7, key, artist: 'Queen', title: 'Bohemian Rhapsody', views: 10, rating: 3 }]);
    let requests = 0;
    const usdb = { findSong: async () => (requests++, null), downloadById: async () => (requests++, null) };
    await syncNoteFiles({ store, usdb, tracks: [track('1', 'Queen', 'Bohemian Rhapsody')] });
    expect(requests).toBe(0);
    expect((await store.getSongRange(key))!.range).toMatchObject({ usdbId: 7, usdbViews: 10, usdbRating: 3 });
  });
});
