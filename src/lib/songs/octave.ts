// Fixes a note file's octave using what recordings say about the singer.
//
// UltraStar scores pitch class only, so a note file can be written an octave off, and range.ts's
// own rule (move the typical note into E2 to C5) cannot tell: a tenor's melody written at C#5 to
// F#5 has a typical note inside the window and stays an octave too high. Measured against 5,029
// songs with both a note file and a recording, 21% of the note files sat an octave away from the
// recording, nearly all of them too high (vocal-range pipeline, scripts/octave-pairs.py).
//
// Two kinds of evidence, both a typical note (tessitura) measured from recordings:
//   songs:   this song's own recording. Trusted at any distance: the note file moves by whole
//            octaves to sit nearest it.
//   artists: the median of the artist's other recordings. Singers keep to a similar register, but
//            a song can differ, so it moves a note file only when the move leaves the typical note
//            within ARTIST_MAX_DISTANCE of the artist's (leave-one-out over those songs: 93% of the
//            songs it moved were then right, 96% of the ones it decided with margin to spare).
//            With no strong evidence the note file stays as written.
// Only plain note-file ranges move. Duets with parts are left alone: the two singers may sit
// an octave apart, and a recording measures neither part. Moving by evidence rather than by
// a stored offset makes the fix idempotent.

import type { DataSourceLogEntry, SongRange } from '../contracts';
import type { Store } from '../server/store';
import { PLAUSIBLE_SONG } from '../notes/bulkImport';

export const ARTIST_MAX_DISTANCE = 4;

export interface OctaveEvidence {
  /** songKey to the typical note (MIDI) of the song's recording. */
  songs: Record<string, number>;
  /** Artist part of songKey to the median typical note of the artist's recordings. */
  artists: Record<string, number>;
}

export interface OctaveMove {
  /** Whole octaves, in semitones: -12 or 12 (or more for a note file far off). */
  semitones: number;
  from: 'recording' | 'artist';
}

/** The whole-octave shift that puts `tessitura` nearest `target`. */
export function octaveToward(tessitura: number, target: number): number {
  let shift = 0;
  while (tessitura + shift - target >= 6) shift -= 12;
  while (tessitura + shift - target < -6) shift += 12;
  return shift;
}

export const artistOfKey = (songKey: string): string => songKey.split('|')[0] ?? '';

/** How far a stored note-file range should move, or null to leave it as written. */
export function octaveMove(songKey: string, range: SongRange, evidence: OctaveEvidence): OctaveMove | null {
  if (range.source !== 'note-file' || range.parts?.length) return null;
  const own = Object.hasOwn(evidence.songs, songKey) ? evidence.songs[songKey]! : undefined;
  const typical = Object.hasOwn(evidence.artists, artistOfKey(songKey)) ? evidence.artists[artistOfKey(songKey)]! : undefined;
  let semitones = 0;
  let from: OctaveMove['from'] = 'recording';
  if (own !== undefined) {
    semitones = octaveToward(range.tessitura, own);
  } else if (typical !== undefined) {
    semitones = octaveToward(range.tessitura, typical);
    from = 'artist';
    if (Math.abs(range.tessitura + semitones - typical) > ARTIST_MAX_DISTANCE) return null;
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
  return move.from === 'recording'
    ? `Moved ${by} ${dir} to match the original recording.`
    : `Moved ${by} ${dir} to match the register of the artist's other recordings.`;
}

export interface OctaveFixSummary {
  checked: number;
  moved: number;
  fromRecording: number;
  fromArtist: number;
}

/**
 * Corrects the octave of stored note-file ranges, for every artist the evidence names (songs and
 * artists). With `dryRun`, counts without writing. Safe to run again: a corrected song matches its
 * evidence and does not move.
 */
export async function fixStoredOctaves(store: Store, evidence: OctaveEvidence, opts: { dryRun?: boolean } = {}): Promise<OctaveFixSummary> {
  const artists = new Set([...Object.keys(evidence.artists), ...Object.keys(evidence.songs).map(artistOfKey)]);
  const summary: OctaveFixSummary = { checked: 0, moved: 0, fromRecording: 0, fromArtist: 0 };
  for (const artist of artists) {
    for (const [key, rec] of await store.listSongRangesByArtist(artist)) {
      if (!rec.range) continue;
      summary.checked++;
      const move = octaveMove(key, rec.range, evidence);
      if (!move) continue;
      summary.moved++;
      if (move.from === 'recording') summary.fromRecording++;
      else summary.fromArtist++;
      if (opts.dryRun) continue;
      const log: DataSourceLogEntry = { ...rec.log, reason: `${rec.log.reason} ${octaveLogNote(move)}`.trim() };
      await store.putSongRange(key, { range: { ...shiftRange(rec.range, move.semitones), octaveFrom: move.from }, log });
    }
  }
  return summary;
}
