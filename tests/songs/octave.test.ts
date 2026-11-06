import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DataSourceLogEntry, SongRange, VocalRange } from '../../src/lib/contracts';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { matchSong } from '../../src/lib/songs/match';
import {
  ARTIST_MAX_DISTANCE,
  correctOctave,
  fixStoredOctaves,
  octaveMove,
  octaveToward,
  shiftRange,
  type OctaveEvidence,
} from '../../src/lib/songs/octave';

const evidenceFile = JSON.parse(readFileSync(join(__dirname, '../../data/octave-evidence.json'), 'utf8')) as OctaveEvidence;
const user: VocalRange = { low: 41, high: 72, source: 'test' }; // F2 to C5
const log = (outcome: DataSourceLogEntry['outcome'] = 'note-file'): DataSourceLogEntry => ({ trackId: '', title: 't', artist: 'a', outcome, reason: 'Used the note file.', at: '2026-01-01' });
const noteFile = (low: number, high: number, tessitura: number, extra: Partial<SongRange> = {}): SongRange => ({
  low, high, tessitura, source: 'note-file', confidence: 'high', fastLyrics: false, ...extra,
});

describe('octaveToward', () => {
  it('picks the whole octave that puts the typical note nearest the target', () => {
    expect(octaveToward(71.15, 59.34)).toBe(-12);
    expect(octaveToward(59, 59.34)).toBe(0);
    expect(octaveToward(47, 59)).toBe(12);
    expect(octaveToward(65, 59)).toBe(-12); // 6 above: the lower octave is nearer or equal
    expect(octaveToward(53, 59)).toBe(0);
  });
});

describe('Easy by the Commodores (QWW-31)', () => {
  // The stored note file: 65 to 78, typical note 71.2: inside E2..C5 so range.ts left it, but a whole octave above the recording.
  const stored = noteFile(65, 78, 71.15, { pitchShare: [[65, 0.4], [72, 0.5], [78, 0.1]], collection: 'singmania' });

  it('is stored an octave too high, so F2 to C5 was told to sing it an octave lower', () => {
    expect(matchSong(user, stored)?.octave).toBe('down');
  });

  it('moves down an octave by its own recording, and then needs no octave shift', () => {
    const fixed = correctOctave('commodores|easy', stored, evidenceFile);
    expect(fixed).toMatchObject({ low: 53, high: 66, octaveFrom: 'recording' });
    expect(fixed.tessitura).toBeCloseTo(59.15, 5);
    expect(fixed.pitchShare).toEqual([[53, 0.4], [60, 0.5], [66, 0.1]]);
    expect(matchSong(user, fixed)?.octave).toBe('none');
  });
});

describe('octaveMove', () => {
  const ev: OctaveEvidence = { songs: { 'a|song': 60 }, artists: { a: 60, b: 60 } };

  it('moves by the song’s own recording at any distance, and leaves a note file already right', () => {
    expect(octaveMove('a|song', noteFile(70, 80, 76), ev)).toEqual({ semitones: -12, from: 'recording' });
    expect(octaveMove('a|song', noteFile(50, 62, 45), ev)).toEqual({ semitones: 12, from: 'recording' });
    expect(octaveMove('a|song', noteFile(55, 68, 62), ev)).toBeNull();
  });

  it('uses the artist’s other recordings only with margin to spare', () => {
    const near = 60 + 12 + ARTIST_MAX_DISTANCE; // moved down an octave it lands ARTIST_MAX_DISTANCE above the artist
    expect(octaveMove('b|other', noteFile(70, 80, near), ev)).toEqual({ semitones: -12, from: 'artist' });
    // 5 above the artist's typical note once moved: not strong enough
    expect(octaveMove('b|other', noteFile(70, 80, 60 + 12 + ARTIST_MAX_DISTANCE + 1), ev)).toBeNull();
    expect(octaveMove('c|other', noteFile(70, 80, 72), ev)).toBeNull(); // no evidence for this artist
  });

  it('leaves estimates, recordings, duets with parts, and moves that leave the plausible range alone', () => {
    const part = { low: 60, high: 70, tessitura: 65, fastLyrics: false };
    expect(octaveMove('a|song', { ...noteFile(70, 80, 76), source: 'audio-full' }, ev)).toBeNull();
    expect(octaveMove('a|song', { ...noteFile(70, 80, 76), source: 'artist-typical' }, ev)).toBeNull();
    expect(octaveMove('a|song', noteFile(70, 80, 76, { duet: true, parts: [part, part] }), ev)).toBeNull();
    expect(octaveMove('a|song', noteFile(60, 85, 70), { songs: { 'a|song': 82 }, artists: {} })).toBeNull(); // 85 + 12 is past the plausible top
  });

  it('does not move a range already corrected (idempotent)', () => {
    const once = correctOctave('a|song', noteFile(70, 80, 76), ev);
    expect(correctOctave('a|song', once, ev)).toBe(once);
  });
});

describe('the shipped evidence', () => {
  const songs = Object.entries(evidenceFile.songs);

  it('covers thousands of songs and artists, with sane typical notes', () => {
    expect(songs.length).toBeGreaterThan(4000);
    expect(Object.keys(evidenceFile.artists).length).toBeGreaterThan(1000);
    for (const [, tess] of [...songs, ...Object.entries(evidenceFile.artists)]) expect(tess).toBeGreaterThan(36);
  });

  it('leaves note files that are already in the recording’s octave exactly as they are', () => {
    // A note file within a few semitones of its recording's typical note is right, wherever it sits.
    for (const [key, tess] of songs) {
      for (const off of [-4, 0, 3]) {
        const range = noteFile(Math.round(tess + off) - 5, Math.round(tess + off) + 6, tess + off);
        expect(octaveMove(key, range, evidenceFile), `${key} at ${off}`).toBeNull();
      }
    }
  });

  it('moves a note file written an octave off back, in both directions', () => {
    for (const [key, tess] of songs.slice(0, 200)) {
      const high = noteFile(Math.round(tess) + 7, Math.round(tess) + 18, tess + 12.5);
      const low = noteFile(Math.round(tess) - 17, Math.round(tess) - 6, tess - 11.5);
      expect(octaveMove(key, high, evidenceFile)?.semitones, key).toBe(-12);
      expect(octaveMove(key, low, evidenceFile)?.semitones, key).toBe(12);
    }
  });
});

describe('shiftRange', () => {
  it('moves low, high, typical note and pitch shares, and nothing else', () => {
    const r = noteFile(60, 70, 65, { pitchShare: [[60, 0.5], [70, 0.5]], usdbId: 7 });
    expect(shiftRange(r, -12)).toEqual({ ...r, low: 48, high: 58, tessitura: 53, pitchShare: [[48, 0.5], [58, 0.5]] });
  });
});

describe('fixStoredOctaves', () => {
  const ev: OctaveEvidence = { songs: { 'a|high': 60 }, artists: { a: 60 } };

  async function seeded() {
    const s = createMemoryStore();
    await s.putSongRange('a|high', { range: noteFile(65, 78, 72 - 0.5), log: log() });
    await s.putSongRange('a|right', { range: noteFile(55, 68, 61), log: log() });
    await s.putSongRange('a|duet', { range: noteFile(65, 78, 71, { duet: true, parts: [{ low: 65, high: 78, tessitura: 71, fastLyrics: false }] }), log: log() });
    await s.putSongRange('a|estimate', { range: { ...noteFile(65, 78, 71), source: 'artist-typical', confidence: 'low' }, log: log('artist-typical') });
    await s.putSongRange('z|untouched', { range: noteFile(65, 78, 71), log: log() });
    return s;
  }

  it('fixes only the plain note files by evidence, notes why, and is a no-op the second time', async () => {
    const s = await seeded();
    const first = await fixStoredOctaves(s, ev);
    expect(first).toMatchObject({ moved: 1, fromRecording: 1, fromArtist: 0 });
    const fixed = await s.getSongRange('a|high');
    expect(fixed?.range).toMatchObject({ low: 53, high: 66, octaveFrom: 'recording' });
    expect(fixed?.log.reason).toBe('Used the note file. Moved an octave down to match the original recording.');
    expect((await s.getSongRange('a|right'))?.range).toMatchObject({ low: 55, high: 68 });
    expect((await s.getSongRange('a|duet'))?.range).toMatchObject({ low: 65 });
    expect((await s.getSongRange('a|estimate'))?.range).toMatchObject({ low: 65 });
    expect((await s.getSongRange('z|untouched'))?.range).toMatchObject({ low: 65 });
    expect(await fixStoredOctaves(s, ev)).toMatchObject({ moved: 0 });
  });

  it('writes nothing on a dry run', async () => {
    const s = await seeded();
    expect(await fixStoredOctaves(s, ev, { dryRun: true })).toMatchObject({ moved: 1 });
    expect((await s.getSongRange('a|high'))?.range).toMatchObject({ low: 65 });
  });
});
