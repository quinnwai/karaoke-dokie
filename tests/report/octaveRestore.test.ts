import { describe, expect, it } from 'vitest';
import type { DataSourceLogEntry, SongRange } from '../../src/lib/contracts';
import { checkBackupTable, describeRestore, movedBy, movedRow, planRestore } from '../../src/lib/report/octaveRestore';
import type { SongRangeRecord } from '../../src/lib/server/store';
import { correctOctave, octaveLogNote, shiftRange, type OctaveEvidence } from '../../src/lib/songs/octave';

// QWW-62: songs a person found moved wrongly are put back from the copy of song_ranges taken before the fix ran.

const log = (reason = 'Used the note file.'): DataSourceLogEntry => ({ trackId: '', title: 'Money, Money, Money', artist: 'ABBA', outcome: 'note-file', reason, at: '2026-11-06T00:00:00.000Z' });
/** A note file as imported: E4 to F5, with a pitch histogram and the USDB facts a real row carries. */
const written: SongRange = {
  low: 64, high: 77, tessitura: 70.23, source: 'note-file', confidence: 'high', fastLyrics: false,
  pitchShare: [[64, 0.31], [67, 0.12], [70, 0.4], [77, 0.17]], usdbViews: 15_321, usdbRating: 4.5, usdbId: 4321,
};
const KEY = 'abba|money, money, money';
const evidence = (typical: number): OctaveEvidence => ({ songs: { [KEY]: typical }, artists: {} });
const backup: SongRangeRecord = { range: written, log: log() };
/** The row the fix writes (octave.ts fixStoredOctaves): the range moved by whole octaves and marked, the log with a note added. */
const moved = (typical = 59.7, from?: NonNullable<SongRange['octaveFrom']>): SongRangeRecord => {
  const range = correctOctave(KEY, written, evidence(typical));
  const mark = from ?? range.octaveFrom!;
  return { range: { ...range, octaveFrom: mark }, log: log(`Used the note file. ${octaveLogNote({ semitones: range.low - written.low, from: mark })}`) };
};

describe('movedBy: the whole octaves the fix moved a row from its backup', () => {
  it('finds a move down and a move up, which the fix writes with a mark, and nothing else changed', () => {
    const down = moved();
    expect(down.range).toMatchObject({ low: 52, high: 65, octaveFrom: 'recording' });
    expect(movedBy(down.range!, written)).toEqual({ semitones: -12, from: 'recording' });
    const lower = { ...written, low: 52, high: 65, tessitura: 58.23, pitchShare: [[52, 0.5], [65, 0.5]] as [number, number][] };
    const up = correctOctave(KEY, lower, evidence(70));
    expect(up).toMatchObject({ low: 64, high: 77, octaveFrom: 'recording' });
    expect(movedBy(up, lower)).toEqual({ semitones: 12, from: 'recording' });
  });

  it('says why a row is not that move of the backup', () => {
    const down = moved().range!;
    expect(movedBy({ ...down, low: down.low + 1 }, written)).toMatchObject({ reason: expect.stringContaining('not whole octaves') });
    const unmarked = { ...down };
    delete unmarked.octaveFrom;
    expect(movedBy(unmarked, written)).toMatchObject({ reason: expect.stringContaining('not marked as moved') });
    // an octave apart at the low note but not at the top, or any other field different: another step touched the row
    expect(movedBy({ ...down, high: down.high + 1 }, written)).toMatchObject({ reason: expect.stringContaining('another step changed it') });
    expect(movedBy({ ...down, usdbViews: 99 }, written)).toMatchObject({ reason: expect.stringContaining('another step changed it') });
    expect(movedBy({ ...down, confidence: 'low' }, written)).toMatchObject({ reason: expect.stringContaining('another step changed it') });
    expect(movedBy({ ...down, pitchShare: [[52, 1]] }, written)).toMatchObject({ reason: expect.stringContaining('another step changed it') });
  });

  it('does not call a row that was never moved, with another field changed, a move that is not whole octaves', () => {
    // the same low note and a different usdbViews: nothing moved it, something else changed it
    const reason = (movedBy({ ...written, usdbViews: 250 }, written) as { reason: string }).reason;
    expect(reason).toContain("has the backup's low note but differs from it elsewhere");
    expect(reason).not.toContain('semitones');
  });

  it('does not take a backup row that was itself moved for the row as written', () => {
    // a row moved before the backup was taken carries its mark, whatever the current row is
    const already = { ...written, octaveFrom: 'artist' as const };
    expect(movedBy(moved().range!, already)).toMatchObject({ reason: expect.stringContaining('already moved (octaveFrom artist)') });
    // identical rows, both marked: untouched since an earlier move, and not a move of the backup either
    expect(movedBy(already, already)).toMatchObject({ reason: expect.stringContaining('already moved') });
  });
});

describe('planRestore: one song under keep', () => {
  it('writes the backup row back, range and log, when the fix moved the stored one', () => {
    const plan = planRestore(KEY, moved(), backup);
    expect(plan).toMatchObject({ action: 'restore', key: KEY, semitones: -12, from: 'recording' });
    if (plan.action !== 'restore') throw new Error('unreachable');
    expect(plan.next).toEqual(backup);
    expect(plan.next.range).toEqual(written);
    expect(plan.next.log.reason).toBe('Used the note file.'); // the "Moved an octave down" note goes with the move
    expect(plan.current).toEqual(moved());
  });

  it('leaves a row that is already as written, so a second run writes nothing', () => {
    expect(planRestore(KEY, backup, backup)).toEqual({ action: 'same', key: KEY, range: written });
    // the row after a restore: its range is the backup's
    const plan = planRestore(KEY, moved(), backup);
    if (plan.action !== 'restore') throw new Error('unreachable');
    expect(planRestore(KEY, plan.next, backup).action).toBe('same');
  });

  it('puts back a move the fix made by any evidence: the artist, the pitch rule or a person', () => {
    for (const from of ['recording', 'artist', 'pitch', 'hand'] as const) {
      expect(planRestore(KEY, moved(59.7, from), backup)).toMatchObject({ action: 'restore', from });
    }
  });

  it('puts back a move of two octaves, whose log note says so', () => {
    const far = { ...written, low: 40, high: 53, tessitura: 46.23, pitchShare: [[40, 1]] as [number, number][] };
    const current: SongRangeRecord = {
      range: { ...shiftRange(far, 24), octaveFrom: 'recording' },
      log: log(`Used the note file. ${octaveLogNote({ semitones: 24, from: 'recording' })}`),
    };
    expect(octaveLogNote({ semitones: 24, from: 'recording' })).toContain('2 octaves up');
    expect(planRestore(KEY, current, { range: far, log: log() })).toMatchObject({ action: 'restore', semitones: 24 });
  });

  it.each([
    ['the backup has no row for the song', undefined, moved(), 'the backup has no row'],
    ['the backup row has no range', { range: null, log: log() }, moved(), 'no range (a skipped song)'],
    ['the backup row was itself moved: the as-written range is not in it', { range: { ...written, octaveFrom: 'artist' as const }, log: log() }, moved(), 'already moved (octaveFrom artist)'],
    ['the song has no row now', backup, undefined, 'no row now'],
    ['its row has no range now', backup, { range: null, log: log() }, 'no range now'],
    ['another step changed the range since the backup', backup, { range: { ...moved().range!, usdbViews: 1 }, log: moved().log }, 'another step changed it'],
    ['another step changed the log since the fix wrote it', backup, { range: moved().range, log: { ...moved().log, usdbMissAt: '2026-11-12' } }, 'its log differs from what the octave fix wrote'],
    ['the log kept the fix\'s note but lost the original reason', backup, { range: moved().range, log: log('Moved an octave down to match the original recording.') }, 'its log differs from what the octave fix wrote'],
    ['the log has the note of another move', backup, { range: moved().range, log: log(`Used the note file. ${octaveLogNote({ semitones: 12, from: 'recording' })}`) }, 'its log differs from what the octave fix wrote'],
  ] as const)('skips, and says so, when %s', (_name, bak, current, reason) => {
    const plan = planRestore(KEY, current as SongRangeRecord | undefined, bak as SongRangeRecord | undefined);
    expect(plan).toMatchObject({ action: 'skip', key: KEY });
    expect((plan as { reason: string }).reason).toContain(reason);
  });

  it('skips a backup row that was moved even when the stored row is the same as it: "as written already" would be false', () => {
    const already: SongRangeRecord = { range: { ...written, octaveFrom: 'recording' }, log: log() };
    expect(planRestore(KEY, already, already)).toMatchObject({ action: 'skip' });
  });
});

describe('describeRestore', () => {
  it('prints where the row is and where it goes, in note names and midi numbers', () => {
    const plan = planRestore(KEY, moved(), backup);
    expect(describeRestore(plan)).toBe(`restore ${KEY}: E3-F4 (52-65, moved -12 by recording) -> E4-F5 (64-77, as written)`);
    expect(describeRestore(planRestore(KEY, backup, backup))).toBe(`as written already: ${KEY} E4-F5 (64-77)`);
    expect(describeRestore(planRestore(KEY, moved(), undefined))).toBe(`SKIP ${KEY}: the backup has no row for it`);
    const up = describeRestore({ ...(plan as Extract<typeof plan, { action: 'restore' }>), semitones: 12 });
    expect(up).toContain('moved +12 by recording');
  });
});

describe('checkBackupTable: the name goes into SQL', () => {
  it('accepts a copy of song_ranges named for its ticket, and nothing else', () => {
    expect(checkBackupTable('song_ranges_bak_qww53')).toBe('song_ranges_bak_qww53');
    expect(checkBackupTable('song_ranges_bak_qww62')).toBe('song_ranges_bak_qww62');
    for (const bad of [undefined, '', 'song_ranges', 'song_canonical_bak_qww62', 'song_ranges_bak_', 'song_ranges_bak_x; DROP TABLE song_ranges', 'SONG_RANGES_BAK_X', 'song_ranges_bak_qww53 --', 'song_ranges_bak_qww53\n']) {
      expect(() => checkBackupTable(bad), String(bad)).toThrow(/--backup takes the name of a copy of song_ranges/);
    }
  });
});

describe('movedRow: the triage mark for the list of moves', () => {
  const artists = { 'cliff richard': 55.74, 'guns n\' roses': 63.01 };
  const row = (key: string, asWrittenTypical: number, semitones: number) => {
    const asWritten: SongRange = { ...written, low: asWrittenTypical - 5, high: asWrittenTypical + 5, tessitura: asWrittenTypical };
    return movedRow(key, { ...asWritten, tessitura: asWrittenTypical + semitones, low: asWritten.low + semitones, high: asWritten.high + semitones, octaveFrom: 'recording' }, asWritten, semitones, { songs: { [key]: 76.4 }, artists });
  };

  it('marks a move that leaves the typical note far from the artist and further than it was', () => {
    // Cliff Richard sits near G#3; the row was at 57 as written and now at 69
    expect(row('cliff richard|mistletoe and wine', 57, 12)).toMatchObject({ awayFromArtist: true, artist: 55.74, recording: 76.4 });
    // Guns N' Roses sit near D#4; 67 as written, 79 after the move up
    expect(row("guns n' roses|welcome to the jungle", 67, 12).awayFromArtist).toBe(true);
  });

  it('does not mark a move toward the artist, a small one, or a song whose artist has no evidence', () => {
    expect(row('cliff richard|other', 69, -12).awayFromArtist).toBe(false); // 69 to 57: toward G#3
    expect(row('cliff richard|near', 53, 5).awayFromArtist).toBe(false); // ends 2.3 from the artist
    expect(row('nobody|song', 57, 12)).toMatchObject({ awayFromArtist: false, artist: undefined });
  });
});
