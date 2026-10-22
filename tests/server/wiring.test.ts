import { describe, expect, it } from 'vitest';
import type { Track } from '../../src/lib/contracts';
import { songKey } from '../../src/lib/songs/resolve';
import {
  artistKey,
  createPlaceholderResolver,
  noteFileSource,
  productionSongDeps,
  realResolver,
  SEED_SONGS,
} from '../../src/lib/server/wiring';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { MOCK_TRACKS } from '../../src/lib/server/mockSpotify';

const track = (artist: string, title: string): Track => ({
  id: 'x',
  title,
  artist,
  artistId: 'a',
  spotifyUrl: '',
  playRank: 0,
});

describe('seed song ranges', () => {
  it('has 10 valid, clearly marked placeholder entries: five stand in for recordings, five for estimates', () => {
    expect(SEED_SONGS).toHaveLength(10);
    for (const s of SEED_SONGS) {
      expect(s.range.low).toBeLessThan(s.range.tessitura);
      expect(s.range.tessitura).toBeLessThan(s.range.high);
      expect(s.provenance).toMatch(/Placeholder/);
      expect(s.range.confidence).toBe(s.range.source === 'audio-full' ? 'high' : 'low');
    }
    expect(SEED_SONGS.filter((s) => s.range.confidence === 'high')).toHaveLength(5);
  });

  it('every seed is in the mock library', () => {
    const keys = new Set(MOCK_TRACKS.map((t) => songKey(t.artist, t.title)));
    for (const s of SEED_SONGS) expect(keys.has(songKey(s.artist, s.title))).toBe(true);
  });

  it('resolves seeded songs and skips the rest with a reason', async () => {
    const resolve = createPlaceholderResolver(SEED_SONGS, songKey, noteFileSource, () => new Date(0));
    const hit = await resolve(track('QUEEN', 'Bohemian Rhapsody - Remastered 2011'));
    expect(hit.range).toEqual(SEED_SONGS[0]!.range);
    expect(hit.log).toMatchObject({ outcome: 'artist-external', at: '1970-01-01T00:00:00.000Z' });
    const miss = await resolve(track('Nobody', 'Unknown'));
    expect(miss.range).toBeNull();
    expect(miss.log.outcome).toBe('skipped');
    expect(miss.log.reason).toMatch(/note file/i);
  });
});

describe('production song wiring', () => {
  const NOTE_FILE = '#TITLE:Song\n#ARTIST:Band\n#BPM:120\n#GAP:0\n: 0 4 -5 la\n: 4 4 0 la\n: 8 4 7 la\nE\n';
  const nf = (low: number, high: number) => ({ low, high, tessitura: (low + high) / 2, source: 'note-file' as const, confidence: 'high' as const, fastLyrics: false });

  it('reads a note file when one exists', async () => {
    const store = createMemoryStore();
    const resolve = realResolver(store, { getNoteFile: async () => NOTE_FILE });
    const { range, log } = await resolve(track('Band', 'Song'));
    expect(range).toMatchObject({ low: 55, high: 67, source: 'note-file' });
    expect(log.outcome).toBe('note-file');
  });

  it('falls back to the typical range of the artist\'s other songs in the store', async () => {
    const store = createMemoryStore();
    await store.putSongRange(songKey('Queen', 'A'), { range: nf(50, 70), log: {} as never });
    await store.putSongRange(songKey('Queen', 'B'), { range: nf(52, 72), log: {} as never });
    const resolve = realResolver(store, { getNoteFile: async () => null });
    const { range, log } = await resolve(track('Queen', 'C'));
    expect(range).toMatchObject({ low: 51, high: 71, source: 'artist-typical', confidence: 'low' });
    expect(log.reason).toMatch(/2 other songs/);
  });

  it('counts the artist\'s measured recordings in the fallback, but not estimates', async () => {
    const store = createMemoryStore();
    await store.putSongRange(songKey('Queen', 'A'), { range: { ...nf(50, 70), source: 'audio-full', method: 'm' }, log: {} as never });
    await store.putSongRange(songKey('Queen', 'B'), { range: { ...nf(40, 60), source: 'artist-typical', confidence: 'low' }, log: {} as never });
    const { range, log } = await realResolver(store, { getNoteFile: async () => null })(track('Queen', 'C'));
    expect(range).toMatchObject({ low: 50, high: 70, source: 'artist-typical' });
    expect(log.reason).toMatch(/1 other song by Queen/);
  });

  it('skips and logs a song with no data at all', async () => {
    const resolve = realResolver(createMemoryStore(), { getNoteFile: async () => null });
    const { range, log } = await resolve(track('Omar Apollo', 'Evergreen'));
    expect(range).toBeNull();
    expect(log.outcome).toBe('skipped');
  });

  it('uses the artist part of the song key', () => {
    expect(artistKey('Queen')).toBe(songKey('Queen', 'x').split('|')[0]);
  });

  it('adapts matchSong to return a full Match', () => {
    const deps = productionSongDeps(createMemoryStore(), false);
    const t = track('A', 'B');
    expect(deps.matchSong(t, nf(56, 64), { low: 48, high: 72, source: 'test' })).toMatchObject({ track: t, difficulty: 'easy', octave: 'none' });
    expect(deps.matchSong(t, nf(30, 90), { low: 48, high: 72, source: 'test' })).toBeNull();
    const estimate = { ...nf(46, 74), source: 'artist-typical' as const, confidence: 'low' as const };
    expect(deps.matchSong(t, estimate, { low: 48, high: 72, source: 'test' })).toMatchObject({ difficulty: 'maybe', octave: 'none', reasons: ['You play this a lot'] });
  });
});
