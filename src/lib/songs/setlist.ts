// The ranking engine behind the Setlist tuner (QWW-47, model A: the design's distance ranking, round 5
// spec §5, is the only model). Pure and deterministic: the same songs and state give the same list, in any
// input order. The screen sends its state and gets this list back; it has no ranking math of its own.
//
//   1. Hard range filter, first. Only songs that fit the singer's measured range, as written or an octave
//      away (match.ts matchSong). That happens before this file: `candidates` are the songs that fit.
//   2. Every song gets a place on each gear, 0 to 100 (prepareSetlist). It depends on the songs and the
//      singer's range only, never on the gears, so it is made once per range and reused while a slider moves.
//   3. Era filter, then the songs are sorted. The first thing that counts is how a song is sung (QWW-58,
//      Quinn-Wai's decision A, 11 Nov): every song that fits as written comes before any song that needs an
//      octave jump, whatever the gears say. The jump songs still follow, so a singer whose popular songs all
//      need a jump still gets a full list. The Maybe songs (ranges we are less sure of) come after all the others, as
//      everywhere else, and are sorted that way inside too. Inside each of those groups the songs are sorted
//      by distance to the gear values (rankPrepared):
//        distance = sum over the active gears of weight × |song's place − gear value|
//      An active gear is one that is not in `off` (and History only when the singer's library was read).
//      Off gears add nothing. A song we do not know on an active gear (no tempo, an implausible range, not in
//      the singer's library) sorts after every song of its group that is known on it: "songs without a tempo
//      sort last", "the singer's own songs come first". When songs miss different gears the more specific
//      control wins (MISSING_RANK: History, then Tempo, then Popularity, then Difficulty), so a song with no
//      tempo sorts after every song that has one, whatever else either is missing. Ties go to the more popular
//      song, then the easier, then to the song's artist and title, then to the track id, so the order never
//      depends on input order, and a song keeps its place among equals whether it arrives as the catalogue's
//      track or the singer's own.
//
// Why the octave is a group of its own and not a penalty in the distance (QWW-58; the penalty was option B,
// not chosen): the octave used to break exact ties only, which a sum of places almost never produces, and the
// places themselves favour the jump. A song that is too high for you sits in the lower half of your range an
// octave down, where the "easy leans low" curve below is kindest, so it reads Easy and beats the same song
// sung as written; and the biggest hits (mostly tenor and female pop) win in whichever octave fits them, which
// put octave jumps at the top of a bass's list. The places do not change: a jump song keeps the Difficulty and
// Popularity place it is shown at, it just comes after the songs sung as written.
//
// The default state (setlistConfig.ts) is Popularity on at 100, Difficulty on at 0, the rest off. With
// Popularity counting double, that is a blend that leans on popularity: of two songs sung the same way, the one
// that is 10 places less popular needs to be 20 places easier to come first (QWW-42 rule 3, "most popular
// first, then easiest"). It is a blend, not a sort by popularity with difficulty breaking ties: the single most
// popular song is first only if it is also easy. The weights are GEAR_WEIGHTS, the one knob if the top of the
// default list needs to lean harder on popularity.
//
// A song's place on a gear is its rank among the singer's songs, as a share of them, not its raw score. Raw
// scores bunch up (karaoke popularity sits between 0.5 and 0.9, most songs sit near 120 bpm), and a track laid
// out by raw score has long stretches where moving the thumb changes nothing (QWW-33). By rank every tenth of
// the Popularity, Tempo and History tracks holds about a tenth of the songs, songs with the same score sharing
// their average place. Difficulty is the exception: it is laid out by label, a third of the track each (see
// difficultyPlaces), however few songs a label has.

import type { EraId, GearId, Match, SetlistInput, SetlistSong, SetlistState, TunerPart, VocalRange } from '../contracts';
import { GEAR_IDS } from '../contracts';
import { familiarityScore } from './score';
import { difficultyFromEdgeTime, edgeTime, pitchTime } from './match';
import { eraOf } from './setlistConfig';

/**
 * How much a gear's distance counts. Popularity counts double (model A), which is what makes the default state lean
 * on popularity: a ten place gap in popularity needs a twenty place easier song to make up for it.
 */
export const GEAR_WEIGHTS: Readonly<Record<GearId, number>> = Object.freeze({ difficulty: 1, history: 1, popularity: 2, tempo: 1 });

/**
 * A song range narrower than this many semitones is not a melody. The 5th to 95th percentile of what is sung
 * spans a fourth or more in any real song; a one-note range ("Jump", C4 to C4) is a rap or a measuring error,
 * and it fits every singer. Its difficulty is unknown, so it cannot win on being easy.
 */
export const MIN_PLAUSIBLE_SPAN = 5;

// ---------- the "easy leans low" curve ----------
//
// How hard one sung note is, by where it sits in the singer's range: t = 0 is their lowest note, t = 1 their
// highest. A song's strain is the sung-time-weighted average of this over its notes.
//
//   cost(t) = ((t - EASE_POINT) / (1 - EASE_POINT))²                  for t at or above EASE_POINT
//   cost(t) = BOTTOM_DISCOUNT × ((EASE_POINT - t) / EASE_POINT)²      for t below it
//
// EASE_POINT is the lower-middle of the range, the chest voice, where a note costs nothing. Cost rises
// with the square of the distance from it, so the middle is nearly flat and the edges are what matter
// (the same idea as the labels, which count time near the edges). The top climbs to 1 at the highest note;
// the bottom climbs only to BOTTOM_DISCOUNT at the lowest. So for the same distance from the edges a note
// near the top costs more than one near the bottom, at every distance (setlist.test.ts checks it):
//
//   t     0.00  0.10  0.20  0.35  0.50  0.65  0.80  0.90  1.00
//   cost  0.60  0.31  0.11  0.00  0.05  0.21  0.48  0.72  1.00

export const EASE_POINT = 0.35;
export const BOTTOM_DISCOUNT = 0.6;

/** The cost of one note at position `t` (0 lowest, 1 highest) of the singer's range; outside the range counts as the edge. */
export function noteCost(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  if (x >= EASE_POINT) return ((x - EASE_POINT) / (1 - EASE_POINT)) ** 2;
  return BOTTOM_DISCOUNT * ((EASE_POINT - x) / EASE_POINT) ** 2;
}

const octaveSemitones = (m: Match) => (m.octave === 'up' ? 12 : m.octave === 'down' ? -12 : 0);

/**
 * How strained the singer is on this song, 0 (all of it at the ease point) to 1 (all of it on their highest
 * note). The notes are as the singer sings them, an octave shift applied. null when the song's range is too
 * narrow to be a melody (MIN_PLAUSIBLE_SPAN): we do not know how hard it is.
 */
export function songStrain(range: Pick<VocalRange, 'low' | 'high'>, m: Match): number | null {
  if (m.range.high - m.range.low < MIN_PLAUSIBLE_SPAN) return null;
  const span = range.high - range.low;
  if (!(span > 0)) return null;
  let sum = 0;
  let total = 0;
  for (const [midi, share] of pitchTime(m.range, octaveSemitones(m))) {
    sum += share * noteCost((midi - range.low) / span);
    total += share;
  }
  return total > 0 ? sum / total : null;
}

/**
 * The tempo a song is ranked on. The one place the Tempo gear reads it, so that moving to QWW-54's
 * effective tempo (one value per song, with its source) is a change to this line and nothing else. Today
 * it is the tempo the catalogue and the library already attach (QWW-40).
 */
export const effectiveTempo = (m: Match): number | undefined => m.tempo;

// ---------- candidates and places ----------

/** A song that fits the singer, for the engine. */
export interface SetlistCandidate {
  match: Match;
  /**
   * 0 to 1: how much the signed-in singer plays the song (score.ts familiarityScore). Unset for a song that is not in
   * their library, and for everyone who is logged out. Those songs have no place on the History gear.
   */
  listening?: number;
}

interface PreparedSong {
  candidate: SetlistCandidate;
  era: EraId | null;
  /** A Maybe song (a range we are less sure of): shown after all the others. */
  maybe: boolean;
  gears: Record<GearId, number | null>;
  /** The song's own popularity score (0 to 1), or -1 when unknown. Breaks ties. */
  popularity: number;
}

/** The songs of one singer with their places on every gear: the part of the work that no slider changes. */
export interface PreparedSetlist {
  range: Pick<VocalRange, 'low' | 'high'>;
  songs: PreparedSong[];
}

/** What rankPrepared and rankSetlist return: every song that passes the filters, best first. */
export interface RankedSetlist {
  songs: SetlistSong[];
  /** The parts that counted: not the ones in `off`, and not History unless `loggedIn`. */
  applied: TunerPart[];
  empty?: 'no-era-picked' | 'no-songs-in-era' | 'no-songs-in-range';
}

/**
 * Which missing gear counts most when songs miss different ones, as bits of a sum: a song missing History sorts after
 * every song that has it, then one missing Tempo after every song that has it, then Popularity, then Difficulty.
 * All of it inside a group: songs sung as written come before songs that need an octave jump (QWW-58), so a song that
 * misses a gear still comes before a jump song that has it.
 * The gears the singer chose to switch on (History, Tempo) outrank the ones that are on from the start.
 */
const MISSING_RANK: Readonly<Record<GearId, number>> = Object.freeze({ difficulty: 1, popularity: 2, tempo: 4, history: 8 });

/** Values rounded so that equal scores computed two ways compare equal. */
const quantize = (v: number) => Math.round(v * 1e9);

/** Each value's rank, 0 for the lowest, a tie sharing the average of the places it covers (so 0, 1.5, 1.5, 3). */
function midranks(values: number[]): number[] {
  const order = values.map((_, i) => i).sort((a, b) => quantize(values[a]!) - quantize(values[b]!) || a - b);
  const ranks = new Array<number>(values.length).fill(0);
  for (let start = 0; start < order.length; ) {
    let end = start;
    while (end + 1 < order.length && quantize(values[order[end + 1]!]!) === quantize(values[order[start]!]!)) end++;
    for (let k = start; k <= end; k++) ranks[order[k]!] = (start + end) / 2;
    start = end + 1;
  }
  return ranks;
}

/** Places 0 to 100 by rank for the values that are known; null stays null. One known value sits in the middle. */
function placesByRank(values: (number | null)[]): (number | null)[] {
  const known = values.flatMap((v, i) => (v === null ? [] : [i]));
  const ranks = midranks(known.map((i) => values[i]!));
  const out = values.map((): number | null => null);
  known.forEach((i, k) => {
    out[i] = known.length > 1 ? (100 * ranks[k]!) / (known.length - 1) : 50;
  });
  return out;
}

const BAND = { easy: 0, medium: 1, hard: 2 } as const;

/** 0 Easy, 1 Medium, 2 Hard: the song's label, or for a Maybe song the one its range would earn if it were sure. */
function bandOf(m: Match, range: Pick<VocalRange, 'low' | 'high'>): 0 | 1 | 2 {
  if (m.difficulty !== 'maybe') return BAND[m.difficulty];
  return BAND[difficultyFromEdgeTime(edgeTime({ ...range, source: 'test' }, m.range, octaveSemitones(m)))];
}

/**
 * Difficulty places. A song sits in the third of the track its label owns (Easy 0 to 33, Medium 33 to 67,
 * Hard 67 to 100, whatever the share of songs in each), so the row's lane colour and the label agree and
 * the middle of the track is Medium songs. Inside its third the songs spread evenly by strain, none on a
 * third's edge, so no Easy song ties with a Medium one. Strain uses the "easy leans low" curve above, so
 * within a label a song in the lower-middle of the range sits lower than one near the top. A song with an
 * implausible range has no place.
 */
function difficultyPlaces(songs: Match[], range: Pick<VocalRange, 'low' | 'high'>): (number | null)[] {
  const items = songs.map((m, i) => ({ i, band: bandOf(m, range), strain: songStrain(range, m) }));
  const out = songs.map((): number | null => null);
  for (const band of [0, 1, 2]) {
    const group = items.filter((x) => x.band === band && x.strain !== null);
    const ranks = midranks(group.map((x) => x.strain!));
    group.forEach((x, k) => {
      out[x.i] = (100 / 3) * (band + (ranks[k]! + 0.5) / group.length);
    });
  }
  return out;
}

/**
 * History places, 0 (Rediscover) to 100 (On repeat), for the songs in the singer's library. Songs are told apart
 * by how much they play them, then by Spotify's order (play rank), so a big tied group (every saved-only song
 * scores the same) spreads out too. Songs outside the library have none.
 */
function historyPlaces(songs: SetlistCandidate[]): (number | null)[] {
  const inLibrary = songs.flatMap((c, i) => (c.listening === undefined ? [] : [i]));
  inLibrary.sort((a, b) => {
    const x = songs[a]!;
    const y = songs[b]!;
    return (
      quantize(x.listening!) - quantize(y.listening!) ||
      y.match.track.playRank - x.match.track.playRank ||
      (x.match.track.id < y.match.track.id ? -1 : x.match.track.id > y.match.track.id ? 1 : 0)
    );
  });
  const out = songs.map((): number | null => null);
  inLibrary.forEach((i, k) => {
    out[i] = inLibrary.length > 1 ? (100 * k) / (inLibrary.length - 1) : 50;
  });
  return out;
}

/**
 * The places of every song on every gear, for one singer. The Maybe songs are laid out on their own, so the
 * songs shown first fill the whole track whatever the Maybe songs look like.
 */
export function prepareSetlist(candidates: SetlistCandidate[], range: Pick<VocalRange, 'low' | 'high'>): PreparedSetlist {
  const songs: PreparedSong[] = [];
  for (const maybe of [false, true]) {
    const group = candidates.filter((c) => (c.match.difficulty === 'maybe') === maybe);
    const difficulty = difficultyPlaces(group.map((c) => c.match), range);
    const history = historyPlaces(group);
    const popularity = placesByRank(group.map((c) => (c.match.parts?.popularityKnown ? c.match.parts.popularity : null)));
    const tempo = placesByRank(group.map((c) => effectiveTempo(c.match) ?? null));
    group.forEach((candidate, k) => {
      const m = candidate.match;
      songs.push({
        candidate,
        era: eraOf(m.year),
        maybe,
        gears: { difficulty: difficulty[k]!, history: history[k]!, popularity: popularity[k]!, tempo: tempo[k]! },
        popularity: m.parts?.popularityKnown ? m.parts.popularity : -1,
      });
    });
  }
  return { range, songs };
}

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The era filter and the sort: what changes when a slider moves. */
export function rankPrepared(prepared: PreparedSetlist, state: SetlistState & { loggedIn: boolean }): RankedSetlist {
  const off = new Set<TunerPart>(state.off);
  const active = GEAR_IDS.filter((g) => !off.has(g) && (g !== 'history' || state.loggedIn));
  const eraOn = !off.has('era');
  const applied: TunerPart[] = eraOn ? [...active, 'era'] : active;
  const picked = new Set<EraId>(state.eras);

  const passing = prepared.songs.filter((s) => !eraOn || (s.era !== null && picked.has(s.era)));
  const scored = passing.map((s) => {
    let distance = 0;
    let missing = 0;
    for (const g of active) {
      const place = s.gears[g];
      if (place === null) missing += MISSING_RANK[g];
      else distance += GEAR_WEIGHTS[g] * Math.abs(place - state.gears[g]);
    }
    const m = s.candidate.match;
    // 0 for a song sung as written, 1 for one that needs an octave jump, up or down (QWW-58).
    const jump = octaveSemitones(m) === 0 ? 0 : 1;
    return { s, jump, missing, distance: quantize(distance), who: `${m.track.artist}\u0000${m.track.title}`.toLowerCase() };
  });
  scored.sort(
    (a, b) =>
      Number(a.s.maybe) - Number(b.s.maybe) ||
      a.jump - b.jump ||
      a.missing - b.missing ||
      a.distance - b.distance ||
      quantize(b.s.popularity) - quantize(a.s.popularity) ||
      (a.s.gears.difficulty ?? 1000) - (b.s.gears.difficulty ?? 1000) ||
      compareIds(a.who, b.who) ||
      compareIds(a.s.candidate.match.track.id, b.s.candidate.match.track.id),
  );

  const songs = scored.map(({ s }): SetlistSong => ({ match: s.candidate.match, era: s.era, gears: s.gears }));
  const result: RankedSetlist = { songs, applied };
  if (songs.length === 0) {
    result.empty = prepared.songs.length === 0 ? 'no-songs-in-range' : eraOn && picked.size === 0 ? 'no-era-picked' : 'no-songs-in-era';
  }
  return result;
}

/**
 * The engine: `candidates` are the songs that fit `input.range`; the result is every one that passes the Era
 * filter, best first. To rank the same songs again with other gear values, prepareSetlist once and call
 * rankPrepared.
 */
export function rankSetlist(candidates: SetlistCandidate[], input: SetlistInput): RankedSetlist {
  return rankPrepared(prepareSetlist(candidates, input.range), input);
}

/** A signed-in singer's library song as a candidate: how much they play it is its familiarity. */
export function libraryCandidate(match: Match): SetlistCandidate {
  return { match, listening: familiarityScore(match.track) };
}
