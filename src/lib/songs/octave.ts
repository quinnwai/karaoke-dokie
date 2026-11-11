// Fixes a note file's octave using what recordings say about the singer.
//
// UltraStar scores pitch class only, so a note file can be written an octave off, and range.ts's
// own rule (move the typical note into E2 to C5) cannot tell: a tenor's melody written at C#5 to
// F#5 has a typical note inside the window and stays an octave too high. Measured against 5,029
// songs with both a note file and a recording, 21% of the note files sat an octave away from the
// recording, nearly all of them too high (vocal-range pipeline, scripts/octave-pairs.py).
//
// Three kinds of evidence, in this order (and a person's say over all of them, see "hand" below):
//   songs:   this song's own recording (its typical note, tessitura, measured from the recording).
//            Trusted at any distance: the note file moves by whole octaves to sit nearest it.
//            A recording flagged mostly-rap is trusted too, but only when it agrees with the note
//            file at a whole octave within RAP_MAX_RESIDUAL semitones, moves it one octave at most,
//            and does not contradict the artist's other recordings (buildOctaveEvidence).
//   artists: the median of the artist's other recordings. Singers keep to a similar register, but
//            a song can differ, so it moves a note file only when the move leaves the typical note
//            within ARTIST_MAX_DISTANCE of the artist's (leave-one-out over those songs: 92% of the
//            songs it moved were then right). An artist with evidence that does not settle it
//            leaves the note file as written; the pitch rule below never overrides an artist.
//   pitch:   an artist with no evidence at all, and a typical note from TYPICAL_HIGH up. A note file
//            that high is an octave too high far more often than not (TYPICAL_HIGH), so it moves
//            down one octave.
// Anything else stays as written.
//
// hand: data/octave-hand-checked.json, kept apart from the generated evidence so a rebuild cannot drop
// it, and merged in by withHandChecked. An artist listed there takes the place of the measured one in
// the artist rule (same limit), which also keeps the pitch rule off that artist; its moves are marked
// 'hand'. A song listed under keep never moves. It exists because a typical note is only a guess at
// who sings: AC/DC sings high, so the pitch rule moved 14 of their songs down an octave.
// Only plain note-file ranges move. Duets with parts are left alone: the two singers may sit
// an octave apart, and a recording measures neither part. Moving by evidence rather than by
// a stored offset makes the fix idempotent.

import type { DataSourceLogEntry, SongRange } from '../contracts';
import type { SongRangeRecord, Store } from '../server/store';
import { PLAUSIBLE_SONG } from '../notes/bulkImport';
import { songKey as makeSongKey } from './resolve';

export const ARTIST_MAX_DISTANCE = 4;

/**
 * The typical note (MIDI; 69 is A4) from which a note file with no better evidence is moved down an
 * octave. Over the 4,760 songs with a note file and a recording not mostly rap, note files that
 * range.ts leaves alone (typical note below C5) were an octave above the recording in 23% of songs
 * from 67 to 68, 44% from 68 to 69, 73% from 69 to 70, 87% from 70 to 71 and 92% from 71 to 72: 84%
 * from 69 up, against 44% just below, where the note file stays as written. The counts are in
 * tests/fixtures/octave-calibration.json (scripts/octave-measure.ts prints them), and a test keeps
 * this number between the two.
 */
export const TYPICAL_HIGH = 69;

/** A mostly-rap recording counts as evidence when it sits this close to the note file at the nearest whole octave... */
export const RAP_MAX_RESIDUAL = 3;
/** ...and this close to the typical note of the artist's other recordings, when there are any. */
export const RAP_MAX_ARTIST_DISTANCE = 6;

export interface OctaveEvidence {
  /** songKey to the typical note (MIDI) of the song's recording. */
  songs: Record<string, number>;
  /** Artist part of songKey to the median typical note of the artist's recordings. */
  artists: Record<string, number>;
  /** Set by withHandChecked: which entries of `artists` a person set, and the song keys that never move. */
  hand?: { artists: string[]; keep: string[] };
}

/** data/octave-hand-checked.json: what a person set, each with where it came from. */
export interface OctaveHandChecked {
  /** Artist part of songKey to the typical note (MIDI) a person heard or looked up for the artist. */
  artists: Record<string, { typical: number; source: string }>;
  /** Song keys the fix must never move. */
  keep: Record<string, { source: string }>;
}

/**
 * The evidence with a person's entries merged in: a hand-checked artist takes the place of the measured
 * one, and the moves that rest on it are marked 'hand'. Every entry has to say where it came from.
 */
export function withHandChecked(evidence: OctaveEvidence, hand: OctaveHandChecked): OctaveEvidence {
  const artists = { ...evidence.artists };
  for (const [artist, entry] of Object.entries(hand.artists)) {
    if (!Number.isFinite(entry.typical) || !entry.source?.trim()) throw new Error(`Hand-checked artist "${artist}" needs a typical note and a source`);
    artists[artist] = entry.typical;
  }
  for (const [key, entry] of Object.entries(hand.keep)) {
    if (!entry.source?.trim()) throw new Error(`Hand-checked song to keep "${key}" needs a source`);
  }
  return { ...evidence, artists, hand: { artists: Object.keys(hand.artists), keep: Object.keys(hand.keep) } };
}

export interface OctaveMove {
  /** Whole octaves, in semitones: -12 or 12 (or more for a note file far off). */
  semitones: number;
  from: NonNullable<SongRange['octaveFrom']>;
}

/** The whole-octave shift that puts `tessitura` nearest `target`. */
export function octaveToward(tessitura: number, target: number): number {
  let shift = 0;
  while (tessitura + shift - target >= 6) shift -= 12;
  while (tessitura + shift - target < -6) shift += 12;
  return shift;
}

export const artistOfKey = (songKey: string): string => songKey.split('|')[0] ?? '';

/**
 * How far a stored note-file range should move, or null to leave it as written. `typicalHigh` is
 * TYPICAL_HIGH; Infinity turns the pitch rules off (the rules as they were before QWW-31's second round).
 */
export function octaveMove(songKey: string, range: SongRange, evidence: OctaveEvidence, typicalHigh = TYPICAL_HIGH): OctaveMove | null {
  if (range.source !== 'note-file' || range.duet || range.parts?.length) return null;
  if (evidence.hand?.keep.includes(songKey)) return null;
  const artist = artistOfKey(songKey);
  const own = Object.hasOwn(evidence.songs, songKey) ? evidence.songs[songKey]! : undefined;
  const typical = Object.hasOwn(evidence.artists, artist) ? evidence.artists[artist]! : undefined;
  let semitones = 0;
  let from: OctaveMove['from'] = 'recording';
  if (own !== undefined) {
    semitones = octaveToward(range.tessitura, own);
  } else if (typical !== undefined) {
    semitones = octaveToward(range.tessitura, typical);
    from = evidence.hand?.artists.includes(artist) ? 'hand' : 'artist';
    if (Math.abs(range.tessitura + semitones - typical) > ARTIST_MAX_DISTANCE) return null;
  } else if (range.tessitura >= typicalHigh) {
    // Down until it is below the line, so a row that was moved is not moved again.
    while (range.tessitura + semitones >= typicalHigh) semitones -= 12;
    from = 'pitch';
  }
  if (semitones === 0) return null;
  if (range.low + semitones < PLAUSIBLE_SONG.lowest || range.high + semitones > PLAUSIBLE_SONG.highest) return null;
  return { semitones, from };
}

/** The range moved by `semitones`: low, high, typical note and pitch shares. */
export function shiftRange(range: SongRange, semitones: number): SongRange {
  const out: SongRange = { ...range, low: range.low + semitones, high: range.high + semitones, tessitura: range.tessitura + semitones };
  if (range.pitchShare) out.pitchShare = range.pitchShare.map(([midi, share]) => [midi + semitones, share]);
  return out;
}

/** `range` with its octave corrected by the evidence; the same range when nothing moves. */
export function correctOctave(songKey: string, range: SongRange, evidence: OctaveEvidence): SongRange {
  const move = octaveMove(songKey, range, evidence);
  return move ? { ...shiftRange(range, move.semitones), octaveFrom: move.from } : range;
}

export function octaveLogNote(move: OctaveMove): string {
  const dir = move.semitones < 0 ? 'down' : 'up';
  const octaves = Math.abs(move.semitones / 12);
  const by = octaves === 1 ? 'an octave' : `${octaves} octaves`;
  switch (move.from) {
    case 'recording':
      return `Moved ${by} ${dir} to match the original recording.`;
    case 'artist':
      return `Moved ${by} ${dir} to match the register of the artist's other recordings.`;
    case 'pitch':
      return `Moved ${by} ${dir}: note files written this high are usually an octave too high.`;
    case 'hand':
      return `Moved ${by} ${dir} to match the artist's register, checked by hand.`;
  }
}

/** One song with both a note file and a recording, from scripts/octave-pairs.py. */
export interface OctavePair {
  artist: string;
  title: string;
  /** Typical note of the recording. */
  recording: number;
  /** Typical note of the note file as stored (range.ts's own octave rule applied). */
  noteAsStored: number;
  /** The recording is mostly rap: pitch tracking is unreliable there. */
  rap: boolean;
  duet: boolean;
  multi: boolean;
}

const round = (n: number) => Math.round(n * 100) / 100;
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** A mostly-rap recording is trusted for its own song only when nothing contradicts it (see the header). */
function trustedRap(p: OctavePair, artistMedian: number | undefined): boolean {
  const shift = octaveToward(p.noteAsStored, p.recording);
  if (Math.abs(shift) > 12) return false;
  if (Math.abs(p.noteAsStored + shift - p.recording) > RAP_MAX_RESIDUAL) return false;
  return artistMedian === undefined || Math.abs(p.recording - artistMedian) <= RAP_MAX_ARTIST_DISTANCE;
}

/**
 * The evidence file from pairs. An artist's typical note is the median of their solo recordings that are not
 * mostly rap; duets and multi-artist credits do not count. A song's own recording is kept for the song, and a
 * mostly-rap one only when trustedRap (and never over a recording that is not mostly rap, whatever order the
 * pairs come in). Computed numbers only: a typical note per song and per artist.
 */
export function buildOctaveEvidence(pairs: OctavePair[]): OctaveEvidence {
  for (const [i, p] of pairs.entries()) {
    if (!Number.isFinite(p.recording) || !Number.isFinite(p.noteAsStored)) {
      throw new Error(`Pair ${i} (${p.artist} - ${p.title}) has no recording or noteAsStored typical note: make the pairs file again with scripts/octave-pairs.py`);
    }
  }
  const keyed = pairs.map((p) => ({ p, key: makeSongKey(p.artist, p.title) })).filter(({ key }) => !key.startsWith('|') && !key.endsWith('|'));
  const byArtist = new Map<string, number[]>();
  for (const { p, key } of keyed) {
    if (p.rap || p.duet || p.multi) continue;
    const artist = artistOfKey(key);
    byArtist.set(artist, [...(byArtist.get(artist) ?? []), p.recording]);
  }
  const artists: Record<string, number> = {};
  for (const [artist, values] of [...byArtist].sort(([a], [b]) => a.localeCompare(b))) artists[artist] = round(median(values));

  const songs: Record<string, number> = {};
  for (const { p, key } of keyed) if (p.rap && trustedRap(p, artists[artistOfKey(key)])) songs[key] = round(p.recording);
  for (const { p, key } of keyed) if (!p.rap) songs[key] = round(p.recording);
  return { songs: Object.fromEntries(Object.entries(songs).sort(([a], [b]) => a.localeCompare(b))), artists };
}

export interface OctaveFixSummary {
  checked: number;
  /** Songs the evidence moves (on a dry run, would move). */
  moved: number;
  fromRecording: number;
  fromArtist: number;
  fromPitch: number;
  fromHand: number;
  /** Moves not written because the row changed after it was read; the next run picks them up. */
  skippedChanged: number;
}

export interface OctaveFixOptions {
  /** Count without writing. */
  dryRun?: boolean;
  /** Start after this song key: the last key a run printed before it stopped. */
  after?: string;
  /** Songs read per query. */
  pageSize?: number;
  /** Called for every song that moves (on a dry run, would move). */
  onMove?: (key: string, move: OctaveMove, range: SongRange) => void;
  /** Called after every page with its last song key, to resume from, and the counts so far. */
  onPage?: (lastKey: string, summary: OctaveFixSummary) => void;
}

/** Rows written at once; each is its own request to the database. */
const WRITE_BATCH = 10;

/**
 * Corrects the octave of every stored note-file range the evidence disagrees with, reading the table
 * in pages by song key. With `dryRun`, counts without writing. Safe to run again, and to stop and
 * resume (`after`): a corrected song matches its evidence and does not move. A row is read again just
 * before it is written, and left alone if someone else changed it meanwhile (`skippedChanged`); that
 * leaves a gap of one batch, so still run it while nothing else writes song ranges.
 */
export async function fixStoredOctaves(store: Store, evidence: OctaveEvidence, opts: OctaveFixOptions = {}): Promise<OctaveFixSummary> {
  const pageSize = opts.pageSize ?? 1000;
  const summary: OctaveFixSummary = { checked: 0, moved: 0, fromRecording: 0, fromArtist: 0, fromPitch: 0, fromHand: 0, skippedChanged: 0 };
  const counter = { recording: 'fromRecording', artist: 'fromArtist', pitch: 'fromPitch', hand: 'fromHand' } as const;
  const same = (a: SongRangeRecord, b: SongRangeRecord | undefined) => b !== undefined && JSON.stringify(a) === JSON.stringify(b);
  let after = opts.after ?? '';
  for (;;) {
    const page = await store.listSongRangesPage(after, pageSize);
    if (page.size === 0) return summary;
    const writes: { key: string; read: SongRangeRecord; next: SongRangeRecord }[] = [];
    for (const [key, rec] of page) {
      after = key;
      if (!rec.range) continue;
      summary.checked++;
      const move = octaveMove(key, rec.range, evidence);
      if (!move) continue;
      summary.moved++;
      summary[counter[move.from]]++;
      opts.onMove?.(key, move, rec.range);
      if (opts.dryRun) continue;
      const log: DataSourceLogEntry = { ...rec.log, reason: `${rec.log.reason} ${octaveLogNote(move)}`.trim() };
      writes.push({ key, read: rec, next: { range: { ...shiftRange(rec.range, move.semitones), octaveFrom: move.from }, log } });
    }
    for (let i = 0; i < writes.length; i += WRITE_BATCH) {
      const batch = writes.slice(i, i + WRITE_BATCH);
      const fresh = await store.getSongRanges(batch.map((w) => w.key));
      await Promise.all(
        batch.map(({ key, read, next }) => {
          if (same(read, fresh.get(key))) return store.putSongRange(key, next);
          summary.skippedChanged++;
          return undefined;
        }),
      );
    }
    opts.onPage?.(after, { ...summary });
  }
}
