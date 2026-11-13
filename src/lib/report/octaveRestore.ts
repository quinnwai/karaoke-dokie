// Undoing a wrong octave move (QWW-62), and finding the moves worth a second look.
//
// The octave fix (songs/octave.ts) moves a note file by whole octaves, and a copy of song_ranges was taken before it ran
// (song_ranges_bak_qww53 on production). When a person finds a move wrong, the song goes under `keep` in
// data/octave-hand-checked.json, so the fix never moves it again, and this puts back the row as it was written, from the
// backup. Everything here is pure except the reads of the backup table (and, for the list of moves, of song_ranges);
// scripts/octave-restore.ts (the write) and scripts/octave-up-moves.ts (a read-only list) wire it to a database.

import { isDeepStrictEqual } from 'node:util';
import { midiToNoteName } from '../audio/notes';
import type { DataSourceLogEntry, SongRange } from '../contracts';
import type { QueryFn } from '../server/postgresStore';
import type { SongRangeRecord } from '../server/store';
import { ARTIST_MAX_DISTANCE, artistOfKey, octaveLogNote, shiftRange, type OctaveEvidence } from '../songs/octave';

/** The backups this reads: a copy of song_ranges named for its ticket. The name goes into SQL, so it is checked. */
export const BACKUP_TABLE = /^song_ranges_bak_[a-z0-9_]+$/;

export function checkBackupTable(name: string | undefined): string {
  if (!name || !BACKUP_TABLE.test(name)) throw new Error(`--backup takes the name of a copy of song_ranges, like song_ranges_bak_qww53; got ${name ?? 'nothing'}`);
  return name;
}

type OctaveFrom = NonNullable<SongRange['octaveFrom']>;

/** Why a backup row is not the row as written, when it carries the mark of an octave move of its own; otherwise undefined. */
const backupAlreadyMoved = (backup: SongRange): string | undefined =>
  backup.octaveFrom ? `the backup row was already moved (octaveFrom ${backup.octaveFrom}), so the as-written range is not in this backup` : undefined;

/** The whole octaves (semitones) the fix moved `range` from `asWritten`, or why `range` is not that move of it. */
export function movedBy(range: SongRange, asWritten: SongRange): { semitones: number; from: OctaveFrom } | { reason: string } {
  const moved = backupAlreadyMoved(asWritten);
  if (moved) return { reason: moved };
  const semitones = range.low - asWritten.low;
  if (semitones === 0) return { reason: 'it has the backup\'s low note but differs from it elsewhere: another step changed it since' };
  if (semitones % 12 !== 0) return { reason: `its low note is ${semitones} semitones from the backup's, not whole octaves` };
  if (!range.octaveFrom) return { reason: 'it differs from the backup but is not marked as moved (no octaveFrom)' };
  const expected: SongRange = { ...shiftRange(asWritten, semitones), octaveFrom: range.octaveFrom };
  return isDeepStrictEqual(range, expected) ? { semitones, from: range.octaveFrom } : { reason: 'it differs from the backup in more than its octave: another step changed it since' };
}

/** A row of song_ranges that has a range. */
export interface Ranged {
  range: SongRange;
  log: DataSourceLogEntry;
}

export type RestorePlan =
  | { action: 'restore'; key: string; semitones: number; from: OctaveFrom; current: Ranged; next: Ranged }
  | { action: 'same'; key: string; range: SongRange }
  | { action: 'skip'; key: string; reason: string };

/**
 * What to do with one song a person has put under `keep`: write the backup's row back when the fix moved the stored one,
 * leave it when it is already as written, and otherwise say why a person has to look. A row is put back only when the stored
 * row is exactly what the fix writes from the backup row: its range moved by whole octaves with an octaveFrom mark, and its
 * log the backup's with the fix's note added, nothing else different. So a row any other step changed since is never
 * overwritten with an old copy. A backup row that was itself moved is not "as written" and is never put back.
 */
export function planRestore(key: string, current: SongRangeRecord | undefined, backup: SongRangeRecord | undefined): RestorePlan {
  const skip = (reason: string): RestorePlan => ({ action: 'skip', key, reason });
  if (!backup) return skip('the backup has no row for it');
  if (!backup.range) return skip('the backup row has no range (a skipped song)');
  const moved = backupAlreadyMoved(backup.range);
  if (moved) return skip(moved);
  if (!current) return skip('the song has no row now');
  if (!current.range) return skip('its row has no range now');
  if (isDeepStrictEqual(current.range, backup.range)) return { action: 'same', key, range: current.range };
  const move = movedBy(current.range, backup.range);
  if ('reason' in move) return skip(move.reason);
  // octave.ts fixStoredOctaves writes this log: the row's own with the note appended
  const written: DataSourceLogEntry = { ...backup.log, reason: `${backup.log.reason} ${octaveLogNote(move)}`.trim() };
  if (!isDeepStrictEqual(current.log, written)) return skip('its log differs from what the octave fix wrote: another step changed the row since');
  return { action: 'restore', key, semitones: move.semitones, from: move.from, current: { range: current.range, log: current.log }, next: { range: backup.range, log: backup.log } };
}

export const notes = (r: { low: number; high: number }) => `${midiToNoteName(r.low)}-${midiToNoteName(r.high)}`;

/** One planned restore as a line for the report: where the row is, and where it goes. */
export function describeRestore(plan: RestorePlan): string {
  switch (plan.action) {
    case 'restore': {
      const [now, back] = [plan.current.range, plan.next.range];
      return `restore ${plan.key}: ${notes(now)} (${now.low}-${now.high}, moved ${plan.semitones > 0 ? '+' : ''}${plan.semitones} by ${plan.from}) -> ${notes(back)} (${back.low}-${back.high}, as written)`;
    }
    case 'same':
      return `as written already: ${plan.key} ${notes(plan.range)} (${plan.range.low}-${plan.range.high})`;
    case 'skip':
      return `SKIP ${plan.key}: ${plan.reason}`;
  }
}

/** The error to give when a backup table is not on the database, so the person running it knows what to fix. */
async function fromBackup(query: QueryFn, table: string, text: string, params: unknown[]) {
  try {
    return await query(text, params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes(table) && /does not exist|no such table/i.test(message)) throw new Error(`${table} is not on this database`);
    throw err;
  }
}

/** A row of a table of song ranges as the store reads one of song_ranges: a skipped row has no range, whatever range_json holds. */
function parseRecord(table: string, row: Record<string, unknown>): SongRangeRecord {
  try {
    const log = JSON.parse(String(row.log_json)) as DataSourceLogEntry | null;
    if (log === null || typeof log !== 'object' || Array.isArray(log)) throw new Error('log_json is not an object');
    const range = row.skipped || row.range_json === null || row.range_json === undefined ? null : (JSON.parse(String(row.range_json)) as SongRange);
    return { range, log };
  } catch (err) {
    throw new Error(`${table} row ${JSON.stringify(String(row.song_key))} does not parse: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * The backup's rows for these keys. Throws a plain message when the table is not on this database, and when it holds two rows
 * for a key (a copy made by CREATE TABLE ... AS SELECT has no primary key, and which of two rows to trust is not for this to guess).
 */
export async function readBackupRows(query: QueryFn, table: string, keys: string[]): Promise<Map<string, SongRangeRecord>> {
  checkBackupTable(table);
  const out = new Map<string, SongRangeRecord>();
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200);
    const placeholders = chunk.map((_, j) => `$${j + 1}`).join(', ');
    for (const row of await fromBackup(query, table, `SELECT song_key, skipped, range_json, log_json FROM ${table} WHERE song_key IN (${placeholders})`, chunk)) {
      const key = String(row.song_key);
      if (out.has(key)) throw new Error(`${table} has two rows for ${JSON.stringify(key)}; remove the extra one before restoring from it`);
      out.set(key, parseRecord(table, row));
    }
  }
  return out;
}

/** A recording-based move as stored: the row now, the row as written, and what the evidence says about the singer's register. */
export interface MovedRow {
  key: string;
  semitones: number;
  asWritten: SongRange;
  now: SongRange;
  /** Typical note (midi) of the song's own recording, from the evidence file. */
  recording?: number;
  /** Typical note of the artist's other recordings. */
  artist?: number;
  /** True when the move left the typical note further than ARTIST_MAX_DISTANCE from the artist's, and further than it was as written. */
  awayFromArtist: boolean;
}

/**
 * A triage mark, not a verdict: a move that takes a row away from where the artist's other recordings sit is the one a
 * person should check first. It says nothing about a song whose artist has no evidence.
 */
export function movedRow(key: string, now: SongRange, asWritten: SongRange, semitones: number, evidence: Pick<OctaveEvidence, 'songs' | 'artists'>): MovedRow {
  const artist = Object.hasOwn(evidence.artists, artistOfKey(key)) ? evidence.artists[artistOfKey(key)] : undefined;
  const recording = Object.hasOwn(evidence.songs, key) ? evidence.songs[key] : undefined;
  const awayFromArtist =
    artist !== undefined && Math.abs(now.tessitura - artist) > ARTIST_MAX_DISTANCE && Math.abs(now.tessitura - artist) > Math.abs(asWritten.tessitura - artist);
  return { key, semitones, asWritten, now, recording, artist, awayFromArtist };
}

/** A row `movedBy` cannot explain: it moved by something other than whole octaves, or another step changed it, or its backup was itself moved. */
export interface Uncomparable {
  key: string;
  current: SongRange;
  backup: SongRange;
  reason: string;
}

/** One such row as a line: the backup range, the range now, how far each end moved, and why it is not an octave move. */
export function describeUncomparable({ key, current, backup, reason }: Uncomparable): string {
  const by = (n: number) => `${n > 0 ? '+' : ''}${n}`;
  return `${key}: backup ${notes(backup)} (${backup.low}-${backup.high}) -> now ${notes(current)} (${current.low}-${current.high}); low ${by(current.low - backup.low)}, high ${by(current.high - backup.high)}; ${reason}`;
}

export interface MovedPage {
  rows: { key: string; current: SongRange; backup: SongRange }[];
  /** The last key read, to ask for the next page after; null when there are no more. */
  last: string | null;
}

/**
 * One page of the rows the fix moved because of their own recording, each with its backup row, by song key. Both sides must
 * have a range. `after` is the last key of the page before.
 */
export async function readRecordingMoves(query: QueryFn, table: string, after: string, limit: number): Promise<MovedPage> {
  checkBackupTable(table);
  const rows = await fromBackup(
    query,
    table,
    `SELECT s.song_key, s.range_json AS current_json, b.range_json AS backup_json
     FROM song_ranges s JOIN ${table} b ON b.song_key = s.song_key
     WHERE s.skipped = false AND s.range_json IS NOT NULL AND b.skipped = false AND b.range_json IS NOT NULL
       AND (s.range_json::json ->> 'octaveFrom') = 'recording' AND s.song_key > $1
     ORDER BY s.song_key LIMIT $2`,
    [after, limit],
  );
  const parse = (key: string, text: unknown) => {
    try {
      return JSON.parse(String(text)) as SongRange;
    } catch (err) {
      throw new Error(`song_ranges or ${table} row ${JSON.stringify(key)} does not parse: ${err instanceof Error ? err.message : err}`);
    }
  };
  // The JOIN on a copy with no primary key returns a song twice when the copy holds it twice (rows come in key order, so twice means next to each other)
  rows.forEach((r, i) => {
    if (i > 0 && String(rows[i - 1]!.song_key) === String(r.song_key)) throw new Error(`${table} has two rows for ${JSON.stringify(String(r.song_key))}; remove the extra one before listing against it`);
  });
  return {
    rows: rows.map((r) => ({ key: String(r.song_key), current: parse(String(r.song_key), r.current_json), backup: parse(String(r.song_key), r.backup_json) })),
    last: rows.length === limit ? String(rows[rows.length - 1]!.song_key) : null,
  };
}
