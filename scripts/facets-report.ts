// Prints how one signed-in person's matches spread over the results screen's filters (QWW-5):
// songs per decade, per label, with and without known popularity, and duets, for the main list and
// for Maybe. The library goes through the app's own whole-list recommend, so the same songs are in
// and out as in the app (dub, instrumental and karaoke versions left out).
// Read-only: the schema is not migrated, and lookups the app would cache are kept for this run
// only. The one write is an expired Spotify sign-in, refreshed and saved as the app does, since
// Spotify can replace the old one.
// Usage: npm run report:facets -- [spotifyUserId] [--live | --snapshot library.json]   (needs DATABASE_URL)
// Without --live no real Spotify is read: a snapshot (or SPOTIFY_SNAPSHOT) or the offline mock. --live needs the Spotify keys and
// spends the shared quota; it also writes the stored library and the call counts.

import { facetReport, facetTable } from '../src/lib/report/facets';
import { readOnlyStore } from '../src/lib/report/readOnlyStore';
import { getStore, neonQuery, pickStoreKind } from '../src/lib/server/getStore';
import { createPostgresStore } from '../src/lib/server/postgresStore';
import { createSongService } from '../src/lib/server/songService';
import { isLive, readScriptLibrary } from '../src/lib/server/scriptLibrary';
import { productionSongDeps } from '../src/lib/server/wiring';

async function main() {
  // Not the app's getStore() for Postgres: that one migrates the schema on first use.
  const store = pickStoreKind() === 'postgres' ? createPostgresStore(neonQuery(process.env.DATABASE_URL!.trim()), { autoMigrate: false }) : getStore();
  const reader = readOnlyStore(store);
  const args = process.argv.slice(2);
  const userId = args.find((a, i) => !a.startsWith('--') && !['--snapshot', '--save-snapshot'].includes(args[i - 1] ?? '')) ?? (await reader.listUserIds())[0];
  if (!userId) throw new Error('No signed-in users yet');
  const user = await reader.getUser(userId);
  if (!user) throw new Error(`No user ${userId}`);
  const userRange = await reader.getRange(userId);
  if (!userRange) throw new Error(`${user.displayName} has not recorded a vocal range yet`);

  // No real Spotify unless --live (a snapshot or the offline mock otherwise). Only --live writes: the stored library and the call counts.
  const { tracks } = await readScriptLibrary(user, { script: 'facets-report', argv: args, env: process.env, store: isLive(args) ? store : reader });
  // Enough lookups for the whole library, so every song is counted.
  const songs = createSongService(reader, productionSongDeps(reader, process.env.SPOTIFY_MOCK === '1'), { maxResolvesPerRequest: tracks.length });
  const res = await songs.recommend(tracks, userRange, 0, 0, { all: true });
  const report = facetReport(res.matches);

  console.log(`${user.displayName}: ${tracks.length} songs in the library, ${report.main.songs} in the main list, ${report.maybe.songs} under Maybe.`);
  if (!res.complete) console.log(`Only the first ${res.matches.length} matches are counted; the whole-list response stops there.`);
  process.stdout.write(facetTable(report));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
