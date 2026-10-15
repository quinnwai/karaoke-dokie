// Ranks songs that fit: one score per song, higher first.
//   score = 0.85 comfort × familiarity + 0.15 popularity - penalties
// Comfort and familiarity multiply (the user's call): a song ranks high only when it is both
// comfortable and one you know; low on either sinks it. Songs the user does not know (saved
// only) are also ranked below known ones in rank.ts.
//
// Comfort (0-1): how much of the song's sung time sits in the user's sweet spot, the middle
// half of their range. Notes outside it count less the closer they get to the edge. Songs
// with a pitch histogram (pitchShare, from the note file) use it; others are estimated from
// their typical note and their highest and lowest notes.
// Familiarity (0-1): computed from Spotify listening (see server/spotify.ts buildLibrary).
// Popularity (0-1): average of Spotify popularity and USDB karaoke popularity (views, stars).
// Penalties lower a song without hiding it.

import type { Difficulty, Match, OctaveShift, ScoreParts, SongRange, Track, VocalRange } from '../contracts';
import { edgeTime } from './match';

export const WEIGHTS = { fit: 0.85, popularity: 0.15 } as const;
/** How much each part counts when picking the reasons shown for a rank. */
const REASON_WEIGHTS = { comfort: 0.5, familiarity: 0.35, popularity: 0.15 } as const;
export const PENALTIES = { octave: 0.1, artistEstimate: 0.1, fastLyrics: 0.05 } as const;
/** Used when we know nothing about a song's popularity. */
export const UNKNOWN_POPULARITY = 0.4;
/** USDB views at which view-popularity reaches 1 (log scale). */
const USDB_VIEWS_FULL = 100_000;

const shiftOf = (octave: OctaveShift) => (octave === 'up' ? 12 : octave === 'down' ? -12 : 0);

/** 1 inside the middle half of the range, falling linearly to 0 at the edges and beyond. */
export function pitchComfort(user: VocalRange, midi: number): number {
  const center = (user.low + user.high) / 2;
  const half = (user.high - user.low) / 2;
  if (half <= 0) return midi === center ? 1 : 0;
  const d = Math.abs(midi - center) / half;
  if (d <= 0.5) return 1;
  return Math.max(0, 1 - (d - 0.5) / 0.5);
}

export function comfortScore(user: VocalRange, song: SongRange, octave: OctaveShift): number {
  const shift = shiftOf(octave);
  if (song.pitchShare?.length) {
    let sum = 0;
    let total = 0;
    for (const [midi, share] of song.pitchShare) {
      sum += share * pitchComfort(user, midi + shift);
      total += share;
    }
    return total > 0 ? sum / total : 0;
  }
  // No histogram: mostly where the song sits, partly how far its extremes reach.
  const typical = pitchComfort(user, song.tessitura + shift);
  const extremes = (pitchComfort(user, song.low + shift) + pitchComfort(user, song.high + shift)) / 2;
  return 0.7 * typical + 0.3 * extremes;
}

export function popularityScore(track: Track, song: SongRange): number {
  const parts: number[] = [];
  if (typeof track.popularity === 'number') parts.push(Math.min(1, Math.max(0, track.popularity / 100)));
  const usdb: number[] = [];
  if (typeof song.usdbViews === 'number') usdb.push(Math.min(1, Math.log10(song.usdbViews + 1) / Math.log10(USDB_VIEWS_FULL)));
  if (typeof song.usdbRating === 'number') usdb.push(Math.min(1, Math.max(0, song.usdbRating / 5)));
  if (usdb.length) parts.push(usdb.reduce((a, b) => a + b, 0) / usdb.length);
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : UNKNOWN_POPULARITY;
}

/** Familiarity for tracks that predate the familiarity field: falls with play rank. */
export function familiarityScore(track: Track): number {
  if (typeof track.familiarity === 'number') return Math.min(1, Math.max(0, track.familiarity));
  return 1 / (1 + track.playRank / 20);
}

export function scoreParts(user: VocalRange, track: Track, song: SongRange, octave: OctaveShift): ScoreParts {
  let penalty = 0;
  if (octave !== 'none') penalty += PENALTIES.octave;
  if (song.confidence === 'low') penalty += PENALTIES.artistEstimate;
  if (song.fastLyrics) penalty += PENALTIES.fastLyrics;
  return {
    comfort: comfortScore(user, song, octave),
    familiarity: familiarityScore(track),
    popularity: popularityScore(track, song),
    penalty,
  };
}

export function totalScore(p: ScoreParts): number {
  return WEIGHTS.fit * p.comfort * p.familiarity + WEIGHTS.popularity * p.popularity - p.penalty;
}

/** Where a song sits for the user: its difficulty and the edge it leans on. */
export interface FitNote {
  difficulty: Difficulty;
  side: 'top' | 'bottom';
}

/**
 * The one or two biggest contributors, in words. With a FitNote the range reason follows the
 * difficulty label, so a Hard song never says "In your sweet spot"; a Hard song always says why.
 */
export function reasonsFor(p: ScoreParts, fit?: FitNote): string[] {
  const candidates: { text: string; weight: number }[] = [];
  const comfortWeight = REASON_WEIGHTS.comfort * p.comfort;
  const edge = fit?.side === 'bottom' ? 'low end' : 'top';
  if (!fit) {
    if (p.comfort >= 0.8) candidates.push({ text: 'In your sweet spot', weight: comfortWeight });
    else if (p.comfort >= 0.5) candidates.push({ text: 'Mostly comfortable', weight: comfortWeight });
  } else if (fit.difficulty === 'easy') {
    candidates.push({ text: 'In your sweet spot', weight: comfortWeight });
  } else if (fit.difficulty === 'medium') {
    candidates.push({ text: `A few notes near your ${edge}`, weight: comfortWeight });
  } else {
    candidates.push({ text: `Spends time at your ${edge}`, weight: Infinity });
  }
  if (p.familiarity >= 0.6) candidates.push({ text: 'You play this a lot', weight: REASON_WEIGHTS.familiarity * p.familiarity });
  else if (p.familiarity >= 0.3) candidates.push({ text: 'You know this one', weight: REASON_WEIGHTS.familiarity * p.familiarity });
  if (p.popularity >= 0.7) candidates.push({ text: 'Crowd favourite', weight: REASON_WEIGHTS.popularity * p.popularity });
  return candidates
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 2)
    .map((c) => c.text);
}

/** Adds score, parts and reasons to a match. */
export function scoreMatch(user: VocalRange, m: Match): Match {
  const parts = scoreParts(user, m.track, m.range, m.octave);
  const { side } = edgeTime(user, m.range, shiftOf(m.octave));
  return { ...m, parts, score: totalScore(parts), reasons: reasonsFor(parts, { difficulty: m.difficulty, side }) };
}
