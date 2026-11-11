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
//    and hide the other from the singers it fits. They stay two rows. The exception is a pair an octave apart
//    with one row better evidenced (a recording, or a note file corrected from one): that is one measurement
//    written in two octaves, the matcher already tries a song an octave up and down, and the better evidenced row
//    is shown. An octave apart with nothing to choose by stays two rows.
//  - The row shown is the main version: the one whose title carries no version tag, the most popular
//    of those. An alternate is shown instead only when it is clearly more popular (see below).
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
 * Rows count as an octave apart (or two) when both ends differ by 12 (or 24) semitones, give or take this many, the
 * same way round. The first build had 28 groups at exactly 12, the wrong-octave problem of QWW-31.
 */
export const OCTAVE_TOLERANCE = 2;

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
  /**
   * How far the range can be trusted for its octave: 2 measured from a recording, 1 a note file whose octave was
   * corrected from evidence (a recording, the artist's other songs, a pitch check, a hand check), 0 a note file as written.
   */
  trust: 0 | 1 | 2;
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
  /** True when some rows are an octave from the rest and the better evidenced rows are the ones shown. */
  octave: boolean;
  members: { key: string; artist: string; title: string; rank: number; low: number; high: number; trust: 0 | 1 | 2 }[];
}

/** Rows of one name kept apart because their ranges disagree, for the dry run's report. */
export interface ApartGroup {
  /** The most popular row of each part, its range and its name. */
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
const gapOf = (a: CanonicalInput, b: CanonicalInput) => Math.max(Math.abs(a.low - b.low), Math.abs(a.high - b.high));
/** True when both ends of `a` sit about one (or two) octaves above, or both below, those of `b`. */
function octaveApart(a: CanonicalInput, b: CanonicalInput): boolean {
  const lowDiff = a.low - b.low;
  const highDiff = a.high - b.high;
  return [12, 24].some((k) => [k, -k].some((shift) => Math.abs(lowDiff - shift) <= OCTAVE_TOLERANCE && Math.abs(highDiff - shift) <= OCTAVE_TOLERANCE));
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
 * Splits rows of one name into the parts that are one song: each row joins the first part (most popular
 * first) whose head it is within MAX_RANGE_GAP of at both ends, or an octave from with a different trust (one of
 * the two is better evidenced), else starts a part. Comparing with the head only, never chaining, keeps a part
 * from drifting a few semitones at a time.
 */
function agreeingParts(members: Prepared[]): Prepared[][] {
  const parts: Prepared[][] = [];
  for (const m of [...members].sort(byRank)) {
    const part = parts.find((p) => gapOf(p[0]!.input, m.input) <= MAX_RANGE_GAP || (octaveApart(p[0]!.input, m.input) && p[0]!.input.trust !== m.input.trust));
    if (part) part.push(m);
    else parts.push([m]);
  }
  return parts;
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
    const parts = agreeingParts(members);
    if (parts.length > 1) {
      apart.push({
        parts: parts.map((part) => ({ key: part[0]!.input.key, artist: part[0]!.input.artist, title: part[0]!.input.title, rank: part[0]!.input.rank, low: part[0]!.input.low, high: part[0]!.input.high })),
        gap: Math.max(...parts.flatMap((a, i) => parts.slice(i + 1).map((b) => gapOf(a[0]!.input, b[0]!.input)))),
      });
    }
    for (const part of parts) {
      if (part.length === 1) {
        records.set(part[0]!.input.key, single(part[0]!));
        continue;
      }
      // A part with rows an octave apart shows one of its best evidenced rows, whatever the titles and popularity say: the
      // others are the same melody written in another octave.
      const octave = part.some((m) => gapOf(part[0]!.input, m.input) > MAX_RANGE_GAP);
      const trusted = Math.max(...part.map((m) => m.input.trust));
      const pool = octave ? part.filter((m) => m.input.trust === trusted) : part;
      const ranked = [...pool].sort(byRank);
      const best = ranked[0]!;
      const main = ranked.find((m) => m.plain) ?? best;
      // Without a plain row the most popular is shown. With one, an alternate (a row with a tag on its title) that is
      // clearly more popular beats it, the most popular such alternate first. Another plain row never does: the most
      // popular plain row is the main version.
      const challenger = main.plain ? ranked.find((m) => !m.plain && clearlyMorePopular(m.input, main.input)) : undefined;
      const shown = challenger ?? main;
      for (const m of part) {
        records.set(
          m.input.key,
          m === shown
            ? single(m)
            : { key: m.input.key, canonicalKey: shown.input.key, title: shown.title, artist: shown.artist, method: CANONICAL_METHOD, reason: 'folded', sourceTitle: m.input.title, sourceArtist: m.input.artist },
        );
      }
      groups.push({
        canonicalKey: shown.input.key,
        alternate: challenger !== undefined,
        octave,
        members: [...part].sort(byRank).map((m) => ({ key: m.input.key, artist: m.input.artist, title: m.input.title, rank: m.input.rank, low: m.input.low, high: m.input.high, trust: m.input.trust })),
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
