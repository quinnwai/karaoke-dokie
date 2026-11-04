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
// Popularity (0-1): average of Spotify popularity, USDB karaoke popularity (views, stars) and
// KaraFun karaoke-video views, with a floor for Billboard Year-End hits (popularityScore).
// Penalties lower a song without hiding it.

import type { Label, Match, OctaveShift, ScoreParts, SongRange, Track, VocalRange } from '../contracts';
import { edgeTime } from './match';

export const WEIGHTS = { fit: 0.85, popularity: 0.15 } as const;
/** How much each part counts when picking the reasons shown for a rank. */
const REASON_WEIGHTS = { comfort: 0.5, familiarity: 0.35, popularity: 0.15 } as const;
export const PENALTIES = { octave: 0.1, artistEstimate: 0.1, fastLyrics: 0.05 } as const;
/** Used when we know nothing about a song's popularity. */
export const UNKNOWN_POPULARITY = 0.4;
/** USDB views at which view-popularity reaches 1 (log scale). */
const USDB_VIEWS_FULL = 100_000;
/**
 * Karaoke views (YouTube views of a song's KaraFun karaoke videos) at which they count 1, on the
 * same log scale as USDB views: the 99th percentile of the 9,712 songs in the KaraFun file of
 * Oct 2026. The median song there scores 0.70 and the 90th percentile 0.86. `npm run
 * popularity:import -- ... --dry-run` prints the percentiles of a newer file.
 */
export const KARAOKE_VIEWS_FULL = 5_500_000;
/**
 * Least popularity of a song on a Billboard Year-End Hot 100, and of a top-20 one, which so always
 * clears the 0.7 of "Crowd favourite". Year-End songs that KaraFun also has score 0.63 at their
 * lower quartile from karaoke views alone (0.72 median, much the same at every rank), so a chart
 * entry with nothing else puts a song about where most charting songs land.
 */
export const CHART_FLOOR = { top100: 0.6, top20: 0.75 } as const;

/**
 * Popularity from our own karaoke data (song_popularity, QWW-6): the YouTube views of a song's
 * KaraFun karaoke videos and its best Billboard Year-End Hot 100 rank (1 to 100). It goes on a copy
 * of the song's range for scoring only and is never stored with the range.
 */
export interface KaraokePopularity {
  karaokeViews?: number;
  chartRank?: number;
}

/** A copy of `range` carrying the song's karaoke popularity, to score with; `range` is left as it is. */
export function withKaraokePopularity(range: SongRange, p: KaraokePopularity | undefined): SongRange & KaraokePopularity {
  if (p?.karaokeViews === undefined && p?.chartRank === undefined) return range;
  const scored: SongRange & KaraokePopularity = { ...range };
  if (p.karaokeViews !== undefined) scored.karaokeViews = p.karaokeViews;
  if (p.chartRank !== undefined) scored.chartRank = p.chartRank;
  return scored;
}

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

/**
 * How well known a song is, from what we know about it, in this order:
 *   1. Spotify popularity, when Spotify sends it
 *   2. USDB views (log scale) and stars, averaged into one
 *   3. karaoke views (log scale, full at KARAOKE_VIEWS_FULL)
 *   4. a Billboard Year-End Hot 100 entry, as a floor (CHART_FLOOR)
 * The first three measure the same thing on their own scales, and none is reliably the best, so
 * the ones present are averaged, as Spotify and USDB always were. The chart is a floor instead:
 * a Year-End hit is widely known whatever its views say, while a song missing from the chart may
 * still be well known (older songs, hits outside the US), so it can only raise a song. With none
 * of the four, UNKNOWN_POPULARITY.
 */
export function popularityScore(track: Track, song: SongRange & KaraokePopularity): number {
  const parts: number[] = [];
  if (typeof track.popularity === 'number') parts.push(Math.min(1, Math.max(0, track.popularity / 100)));
  const usdb: number[] = [];
  if (typeof song.usdbViews === 'number') usdb.push(Math.min(1, Math.log10(song.usdbViews + 1) / Math.log10(USDB_VIEWS_FULL)));
  if (typeof song.usdbRating === 'number') usdb.push(Math.min(1, Math.max(0, song.usdbRating / 5)));
  if (usdb.length) parts.push(usdb.reduce((a, b) => a + b, 0) / usdb.length);
  if (typeof song.karaokeViews === 'number') parts.push(Math.min(1, Math.log10(song.karaokeViews + 1) / Math.log10(KARAOKE_VIEWS_FULL)));
  const floor = typeof song.chartRank !== 'number' ? undefined : song.chartRank <= 20 ? CHART_FLOOR.top20 : CHART_FLOOR.top100;
  if (!parts.length) return floor ?? UNKNOWN_POPULARITY;
  return Math.max(parts.reduce((a, b) => a + b, 0) / parts.length, floor ?? 0);
}

/**
 * False when popularityScore had nothing to go on (no Spotify popularity, USDB views or stars,
 * karaoke views or Year-End chart entry) and gave the flat default.
 */
export function popularityKnown(track: Track, song: SongRange & KaraokePopularity): boolean {
  return (
    typeof track.popularity === 'number' ||
    typeof song.usdbViews === 'number' ||
    typeof song.usdbRating === 'number' ||
    typeof song.karaokeViews === 'number' ||
    typeof song.chartRank === 'number'
  );
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
    popularityKnown: popularityKnown(track, song),
    penalty,
  };
}

export function totalScore(p: ScoreParts): number {
  return WEIGHTS.fit * p.comfort * p.familiarity + WEIGHTS.popularity * p.popularity - p.penalty;
}

/** Where a song sits for the user: its difficulty and the edge it leans on. */
export interface FitNote {
  difficulty: Label;
  side: 'top' | 'bottom';
}

/** What the reasons read from a track: whether the user knows it, and where their listening shows it. */
type TrackListening = Pick<Track, 'known' | 'topLists' | 'recentPlays' | 'inPlaylist'>;

/**
 * The listening reason: the strongest sign that the user knows the song, with its time frame, in
 * this order: the 4-week top list, the 6-month one, the last 50 plays, the 1-year one, their
 * playlists. A track that does not say where it was heard (a library cached before buildLibrary
 * recorded it, a test track) gets the older wording, from familiarity alone.
 */
function listeningReason(t: TrackListening | undefined, familiarity: number): string {
  const top = t?.topLists ?? [];
  if (top.includes('short_term')) return 'In your top songs this month';
  if (top.includes('medium_term')) return 'In your top songs of the past 6 months';
  if (t?.recentPlays) return 'Played recently';
  if (top.includes('long_term')) return 'In your top songs of the past year';
  if (t?.inPlaylist) return 'In your playlists';
  return familiarity >= 0.6 ? 'You play this a lot' : 'You know this one';
}

/**
 * The one or two biggest contributors, in words. With a FitNote the range reason follows the
 * difficulty label, so a Hard song never says "In your sweet spot"; a Hard song always says why.
 * A Maybe song's range is only an estimate, so it gets no range reason.
 * A song with familiarity 0.3 or more gets a listening reason (listeningReason), unless the user
 * does not know it (`known` false): catalogue songs carry familiarity 1 only so that comfort
 * alone decides their fit. Saved-only songs are also not known, but their familiarity is below
 * 0.3 anyway.
 */
export function reasonsFor(p: ScoreParts, fit?: FitNote, track?: TrackListening): string[] {
  const candidates: { text: string; weight: number }[] = [];
  const comfortWeight = REASON_WEIGHTS.comfort * p.comfort;
  const edge = fit?.side === 'bottom' ? 'low end' : 'high end';
  if (!fit) {
    if (p.comfort >= 0.8) candidates.push({ text: 'In your sweet spot', weight: comfortWeight });
    else if (p.comfort >= 0.5) candidates.push({ text: 'Mostly comfortable', weight: comfortWeight });
  } else if (fit.difficulty === 'easy') {
    candidates.push({ text: 'In your sweet spot', weight: comfortWeight });
  } else if (fit.difficulty === 'medium') {
    candidates.push({ text: `A few notes near your ${edge}`, weight: comfortWeight });
  } else if (fit.difficulty === 'hard') {
    candidates.push({ text: `Spends time at your ${edge}`, weight: Infinity });
  }
  if (track?.known !== false && p.familiarity >= 0.3) {
    candidates.push({ text: listeningReason(track, p.familiarity), weight: REASON_WEIGHTS.familiarity * p.familiarity });
  }
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
  return { ...m, parts, score: totalScore(parts), reasons: reasonsFor(parts, { difficulty: m.difficulty, side }, m.track) };
}
