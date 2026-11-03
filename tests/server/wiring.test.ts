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
  seedStore,
  type SeedSong,
} from '../../src/lib/server/wiring';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { MOCK_TRACKS } from '../../src/lib/server/mockSpotify';
import { songRangeFromUltrastar } from '../../src/lib/songs/range';
import { fixture } from '../songs/fixture';

const track = (artist: string, title: string): Track => ({
  id: 'x',
  title,
  artist,
  artistId: 'a',
  spotifyUrl: '',
  playRank: 0,
});

describe('seed song ranges', () => {
  it('has valid, clearly marked placeholder entries: recordings and note files are sure, estimates are not', () => {
    expect(SEED_SONGS.length).toBeGreaterThanOrEqual(25);
    for (const s of SEED_SONGS) {
      expect(s.range.low).toBeLessThan(s.range.tessitura);
      expect(s.range.tessitura).toBeLessThan(s.range.high);
      expect(s.provenance).toMatch(/Placeholder/);
      expect(s.range.confidence).toBe(s.range.source === 'audio-full' || s.range.source === 'note-file' ? 'high' : 'low');
      for (const p of s.range.parts ?? []) {
        expect(p.low).toBeLessThan(p.tessitura);
        expect(p.tessitura).toBeLessThan(p.high);
      }
    }
    // The demo has a few duets, each with both singers' parts, and moods on most songs.
    const duets = SEED_SONGS.filter((s) => s.range.duet);
    expect(duets.length).toBeGreaterThanOrEqual(2);
    for (const d of duets) expect(d.range.parts?.map((p) => p.singer)).toHaveLength(2);
    expect(SEED_SONGS.filter((s) => s.moods?.length).length).toBeGreaterThan(SEED_SONGS.length / 2);
  });

  it('every seed not marked catalogue-only is in the mock library, and the catalogue-only ones are not', () => {
    const keys = new Set(MOCK_TRACKS.map((t) => songKey(t.artist, t.title)));
    for (const s of SEED_SONGS) expect(keys.has(songKey(s.artist, s.title))).toBe(!s.catalogueOnly);
  });

  it('seeds a store with every seed, its log line and USDB row, however many seeds there are', async () => {
    const seeds: SeedSong[] = Array.from({ length: 300 }, (_, i) => ({
      artist: `Artist ${i}`,
      title: `Song ${i}`,
      range: { low: 50, high: 70, tessitura: 60, source: i % 3 ? 'audio-full' : 'artist-typical', confidence: i % 3 ? 'high' : 'low', fastLyrics: false },
      provenance: `Placeholder ${i}`,
      ...(i % 2 ? { usdb: { id: 1000 + i, views: i, year: 1960 + (i % 60), genre: 'Pop' } } : {}),
    }));
    const store = createMemoryStore();
    await seedStore(store, seeds, () => new Date(0));
    const key = songKey('Artist 7', 'Song 7');
    expect(await store.getSongRange(key)).toEqual({
      range: seeds[7]!.range,
      log: { trackId: '', title: 'Song 7', artist: 'Artist 7', outcome: 'audio-full', reason: 'Placeholder 7', at: '1970-01-01T00:00:00.000Z' },
    });
    expect((await store.findUsdbSongs([key])).get(key)).toEqual({ id: 1007, key, artist: 'Artist 7', title: 'Song 7', views: 7, year: 1967, genre: 'Pop' });
    expect(await store.listLog(1000)).toHaveLength(300);
    expect((await store.usdbIndexStats()).count).toBe(150);
    // The estimates (every third seed) stay out of the catalogue.
    expect(await store.listCatalogue(6000)).toHaveLength(200);
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

  it('scores and shows a duet on the part the user sings', () => {
    const deps = productionSongDeps(createMemoryStore(), false);
    const range = { ...songRangeFromUltrastar(fixture('duet.txt')), usdbViews: 100 };
    // D4..E5: P2 (G4..C5) fits as written; P1 (C4..D4) only an octave up.
    const m = deps.matchSong(track('Duo', 'Duet Song'), range, { low: 62, high: 76, source: 'test' })!;
    expect(m).toMatchObject({ difficulty: 'easy', octave: 'none', part: 2, partSinger: 'Singer Two' });
    expect(m.range).toEqual({ ...range, low: 67, high: 72, tessitura: range.parts![1]!.tessitura, pitchShare: [[67, 0.333], [72, 0.667]] });
    expect(m.parts?.comfort).toBe(1); // P2 sits in the middle of this range; P1's notes as written would score 0
  });

  it("uses the matched part's own fast-lyrics flag", () => {
    const deps = productionSongDeps(createMemoryStore(), false);
    const parts = [{ low: 40, high: 74, tessitura: 57, fastLyrics: false }, { low: 56, high: 64, tessitura: 60, fastLyrics: true }];
    const m = deps.matchSong(track('A', 'B'), { ...nf(40, 74), duet: true, parts }, { low: 48, high: 72, source: 'test' })!;
    expect(m).toMatchObject({ part: 2, range: { low: 56, high: 64, fastLyrics: true } });
    expect(m.parts?.penalty).toBe(0.05);
    expect(m).not.toHaveProperty('partSinger'); // the file named no singers
  });

  it('leaves a solo match on the stored range, with no part', () => {
    const m = productionSongDeps(createMemoryStore(), false).matchSong(track('A', 'B'), nf(56, 64), { low: 48, high: 72, source: 'test' })!;
    expect(m.range).toEqual(nf(56, 64));
    expect(m).not.toHaveProperty('part');
  });
});
