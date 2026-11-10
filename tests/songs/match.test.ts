import { describe, expect, it } from 'vitest';
import type { SongPart, SongRange, VocalRange } from '../../src/lib/contracts';
import { edgeTime, MAYBE_SLACK, matchSong, partRange } from '../../src/lib/songs/match';
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

const part = (low: number, high: number, over: Partial<SongPart> = {}): SongPart => ({ low, high, tessitura: (low + high) / 2, fastLyrics: false, ...over });
/** A duet whose top level is P1's, as range.ts writes it. */
const duet = (p1: SongPart, p2: SongPart): SongRange => ({ ...song(p1.low, p1.high), ...(p1.pitchShare ? { pitchShare: p1.pitchShare } : {}), duet: true, parts: [p1, p2] });

describe('matchSong for duets (user C3..C5)', () => {
  it('matches on P2 when only P2 fits', () => {
    expect(matchSong(C3C5, duet(part(40, 74), part(56, 64)))).toEqual({ difficulty: 'easy', octave: 'none', part: 2 });
  });

  it('takes the easier part when both fit, and P1 when they are as easy', () => {
    expect(matchSong(C3C5, duet(part(48, 72), part(56, 64)))).toEqual({ difficulty: 'easy', octave: 'none', part: 2 });
    expect(matchSong(C3C5, duet(part(56, 64), part(48, 72)))).toEqual({ difficulty: 'easy', octave: 'none', part: 1 });
    expect(matchSong(C3C5, duet(part(56, 64), part(55, 65)))).toEqual({ difficulty: 'easy', octave: 'none', part: 1 });
  });

  it("judges each part's difficulty by its own singing", () => {
    // Same lowest and highest notes; P1 spends 40% of its time at the user's edges, P2 1%.
    const p1 = part(50, 70, { pitchShare: [[50, 0.2], [60, 0.6], [70, 0.2]] });
    const p2 = part(50, 70, { pitchShare: [[50, 0.005], [60, 0.99], [70, 0.005]] });
    expect(matchSong(C3C5, duet(p1, p2))).toEqual({ difficulty: 'easy', octave: 'none', part: 2 });
  });

  it('prefers a part that fits as written over an easier one an octave away', () => {
    // P1 fits an octave down (56..64, easy); P2 fits as written but touches both edges (hard).
    expect(matchSong(C3C5, duet(part(68, 76), part(48, 72)))).toEqual({ difficulty: 'hard', octave: 'none', part: 2 });
  });

  it('tries each part an octave down, then up, when no part fits as written', () => {
    expect(matchSong(C3C5, duet(part(40, 74), part(68, 76)))).toEqual({ difficulty: 'easy', octave: 'down', part: 2 });
    expect(matchSong(C3C5, duet(part(44, 52), part(40, 74)))).toEqual({ difficulty: 'easy', octave: 'up', part: 1 });
  });

  it('returns null when no part fits', () => {
    expect(matchSong(C3C5, duet(part(40, 74), part(80, 90)))).toBeNull();
  });

  it('matches a parsed duet file on the part that fits', () => {
    // duet.txt: P1 C4..D4, P2 G4..C5. For a D4..E5 singer P1 only fits an octave up, P2 as written.
    expect(matchSong(user(62, 76), songRangeFromUltrastar(fixture('duet.txt')))).toEqual({ difficulty: 'easy', octave: 'none', part: 2 });
  });
});

describe('partRange', () => {
  it("swaps in one part's notes and keeps the rest of the song", () => {
    const p2 = part(56, 64, { singer: 'Two', pitchShare: [[56, 0.5], [64, 0.5]], fastLyrics: true });
    const whole = { ...duet(part(40, 74, { pitchShare: [[40, 1]] }), p2), usdbViews: 7 };
    expect(partRange(whole, 2)).toEqual({ ...whole, low: 56, high: 64, tessitura: 60, pitchShare: [[56, 0.5], [64, 0.5]], fastLyrics: true });
  });

  it("drops the whole song's pitch histogram when the part has none", () => {
    const whole = duet(part(40, 74, { pitchShare: [[40, 1]] }), part(56, 64));
    expect(partRange(whole, 2)).not.toHaveProperty('pitchShare');
  });
});

describe('matchSong for low-confidence ranges (the Maybe group)', () => {
  const rough = (low: number, high: number): SongRange => ({ ...song(low, high), source: 'artist-typical', confidence: 'low' });

  it('goes by the whole range even when it has duet parts', () => {
    const parts = [part(40, 80), part(56, 64)];
    expect(matchSong(C3C5, { ...rough(46, 74), duet: true, parts })).toEqual({ difficulty: 'maybe', octave: 'none' });
    expect(matchSong(C3C5, { ...rough(45, 70), duet: true, parts })).toBeNull(); // P2 would fit, but estimates have no parts to sing
  });

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
