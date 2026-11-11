// Builds the one-song-one-row mapping (QWW-49): for every measured song, which row the list shows for
// it and the clean title and artist line to show, in song_canonical. Rules: songs/title.ts (tags
// off the title) and songs/canonical.ts (which rows are one song, which is the main version). Offline,
// never at request time: the app reads the table when the catalogue loads, and shows the titles as
// stored for a song with no usable row, so the table may be empty or half written.
//
// A dry run by default: reads the database, writes nothing (not even the empty table), prints what a
// run would change and the numbers to check. --apply writes, and only to the database named by
// --confirm-database, so a connection string pointing at another database fails instead of writing.
// A database named neondb is production, which is read-only until its data step: writing it also
// needs --production. (A Neon branch of production keeps that name, so check the host printed first.)
// Resumable: a run writes only the rows that are missing or differ, so after a stop, run it again.
// Usage: npm run titles:build [-- --samples 25] [--lists titles-before-after.md]
//        npm run titles:build -- --apply --confirm-database <name> [--production]
// Needs DATABASE_URL. --lists also builds the logged-out list for the release eval harness's five test ranges
// once as it is and once with the mapping applied, and writes both as Markdown.

import { realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { checkList, listsBeforeAfter, planCanonical, renderLists, sameRecord, summarizePlan, writePlan } from '../src/lib/report/titles';
import { readOnlyStore } from '../src/lib/report/readOnlyStore';
import { neonQuery } from '../src/lib/server/getStore';
import { createPostgresStore, schemaStatements, type QueryFn } from '../src/lib/server/postgresStore';
import type { SongCanonical, Store } from '../src/lib/server/store';
import { productionSongDeps } from '../src/lib/server/wiring';

/** Database names that are production: writing one needs --production too. */
export const PRODUCTION_DATABASES = ['neondb'];

export interface RunOptions {
  argv: string[];
  query: QueryFn;
  /** The database host, printed so the person running it can see which server this is. */
  host: string;
  log?: (line: string) => void;
  writeFile?: (path: string, text: string) => void;
}

/** The stored mapping, or null when the table does not exist (a dry run does not create it). */
async function readStored(store: Pick<Store, 'listSongCanonical'>): Promise<Map<string, SongCanonical> | null> {
  try {
    return await store.listSongCanonical();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/song_canonical/.test(message) && /does not exist|no such table/i.test(message)) return null;
    throw err;
  }
}

export async function run(opts: RunOptions): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const { values } = parseArgs({
    args: opts.argv,
    options: {
      apply: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      production: { type: 'boolean' },
      'confirm-database': { type: 'string' },
      lists: { type: 'string' },
      samples: { type: 'string' },
    },
  });
  if (values.apply && values['dry-run']) throw new Error('Pass --apply or --dry-run, not both');
  const [who] = await opts.query('SELECT current_database() AS db', []);
  const database = String(who?.db);
  log(`Database ${database} on ${opts.host}${values.apply ? '' : ' (dry run: nothing is written)'}`);

  // Nothing here can write: the planning and the lists go through a store that drops writes, and the store
  // does not migrate on open, so a dry run does not even create the table.
  const store = createPostgresStore(opts.query, { autoMigrate: false });
  const reader = readOnlyStore(store);
  const stored = await readStored(reader);
  const inputs = await reader.listCanonicalInputs();
  if (inputs.length === 0) throw new Error('No measured songs in this database; nothing to build');
  const plan = planCanonical(inputs, stored ?? new Map());
  log(`${stored ? `${stored.size} rows stored` : 'song_canonical does not exist yet'}.\n`);
  log(summarizePlan(inputs, plan, values.samples ? Number(values.samples) : 25).join('\n'));

  if (values.lists) {
    const lists = await listsBeforeAfter(reader, plan.build.records, productionSongDeps(reader, false));
    (opts.writeFile ?? writeFileSync)(values.lists, renderLists(lists));
    log(`\nLists for ${lists.length} ranges written to ${values.lists}.`);
    for (const l of lists) {
      const [b, a] = [checkList(l.before, 50), checkList(l.after, 50)];
      log(`  ${l.label.padEnd(28)} top 50 before: ${b.tagged.length} tagged, ${b.duplicates.length} duplicate groups; after: ${a.tagged.length} tagged, ${a.duplicates.length} duplicate groups, ${a.near.length} near-duplicates`);
    }
  }

  if (!values.apply) {
    log(`\nDry run. To write ${plan.changed.length} rows: npm run titles:build -- --apply --confirm-database ${database}${PRODUCTION_DATABASES.includes(database) ? ' --production' : ''}`);
    return;
  }
  if (values['confirm-database'] !== database) {
    throw new Error(`--confirm-database must name the database being written (${database}); got ${values['confirm-database'] ?? 'nothing'}. Nothing was written.`);
  }
  if (PRODUCTION_DATABASES.includes(database) && !values.production) {
    throw new Error(`${database} is production, which is read-only until its data step. Pass --production to write it. Nothing was written.`);
  }
  // Create the table only when the read above found it missing, and only this table's statements (CREATE ... IF NOT EXISTS, additive):
  // the rest of the schema is the app's own migration to run.
  if (stored === null) for (const stmt of schemaStatements()) if (stmt.includes('song_canonical')) await opts.query(stmt);
  await writePlan(store, plan, { onBatch: (done, total) => (done === total || done % 5000 === 0) && log(`  wrote ${done}/${total}`) });
  // Read it back: every record of the plan is stored, equal.
  const after = await store.listSongCanonical();
  const missing = plan.build.records.filter((r) => !sameRecord(r, after.get(r.key)));
  if (missing.length) throw new Error(`${missing.length} rows did not read back equal (first: ${missing[0]!.key}); run again`);
  log(`Done. ${plan.build.records.length} rows in song_canonical, read back and equal.`);
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
