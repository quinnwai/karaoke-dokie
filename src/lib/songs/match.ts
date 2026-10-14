// Decides whether a song fits a user's vocal range and how hard it will feel.
//
// A song is only offered if every sung note (low..high) lies inside the
// user's comfortable range. Difficulty then depends on how close the song
// gets to the edges of that range: notes near the middle are easy to sustain,
// notes at the very top or bottom of a range strain the voice. We measure the
// furthest song note from the centre of the user's range as a fraction f of
// the half-range (0 = centre, 1 = edge): easy up to 0.5, medium up to 0.7,
// hard beyond.
//
// If the song does not fit as written, we try it an octave down, then an
// octave up. Singing an octave away from the recording is natural (men and
// women routinely do it with each other's songs) and keeps the melody; other
// transpositions need a karaoke key-change, so we do not offer them.

import type { Difficulty, OctaveShift, SongRange, VocalRange } from '../contracts';

export const EASY_MAX_EDGE_FRACTION = 0.5;
export const MEDIUM_MAX_EDGE_FRACTION = 0.7;

// Absorbs floating-point noise so boundaries like 7/10 stay inclusive.
const EPSILON = 1e-9;

export interface SongFit {
  difficulty: Difficulty;
  octave: OctaveShift;
}

function fits(user: VocalRange, low: number, high: number): boolean {
  return low >= user.low - EPSILON && high <= user.high + EPSILON;
}

function difficultyOf(user: VocalRange, low: number, high: number): Difficulty {
  const center = (user.low + user.high) / 2;
  const half = (user.high - user.low) / 2;
  if (half <= 0) return 'hard'; // single-note range: anything that fits is at the edge
  const f = Math.max(Math.abs(low - center), Math.abs(high - center)) / half;
  if (f <= EASY_MAX_EDGE_FRACTION + EPSILON) return 'easy';
  if (f <= MEDIUM_MAX_EDGE_FRACTION + EPSILON) return 'medium';
  return 'hard';
}

const SHIFTS: { octave: OctaveShift; semitones: number }[] = [
  { octave: 'none', semitones: 0 },
  { octave: 'down', semitones: -12 },
  { octave: 'up', semitones: 12 },
];

export function matchSong(userRange: VocalRange, song: SongRange): SongFit | null {
  for (const { octave, semitones } of SHIFTS) {
    const low = song.low + semitones;
    const high = song.high + semitones;
    if (fits(userRange, low, high)) {
      return { difficulty: difficultyOf(userRange, low, high), octave };
    }
  }
  return null;
}
