// Lists the rows the octave fix moved because of their own recording (octaveFrom 'recording'), against a copy of
// song_ranges taken before the fix ran (QWW-62). Five such moves were flagged as wrong (at least two of them upward) and
// three were confirmed wrong against published ranges; the fix's own measurement says note files are nearly always too high,
// so a move up is the unusual one. This is the list to read.
//
// Read-only: it runs SELECTs and nothing else. Every row is shown as written and as moved, with the typical note of the
// song's recording and of the artist's other recordings (data/octave-evidence.json). A row is marked AWAY when the move left
// its typical note more than 4 semitones from the artist's and further than it was as written: a triage mark, not a verdict,
// and it says nothing about a song whose artist has no evidence. All marked rows are listed, then the most viewed of the
// others, up to --limit lines.
// Usage: npm run octave:moves -- --backup song_ranges_bak_qww53 [--direction up|down|both] [--limit 100]
// Needs DATABASE_URL. Run it from the repository root (it reads data/octave-evidence.json from there).

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { midiToNoteName } from '../src/lib/audio/notes';
import { checkBackupTable, movedBy, movedRow, notes, readRecordingMoves, type MovedRow } from '../src/lib/report/octaveRestore';
import type { QueryFn } from '../src/lib/server/postgresStore';
import { neonQuery } from '../src/lib/server/getStore';
import { ARTIST_MAX_DISTANCE } from '../src/lib/songs/octave';
import { loadOctaveEvidence } from '../src/lib/songs/octaveFiles';

export interface RunOptions {
  argv: string[];
  query: QueryFn;
  host: string;
  log?: (line: string) => void;
  /** Paths of the evidence files, for tests; the real ones by default. */
  paths?: { evidence?: string; hand?: string };
}

const note = (typical: number | undefined) => (typical === undefined ? 'none' : `${midiToNoteName(Math.round(typical))} (${typical.toFixed(1)})`);

export async function run(opts: RunOptions): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const { values } = parseArgs({ args: opts.argv, options: { backup: { type: 'string' }, direction: { type: 'string' }, limit: { type: 'string' } } });
  const table = checkBackupTable(values.backup);
  const direction = values.direction ?? 'up';
  if (!['up', 'down', 'both'].includes(direction)) throw new Error(`--direction takes up, down or both, not "${direction}"`);
  if (values.limit !== undefined && !/^\d+$/.test(values.limit)) throw new Error(`--limit takes a whole number, not "${values.limit}"`);
  const limit = Number(values.limit ?? 100);
  const [who] = await opts.query('SELECT current_database() AS db', []);
  log(`Database ${String(who?.db)} on ${opts.host} (read only), against ${table}`);

  const evidence = loadOctaveEvidence(opts.paths);
  const moved: MovedRow[] = [];
  const cannotCompare: string[] = [];
  for (let after = ''; ; ) {
    const page = await readRecordingMoves(opts.query, table, after, 1000);
    for (const r of page.rows) {
      const move = movedBy(r.current, r.backup);
      if ('reason' in move) cannotCompare.push(r.key);
      else moved.push(movedRow(r.key, r.current, r.backup, move.semitones, evidence));
    }
    if (page.last === null) break;
    after = page.last;
  }

  const up = moved.filter((m) => m.semitones > 0);
  const listed = moved.filter((m) => (direction === 'both' ? true : direction === 'up' ? m.semitones > 0 : m.semitones < 0));
  const away = listed.filter((m) => m.awayFromArtist);
  const views = (m: MovedRow) => m.now.usdbViews ?? 0;
  const byViews = (a: MovedRow, b: MovedRow) => views(b) - views(a) || (a.key < b.key ? -1 : 1);
  const rest = listed.filter((m) => !m.awayFromArtist).sort(byViews).slice(0, limit);
  log(`${moved.length} rows were moved by their own recording (${up.length} up, ${moved.length - up.length} down); ${cannotCompare.length} more cannot be compared with the backup (it was itself moved before the backup was taken, or another step changed the row since) and are not listed.`);
  log(`Listing ${direction === 'both' ? 'all moves' : `the moves ${direction}`}: ${listed.length}, of which ${away.length} are marked AWAY (typical note more than ${ARTIST_MAX_DISTANCE} semitones from the artist's, and further than as written).`);
  log('');
  for (const m of [...away.sort(byViews), ...rest]) {
    log(
      `${m.awayFromArtist ? 'AWAY ' : '     '} ${m.key}: ${notes(m.asWritten)} (${m.asWritten.low}-${m.asWritten.high}) -> ${notes(m.now)} (${m.now.low}-${m.now.high}), ${m.semitones > 0 ? '+' : ''}${m.semitones}; recording ${note(m.recording)}, artist ${note(m.artist)}; USDB views ${m.now.usdbViews ?? 'unknown'}`,
    );
  }
  if (listed.length > away.length + rest.length) log(`\n(${listed.length - away.length - rest.length} more not listed: raise --limit.)`);
}

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('Set DATABASE_URL');
  await run({ argv: process.argv.slice(2), query: neonQuery(url), host: new URL(url).hostname });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
