import { describe, expect, it } from 'vitest';
import type { Match, SongRange, Track, VocalRange } from '../../src/lib/contracts';
import { matchSong } from '../../src/lib/songs/match';
import { rankMatches } from '../../src/lib/songs/rank';
import {
  comfortScore,
  familiarityScore,
  pitchComfort,
  popularityScore,
  reasonsFor,
  scoreMatch,
  UNKNOWN_POPULARITY,
} from '../../src/lib/songs/score';
import { songRangeFromUltrastar } from '../../src/lib/songs/range';

const user: VocalRange = { low: 48, high: 72, source: 'test' }; // C3-C5, centre C4
const track = (id: string, extra: Partial<Track> = {}): Track => ({ id, title: id, artist: 'A', artistId: 'a', spotifyUrl: '', playRank: 0, ...extra });
const song = (low: number, high: number, extra: Partial<SongRange> = {}): SongRange => ({
  low,
  high,
  tessitura: (low + high) / 2,
  source: 'note-file',
  confidence: 'high',
  fastLyrics: false,
  ...extra,
});
const match = (t: Track, r: SongRange): Match => {
  const fit = matchSong(user, r)!;
  return scoreMatch(user, { track: t, range: r, ...fit });
};

describe('comfort', () => {
  it('is 1 in the middle half of the range and falls to 0 at the edges', () => {
    expect(pitchComfort(user, 60)).toBe(1);
    expect(pitchComfort(user, 54)).toBe(1); // exactly halfway to the edge
    expect(pitchComfort(user, 69)).toBeCloseTo(0.5);
    expect(pitchComfort(user, 72)).toBe(0);
  });

  it('weighs the time spent on each pitch, not just the extremes', () => {
    // Hard by its top note (C5), but 95% of it sits on C4.
    const mostlyMiddle = song(60, 72, { pitchShare: [[60, 0.95], [72, 0.05]] });
    expect(comfortScore(user, mostlyMiddle, 'none')).toBeCloseTo(0.95);
    expect(matchSong(user, mostlyMiddle)!.difficulty).toBe('hard');
  });

  it('applies the octave shift', () => {
    const high = song(72, 84, { pitchShare: [[72, 1]] });
    expect(comfortScore(user, high, 'down')).toBe(1); // sung as C4
  });

  it('estimates from the typical note when there is no histogram', () => {
    expect(comfortScore(user, song(57, 63), 'none')).toBe(1);
    expect(comfortScore(user, song(48, 72), 'none')).toBeCloseTo(0.7);
  });

  it('note files now carry a pitch histogram that sums to about 1', () => {
    const r = songRangeFromUltrastar('#BPM:120\n: 0 4 0 a\n: 8 4 2 b\n: 16 8 4 c\nE\n');
    expect(r.pitchShare).toEqual([[60, 0.25], [62, 0.25], [64, 0.5]]);
  });
});

describe('familiarity and popularity', () => {
  it('uses the familiarity field, else falls with play rank', () => {
    expect(familiarityScore(track('x', { familiarity: 0.8 }))).toBe(0.8);
    expect(familiarityScore(track('x', { playRank: 0 }))).toBe(1);
    expect(familiarityScore(track('x', { playRank: 20 }))).toBe(0.5);
  });

  it('averages Spotify and USDB popularity, using whichever exists', () => {
    expect(popularityScore(track('x', { popularity: 80 }), song(55, 65))).toBeCloseTo(0.8);
    expect(popularityScore(track('x'), song(55, 65, { usdbViews: 99_999, usdbRating: 5 }))).toBeCloseTo(1);
    expect(popularityScore(track('x', { popularity: 40 }), song(55, 65, { usdbRating: 4 }))).toBeCloseTo(0.6);
    expect(popularityScore(track('x'), song(55, 65))).toBe(UNKNOWN_POPULARITY);
  });
});

describe('ranking', () => {
  it('puts a comfortable song you know ahead of a hard one you play slightly more', () => {
    const easy = match(track('easy', { familiarity: 0.7 }), song(57, 63));
    const hard = match(track('hard', { familiarity: 0.8 }), song(48, 72, { pitchShare: [[48, 0.5], [72, 0.5]] }));
    expect(rankMatches([hard, easy]).map((m) => m.track.id)).toEqual(['easy', 'hard']);
  });

  it('lets a Hard song reach the top 5 through familiarity and popularity', () => {
    const favourite = match(track('fav', { familiarity: 1, popularity: 95 }), song(50, 72, { pitchShare: [[50, 0.1], [60, 0.8], [72, 0.1]] }));
    expect(favourite.difficulty).toBe('hard');
    const filler = Array.from({ length: 10 }, (_, i) => match(track(`f${i}`, { familiarity: 0.1, popularity: 20 }), song(56, 64)));
    const top5 = rankMatches([...filler, favourite]).slice(0, 5).map((m) => m.track.id);
    expect(top5[0]).toBe('fav');
  });

  it('penalties lower a song without removing it', () => {
    const plain = match(track('plain', { familiarity: 0.5 }), song(57, 63));
    const fast = match(track('fast', { familiarity: 0.5 }), song(57, 63, { fastLyrics: true }));
    const guessed = match(track('guessed', { familiarity: 0.5 }), song(57, 63, { source: 'artist-typical', confidence: 'low' }));
    const shifted = match(track('shifted', { familiarity: 0.5 }), song(69, 75));
    expect(shifted.octave).toBe('down');
    const order = rankMatches([shifted, guessed, fast, plain]).map((m) => m.track.id);
    // Shifted and guessed tie at -0.10; the song that fits as written goes first.
    expect(order).toEqual(['plain', 'fast', 'guessed', 'shifted']);
    expect(fast.score!).toBeCloseTo(plain.score! - 0.05);
    expect(guessed.score!).toBeCloseTo(plain.score! - 0.1);
    expect(shifted.parts!.penalty).toBeCloseTo(0.1);
  });

  it('breaks score ties by comfort, then familiarity', () => {
    const a: Match = { track: track('a'), range: song(55, 65), difficulty: 'easy', octave: 'none', score: 0.5, parts: { comfort: 0.6, familiarity: 0.2, popularity: 0, penalty: 0 } };
    const b: Match = { ...a, track: track('b'), parts: { comfort: 0.8, familiarity: 0.1, popularity: 0, penalty: 0 } };
    const c: Match = { ...a, track: track('c'), parts: { comfort: 0.8, familiarity: 0.3, popularity: 0, penalty: 0 } };
    expect(rankMatches([a, b, c]).map((m) => m.track.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('reasons', () => {
  it('names the one or two biggest contributors', () => {
    expect(reasonsFor({ comfort: 0.9, familiarity: 0.8, popularity: 0.9, penalty: 0 })).toEqual(['In your sweet spot', 'You play this a lot']);
    expect(reasonsFor({ comfort: 0.3, familiarity: 0.1, popularity: 0.9, penalty: 0 })).toEqual(['Crowd favourite']);
    expect(reasonsFor({ comfort: 0.2, familiarity: 0.1, popularity: 0.2, penalty: 0 })).toEqual([]);
  });
});
