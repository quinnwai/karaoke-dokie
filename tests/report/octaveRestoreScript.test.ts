import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSourceLogEntry, SongRange } from '../../src/lib/contracts';
import { createPostgresStore, schemaStatements, type QueryFn } from '../../src/lib/server/postgresStore';
import { fixStoredOctaves, withHandChecked, type OctaveEvidence, type OctaveHandChecked } from '../../src/lib/songs/octave';
import { run as restore } from '../../scripts/octave-restore';
import { run as listMoves } from '../../scripts/octave-up-moves';

// QWW-62 end to end on an in-memory Postgres: rows as written, moved by the real octave fix, put back from the copy taken
// before it ran, and kept from moving again.

const BACKUP = 'song_ranges_bak_qww53';
const ABBA = 'abba|money, money, money'; // moved down by its recording: a wrong move
const JUNGLE = "guns n' roses|welcome to the jungle"; // moved up by its recording: a wrong move
const ROCK = 'ac/dc|let there be rock'; // under keep from the start: the fix never moved it
const CHANGED = 'x|changed since'; // moved, then another step changed the row's range
const GONE = 'pixies|where is my mind'; // under keep, but the backup has no row for it
const SIBLING = 'abba|money money money'; // not under keep, never moved

const note = (low: number, high: number, tessitura: number, extra: Partial<SongRange> = {}): SongRange => ({
  low, high, tessitura, source: 'note-file', confidence: 'high', fastLyrics: false, pitchShare: [[low, 0.5], [high, 0.5]], usdbViews: 5_000, ...extra,
});
const AS_WRITTEN: Record<string, SongRange> = {
  [ABBA]: note(64, 77, 70.2),
  [JUNGLE]: note(61, 75, 67),
  [ROCK]: note(48, 76, 62),
  [CHANGED]: note(64, 77, 70),
  [GONE]: note(61, 69, 64),
  [SIBLING]: note(64, 77, 70.2),
};
const log = (key: string): DataSourceLogEntry => ({ trackId: '', title: key.split('|')[1]!, artist: key.split('|')[0]!, outcome: 'note-file', reason: 'Used the note file.', at: '2026-11-06T00:00:00.000Z' });
// What the recordings say (as in data/octave-evidence.json): the fix moves ABBA down, the Jungle up and CHANGED down; the artists
// have evidence, so the pitch rule stays off the sibling row, which sits within 6 semitones of ABBA's register.
const evidence: OctaveEvidence = { songs: { [ABBA]: 59.7, [JUNGLE]: 76.44, [CHANGED]: 59.7 }, artists: { abba: 64.74, "guns n' roses": 63.01 } };
const KEEP = [ABBA, JUNGLE, ROCK, CHANGED, GONE];

let dir: string;
let files = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'octave-restore-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const writeJson = (value: unknown) => {
  const path = join(dir, `file-${files++}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
};
const handFile = (keep: string[] = KEEP) => {
  const hand: OctaveHandChecked = { artists: {}, keep: Object.fromEntries(keep.map((k) => [k, { source: `sheet music, test source for ${k}` }])) };
  return { hand, path: writeJson(hand) };
};

/** A pg-mem database `name` holding the rows as written, a copy of them as the backup, and then the rows after the real fix. */
async function database(name: string, opts: { backup?: boolean } = {}) {
  const db = newDb();
  db.public.registerFunction({ name: 'current_database', returns: DataType.text, implementation: () => name });
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const query: QueryFn = async (text, params) => (await pool.query(text, params)).rows;
  for (const stmt of schemaStatements()) await query(stmt);
  const store = createPostgresStore(query, { autoMigrate: false });
  for (const [key, range] of Object.entries(AS_WRITTEN)) await store.putSongRange(key, { range, log: log(key) });
  if (opts.backup !== false) {
    await query(`CREATE TABLE ${BACKUP} (song_key TEXT, skipped BOOLEAN NOT NULL, range_json TEXT, log_json TEXT NOT NULL)`, []);
    for (const key of Object.keys(AS_WRITTEN)) {
      if (key === GONE) continue; // the backup has no row for it
      const rec = (await store.getSongRange(key))!;
      await query(`INSERT INTO ${BACKUP} (song_key, skipped, range_json, log_json) VALUES ($1, false, $2, $3)`, [key, JSON.stringify(rec.range), JSON.stringify(rec.log)]);
    }
  }
  const summary = await fixStoredOctaves(store, withHandChecked(evidence, handFile([ROCK]).hand));
  expect(summary).toMatchObject({ moved: 3, fromRecording: 3 }); // ABBA, the Jungle and CHANGED; ROCK is kept, the rest are not moved
  // another step changes CHANGED's row after the fix
  const rec = (await store.getSongRange(CHANGED))!;
  await store.putSongRange(CHANGED, { ...rec, range: { ...rec.range!, usdbViews: 1 } });
  return { query, store };
}
const asWritten = (store: ReturnType<typeof createPostgresStore>, key: string) => store.getSongRange(key).then((r) => r!.range);
const goWith = async (query: QueryFn, argv: string[], hand: string) => {
  const lines: string[] = [];
  const summary = await restore({ argv: [...argv, '--hand', hand], query, host: 'db.example', log: (l) => lines.push(l) });
  return { out: lines.join('\n'), summary };
};
const go = async (query: QueryFn, argv: string[], hand: string) => (await goWith(query, argv, hand)).out;
const APPLY = ['--backup', BACKUP, '--apply', '--confirm-database', 'karaoke_pr4_preview'];

describe('npm run octave:restore', () => {
  it('is a dry run by default: it lists what it would do, writes nothing, and says what the real command takes', async () => {
    const { query, store } = await database('karaoke_pr4_preview');
    const before = await store.getSongRanges(Object.keys(AS_WRITTEN));
    const { path } = handFile();
    const { out, summary } = await goWith(query, ['--backup', BACKUP], path);
    expect(summary).toEqual({ restored: 0, same: 1, skipped: 2, changedMeanwhile: 0 });
    expect(out).toContain('Database karaoke_pr4_preview on db.example (dry run: nothing is written)');
    expect(out).toContain(`5 songs under keep in the hand-checked file; backup ${BACKUP} has 4 of them.`);
    expect(out).toContain(`restore ${ABBA}: E3-F4 (52-65, moved -12 by recording) -> E4-F5 (64-77, as written)`);
    expect(out).toContain(`restore ${JUNGLE}: C#5-D#6 (73-87, moved +12 by recording) -> C#4-D#5 (61-75, as written)`);
    expect(out).toContain(`      checked: sheet music, test source for ${ABBA}`);
    expect(out).toContain(`as written already: ${ROCK} C3-E5 (48-76)`);
    expect(out).toContain(`SKIP ${CHANGED}: it differs from the backup in more than its octave: another step changed it since`);
    expect(out).toContain(`SKIP ${GONE}: the backup has no row for it`);
    expect(out).toContain('2 to restore, 1 already as written, 2 skipped (each needs a person: see the lines marked SKIP).');
    expect(out).toContain(`npm run octave:restore -- --backup ${BACKUP} --expect-restore 2 --apply --confirm-database karaoke_pr4_preview`);
    expect(await store.getSongRanges(Object.keys(AS_WRITTEN))).toEqual(before);
  });

  it('writes nothing without --confirm-database naming the database it is connected to', async () => {
    const { query, store } = await database('karaoke_pr4_preview');
    const before = await asWritten(store, ABBA);
    const { path } = handFile();
    await expect(go(query, ['--backup', BACKUP, '--apply'], path)).rejects.toThrow(/--confirm-database must name the database being written \(karaoke_pr4_preview\); got nothing/);
    await expect(go(query, ['--backup', BACKUP, '--apply', '--confirm-database', 'neondb'], path)).rejects.toThrow(/got neondb\. Nothing was written/);
    expect(await asWritten(store, ABBA)).toEqual(before);
  });

  it('treats a database named neondb as production: --confirm-database is not enough, it needs --production', async () => {
    const { query, store } = await database('neondb');
    const { path } = handFile();
    await expect(go(query, ['--backup', BACKUP, '--apply', '--confirm-database', 'neondb'], path)).rejects.toThrow(/neondb is production.*Pass --production/);
    expect((await asWritten(store, ABBA))!.low).toBe(52);
    expect(await go(query, ['--backup', BACKUP], path)).toContain('--apply --confirm-database neondb --production');
    expect(await go(query, ['--backup', BACKUP, '--apply', '--confirm-database', 'neondb', '--production'], path)).toContain('Done. 2 rows restored, read back and equal to the backup.');
    expect((await asWritten(store, ABBA))!.low).toBe(64);
  });

  it('puts back the as-written row, range and log, names each row it writes, touches no other row, and a second run has nothing to write', async () => {
    const { query, store } = await database('karaoke_pr4_preview');
    const { path } = handFile();
    const others = await store.getSongRanges([ROCK, CHANGED, GONE, SIBLING]);
    const { out, summary } = await goWith(query, APPLY, path);
    expect(summary).toEqual({ restored: 2, same: 1, skipped: 2, changedMeanwhile: 0 });
    expect(out).toContain(`restored ${ABBA}`);
    expect(out).toContain(`restored ${JUNGLE}`);
    expect(out).toContain('Done. 2 rows restored, read back and equal to the backup.');
    expect(await store.getSongRange(ABBA)).toEqual({ range: AS_WRITTEN[ABBA], log: log(ABBA) });
    expect(await store.getSongRange(JUNGLE)).toEqual({ range: AS_WRITTEN[JUNGLE], log: log(JUNGLE) });
    expect(await store.getSongRanges([ROCK, CHANGED, GONE, SIBLING])).toEqual(others);
    // a rerun has nothing to restore; the two skips remain, which is a person's to look at
    const again = await goWith(query, ['--backup', BACKUP], path);
    expect(again.out).toContain('0 to restore, 3 already as written, 2 skipped');
    expect(again.out).toContain('Dry run. To write 0 rows');
    expect(again.summary).toEqual({ restored: 0, same: 3, skipped: 2, changedMeanwhile: 0 });
  });

  it('with only songs that can be put back, the rerun is clean: 0 to restore, all as written, 0 skipped', async () => {
    const { query } = await database('karaoke_pr4_preview');
    const { path } = handFile([ABBA, JUNGLE, ROCK]);
    await go(query, APPLY, path);
    const again = await goWith(query, ['--backup', BACKUP], path);
    expect(again.out).toContain('0 to restore, 3 already as written, 0 skipped.');
    expect(again.summary).toEqual({ restored: 0, same: 3, skipped: 0, changedMeanwhile: 0 });
  });

  it('is what makes keep work: the fix puts a restored song back unless the song is under keep', async () => {
    const { query, store } = await database('karaoke_pr4_preview');
    const { hand, path } = handFile();
    await go(query, APPLY, path);
    // with the keep list, the fix leaves the restored rows alone (CHANGED is under keep too)
    expect(await fixStoredOctaves(store, withHandChecked(evidence, hand), { dryRun: true })).toMatchObject({ moved: 0 });
    // without it, the same evidence moves the two restored rows again: that is what a rerun of the fix would have done
    // (CHANGED is not moved: it is still where its recording puts it)
    const none = await fixStoredOctaves(store, withHandChecked(evidence, { artists: {}, keep: { [ROCK]: { source: 'test' } } }), { dryRun: true });
    expect(none).toMatchObject({ moved: 2, fromRecording: 2 });
  });

  describe('--expect-restore: an apply cannot differ from the dry run that was approved', () => {
    it('goes on when the plan restores exactly that many rows, in a dry run and an apply', async () => {
      const { query } = await database('karaoke_pr4_preview');
      const { path } = handFile();
      expect(await go(query, ['--backup', BACKUP, '--expect-restore', '2'], path)).toContain('2 to restore');
      expect(await go(query, [...APPLY, '--expect-restore', '2'], path)).toContain('Done. 2 rows restored');
    });

    it('refuses, and writes nothing, when the plan restores another number', async () => {
      const { query, store } = await database('karaoke_pr4_preview');
      const { path } = handFile();
      const before = await store.getSongRanges(Object.keys(AS_WRITTEN));
      await expect(go(query, [...APPLY, '--expect-restore', '3'], path)).rejects.toThrow('--expect-restore says 3 rows but the plan restores 2. Nothing was written.');
      await expect(go(query, ['--backup', BACKUP, '--expect-restore', '0'], path)).rejects.toThrow('--expect-restore says 0 rows but the plan restores 2');
      expect(await store.getSongRanges(Object.keys(AS_WRITTEN))).toEqual(before);
    });

    it('takes a whole number', async () => {
      const { query } = await database('karaoke_pr4_preview');
      const { path } = handFile();
      for (const bad of ['x', '-1', '1.5', '']) await expect(go(query, ['--backup', BACKUP, `--expect-restore=${bad}`], path), bad).rejects.toThrow('--expect-restore takes a whole number');
    });
  });

  describe('a row another step changed', () => {
    it('is skipped when only its log changed since the fix wrote it, and the other row is still restored', async () => {
      const { query, store } = await database('karaoke_pr4_preview');
      const { path } = handFile();
      const rec = (await store.getSongRange(ABBA))!;
      await store.putSongRange(ABBA, { ...rec, log: { ...rec.log, usdbMissAt: '2026-11-12T00:00:00.000Z' } as DataSourceLogEntry });
      const { out, summary } = await goWith(query, APPLY, path);
      expect(out).toContain(`SKIP ${ABBA}: its log differs from what the octave fix wrote: another step changed the row since`);
      expect(summary).toMatchObject({ restored: 1, skipped: 3 });
      expect((await asWritten(store, ABBA))!.low).toBe(52); // left as it was, with its log
      expect((await store.getSongRange(ABBA))!.log).toHaveProperty('usdbMissAt');
      expect((await asWritten(store, JUNGLE))!.low).toBe(61);
    });

    it.each([
      ['range', (rec: { range: SongRange | null; log: DataSourceLogEntry }) => ({ ...rec, range: { ...rec.range!, usdbViews: 77 } })],
      ['log', (rec: { range: SongRange | null; log: DataSourceLogEntry }) => ({ ...rec, log: { ...rec.log, usdbMissAt: '2026-11-12' } as DataSourceLogEntry })],
    ])('is left alone when its %s changed between the plan and the write, and says so', async (_what, change) => {
      const { query, store } = await database('karaoke_pr4_preview');
      const { path } = handFile();
      let armed = true;
      const racing: QueryFn = async (text, params) => {
        // the write path reads the row again just before writing: change ABBA's row at that moment
        if (armed && text.includes('FROM song_ranges WHERE song_key = $1') && params?.[0] === ABBA) {
          armed = false;
          await store.putSongRange(ABBA, change((await store.getSongRange(ABBA))!));
        }
        return query(text, params);
      };
      const { out, summary } = await goWith(racing, APPLY, path);
      expect(out).toContain(`changed meanwhile, left alone: ${ABBA}`);
      expect(out).toContain('Done. 1 rows restored, read back and equal to the backup; 1 left alone because they changed meanwhile.');
      expect(summary).toMatchObject({ restored: 1, changedMeanwhile: 1 });
      expect((await asWritten(store, ABBA))!.low).toBe(52);
      expect((await asWritten(store, JUNGLE))!.low).toBe(61);
    });
  });

  describe('the backup and the keep list', () => {
    it('says so when the backup is not on this database, and takes only the name of a copy of song_ranges', async () => {
      const { query } = await database('karaoke_pr4_preview', { backup: false });
      const { path } = handFile();
      await expect(go(query, ['--backup', BACKUP], path)).rejects.toThrow(`${BACKUP} is not on this database`);
      await expect(go(query, [], path)).rejects.toThrow(/--backup takes the name of a copy of song_ranges/);
      await expect(go(query, ['--backup', 'song_ranges'], path)).rejects.toThrow(/--backup takes the name of a copy of song_ranges/);
      await expect(go(query, ['--backup', BACKUP, '--apply', '--dry-run'], path)).rejects.toThrow('Pass --apply or --dry-run, not both');
    });

    it('skips a backup row that was itself moved: it is not the as-written range', async () => {
      const { query, store } = await database('karaoke_pr4_preview');
      const { path } = handFile();
      const rec = (await store.getSongRange(ABBA))!; // the moved row, with its octaveFrom mark, as the backup
      await query(`UPDATE ${BACKUP} SET range_json = $1 WHERE song_key = $2`, [JSON.stringify(rec.range), ABBA]);
      const out = await go(query, ['--backup', BACKUP], path);
      expect(out).toContain(`SKIP ${ABBA}: the backup row was already moved (octaveFrom recording), so the as-written range is not in this backup`);
      expect(out).toContain('1 to restore');
    });

    it('reads a skipped backup row as the store does, with no range, whatever range_json holds', async () => {
      const { query } = await database('karaoke_pr4_preview');
      const { path } = handFile();
      await query(`UPDATE ${BACKUP} SET skipped = true WHERE song_key = $1`, [ABBA]);
      const out = await go(query, ['--backup', BACKUP], path);
      expect(out).toContain(`SKIP ${ABBA}: the backup row has no range (a skipped song)`);
      expect(out).toContain('1 to restore');
    });

    it('refuses a backup with two rows for a song, whichever comes first', async () => {
      const { query, store } = await database('karaoke_pr4_preview');
      const { path } = handFile();
      const moved = (await store.getSongRange(ABBA))!;
      await query(`INSERT INTO ${BACKUP} (song_key, skipped, range_json, log_json) VALUES ($1, false, $2, $3)`, [ABBA, JSON.stringify(moved.range), JSON.stringify(moved.log)]);
      await expect(go(query, ['--backup', BACKUP], path)).rejects.toThrow(`${BACKUP} has two rows for "${ABBA}"`);
      await expect(go(query, APPLY, path)).rejects.toThrow('has two rows');
      expect((await asWritten(store, ABBA))!.low).toBe(52); // nothing was written
    });

    it('names the song when a backup row does not parse or has no log object', async () => {
      const { query } = await database('karaoke_pr4_preview');
      const { path } = handFile();
      await query(`UPDATE ${BACKUP} SET log_json = 'null' WHERE song_key = $1`, [ABBA]);
      await expect(go(query, ['--backup', BACKUP], path)).rejects.toThrow(`${BACKUP} row "${ABBA}" does not parse: log_json is not an object`);
      await query(`UPDATE ${BACKUP} SET log_json = $1, range_json = '{oops' WHERE song_key = $2`, [JSON.stringify(log(ABBA)), ABBA]);
      await expect(go(query, ['--backup', BACKUP], path)).rejects.toThrow(new RegExp(`${BACKUP} row "${ABBA}" does not parse`));
    });

    it('refuses a keep entry that does not say where it came from, as the fix does, and a file with no keep list', async () => {
      const { query } = await database('karaoke_pr4_preview');
      const noSource = writeJson({ artists: {}, keep: { [ABBA]: {} } });
      await expect(go(query, ['--backup', BACKUP], noSource)).rejects.toThrow(`Hand-checked song to keep "${ABBA}" needs a source`);
      const noKeep = writeJson({ artists: {} });
      await expect(go(query, ['--backup', BACKUP], noKeep)).rejects.toThrow('needs an "artists" object and a "keep" object');
    });
  });
});

describe('every kind of move the real fix makes is put back', () => {
  // as written, the evidence that moves it, the move, and its mark: the log the fix writes differs for each (octaveLogNote)
  const KINDS = [
    ['x|by the artist', note(64, 76, 70), -12, 'artist'],
    ['y|by the pitch', note(66, 78, 72), -12, 'pitch'],
    ['ac/dc|by hand', note(52, 64, 58), 12, 'hand'],
    ['z|two octaves down', note(76, 89, 82), -24, 'recording'],
    ['w|two octaves up', note(40, 53, 46), 24, 'recording'],
  ] as const;
  const kindEvidence: OctaveEvidence = { songs: { 'z|two octaves down': 58, 'w|two octaves up': 70 }, artists: { x: 58 } };
  const kindHand: OctaveHandChecked = { artists: { 'ac/dc': { typical: 70, source: 'by ear, test' } }, keep: {} };

  it('writes the as-written row back for an artist, pitch, hand and recording move of one and of two octaves, and the rerun is clean', async () => {
    const db = newDb();
    db.public.registerFunction({ name: 'current_database', returns: DataType.text, implementation: () => 'karaoke_pr4_preview' });
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();
    const query: QueryFn = async (text, params) => (await pool.query(text, params)).rows;
    for (const stmt of schemaStatements()) await query(stmt);
    const store = createPostgresStore(query, { autoMigrate: false });
    await query(`CREATE TABLE ${BACKUP} (song_key TEXT, skipped BOOLEAN NOT NULL, range_json TEXT, log_json TEXT NOT NULL)`, []);
    for (const [key, range] of KINDS) {
      await store.putSongRange(key, { range, log: log(key) });
      await query(`INSERT INTO ${BACKUP} (song_key, skipped, range_json, log_json) VALUES ($1, false, $2, $3)`, [key, JSON.stringify(range), JSON.stringify(log(key))]);
    }
    expect(await fixStoredOctaves(store, withHandChecked(kindEvidence, kindHand))).toMatchObject({ moved: 5, fromRecording: 2, fromArtist: 1, fromPitch: 1, fromHand: 1 });
    const { path } = handFile(KINDS.map(([key]) => key));
    const dry = await goWith(query, ['--backup', BACKUP, '--expect-restore', '5'], path);
    expect(dry.summary).toEqual({ restored: 0, same: 0, skipped: 0, changedMeanwhile: 0 });
    for (const [key, , semitones, from] of KINDS) {
      const line = dry.out.split('\n').find((l) => l.startsWith(`restore ${key}: `));
      expect(line, key).toBeDefined();
      expect(line, key).toContain(`moved ${semitones > 0 ? '+' : ''}${semitones} by ${from})`);
    }
    const applied = await goWith(query, [...APPLY, '--expect-restore', '5'], path);
    expect(applied.summary).toEqual({ restored: 5, same: 0, skipped: 0, changedMeanwhile: 0 });
    for (const [key, range] of KINDS) expect(await store.getSongRange(key), key).toEqual({ range, log: log(key) });
    const again = await goWith(query, ['--backup', BACKUP], path);
    expect(again.out).toContain('0 to restore, 5 already as written, 0 skipped.');
  });
});

describe('npm run octave:moves', () => {
  // the evidence files this run reads: the same numbers the database above was moved by, not the checked-in data/octave-evidence.json
  const paths = (songs = evidence.songs) => ({ evidence: writeJson({ ...evidence, songs }), hand: handFile([ROCK]).path });
  const lines = async (query: QueryFn, argv: string[], songs = evidence.songs) => {
    const out: string[] = [];
    await listMoves({ argv, query, host: 'db.example', log: (l) => out.push(l), paths: paths(songs) });
    return out.join('\n');
  };

  it('lists the moves up by default, marks one that leaves the artist, and is read only', async () => {
    const { query, store } = await database('karaoke_pr4_preview');
    const before = await store.getSongRanges(Object.keys(AS_WRITTEN));
    const out = await lines(query, ['--backup', BACKUP]);
    expect(out).toContain('Database karaoke_pr4_preview on db.example (read only), against song_ranges_bak_qww53');
    expect(out).toContain('2 rows were moved by their own recording (1 up, 1 down); 1 more cannot be compared with the backup');
    expect(out).toContain('Listing the moves up: 1, of which 1 are marked AWAY');
    expect(out).toContain(`AWAY  ${JUNGLE}: C#4-D#5 (61-75) -> C#5-D#6 (73-87), +12; recording E5 (76.4), artist D#4 (63.0)`);
    expect(out).not.toContain(ABBA); // a move down is not in the default list
    expect(await store.getSongRanges(Object.keys(AS_WRITTEN))).toEqual(before);
  });

  it('lists the moves down, or both, and counts the rows that cannot be compared with the backup', async () => {
    const { query } = await database('karaoke_pr4_preview');
    const down = await lines(query, ['--backup', BACKUP, '--direction', 'down']);
    expect(down).toContain(`${ABBA}: E4-F5 (64-77) -> E3-F4 (52-65), -12; recording C4 (59.7), artist F4 (64.7)`);
    expect(down).not.toContain(JUNGLE);
    // CHANGED differs from its backup in more than its octave, so it is counted and not listed
    expect(down).toContain('1 more cannot be compared with the backup (it was itself moved before the backup was taken, or another step changed the row since) and are not listed');
    expect(down).not.toContain(CHANGED);
    const both = await lines(query, ['--backup', BACKUP, '--direction', 'both']);
    expect(both).toContain('Listing all moves: 2');
    expect(both).toContain(JUNGLE);
    expect(both).toContain(ABBA);
  });

  it('does not list a row whose backup was itself moved as if the backup were as written', async () => {
    const { query, store } = await database('karaoke_pr4_preview');
    // the backup holds a row moved earlier (marked 'artist') at 64-77; the stored row, marked 'recording', is at 52-65
    const asBacked = { ...AS_WRITTEN[ABBA]!, octaveFrom: 'artist' as const };
    await query(`UPDATE ${BACKUP} SET range_json = $1 WHERE song_key = $2`, [JSON.stringify(asBacked), ABBA]);
    const down = await lines(query, ['--backup', BACKUP, '--direction', 'down']);
    expect(down).not.toContain(`${ABBA}:`);
    expect(down).toContain('2 more cannot be compared with the backup');
    // and identical rows on both sides, both marked: untouched since an earlier move, so not a move against this backup
    const rec = (await store.getSongRange(JUNGLE))!;
    await query(`UPDATE ${BACKUP} SET range_json = $1 WHERE song_key = $2`, [JSON.stringify(rec.range), JUNGLE]);
    const up = await lines(query, ['--backup', BACKUP]);
    expect(up).not.toContain(`${JUNGLE}:`);
    expect(up).toContain('0 rows were moved by their own recording (0 up, 0 down); 3 more cannot be compared');
  });

  it('puts the marked rows first, most viewed first, then the most viewed of the others up to the limit', async () => {
    const { query, store } = await database('karaoke_pr4_preview');
    // three more rows moved down by their own recording, by an artist the evidence knows nothing about: never marked
    const extra = [['nobody|few views', 10], ['nobody|many views', 90_000], ['nobody|some views', 5_000]] as const;
    for (const [key, views] of extra) {
      const range = note(64, 77, 70.2, { usdbViews: views });
      await store.putSongRange(key, { range, log: log(key) });
      await query(`INSERT INTO ${BACKUP} (song_key, skipped, range_json, log_json) VALUES ($1, false, $2, $3)`, [key, JSON.stringify(range), JSON.stringify(log(key))]);
    }
    const songs = { ...evidence.songs, ...Object.fromEntries(extra.map(([key]) => [key, 59.7])) };
    await fixStoredOctaves(store, withHandChecked({ ...evidence, songs }, handFile([ROCK]).hand));
    const text = await lines(query, ['--backup', BACKUP, '--direction', 'both', '--limit', '2'], songs);
    const rows = text.split('\n').filter((l) => /^(AWAY | {5}) \S/.test(l));
    expect(rows.map((l) => `${l.startsWith('AWAY') ? 'AWAY' : 'rest'} ${l.slice(6, l.indexOf(': '))}`)).toEqual([
      `AWAY ${ABBA}`, // equal views: the lower key first
      `AWAY ${JUNGLE}`,
      'rest nobody|many views',
      'rest nobody|some views',
    ]);
    expect(text).toContain('Listing all moves: 5, of which 2 are marked AWAY');
    expect(text).toContain('(1 more not listed: raise --limit.)');
  });

  it('refuses a backup with two rows for a song instead of listing the song twice', async () => {
    const { query, store } = await database('karaoke_pr4_preview');
    const moved = (await store.getSongRange(JUNGLE))!;
    await query(`INSERT INTO ${BACKUP} (song_key, skipped, range_json, log_json) VALUES ($1, false, $2, $3)`, [JUNGLE, JSON.stringify(AS_WRITTEN[JUNGLE]), JSON.stringify(log(JUNGLE))]);
    expect(moved.range!.low).toBe(73);
    await expect(lines(query, ['--backup', BACKUP])).rejects.toThrow(`${BACKUP} has two rows for "${JUNGLE}"`);
  });

  it('refuses a bad direction, limit or backup name, and says so when the backup is not there', async () => {
    const { query } = await database('karaoke_pr4_preview');
    await expect(lines(query, ['--backup', BACKUP, '--direction', 'sideways'])).rejects.toThrow('--direction takes up, down or both');
    for (const bad of ['-1', '', '0x10', '1e2', '1.5']) await expect(lines(query, ['--backup', BACKUP, `--limit=${bad}`]), bad).rejects.toThrow('--limit takes a whole number');
    await expect(lines(query, ['--backup', 'song_ranges'])).rejects.toThrow(/--backup takes the name of a copy of song_ranges/);
    await expect(lines(query, ['--backup', 'song_ranges_bak_nothing'])).rejects.toThrow('song_ranges_bak_nothing is not on this database');
  });
});
