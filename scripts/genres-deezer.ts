// Fills song_genre (QWW-61): Deezer's genres for every song with a Deezer track (song_deezer.deezer_id, from
// npm run popularity:deezer), read from the track's album (how, in src/lib/genres/deezer.ts). A song shows them only when
// USDB lists no genre for it, so those songs go first, then the most popular. A song whose genres were read is never looked
// up again; a miss (the track or album is gone, or the album lists no genre) is asked again after RECHECK_DAYS. Stops
// cleanly after --max-minutes and after 20 failures in a row (Deezer is refusing us); rerun to carry on.
// --dry-run only reads (no migration, no Deezer, no writes): it counts what a run would look up, and prints the genre
// coverage now and the most a full run could reach, for measured songs and for the logged-out lists of the release
// harness's nine ranges.
// Usage: npm run genres:deezer [-- --max-minutes 9] [--limit N] [--dry-run]
// Needs DATABASE_URL. Rollback: DELETE FROM song_genre; (every song then shows USDB's genre only, as before).

import { parseArgs } from 'node:util';
import type { Match } from '../src/lib/contracts';
import { TEST_RANGES, tunerDefaultList } from '../src/lib/eval/release';
import { createGenreClient, runGenreFetch } from '../src/lib/genres/deezer';
import { readSongGenres, shownGenre } from '../src/lib/genres/genres';
import { readOnlyStore } from '../src/lib/report/readOnlyStore';
import { catalogueKey, catalogueTracks, loadCatalogue, prepareCatalogue } from '../src/lib/server/catalogue';
import { neonQuery } from '../src/lib/server/getStore';
import { createPostgresStore } from '../src/lib/server/postgresStore';
import type { Store } from '../src/lib/server/store';
import { productionSongDeps } from '../src/lib/server/wiring';
import { SETLIST_PAGE } from '../src/lib/songs/setlistConfig';

const pct = (n: number, of: number) => (of ? `${((100 * n) / of).toFixed(1)}%` : '-');

/**
 * The share of songs with a genre now, and the most a full run could reach (every due song given one, though an album
 * that lists no genre gives none): for every measured song, and for what the Setlist tuner shows a logged-out singer who
 * has not touched it on each of the release harness's nine ranges, its first page and the whole list.
 */
async function printCoverage(store: Store, due: Set<string>) {
  const measured = (await store.listCanonicalInputs()).map((i) => i.key);
  const [usdb, deezer] = await Promise.all([store.findUsdbSongs(measured), readSongGenres(store, measured)]);
  const hasNow = (key: string) => shownGenre(usdb.get(key)?.genre, deezer.get(key)) !== undefined;
  const now = measured.filter(hasNow).length;
  const upTo = measured.filter((key) => hasNow(key) || due.has(key)).length;
  console.log(`Measured songs with a genre: ${pct(now, measured.length)} now, up to ${pct(upTo, measured.length)} (of ${measured.length})`);

  const tracks = catalogueTracks(await loadCatalogue(store, undefined, { canonical: true }));
  const deps = productionSongDeps(store, false);
  const share = (ms: Match[], has: (m: Match) => boolean) => pct(ms.filter(has).length, ms.length);
  const shown = (m: Match) => m.genre !== undefined;
  const could = (m: Match) => shown(m) || due.has(catalogueKey(m.track.id) ?? '');
  console.log('Logged-out lists (Setlist tuner at its defaults) with a genre, now -> up to:');
  for (const t of TEST_RANGES) {
    const list = tunerDefaultList(prepareCatalogue(tracks, t.range, deps).prepared);
    const page = list.slice(0, SETLIST_PAGE.default);
    console.log(`  ${t.label}: first ${page.length} ${share(page, shown)} -> ${share(page, could)}; all ${list.length} ${share(list, shown)} -> ${share(list, could)}`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'max-minutes': { type: 'string' },
      limit: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
  });
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('Set DATABASE_URL');
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) throw new Error(`--limit takes a whole number (got ${values.limit})`);
  const minutes = values['max-minutes'] === undefined ? undefined : Number(values['max-minutes']);
  if (minutes !== undefined && !(minutes > 0)) throw new Error(`--max-minutes takes a number of minutes (got ${values['max-minutes']})`);
  const dryRun = values['dry-run'] === true;
  // A dry run only reads: no migration (it would create song_genre), and any write is dropped.
  const store = dryRun
    ? readOnlyStore(createPostgresStore(neonQuery(url), { autoMigrate: false }))
    : createPostgresStore(neonQuery(url)); // migrates: creates song_genre
  const deadline = minutes === undefined ? undefined : Date.now() + minutes * 60_000;
  const result = await runGenreFetch(store, createGenreClient(), { dryRun, limit, deadline });
  if (dryRun) await printCoverage(store, new Set(result.due.map((s) => s.key)));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
