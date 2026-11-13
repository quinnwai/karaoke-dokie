// One song, one row (QWW-49). The catalogue keeps a row per spelling the sources used: "Don't" and
// "Don’t", "E-40" with a hyphen and with a Unicode hyphen, "Song" and "Song (Album Version)". The
// list shows each as its own song. This works out, offline, which rows are one song and what to show
// for it; the result is stored (`song_canonical`) and the catalogue reads it (server/catalogue.ts).
//
// Rules, kept strict because a wrong fold hides a song for good while a missed one only shows twice:
//  - Two rows are one song only when the lead artist (the first credit) and the title match once version
//    tags are taken off the title (title.ts) and case, accents, quote marks, dashes, "&" against "and" and
//    other punctuation are set aside. A featured artist or a further credit does not make another song:
//    "Calvin Harris" and "Calvin Harris & Dua Lipa" sing "One Kiss" once, as the release eval harness counts it.
//  - And only when their measured ranges agree (MAX_RANGE_GAP). Two rows with the same name and ranges a
//    fifth apart do not say the same thing about the song: folding would pick one measurement for everyone
//    and hide the other from the singers it fits. They stay two rows. Rows whose ranges agree make a part; the
//    parts are what the next rule works on.
//  - The exception is two parts an octave apart (12 semitones, give or take OCTAVE_TOLERANCE; the matcher tries a song
//    an octave up and down, and no further) when one is strictly better evidenced (rangeTrust, the best of its rows):
//    that is one melody written in two octaves, and the better evidenced part supplies the row shown. Every row folded
//    in has to sit an octave from the row shown, not only from the head of its part, so the matcher's octave shift
//    reaches it. Equal evidence stays two rows, and a part folded in this way takes no other part with it, so a row is
//    never hidden for one two octaves away.
//  - The row shown is the main version: the one whose title carries no version tag, the most popular
//    of those. An alternate is shown instead only when it is clearly more popular (see below). Never a low-confidence
//    row (the matcher shows that as a Maybe) when another row whose range agrees is confident: a Maybe must not hide
//    a row the matcher shows as a fit. That holds for every song, folded across octaves or not (QWW-62).
//  - Instrumental, karaoke and dub rows are never folded or shown as a song (hasLittleSinging hides them).
//  - What is shown is always the clean title and the artist line, whichever row is picked.

import { hasLittleSinging } from './resolve';
import { artistLine, cleanTitle, foldKey } from './title';

/** The rules this file and title.ts implement. A rerun with another value rewrites every row. */
export const CANONICAL_METHOD = 'titles-v1';

/**
 * An alternate (a row whose title carries a version tag) is shown instead of the main version only when
 * its popularity score is this much higher (the 0 to 1 scale of score.ts, which already counts Deezer rank
 * and a Year-End chart entry; a song nothing is known about is -1).
 */
export const ALTERNATE_MARGIN = 0.15;

/**
 * Rows of one name are folded only when neither end of their ranges differs by more than this many
 * semitones (a major third). Of the 641 groups of the first build, 551 agree this closely, 437 exactly;
 * the 90 that do not include 28 an octave apart, the wrong-octave problem of QWW-31.
 */
export const MAX_RANGE_GAP = 4;

/**
 * Two parts are an octave apart when both ends of one differ from the other's by 12 semitones, give or take this
 * many, the same way round. The first build had 28 groups at exactly 12, the wrong-octave problem of QWW-31.
 */
export const OCTAVE_TOLERANCE = 2;

/** What a stored range says about where it came from, which is all `rangeTrust` reads. */
export interface RangeEvidence {
  /** The range's source: 'audio-full' is a recording, 'note-file' a note file. */
  source: string;
  /** 'high' or 'low'. The matcher shows a low-confidence range as a Maybe (match.ts). */
  confidence?: string;
  /** Set when a note file's octave was moved after import (octave.ts): 'recording', 'artist', 'pitch' or 'hand'. */
  octaveFrom?: string;
}

/**
 * How far a stored range can be trusted for its octave (`CanonicalInput.trust`):
 *  2  measured from a recording, with high confidence;
 *  1  a note file whose octave was moved to sit with its own recording, or by a person (octaveFrom 'recording' or 'hand');
 *  0  anything else: a note file as written (a song kept by hand, data/octave-hand-checked.json, leaves no mark on its
 *     range), one moved on a guess (the artist's other songs, a high typical note), and any low-confidence range. The
 *     matcher shows that as a Maybe, so it must never hide a row the matcher would show as a fit.
 */
export function rangeTrust({ source, confidence, octaveFrom }: RangeEvidence): 0 | 1 | 2 {
  if (confidence !== 'high') return 0;
  if (source === 'audio-full') return 2;
  return octaveFrom === 'recording' || octaveFrom === 'hand' ? 1 : 0;
}

/** What the build reads about one measured song. */
export interface CanonicalInput {
  key: string;
  /** The artist and title the list shows today (the range record's log line). */
  artist: string;
  title: string;
  /** catalogueRank (songs/score.ts): -1 when nothing is known about the song's popularity. */
  rank: number;
  /** The stored range, lowest and highest note (midi). */
  low: number;
  high: number;
  /** How far the range can be trusted for its octave (rangeTrust). */
  trust: 0 | 1 | 2;
  /** What `trust` was worked out from, for the dry run's report: the stored range's source, confidence and octaveFrom. */
  source?: string;
  confidence?: string;
  octaveFrom?: string;
  /** The row is on a Billboard Year-End chart (a chart rank in its karaoke popularity): the catalogue reads every such row, whatever its rank. */
  charted?: boolean;
}

/** Why a row is as it is: shown as written, shown with a cleaned title or artist line, or folded into another row. */
export type CanonicalReason = 'same' | 'cleaned' | 'folded';

/** One row of song_canonical. Every measured song has one once the build has run; a missing row means the build has not seen the song. */
export interface SongCanonical {
  key: string;
  /** The key of the row that is shown for this song: its own key for the row shown, another's for a folded one. */
  canonicalKey: string;
  /** The title and artist line to show, the same on every row of one song. */
  title: string;
  artist: string;
  method: string;
  reason: CanonicalReason;
  /**
   * The title and artist the row had when this was worked out. The catalogue applies the record only while
   * the row still has them: a sync that renames a song later makes the record stale, and a stale record must
   * not put a clean title on a row that has changed (or show a song hidden for having no singing).
   */
  sourceTitle: string;
  sourceArtist: string;
}

/** One song that more than one row made up, for the dry run's report. */
export interface FoldGroup {
  canonicalKey: string;
  /** True when an alternate was shown instead of the main version. */
  alternate: boolean;
  /** True when a part an octave from the row shown was folded in, because the part the row is shown from is better evidenced. */
  octave: boolean;
  /** Every row of the song, most popular first. */
  members: CanonicalInput[];
}

/** Rows of one name kept apart because their ranges disagree, for the dry run's report. */
export interface ApartGroup {
  /** The most popular row of the part each song kept apart is shown from, its range and its name. */
  parts: { key: string; artist: string; title: string; rank: number; low: number; high: number }[];
  /** The widest end-to-end gap between two of them, in semitones. */
  gap: number;
}

export interface CanonicalBuild {
  /** One record per input, by key. */
  records: SongCanonical[];
  /** The songs made of more than one row. */
  groups: FoldGroup[];
  /** The names that would have folded but for the ranges. */
  apart: ApartGroup[];
}

interface Prepared {
  input: CanonicalInput;
  title: string;
  artist: string;
  /** No version tag on the title: a main version. */
  plain: boolean;
  fold: string | null;
}

const byRank = (a: Prepared, b: Prepared) => b.input.rank - a.input.rank || (a.input.key < b.input.key ? -1 : a.input.key > b.input.key ? 1 : 0);
/** The widest gap between the ends of two ranges, in semitones. */
export const gapOf = (a: CanonicalInput, b: CanonicalInput) => Math.max(Math.abs(a.low - b.low), Math.abs(a.high - b.high));
/** True when both ends of `a` sit one octave (12 semitones, give or take OCTAVE_TOLERANCE) above those of `b`, or both below. */
export function octaveApart(a: CanonicalInput, b: CanonicalInput): boolean {
  const lowDiff = a.low - b.low;
  const highDiff = a.high - b.high;
  return [12, -12].some((shift) => Math.abs(lowDiff - shift) <= OCTAVE_TOLERANCE && Math.abs(highDiff - shift) <= OCTAVE_TOLERANCE);
}

function prepare(input: CanonicalInput): Prepared {
  if (hasLittleSinging(input.title)) return { input, title: input.title, artist: input.artist, plain: false, fold: null };
  const cleaned = cleanTitle(input.title);
  const artist = artistLine(input.artist, cleaned.featured);
  return { input, title: cleaned.title, artist, plain: cleaned.removed.length === 0, fold: foldKey(artist, cleaned.title) };
}

/** True when `alt` is clearly more popular than `main`. */
function clearlyMorePopular(alt: CanonicalInput, main: CanonicalInput): boolean {
  return alt.rank - main.rank >= ALTERNATE_MARGIN;
}

/**
 * Splits rows of one name into the parts whose ranges agree: each row joins the first part (most popular
 * first) whose head it is within MAX_RANGE_GAP of at both ends, else starts a part. Comparing with the head
 * only, never chaining, keeps a part from drifting a few semitones at a time.
 */
function rangeParts(members: Prepared[]): Prepared[][] {
  const parts: Prepared[][] = [];
  for (const m of [...members].sort(byRank)) {
    const part = parts.find((p) => gapOf(p[0]!.input, m.input) <= MAX_RANGE_GAP);
    if (part) part.push(m);
    else parts.push([m]);
  }
  return parts;
}

const bestTrust = (part: Prepared[]) => Math.max(...part.map((m) => m.input.trust));

/** One song of a name: the part the row is shown from first, then the parts folded into it, and the row shown. */
interface Song {
  parts: Prepared[][];
  shown: Prepared;
  /** True when the row shown is an alternate that is clearly more popular than the main version. */
  alternate: boolean;
}

/**
 * The row shown for some rows of one song: the main version, the most popular row with no tag on its title, unless an
 * alternate (a row with a tag on its title) is clearly more popular, the most popular such alternate first. Another
 * plain row never beats the main one. Without a plain row, the most popular. Rows the matcher shows as a Maybe (low
 * confidence) are left out when any other row is there, so a song with a confident row is never shown as a Maybe.
 */
function pickShown(rows: Prepared[]): { shown: Prepared; alternate: boolean } {
  const ranked = [...rows].sort(byRank);
  const confident = ranked.filter((m) => m.input.confidence !== 'low');
  const pool = confident.length > 0 ? confident : ranked;
  const main = pool.find((m) => m.plain) ?? pool[0]!;
  const challenger = main.plain ? pool.find((m) => !m.plain && clearlyMorePopular(m.input, main.input)) : undefined;
  return { shown: challenger ?? main, alternate: challenger !== undefined };
}

/**
 * Joins the parts of one name that are one melody in two octaves. A part is folded into another only when every one of
 * its rows is an octave (OCTAVE_TOLERANCE) from the row that other part shows, and the other part's best row is strictly
 * better evidenced (`trust`); equal evidence, or any other gap, leaves two songs. The best evidenced part goes first and
 * takes every part it can, and a part that was folded in takes no other with it: the matcher tries a song one octave up
 * and one down, so a row hidden for another is never more than an octave from the row shown. The row shown comes from the
 * part that takes, by the usual rules (pickShown). Which part goes first is decided by trust, then by the popularity of
 * its head, so the result does not depend on the order of the rows.
 */
function joinOctaves(parts: Prepared[][]): Song[] {
  const order = [...parts].sort((a, b) => bestTrust(b) - bestTrust(a) || byRank(a[0]!, b[0]!));
  const joined = new Set<Prepared[]>();
  const songs: Song[] = [];
  for (const part of order) {
    if (joined.has(part)) continue;
    const picked = pickShown(part);
    const taken = order.filter((other) => !joined.has(other) && bestTrust(other) < bestTrust(part) && other.every((m) => octaveApart(m.input, picked.shown.input)));
    for (const t of taken) joined.add(t);
    songs.push({ parts: [part, ...taken], ...picked });
  }
  return songs;
}

/**
 * Works out, for every row, which row is shown for its song and with what title and artist line.
 * Pure and deterministic: the same rows in any order give the same records.
 */
export function buildCanonical(inputs: CanonicalInput[]): CanonicalBuild {
  const prepared = inputs.map(prepare);
  const folds = new Map<string, Prepared[]>();
  for (const p of prepared) {
    if (p.fold === null) continue;
    const group = folds.get(p.fold);
    if (group) group.push(p);
    else folds.set(p.fold, [p]);
  }

  const records = new Map<string, SongCanonical>();
  const groups: FoldGroup[] = [];
  const apart: ApartGroup[] = [];
  const single = (p: Prepared): SongCanonical => ({
    key: p.input.key,
    canonicalKey: p.input.key,
    title: p.title,
    artist: p.artist,
    method: CANONICAL_METHOD,
    reason: p.title === p.input.title && p.artist === p.input.artist ? 'same' : 'cleaned',
    sourceTitle: p.input.title,
    sourceArtist: p.input.artist,
  });

  for (const p of prepared) if (p.fold === null) records.set(p.input.key, single(p));
  for (const members of folds.values()) {
    const songs = joinOctaves(rangeParts(members));
    if (songs.length > 1) {
      // The most popular row of the part each song is shown from, most popular song first.
      const heads = songs.map((song) => song.parts[0]![0]!).sort(byRank);
      apart.push({
        parts: heads.map((h) => ({ key: h.input.key, artist: h.input.artist, title: h.input.title, rank: h.input.rank, low: h.input.low, high: h.input.high })),
        gap: Math.max(...heads.flatMap((a, i) => heads.slice(i + 1).map((b) => gapOf(a.input, b.input)))),
      });
    }
    for (const song of songs) {
      const rows = song.parts.flat();
      const { shown } = song;
      if (rows.length === 1) {
        records.set(shown.input.key, single(shown));
        continue;
      }
      for (const m of rows) {
        records.set(
          m.input.key,
          m === shown
            ? single(m)
            : { key: m.input.key, canonicalKey: shown.input.key, title: shown.title, artist: shown.artist, method: CANONICAL_METHOD, reason: 'folded', sourceTitle: m.input.title, sourceArtist: m.input.artist },
        );
      }
      groups.push({
        canonicalKey: shown.input.key,
        alternate: song.alternate,
        octave: song.parts.length > 1,
        members: [...rows].sort(byRank).map((m) => m.input),
      });
    }
  }

  const byKey = <T extends { key: string }>(a: T, b: T) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return {
    records: [...records.values()].sort(byKey),
    groups: groups.sort((a, b) => byKey({ key: a.canonicalKey }, { key: b.canonicalKey })),
    apart: apart.sort((a, b) => byKey(a.parts[0]!, b.parts[0]!)),
  };
}

/**
 * The songs the list shows, from the rows it loaded and the stored mapping: one row per song, with the
 * clean title and artist line. Order is kept. What the list has to survive:
 *  - A row with no mapping (the build has not run, or has not seen it) is left exactly as it is.
 *  - A record is used only while the row still has the title and artist it was worked out from; a row
 *    that has changed since is left as it is until the build runs again.
 *  - A folded row is dropped when the row it folds into is in the list. If that row is not (it ranked
 *    too low to be loaded), the first loaded row of the song stays in its place, so folding never
 *    removes a song.
 *  - A mapping that contradicts itself (a rebuild caught half-written: A says "shown as B" while B says
 *    "shown as A") drops nothing: a duplicate for a moment beats a song missing for the cache's hour.
 */
export function applyCanonical<T extends { key: string; title: string; artist: string }>(songs: T[], stored: Map<string, SongCanonical>): T[] {
  if (stored.size === 0) return songs;
  const mapping = new Map<string, SongCanonical>();
  for (const s of songs) {
    const m = stored.get(s.key);
    if (m && m.sourceTitle === s.title && m.sourceArtist === s.artist) mapping.set(s.key, m);
  }
  if (mapping.size === 0) return songs;
  const loaded = new Set(songs.map((s) => s.key));
  // A target is sound when the row it names points at itself, or has no record to use.
  const sound = (target: string) => (mapping.get(target)?.canonicalKey ?? target) === target;
  // For a song whose canonical row was not loaded: the first loaded row, which stands in for it.
  const standIn = new Map<string, string>();
  for (const s of songs) {
    const m = mapping.get(s.key);
    if (m && m.canonicalKey !== s.key && !loaded.has(m.canonicalKey) && !standIn.has(m.canonicalKey)) standIn.set(m.canonicalKey, s.key);
  }
  const out: T[] = [];
  for (const s of songs) {
    const m = mapping.get(s.key);
    if (!m) out.push(s);
    else if (m.canonicalKey === s.key || standIn.get(m.canonicalKey) === s.key || (loaded.has(m.canonicalKey) && !sound(m.canonicalKey))) {
      out.push({ ...s, title: m.title, artist: m.artist });
    }
  }
  return out;
}
