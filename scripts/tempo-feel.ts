// Imports the feel labels (data/tempo-feel.json, QWW-54) into song_feel, and lists the catalogue songs that still
// have none. The labels are made offline (data/tempo-feel.md) and kept in the repo, so this needs no model and no key.
// A dry run unless --apply: it reads, says what it would write and what that does to the Tempo gear, and writes
// nothing. It can be stopped and run again: --apply writes only the rows that are missing or different, so a rerun
// does the rest, and a run that has nothing left to do writes nothing.
//
// Usage: npm run tempo:feel [-- --file data/tempo-feel.json] [--apply] [--production --confirm-database <name>]
//                          [--unlabeled out.json [--top 3000 | --served] [--feel mid]]
//   --apply            write the rows. Only to karaoke_pr4_preview, unless --production is given together with
//                      --confirm-database <the database's own name> (neondb); it refuses either flag alone.
//   --unlabeled FILE   write the catalogue songs that have no label (in the file or in song_feel) to FILE, as
//                      [{ id: songKey, artist, title, year }], for the labellers: the first --top of the catalogue in its
//                      order (most popular first), or with --served every song a logged-out singer is shown in any of the
//                      release harness' five test ranges or in F2 to C5 and E2 to E5 (the best 1,000 of each), which are the
//                      only songs that can reach the top 20 at an end of the Tempo gear there. With --feel mid (or slow, upbeat)
//                      it lists the songs that already carry that label instead, for a second look.
// Needs DATABASE_URL. Reads with SELECT only; --apply creates song_feel if missing and writes its rows, nothing else.

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { VocalRange } from '../src/lib/contracts';
import { catalogueTracks, loadCatalogue, recommendCatalogue } from '../src/lib/server/catalogue';
import { neonQuery } from '../src/lib/server/getStore';
import { createPostgresStore, schemaStatements } from '../src/lib/server/postgresStore';
import { isMissingTable } from '../src/lib/server/songFeel';
import type { SongFeelRecord } from '../src/lib/server/store';
import { productionSongDeps } from '../src/lib/server/wiring';
import { isFeel } from '../src/lib/tempo/feel';
import { parseFeelFile } from '../src/lib/tempo/feelFile';
import { planFeelImport, SCRATCH_DB, writeRefusal } from '../src/lib/tempo/feelImport';

const WRITE_BATCH = 500;
/** The release harness' five test ranges (QWW-52, MIDI notes) and E2 to E5: where the two ends of the Tempo gear are checked. */
const SERVED_RANGES: [number, number][] = [[41, 72], [48, 72], [53, 77], [57, 81], [55, 69], [40, 76]];
const pct = (n: number, d: number) => `${n}/${d} (${d ? ((100 * n) / d).toFixed(1) : '0'}%)`;

async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: 'string', default: 'data/tempo-feel.json' },
      apply: { type: 'boolean' },
      production: { type: 'boolean' },
      'confirm-database': { type: 'string' },
      unlabeled: { type: 'string' },
      top: { type: 'string', default: '3000' },
      served: { type: 'boolean' },
      feel: { type: 'string' },
    },
  });
  // Arguments are checked before the database is touched.
  const top = Number(values.top);
  if (!Number.isInteger(top) || top < 1) throw new Error('--top must be a whole number, 1 or more');
  if (values.feel !== undefined && !isFeel(values.feel)) throw new Error('--feel must be slow, mid or upbeat');
  if ((values.feel !== undefined || values.served) && !values.unlabeled) throw new Error('--feel and --served go with --unlabeled <file>');
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('Set DATABASE_URL');
  const query = neonQuery(url);
  const db = String((await query('SELECT current_database() AS db'))[0]?.db);
  console.log(`Database: ${db}${values.apply ? ' (writing song_feel)' : ' (dry run: nothing is written)'}`);
  const refusal = values.apply ? writeRefusal(db, { production: values.production, confirmDatabase: values['confirm-database'] }) : null;
  if (refusal) throw new Error(refusal);

  const store = createPostgresStore(query, { autoMigrate: false }); // a dry run must not create anything
  // --apply creates only the table it writes (its statement in db/schema.sql); the rest of the app's migration is not this step's.
  if (values.apply) for (const stmt of schemaStatements().filter((x) => /CREATE TABLE IF NOT EXISTS song_feel\b/.test(x))) await query(stmt);

  const entries = await loadCatalogue(store); // most popular first
  const keys = entries.map((e) => e.key);
  const tempos = await store.getSongTempos(keys);
  const file = parseFeelFile(await readFile(values.file!, 'utf8'));
  const current: Map<string, SongFeelRecord> = await store.listSongFeels().catch((err) => {
    if (!isMissingTable(err)) throw err; // any other failure must not read as "nothing written yet"
    console.log('song_feel does not exist here yet: counting every row as new.');
    return new Map<string, SongFeelRecord>();
  });
  const { rows, unmatched, toWrite, added, effect, moves } = planFeelImport({ catalogue: entries, tempos, current, file });
  const count = (xs: SongFeelRecord[]) => (['slow', 'mid', 'upbeat'] as const).map((f) => `${f} ${xs.filter((r) => r.feel === f).length}`).join(', ');

  console.log(`\nCatalogue: ${keys.length} songs. Labels file ${values.file}: ${file.labels.length} labels by ${file.method}, ${pct(rows.length, keys.length)} of the catalogue labelled, ${unmatched} labels match no catalogue song.`);
  console.log(`song_feel now has ${current.size} rows. Rows to write: ${toWrite.length} (${added} new, ${toWrite.length - added} changed): ${count(toWrite)}.`);
  console.log(
    `\nOn the Tempo gear, for the labelled songs: ${effect.sameBand} stay in the band their measured tempo was in, ${effect.moved} move to another band, ${effect.noMeasured} had no tempo and get one from the label` +
      ` (${effect.fromLabelAlone} from the label alone). Moved by octave: ${effect.halved} halved, ${effect.doubled} doubled; ${effect.clamped} put at the edge of their band.`,
  );
  if (moves.length) console.log(`Songs moved to another band (catalogue position, then old and new tempo), first ${Math.min(25, moves.length)} of ${moves.length}:\n${moves.slice(0, 25).join('\n')}`);

  // Coverage by popularity, before and after: the songs people see first are the ones that matter.
  const after = new Set([...current.keys(), ...rows.map((r) => r.key)]);
  console.log('\nLabelled share of the most popular songs, now -> after this file:');
  for (const n of [300, 1000, 2000, 3000, keys.length]) {
    const top = keys.slice(0, n);
    console.log(`  top ${Math.min(n, keys.length)}: ${pct(top.filter((k) => current.has(k)).length, top.length)} -> ${pct(top.filter((k) => after.has(k)).length, top.length)}`);
  }

  if (values.unlabeled) {
    let wanted = entries.slice(0, top);
    if (values.served) {
      const tracks = catalogueTracks(entries);
      const deps = productionSongDeps(store, false);
      const served = new Set<string>();
      for (const [low, high] of SERVED_RANGES) {
        const range: VocalRange = { low, high, source: 'test' };
        for (const m of recommendCatalogue(tracks, range, deps, { all: true }).matches) served.add(m.track.id.replace(/^cat:/, ''));
      }
      wanted = entries.filter((e) => served.has(e.key));
      console.log(`\nServed in the ${SERVED_RANGES.length} ranges: ${served.size} songs, ${pct([...served].filter((k) => after.has(k)).length, served.size)} labelled (now or by this file).`);
    }
    const feelAfter = new Map([...current].map(([k, v]) => [k, v.feel] as const));
    for (const r of rows) feelAfter.set(r.key, r.feel);
    const todo = wanted
      .filter((e) => (values.feel ? feelAfter.get(e.key) === values.feel : !after.has(e.key)))
      .map((e) => ({ id: e.key, artist: e.artist, title: e.title, ...((e.usdb?.year ?? e.popularity?.chartYear) !== undefined ? { year: e.usdb?.year ?? e.popularity?.chartYear } : {}) }));
    await writeFile(values.unlabeled, JSON.stringify(todo));
    console.log(`\nWrote ${todo.length} of ${values.served ? 'the served' : `the top ${top}`} songs ${values.feel ? `labelled ${values.feel}` : 'with no label'} to ${values.unlabeled}.`);
  }

  if (!values.apply) {
    console.log(`\nDry run: nothing written. Add --apply to write ${toWrite.length} rows${db === SCRATCH_DB ? '' : ` (to ${db}, with --production --confirm-database ${db})`}.`);
    return;
  }
  for (let i = 0; i < toWrite.length; i += WRITE_BATCH) {
    await store.putSongFeel(toWrite.slice(i, i + WRITE_BATCH));
    console.log(`written ${Math.min(i + WRITE_BATCH, toWrite.length)} / ${toWrite.length}`);
  }
  console.log(`Done: ${toWrite.length} rows written to ${db}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
