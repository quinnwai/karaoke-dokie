import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { decodeNoteFile, dedupeRanges, importBulkRanges, rangeFromNoteText } from '../../src/lib/notes/bulkImport';
import { songKey } from '../../src/lib/songs/resolve';
import { fixture } from '../songs/fixture';

const at = () => new Date('2026-10-15T00:00:00Z');

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
    expect(summary).toEqual({ imported: 2, kept: 1 });
    expect((await store.getSongRange(solo.key))!.range!.low).toBe(40);
    expect((await store.getSongRange(ballad.key))!.range!.source).toBe('note-file');
    const lowRec = (await store.getSongRange(low.key))!;
    expect(lowRec.log.reason).toContain('originally from USDB');
    expect(await store.listLog()).toEqual([]);
  });
});
