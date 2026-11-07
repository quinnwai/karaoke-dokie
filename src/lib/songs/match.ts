// Decides whether a song fits a user's vocal range and how hard it will feel.
//
// A song is only offered if every sung note (low..high) lies inside the
// user's comfortable range. Difficulty then depends on how much of the singing
// sits near the edges of that range. The range splits into the middle half,
// then on each side an outer eighth and, at the very top and bottom, an edge
// eighth:
//   hard:   10% or more of the sung time in an edge eighth
//   medium: 2% or more in an edge eighth, or 25% or more outside the middle half
//   easy:   everything else
// Time comes from the note file's pitch histogram (pitchShare). Songs without
// one are estimated as 70% at their typical note and 15% each at their lowest
// and highest notes, the same weighting score.ts uses for comfort.
//
// If the song does not fit as written, we try it an octave down, then an
// octave up. Singing an octave away from the recording is natural (men and
// women routinely do it with each other's songs) and keeps the melody; other
// transpositions need a karaoke key-change, so we do not offer them.
//
// A duet is sung as a pair, each singer on their own part, so a duet with
// parts (range.ts) is offered when one part fits the user, and matched on the
// part that suits them best: one that fits as written over one that needs an
// octave shift, then the easier one, then P1. The match then shows and scores
// that part's own notes (toMatch).
//
// All of that is for confident ranges. A low-confidence range (an artist
// estimate, or a mostly-rap or thinly sung recording) is too rough for a
// label: it goes in the Maybe group, shown after the other songs without a
// difficulty, when it fits the user's range widened by MAYBE_SLACK semitones
// at each end (as written or an octave away). Two semitones is about the
// artist estimate's typical error at each end; against note files it catches
// 93% of the estimated songs that really fit (maybe_group.py in the
// vocal-range pipeline).

import type { Difficulty, Label, Match, OctaveShift, SongRange, Track, VocalRange } from '../contracts';

/** Distance from the centre, as a fraction of the half-range, where the outer and edge eighths start. */
export const OUTER_FROM = 0.5;
export const EDGE_FROM = 0.75;
export const HARD_MIN_EDGE_SHARE = 0.1;
export const MEDIUM_MIN_EDGE_SHARE = 0.02;
export const MEDIUM_MIN_OUTER_SHARE = 0.25;
/** Semitones of slack at each end of the user's range for low-confidence ranges (the Maybe group). */
export const MAYBE_SLACK = 2;

// Absorbs floating-point noise so boundaries stay put.
const EPSILON = 1e-9;

export interface SongFit {
  difficulty: Label;
  octave: OctaveShift;
  /** For a duet, the part the user sings (1 = P1, 2 = P2). Unset for solo songs and the Maybe group. */
  part?: number;
}

export interface EdgeTime {
  /** Share of sung time outside the middle half of the range (edge eighths included). */
  outer: number;
  /** Share of sung time in the edge eighths. */
  edge: number;
  /** Which edge the song leans on most. */
  side: 'top' | 'bottom';
}

function fits(user: VocalRange, low: number, high: number): boolean {
  return low >= user.low - EPSILON && high <= user.high + EPSILON;
}

/** The song's sung time by pitch, shifted by `semitones`. */
function pitchTime(song: SongRange, semitones: number): [number, number][] {
  if (song.pitchShare?.length) return song.pitchShare.map(([m, share]) => [m + semitones, share]);
  return [
    [song.tessitura + semitones, 0.7],
    [song.low + semitones, 0.15],
    [song.high + semitones, 0.15],
  ];
}

/** How much of a song (shifted by `semitones`) sits outside the user's middle half and at their edges. */
export function edgeTime(user: VocalRange, song: SongRange, semitones = 0): EdgeTime {
  const center = (user.low + user.high) / 2;
  const half = (user.high - user.low) / 2;
  let outer = 0;
  let edge = 0;
  let total = 0;
  let above = 0;
  let below = 0;
  for (const [midi, share] of pitchTime(song, semitones)) {
    total += share;
    const d = half > 0 ? Math.abs(midi - center) / half : 1;
    if (d > OUTER_FROM + EPSILON) {
      outer += share;
      if (midi > center) above += share;
      else below += share;
    }
    if (d > EDGE_FROM + EPSILON) edge += share;
  }
  if (total <= 0) return { outer: 0, edge: 0, side: 'top' };
  return { outer: outer / total, edge: edge / total, side: below > above ? 'bottom' : 'top' };
}

export function difficultyFromEdgeTime({ outer, edge }: EdgeTime): Difficulty {
  if (edge >= HARD_MIN_EDGE_SHARE - EPSILON) return 'hard';
  if (edge >= MEDIUM_MIN_EDGE_SHARE - EPSILON || outer >= MEDIUM_MIN_OUTER_SHARE - EPSILON) return 'medium';
  return 'easy';
}

/**
 * How hard a song is inside its difficulty label, 0 to 3 (Match.strain): the edge-eighth share counts
 * twice, since those notes are also outside the middle half. Same numbers as the label itself.
 */
export function strainOf({ outer, edge }: EdgeTime): number {
  return 2 * edge + outer;
}

export const SHIFTS: { octave: OctaveShift; semitones: number }[] = [
  { octave: 'none', semitones: 0 },
  { octave: 'down', semitones: -12 },
  { octave: 'up', semitones: 12 },
];

export function matchSong(userRange: VocalRange, song: SongRange): SongFit | null {
  if (song.confidence === 'low') return maybeFit(userRange, song);
  if (song.parts?.length) return duetFit(userRange, song);
  return strictFit(userRange, song);
}

/** As written, else an octave down, else an octave up: the first that fits, with its difficulty. */
function strictFit(userRange: VocalRange, song: SongRange): SongFit | null {
  for (const { octave, semitones } of SHIFTS) {
    const low = song.low + semitones;
    const high = song.high + semitones;
    if (fits(userRange, low, high)) {
      return { difficulty: difficultyFromEdgeTime(edgeTime(userRange, song, semitones)), octave };
    }
  }
  return null;
}

const DIFFICULTY_ORDER: Record<Label, number> = { easy: 0, medium: 1, hard: 2, maybe: 3 };

/** The duet part that suits the user best: fits as written, then easier; a tie goes to the earlier part. */
function duetFit(userRange: VocalRange, song: SongRange): SongFit | null {
  const shifted = (f: SongFit) => (f.octave === 'none' ? 0 : 1);
  const fitting = (song.parts ?? []).flatMap((_, i) => {
    const fit = strictFit(userRange, partRange(song, i + 1));
    return fit ? [{ ...fit, part: i + 1 }] : [];
  });
  // Sorting is stable, so parts that tie stay in order.
  fitting.sort((a, b) => shifted(a) - shifted(b) || DIFFICULTY_ORDER[a.difficulty] - DIFFICULTY_ORDER[b.difficulty]);
  return fitting[0] ?? null;
}

/**
 * A duet as one singer sings it: that part's range, typical note, pitch histogram and fast-lyrics
 * flag, with the song's other details (source, USDB facts, `duet`, `parts`) kept.
 */
export function partRange(song: SongRange, part: number): SongRange {
  const p = song.parts?.[part - 1];
  if (!p) throw new Error(`Song has no part ${part}`);
  const { pitchShare: _wholeSong, ...rest } = song;
  const range: SongRange = { ...rest, low: p.low, high: p.high, tessitura: p.tessitura, fastLyrics: p.fastLyrics };
  if (p.pitchShare) range.pitchShare = p.pitchShare;
  return range;
}

/**
 * The (unscored) match for a fit. A duet matched on one part is shown and scored as that part:
 * its range is the part's, so the range bar shows the singer's own notes, and it says which part
 * and who sings it.
 */
export function toMatch(track: Track, song: SongRange, fit: SongFit): Match {
  if (fit.part === undefined) return { track, range: song, ...fit };
  const match: Match = { track, range: partRange(song, fit.part), ...fit };
  const singer = song.parts?.[fit.part - 1]?.singer;
  if (singer) match.partSinger = singer;
  return match;
}

/** A low-confidence range that fits the user's range give or take MAYBE_SLACK: the Maybe group. */
function maybeFit(userRange: VocalRange, song: SongRange): SongFit | null {
  const wide = { ...userRange, low: userRange.low - MAYBE_SLACK, high: userRange.high + MAYBE_SLACK };
  for (const { octave, semitones } of SHIFTS) {
    if (fits(wide, song.low + semitones, song.high + semitones)) return { difficulty: 'maybe', octave };
  }
  return null;
}
