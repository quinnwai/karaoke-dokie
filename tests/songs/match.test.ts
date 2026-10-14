import { describe, expect, it } from 'vitest';
import type { SongRange, VocalRange } from '../../src/lib/contracts';
import { matchSong } from '../../src/lib/songs/match';
import { songRangeFromUltrastar } from '../../src/lib/songs/range';
import { fixture } from './fixture';

const user = (low: number, high: number): VocalRange => ({ low, high, source: 'test' });
const song = (low: number, high: number): SongRange => ({
  low,
  high,
  tessitura: (low + high) / 2,
  source: 'note-file',
  confidence: 'high',
  fastLyrics: false,
});

const C3C5 = user(48, 72);

describe('matchSong difficulty (user C3..C5)', () => {
  it('is easy for songs within F#3..F#4', () => {
    expect(matchSong(C3C5, song(54, 66))).toEqual({ difficulty: 'easy', octave: 'none' });
    expect(matchSong(C3C5, song(60, 60))).toEqual({ difficulty: 'easy', octave: 'none' });
  });

  it('is medium for songs reaching about E3..G#4', () => {
    expect(matchSong(C3C5, song(53, 66))).toEqual({ difficulty: 'medium', octave: 'none' });
    expect(matchSong(C3C5, song(52, 68))).toEqual({ difficulty: 'medium', octave: 'none' });
  });

  it('is hard for songs that reach near the edges, including exactly the edges', () => {
    expect(matchSong(C3C5, song(51, 60))).toEqual({ difficulty: 'hard', octave: 'none' });
    expect(matchSong(C3C5, song(60, 69))).toEqual({ difficulty: 'hard', octave: 'none' });
    expect(matchSong(C3C5, song(48, 72))).toEqual({ difficulty: 'hard', octave: 'none' });
  });

  it('treats the 0.5 and 0.7 boundaries as inclusive', () => {
    const u = user(50, 70); // center 60, half 10
    expect(matchSong(u, song(55, 65))?.difficulty).toBe('easy');
    expect(matchSong(u, song(53, 67))?.difficulty).toBe('medium');
    expect(matchSong(u, song(52, 60))?.difficulty).toBe('hard');
  });
});

describe('matchSong octave shifts', () => {
  it('suggests singing an octave up when the song is too low', () => {
    const deep = songRangeFromUltrastar(fixture('low-song.txt')); // C2..C3
    expect(deep).toMatchObject({ low: 36, high: 48 });
    // C3..C4 after shifting: touches the user's bottom edge, so hard.
    expect(matchSong(C3C5, deep)).toEqual({ difficulty: 'hard', octave: 'up' });
    expect(matchSong(C3C5, song(44, 52))).toEqual({ difficulty: 'easy', octave: 'up' });
  });

  it('suggests singing an octave down when the song is too high', () => {
    expect(matchSong(C3C5, song(68, 76))).toEqual({ difficulty: 'easy', octave: 'down' });
  });

  it('prefers the written key when it fits', () => {
    expect(matchSong(user(36, 84), song(60, 62))?.octave).toBe('none');
  });

  it('returns null when nothing fits', () => {
    expect(matchSong(C3C5, song(46, 70))).toBeNull(); // starts below, too wide to move up
    expect(matchSong(C3C5, song(40, 74))).toBeNull(); // wider than the user
    expect(matchSong(C3C5, song(80, 90))).toBeNull(); // two octaves away
  });

  it('never tries transpositions other than one octave', () => {
    // User C3..C4. G3..F#4 is too high as written and too low an octave down;
    // only a 6-semitone shift would fit, which we do not offer.
    expect(matchSong(user(48, 60), song(55, 66))).toBeNull();
  });
});
