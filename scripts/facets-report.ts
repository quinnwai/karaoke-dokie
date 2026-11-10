// Prints how one signed-in person's matches spread over the results screen's filters (QWW-5):
// songs per decade, per label, with and without known popularity, and duets, for the main list and
// for Maybe. The library goes through the app's own whole-list recommend, so the same songs are in
// and out as in the app (dub, instrumental and karaoke versions left out).
// Read-only: the schema is not migrated, and lookups the app would cache are kept for this run
// only. The one write is an expired Spotify sign-in, refreshed and saved as the app does, since
// Spotify can replace the old one.
// Usage: npm run report:facets -- [spotifyUserId]   (needs DATABASE_URL and Spotify keys)

import { facetReport, facetTable } from '../src/lib/report/facets';
import { readOnlyStore } from '../src/lib/report/readOnlyStore';
import { readConfig } from '../src/lib/server/config';
import { getStore, neonQuery, pickStoreKind } from '../src/lib/server/getStore';
import { createMockSpotifyClient } from '../src/lib/server/mockSpotify';
import { createPostgresStore } from '../src/lib/server/postgresStore';
import { createSongService } from '../src/lib/server/songService';
import { createSpotifyClient, readUserTracks } from '../src/lib/server/spotify';
import { productionSongDeps } from '../src/lib/server/wiring';

async function main() {
  // Not the app's getStore() for Postgres: that one migrates the schema on first use.
  const store = pickStoreKind() === 'postgres' ? createPostgresStore(neonQuery(process.env.DATABASE_URL!.trim()), { autoMigrate: false }) : getStore();
  const reader = readOnlyStore(store);
  const userId = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? (await reader.listUserIds())[0];
  if (!userId) throw new Error('No signed-in users yet');
  const user = await reader.getUser(userId);
  if (!user) throw new Error(`No user ${userId}`);
  const userRange = await reader.getRange(userId);
  if (!userRange) throw new Error(`${user.displayName} has not recorded a vocal range yet`);

  // The app's own wiring, so SPOTIFY_MOCK=1 runs it offline against the mock library. The mock's
  // made-up tokens must never replace a real user's, so with the mock nothing is saved.
  const config = readConfig();
  const spotify = config.spotifyMock ? createMockSpotifyClient() : createSpotifyClient(config.spotify);
  const tracks = await readUserTracks(config.spotifyMock ? reader : store, spotify, user);
  // Enough lookups for the whole library, so every song is counted.
  const songs = createSongService(reader, productionSongDeps(reader, config.spotifyMock), { maxResolvesPerRequest: tracks.length });
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
