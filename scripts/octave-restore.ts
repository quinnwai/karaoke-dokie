// Puts back the as-written range of every song under `keep` in data/octave-hand-checked.json that the octave fix had
// already moved (QWW-62), from a copy of song_ranges taken before the fix ran (song_ranges_bak_qww53 on production).
// A song goes under `keep` when a person has checked its octave and the move was wrong; `keep` stops the fix moving it
// again, and this undoes the move that was already made. Rules (src/lib/report/octaveRestore.ts):
//  - A row is written back only when the stored row is exactly what the fix writes from the backup row: its range moved by
//    whole octaves with an octaveFrom mark, its log the backup's with the fix's note added, nothing else different. A row
//    any other step changed since is skipped and reported (a line marked SKIP), never overwritten with an old copy.
//  - A song already as written is left alone, so a second run writes 0 rows: its pass is "0 to restore, N already as
//    written, 0 skipped", and the exit code is 2 when anything was skipped.
//  - A backup row that carries an octaveFrom mark of its own was moved before the backup was taken, so it is not "as
//    written" and is skipped (the preview database is like that: it had the 6 Nov round before the 11 Nov one).
//  - A backup with two rows for a song is refused: which one to trust is for a person to say.
//
// A dry run by default: it reads the two tables and writes nothing. --apply writes, and only to the database named by
// --confirm-database; a database named neondb is production, which also needs --production (as for titles:build).
// --expect-restore N refuses to go on (dry run or not) unless the plan restores exactly N rows, so an apply cannot differ from the
// dry run that was approved. Each row is read again just before it is written and left alone if it changed meanwhile, each
// row written is named, and every row written is read back. That is not a compare-and-swap, so run it while nothing else
// writes song ranges (usdb:sync, usdb:fill, ranges:import, narrow-ranges, octave-fix), as the octave fix itself asks.
// Usage: npm run octave:restore -- --backup song_ranges_bak_qww53 [--expect-restore N]
//        npm run octave:restore -- --backup song_ranges_bak_qww53 --expect-restore N --apply --confirm-database <name> [--production]
// Needs DATABASE_URL. Run it from the repository root (it reads data/octave-hand-checked.json from there; --hand <file> reads
// another, for tests). Run `npm run titles:build` after it: the row the list shows for a song follows the ranges of its rows.

import { realpathSync } from 'node:fs';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { checkBackupTable, describeRestore, planRestore, readBackupRows, type RestorePlan } from '../src/lib/report/octaveRestore';
import { readOnlyStore } from '../src/lib/report/readOnlyStore';
import { neonQuery } from '../src/lib/server/getStore';
import { createPostgresStore, type QueryFn } from '../src/lib/server/postgresStore';
import { withHandChecked } from '../src/lib/songs/octave';
import { loadHandChecked } from '../src/lib/songs/octaveFiles';
import { PRODUCTION_DATABASES } from './song-titles';

export interface RunOptions {
  argv: string[];
  query: QueryFn;
  /** The database host, printed so the person running it can see which server this is. */
  host: string;
  log?: (line: string) => void;
}

/** What a run did, or in a dry run would do. */
export interface RunSummary {
  restored: number;
  same: number;
  skipped: number;
  /** Rows left alone because they changed between the plan and the write. */
  changedMeanwhile: number;
}

export async function run(opts: RunOptions): Promise<RunSummary> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const { values } = parseArgs({
    args: opts.argv,
    options: {
      backup: { type: 'string' },
      apply: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      production: { type: 'boolean' },
      'confirm-database': { type: 'string' },
      'expect-restore': { type: 'string' },
      hand: { type: 'string' },
    },
  });
  if (values.apply && values['dry-run']) throw new Error('Pass --apply or --dry-run, not both');
  const table = checkBackupTable(values.backup);
  const rawExpected = values['expect-restore'];
  if (rawExpected !== undefined && !/^\d+$/.test(rawExpected)) throw new Error(`--expect-restore takes a whole number, not "${rawExpected}"`);
  const expected = rawExpected === undefined ? undefined : Number(rawExpected);
  const [who] = await opts.query('SELECT current_database() AS db', []);
  const database = String(who?.db);
  log(`Database ${database} on ${opts.host}${values.apply ? '' : ' (dry run: nothing is written)'}`);

  const hand = loadHandChecked(values.hand);
  withHandChecked({ songs: {}, artists: {} }, hand); // every entry has to say where it came from, as the fix demands
  const keep = hand.keep;
  const keys = Object.keys(keep).sort();
  const store = createPostgresStore(opts.query, { autoMigrate: false });
  const [current, backup] = await Promise.all([readOnlyStore(store).getSongRanges(keys), readBackupRows(opts.query, table, keys)]);
  const plans = keys.map((key) => planRestore(key, current.get(key), backup.get(key)));
  const todo = plans.filter((p): p is Extract<RestorePlan, { action: 'restore' }> => p.action === 'restore');
  const summary: RunSummary = { restored: 0, same: plans.filter((p) => p.action === 'same').length, skipped: plans.filter((p) => p.action === 'skip').length, changedMeanwhile: 0 };

  log(`${keys.length} songs under keep in the hand-checked file; backup ${table} has ${backup.size} of them.\n`);
  for (const p of plans) {
    log(describeRestore(p));
    if (p.action === 'restore') log(`      checked: ${keep[p.key]!.source}`);
  }
  log(`\n${todo.length} to restore, ${summary.same} already as written, ${summary.skipped} skipped${summary.skipped ? ' (each needs a person: see the lines marked SKIP)' : ''}.`);
  if (expected !== undefined && expected !== todo.length) {
    throw new Error(`--expect-restore says ${expected} rows but the plan restores ${todo.length}. Nothing was written.`);
  }

  if (!values.apply) {
    log(`\nDry run. To write ${todo.length} rows: npm run octave:restore -- --backup ${table} --expect-restore ${todo.length} --apply --confirm-database ${database}${PRODUCTION_DATABASES.includes(database) ? ' --production' : ''}`);
    return summary;
  }
  if (values['confirm-database'] !== database) {
    throw new Error(`--confirm-database must name the database being written (${database}); got ${values['confirm-database'] ?? 'nothing'}. Nothing was written.`);
  }
  if (PRODUCTION_DATABASES.includes(database) && !values.production) {
    throw new Error(`${database} is production, which is read-only until its data step. Pass --production to write it. Nothing was written.`);
  }

  const written: typeof todo = [];
  for (const p of todo) {
    // Read again just before writing: a row someone else changed since the plan was made is left alone. The whole row counts, log included.
    if (!isDeepStrictEqual(await store.getSongRange(p.key), p.current)) {
      summary.changedMeanwhile++;
      log(`changed meanwhile, left alone: ${p.key} (run the dry run again to see what it is now)`);
      continue;
    }
    await store.putSongRange(p.key, p.next);
    written.push(p);
    log(`restored ${p.key}`);
  }
  const after = await store.getSongRanges(written.map((p) => p.key));
  const wrong = written.filter((p) => !isDeepStrictEqual(after.get(p.key), p.next));
  if (wrong.length) throw new Error(`${wrong.length} rows did not read back equal to the backup (first: ${wrong[0]!.key}); look at the row before running again`);
  summary.restored = written.length;
  log(`Done. ${written.length} rows restored, read back and equal to the backup${summary.changedMeanwhile ? `; ${summary.changedMeanwhile} left alone because they changed meanwhile` : ''}.`);
  return summary;
}

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('Set DATABASE_URL');
  const summary = await run({ argv: process.argv.slice(2), query: neonQuery(url), host: new URL(url).hostname });
  // 2: a song needs a person (SKIP), or a row was left alone, so "nothing left to do" is not what this run found
  if (summary.skipped > 0 || summary.changedMeanwhile > 0) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
