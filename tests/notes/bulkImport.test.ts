import { describe, expect, it } from 'vitest';
import type { SongRange } from '../../src/lib/contracts';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { decodeNoteFile, dedupeRanges, importBulkRanges, rangeFromNoteText, type BulkRange } from '../../src/lib/notes/bulkImport';
import { songKey } from '../../src/lib/songs/resolve';
import { fixture } from '../songs/fixture';

const at = () => new Date('2026-10-15T00:00:00Z');

/** A row as the vocal-range pipeline exports it (export_karaoke.py). */
const audioRow = (key: string, over: Partial<SongRange> = {}): BulkRange => ({
  key,
  artist: 'Whitney Houston',
  title: 'I Will Always Love You',
  collection: 'vocal-catalog',
  outcome: 'audio-full',
  reason: 'Measured from the full recording: vocals separated and pitch-tracked, 119 s of clear singing.',
  range: {
    low: 59,
    high: 75,
    tessitura: 67.6,
    source: 'audio-full',
    confidence: 'high',
    fastLyrics: false,
    pitchShare: [[59, 0.2], [67, 0.6], [75, 0.2]],
    collection: 'vocal-catalog',
    method: 'pyin-v1/app-range-v1',
    mbid: 'e77b5548-66d5-42d7-829b-86657a6cb596',
    ...over,
  },
});
const logOf = (outcome: 'note-file' | 'audio-full' | 'artist-typical' | 'skipped', reason = 'earlier') => ({
  trackId: 't', title: 'x', artist: 'y', outcome, reason, at: at().toISOString(),
});

describe('rangeFromNoteText', () => {
  it('computes the range and keys it by artist and title', () => {
    const r = rangeFromNoteText(fixture('solo.txt'), 'test')!;
    expect(r.key).toBe(songKey(r.artist, r.title));
    expect(r.range.source).toBe('note-file');
    expect(r.range.low).toBe(55);
    expect(r.collection).toBe('test');
    expect(r.range.collection).toBe('test');
  });

  it('keeps no lyrics', () => {
    const r = rangeFromNoteText(fixture('solo.txt'), 'test')!;
    const syllable = fixture('solo.txt').split('\n').find((l) => l.startsWith(':'))!.split(' ').slice(4).join(' ').trim();
    expect(JSON.stringify(r)).not.toContain(syllable);
  });

  it('returns null for files without artist, title or notes', () => {
    expect(rangeFromNoteText('#ARTIST:A\n#BPM:100\n: 0 4 0 la\nE', 't')).toBeNull();
    expect(rangeFromNoteText('#ARTIST:A\n#TITLE:B\n#BPM:100\nE', 't')).toBeNull();
    expect(rangeFromNoteText('garbage', 't')).toBeNull();
  });

  it('drops implausible ranges (over three octaves wide)', () => {
    const notes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `: ${i * 4} 4 ${i < 5 ? -20 : 25} la`).join('\n');
    expect(rangeFromNoteText(`#ARTIST:A\n#TITLE:B\n#BPM:100\n${notes}\nE`, 't')).toBeNull();
  });
});

describe('decodeNoteFile', () => {
  it('reads UTF-8 and falls back to Latin-1', () => {
    expect(decodeNoteFile(new TextEncoder().encode('Beyoncé'))).toBe('Beyoncé');
    expect(decodeNoteFile(new Uint8Array([0x42, 0xe9]))).toBe('Bé');
  });
});

describe('dedupeRanges', () => {
  it('keeps the first song seen per key', () => {
    const a = rangeFromNoteText(fixture('solo.txt'), 'first')!;
    const b = { ...a, collection: 'second' };
    expect(dedupeRanges([a, b]).map((r) => r.collection)).toEqual(['first']);
  });
});

describe('importBulkRanges', () => {
  it('with recheckFast, corrects the fast flag of songs from the same collection only', async () => {
    const store = createMemoryStore();
    const solo = rangeFromNoteText(fixture('solo.txt'), 'c')!;
    const ballad = rangeFromNoteText(fixture('ballad.txt'), 'c')!;
    const log = { trackId: '', title: 'x', artist: 'y', outcome: 'note-file' as const, reason: 'r', at: at().toISOString() };
    await store.putSongRange(solo.key, { range: { ...solo.range, fastLyrics: true }, log });
    await store.putSongRange(ballad.key, { range: { ...ballad.range, collection: 'other', fastLyrics: true }, log });
    const summary = await importBulkRanges(store, [solo, ballad], { now: at, recheckFast: true });
    expect(summary).toEqual({ imported: 0, kept: 2, fastUpdated: 1 });
    expect((await store.getSongRange(solo.key))!.range!.fastLyrics).toBe(false);
    expect((await store.getSongRange(solo.key))!.log).toEqual(log);
    expect((await store.getSongRange(ballad.key))!.range!.fastLyrics).toBe(true);
  });

  it('stores new songs, upgrades estimates, keeps existing note files', async () => {
    const store = createMemoryStore();
    const solo = rangeFromNoteText(fixture('solo.txt'), 'c')!;
    const ballad = rangeFromNoteText(fixture('ballad.txt'), 'c')!;
    const low = rangeFromNoteText(fixture('low-song.txt'), 'c')!;
    const existing = { ...solo.range, low: 40 };
    const log = { trackId: 't', title: 'x', artist: 'y', outcome: 'note-file' as const, reason: 'usdb', at: at().toISOString() };
    await store.putSongRange(solo.key, { range: existing, log });
    await store.putSongRange(ballad.key, { range: { ...ballad.range, source: 'artist-typical', confidence: 'low' }, log: { ...log, outcome: 'artist-typical' } });

    const summary = await importBulkRanges(store, [solo, ballad, low], { now: at, batchSize: 2 });
    expect(summary).toEqual({ imported: 2, kept: 1, fastUpdated: 0 });
    expect((await store.getSongRange(solo.key))!.range!.low).toBe(40);
    expect((await store.getSongRange(ballad.key))!.range!.source).toBe('note-file');
    const lowRec = (await store.getSongRange(low.key))!;
    expect(lowRec.log.reason).toContain('originally from USDB');
    expect(await store.listLog()).toEqual([]);
  });

  it('stores a measured recording with the log line it came with', async () => {
    const store = createMemoryStore();
    const row = audioRow('whitney houston|i will always love you');
    expect(await importBulkRanges(store, [row], { now: at })).toEqual({ imported: 1, kept: 0, fastUpdated: 0 });
    expect(await store.getSongRange(row.key)).toEqual({
      range: row.range,
      log: { trackId: '', title: row.title, artist: row.artist, outcome: 'audio-full', reason: row.reason, at: at().toISOString() },
    });
  });

  it('writes only over a lower-ranked source, or the same source from another export', async () => {
    const store = createMemoryStore();
    const note = { ...audioRow('').range, source: 'note-file' as const, method: undefined, mbid: undefined, low: 40 };
    const older = { ...audioRow('').range, method: 'pyin-v0/app-range-v1', low: 41 };
    const same = { ...audioRow('').range, low: 42 };
    const estimate = { ...audioRow('').range, source: 'artist-typical' as const, confidence: 'low' as const, low: 43 };
    await store.putSongRange('a|note file', { range: note, log: logOf('note-file') });
    await store.putSongRange('a|older export', { range: older, log: logOf('audio-full') });
    await store.putSongRange('a|same export', { range: same, log: logOf('audio-full') });
    await store.putSongRange('a|estimate', { range: estimate, log: logOf('artist-typical') });
    await store.putSongRange('a|skipped', { range: null, log: logOf('skipped') });
    const keys = ['a|note file', 'a|older export', 'a|same export', 'a|estimate', 'a|skipped', 'a|new'];

    const summary = await importBulkRanges(store, keys.map((k) => audioRow(k)), { now: at, batchSize: 4 });

    expect(summary).toEqual({ imported: 4, kept: 2, fastUpdated: 0 });
    const lows = Object.fromEntries(await Promise.all(keys.map(async (k) => [k, (await store.getSongRange(k))!.range!.low])));
    expect(lows).toEqual({ 'a|note file': 40, 'a|older export': 59, 'a|same export': 42, 'a|estimate': 59, 'a|skipped': 59, 'a|new': 59 });
    expect((await store.getSongRange('a|same export'))!.log.reason).toBe('earlier');
    expect((await store.getSongRange('a|older export'))!.log.outcome).toBe('audio-full');
  });

  it('never replaces a note file with a recording, and re-importing the same export keeps every row', async () => {
    const store = createMemoryStore();
    const solo = rangeFromNoteText(fixture('solo.txt'), 'c')!;
    await importBulkRanges(store, [solo], { now: at });
    const rows = [audioRow(solo.key), audioRow('b|song')];
    expect(await importBulkRanges(store, rows, { now: at })).toEqual({ imported: 1, kept: 1, fastUpdated: 0 });
    expect((await store.getSongRange(solo.key))!.range!.source).toBe('note-file');
    expect(await importBulkRanges(store, rows, { now: at })).toEqual({ imported: 0, kept: 2, fastUpdated: 0 });
  });

  it('keeps the time USDB last had no note file when it replaces a row', async () => {
    const store = createMemoryStore();
    const estimate = { ...audioRow('').range, source: 'artist-typical' as const, confidence: 'low' as const };
    await store.putSongRange('a|guess', { range: estimate, log: { ...logOf('artist-typical'), usdbMissAt: '2026-09-01T00:00:00.000Z' } });
    await importBulkRanges(store, [audioRow('a|guess'), audioRow('a|new')], { now: at });
    expect((await store.getSongRange('a|guess'))!.log).toMatchObject({ outcome: 'audio-full', usdbMissAt: '2026-09-01T00:00:00.000Z' });
    expect((await store.getSongRange('a|new'))!.log).not.toHaveProperty('usdbMissAt');
  });

  it('logs a row without its own line under its source, and refuses an outcome that is not its source', async () => {
    const store = createMemoryStore();
    const { outcome: _outcome, reason: _reason, ...bare } = audioRow('a|bare');
    await importBulkRanges(store, [bare], { now: at });
    expect((await store.getSongRange('a|bare'))!.log).toMatchObject({ outcome: 'audio-full', reason: '' });

    const mislabeled = { ...audioRow('b|mislabeled'), outcome: 'note-file' as const };
    await expect(importBulkRanges(store, [audioRow('c|fine'), mislabeled])).rejects.toThrow(
      /Log outcome "note-file" is not the range source "audio-full" \(b\|mislabeled\)/,
    );
    expect(await store.getSongRange('c|fine')).toBeNull();
  });

  it('refuses a file with a source this app does not know, before writing anything', async () => {
    const store = createMemoryStore();
    const preview = audioRow('b|preview', { source: 'audio-preview' as SongRange['source'] });
    await expect(importBulkRanges(store, [audioRow('a|song'), preview])).rejects.toThrow(/Unknown range source "audio-preview" \(b\|preview\)/);
    expect(await store.getSongRange('a|song')).toBeNull();
  });
});
