import { describe, expect, it } from 'vitest';
import type { SongRange, VocalRange } from '../../src/lib/contracts';
import { edgeTime, MAYBE_SLACK, matchSong } from '../../src/lib/songs/match';
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
  // Centre C4. Middle half: F#3..F#4. Edge eighths: up to D3 and from A#4.
  const shared = (pitchShare: [number, number][]): SongRange => ({
    ...song(Math.min(...pitchShare.map(([m]) => m)), Math.max(...pitchShare.map(([m]) => m))),
    pitchShare,
  });

  it('is easy when the singing stays in the middle half', () => {
    expect(matchSong(C3C5, song(54, 66))).toEqual({ difficulty: 'easy', octave: 'none' });
    expect(matchSong(C3C5, song(60, 60))).toEqual({ difficulty: 'easy', octave: 'none' });
    expect(matchSong(C3C5, shared([[60, 0.99], [70, 0.01]]))?.difficulty).toBe('easy');
  });

  it('is medium with a few notes at an edge, or a quarter of the song outside the middle', () => {
    expect(matchSong(C3C5, shared([[60, 0.95], [72, 0.05]]))?.difficulty).toBe('medium');
    expect(matchSong(C3C5, shared([[60, 0.98], [70, 0.02]]))?.difficulty).toBe('medium');
    expect(matchSong(C3C5, shared([[60, 0.7], [67, 0.3]]))?.difficulty).toBe('medium');
    expect(matchSong(C3C5, shared([[60, 0.75], [66, 0.25]]))?.difficulty).toBe('easy'); // F#4 is still the middle
  });

  it('is hard when a tenth of the singing is at an edge', () => {
    expect(matchSong(C3C5, shared([[60, 0.9], [71, 0.1]]))?.difficulty).toBe('hard');
    expect(matchSong(C3C5, shared([[50, 0.2], [60, 0.8]]))?.difficulty).toBe('hard');
  });

  it('estimates songs without a pitch histogram from their typical, lowest and highest notes', () => {
    expect(matchSong(C3C5, song(48, 72))?.difficulty).toBe('hard'); // both extremes at the edges
    expect(matchSong(C3C5, song(50, 60))?.difficulty).toBe('hard'); // lowest note at the edge
    expect(matchSong(C3C5, song(51, 60))?.difficulty).toBe('easy'); // D#3 is outside the middle, not at the edge
  });

  it('says which edge a song leans on', () => {
    expect(edgeTime(C3C5, shared([[50, 0.2], [60, 0.8]])).side).toBe('bottom');
    expect(edgeTime(C3C5, shared([[60, 0.9], [71, 0.1]])).side).toBe('top');
    expect(edgeTime(C3C5, shared([[60, 0.9], [71, 0.1]]))).toMatchObject({ outer: 0.1, edge: 0.1 });
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

describe('matchSong for low-confidence ranges (the Maybe group)', () => {
  const rough = (low: number, high: number): SongRange => ({ ...song(low, high), source: 'artist-typical', confidence: 'low' });

  it('widens the user range by 2 semitones at each end', () => {
    expect(MAYBE_SLACK).toBe(2);
    expect(matchSong(C3C5, rough(46, 74))).toEqual({ difficulty: 'maybe', octave: 'none' });
    expect(matchSong(C3C5, rough(45, 70))).toBeNull(); // 3 below the user's lowest note
    expect(matchSong(C3C5, rough(50, 75))).toBeNull(); // 3 above the highest
  });

  it('tries an octave down, then up, like confident ranges', () => {
    expect(matchSong(C3C5, rough(70, 86))).toEqual({ difficulty: 'maybe', octave: 'down' }); // 58..74
    expect(matchSong(C3C5, rough(34, 50))).toEqual({ difficulty: 'maybe', octave: 'up' }); // 46..62
  });

  it('never gets a difficulty, even when it fits as written', () => {
    expect(matchSong(C3C5, rough(56, 64))).toEqual({ difficulty: 'maybe', octave: 'none' });
    expect(matchSong(C3C5, { ...rough(56, 64), source: 'audio-full' })?.difficulty).toBe('maybe');
  });

  it('leaves confident ranges to the strict fit', () => {
    expect(matchSong(C3C5, song(47, 72))).toBeNull();
    expect(matchSong(C3C5, { ...song(47, 72), source: 'audio-full' })).toBeNull();
    expect(matchSong(C3C5, { ...song(56, 64), source: 'audio-full' })).toEqual({ difficulty: 'easy', octave: 'none' });
  });
});
