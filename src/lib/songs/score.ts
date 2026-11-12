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
// Popularity (0-1): average of Spotify popularity, USDB karaoke popularity (views), KaraFun
// karaoke-video views and Deezer track rank, each on one shared scale, with a floor for Billboard
// Year-End hits (popularityScore, POPULARITY_SCALE).
// Penalties lower a song without hiding it.

import { SHAPE_BINS, type Label, type Match, type OctaveShift, type ScoreParts, type SongRange, type Track, type VocalRange } from '../contracts';
import { onScale } from '../popularity/calibrate';
import { edgeTime, strainOf } from './match';
import { POPULARITY_SCALE } from './popularityScale';

export const WEIGHTS = { fit: 0.85, popularity: 0.15 } as const;
/** How much each part counts when picking the reasons shown for a rank. */
const REASON_WEIGHTS = { comfort: 0.5, familiarity: 0.35, popularity: 0.15 } as const;
/** `artistEstimate` is the penalty for any low-confidence range: an artist estimate, a rough recording, or a narrow range (QWW-60). */
export const PENALTIES = { octave: 0.1, artistEstimate: 0.1, fastLyrics: 0.05 } as const;
/** Used when we know nothing about a song's popularity. */
export const UNKNOWN_POPULARITY = 0.4;
/**
 * Least popularity of a song on a Billboard Year-End Hot 100, and of a top-20 one: the lower
 * quartile of what charting songs score from their views, so a chart entry with nothing else puts a
 * song about where most charting songs land. Set by `npm run popularity:calibrate`.
 */
export const CHART_FLOOR = POPULARITY_SCALE.chartFloor;

/**
 * Popularity from our own karaoke data (song_popularity, QWW-6): the YouTube views of a song's
 * KaraFun karaoke videos and its best Billboard Year-End Hot 100 rank (1 to 100), plus its Deezer
 * track rank (song_deezer, QWW-37). It goes on a copy of the song's range for scoring only and is
 * never stored with the range.
 */
export interface KaraokePopularity {
  karaokeViews?: number;
  chartRank?: number;
  deezerRank?: number;
}

/** A copy of `range` carrying the song's karaoke popularity, to score with; `range` is left as it is. */
export function withKaraokePopularity(range: SongRange, p: KaraokePopularity | undefined): SongRange & KaraokePopularity {
  if (p?.karaokeViews === undefined && p?.chartRank === undefined && p?.deezerRank === undefined) return range;
  const scored: SongRange & KaraokePopularity = { ...range };
  if (p.karaokeViews !== undefined) scored.karaokeViews = p.karaokeViews;
  if (p.chartRank !== undefined) scored.chartRank = p.chartRank;
  if (p.deezerRank !== undefined) scored.deezerRank = p.deezerRank;
  return scored;
}

/** What popularityScore reads from a song: its USDB views and its karaoke popularity. */
export type PopularityInputs = Pick<SongRange, 'usdbViews'> & KaraokePopularity;

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
 * How well known a song is, from what we know about it:
 *   1. Spotify popularity, when Spotify sends it
 *   2. USDB views
 *   3. karaoke views (KaraFun karaoke videos on YouTube)
 *   4. Deezer track rank (QWW-37)
 *   5. a Billboard Year-End Hot 100 entry, as a floor (CHART_FLOOR)
 * Each source is first put on one scale (POPULARITY_SCALE, src/lib/popularity/calibrate.ts): the
 * share of catalogue songs with fewer USDB views, the others linked to it on the songs that have
 * both, so a typical song scores the same whichever source we have. The first four measure the
 * same thing and none is reliably the best, so the ones present are averaged. The chart is a floor
 * instead: a Year-End hit is widely known whatever its views say, while a song missing from the
 * chart may still be well known (older songs, hits outside the US), so it can only raise a song.
 * With none of the five, UNKNOWN_POPULARITY. USDB stars are not used: nearly every song has 5.
 */
export function popularityScore(track: Pick<Track, 'popularity'>, song: PopularityInputs): number {
  const scale = POPULARITY_SCALE;
  const parts: number[] = [];
  if (typeof track.popularity === 'number') {
    parts.push(scale.spotify.length ? onScale(scale.spotify, track.popularity) : Math.min(1, Math.max(0, track.popularity / 100)));
  }
  if (typeof song.usdbViews === 'number') parts.push(onScale(scale.usdbViews, song.usdbViews));
  if (typeof song.karaokeViews === 'number') parts.push(onScale(scale.karaokeViews, song.karaokeViews));
  if (typeof song.deezerRank === 'number' && scale.deezer.length) parts.push(onScale(scale.deezer, song.deezerRank));
  const floor = typeof song.chartRank !== 'number' ? undefined : song.chartRank <= 20 ? CHART_FLOOR.top20 : CHART_FLOOR.top100;
  if (!parts.length) return floor ?? UNKNOWN_POPULARITY;
  return Math.max(parts.reduce((a, b) => a + b, 0) / parts.length, floor ?? 0);
}

/**
 * False when popularityScore had nothing to go on (no Spotify popularity, USDB views,
 * karaoke views, Deezer rank or Year-End chart entry) and gave the flat default. A Deezer rank
 * counts only once the scale has a Deezer link (npm run popularity:calibrate).
 */
export function popularityKnown(track: Pick<Track, 'popularity'>, song: PopularityInputs): boolean {
  return (
    typeof track.popularity === 'number' ||
    typeof song.usdbViews === 'number' ||
    typeof song.karaokeViews === 'number' ||
    (typeof song.deezerRank === 'number' && POPULARITY_SCALE.deezer.length > 0) ||
    typeof song.chartRank === 'number'
  );
}

/**
 * Where a song goes in the no-Spotify catalogue, highest first (QWW-32): its popularityScore
 * without Spotify, from its USDB views (the range's own, else its USDB row's, as the
 * catalogue scores it), its karaoke popularity and its Deezer rank. -1 when there is none of these, so a song we
 * know nothing about never takes the place of one we do; scored, it would get UNKNOWN_POPULARITY,
 * above many known songs. Both stores pick the catalogue with this, so it reads the same anywhere.
 */
export function catalogueRank(
  range: Pick<SongRange, 'usdbViews'>,
  usdb: { views?: number } | undefined,
  karaoke: KaraokePopularity | undefined,
): number {
  const song: PopularityInputs = {};
  const views = range.usdbViews ?? usdb?.views;
  if (views !== undefined) song.usdbViews = views;
  if (karaoke?.karaokeViews !== undefined) song.karaokeViews = karaoke.karaokeViews;
  if (karaoke?.chartRank !== undefined) song.chartRank = karaoke.chartRank;
  if (karaoke?.deezerRank !== undefined) song.deezerRank = karaoke.deezerRank;
  return popularityKnown({}, song) ? popularityScore({}, song) : -1;
}

/** Catalogue order: highest catalogueRank first, then by song key (code points, the same in every store). */
export function byCatalogueRank(a: { key: string; rank: number }, b: { key: string; rank: number }): number {
  return b.rank - a.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/**
 * The catalogue's songs, in catalogue order: the `limit` highest by catalogueRank, plus every song
 * on a Billboard Year-End Hot 100 (`charted`) below them. A Year-End hit is well known, but a recent
 * or US-only one can have few karaoke views yet (Burning Blue, 2025: #11,717 of 30,528 measured
 * songs in November 2026), so the cut alone would leave it out (QWW-32). Both stores pick with this.
 */
export function pickCatalogue<T extends { key: string; rank: number; charted: boolean }>(rows: T[], limit: number): T[] {
  return [...rows].sort(byCatalogueRank).filter((r, i) => i < limit || r.charted);
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
  if (top.includes('short_term')) return 'Top songs this month';
  if (top.includes('medium_term')) return 'Top songs, past 6 months';
  if (t?.recentPlays) return 'Played recently';
  if (top.includes('long_term')) return 'Top songs this past year';
  if (t?.inPlaylist) return 'In your playlists';
  return familiarity >= 0.6 ? 'You play this a lot' : 'You know this one';
}

/**
 * The one or two biggest contributors, in words. With a FitNote the range reason follows the
 * difficulty label, so a Hard song never says "In your sweet spot"; a Hard song always says why.
 * A Maybe song's range is not one we are sure of (an estimate, a rough recording, a very narrow range), so it gets no range reason.
 * A song with familiarity 0.3 or more gets a listening reason (listeningReason), unless the user
 * does not know it (`known` false): catalogue songs carry familiarity 1 only so that comfort
 * alone decides their fit. Saved-only songs are also not known, but their familiarity is below
 * 0.3 anyway.
 */
export function reasonsFor(p: ScoreParts, fit?: FitNote, track?: TrackListening): string[] {
  const candidates: { text: string; weight: number }[] = [];
  const comfortWeight = REASON_WEIGHTS.comfort * p.comfort;
  const edge = fit?.side === 'bottom' ? 'low' : 'high';
  if (!fit) {
    if (p.comfort >= 0.8) candidates.push({ text: 'In your sweet spot', weight: comfortWeight });
    else if (p.comfort >= 0.5) candidates.push({ text: 'Mostly comfortable', weight: comfortWeight });
  } else if (fit.difficulty === 'easy') {
    candidates.push({ text: 'In your sweet spot', weight: comfortWeight });
  } else if (fit.difficulty === 'medium') {
    candidates.push({ text: `Some ${edge} notes`, weight: comfortWeight });
  } else if (fit.difficulty === 'hard') {
    candidates.push({ text: `Lots of ${edge} notes`, weight: Infinity });
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

/**
 * The song's sung time across the user's range, as it is sung: SHAPE_BINS whole percents, lowest
 * note first. Undefined when the song has no pitch histogram (its estimate is three lumps, not a shape).
 *
 * Only notes inside the song's own range count. The range skips the outlier notes at each end (range.ts
 * trimmedRange) but the histogram keeps every note, so counting them all drew bars past the pink range on
 * the song page. A note outside the user's range has no bin: it used to be piled into the edge bin, which
 * showed sung time at the very edge of the range that is not there. A bin with any sung time is at least 1,
 * so 0 means no notes.
 */
export function shapeOf(user: VocalRange, song: SongRange, octave: OctaveShift): number[] | undefined {
  const span = user.high - user.low;
  if (!song.pitchShare?.length || span <= 0) return undefined;
  const shift = shiftOf(octave);
  const bins = new Array<number>(SHAPE_BINS).fill(0);
  let total = 0;
  for (const [midi, share] of song.pitchShare) {
    if (!(share > 0) || midi < song.low || midi > song.high) continue;
    const note = midi + shift;
    if (note < user.low || note > user.high) continue;
    const at = ((note - user.low) * SHAPE_BINS) / span;
    // A note on a bin's edge goes up a bin, except the song's top note, which goes down: the song page cuts a
    // bar at the song's top note, so the bin above it would be left with no width to draw in.
    const bin = midi === song.high && at > 0 && Number.isInteger(at) ? at - 1 : Math.min(SHAPE_BINS - 1, Math.floor(at));
    bins[bin]! += share;
    total += share;
  }
  return total > 0 ? bins.map((b) => (b > 0 ? Math.max(1, Math.round((100 * b) / total)) : 0)) : undefined;
}

/** Adds score, parts, reasons, strain and the time-in-range shape to a match. */
export function scoreMatch(user: VocalRange, m: Match): Match {
  const parts = scoreParts(user, m.track, m.range, m.octave);
  const edges = edgeTime(user, m.range, shiftOf(m.octave));
  const shape = shapeOf(user, m.range, m.octave);
  return {
    ...m,
    parts,
    score: totalScore(parts),
    reasons: reasonsFor(parts, { difficulty: m.difficulty, side: edges.side }, m.track),
    strain: strainOf(edges),
    ...(shape ? { shape } : {}),
  };
}
