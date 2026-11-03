// Prints how one signed-in person's matches spread over the results screen's filters (QWW-5):
// songs per decade, per label, with and without known popularity, and duets, for the main list and
// for Maybe. The library goes through the app's own whole-list recommend, so the same songs are in
// and out as in the app (dub, instrumental and karaoke versions left out).
// Read-only: lookups the app would cache are kept for this run only. A Spotify token that has
// expired is refreshed and saved, as the app does.
// Usage: npm run report:facets -- [spotifyUserId]   (needs DATABASE_URL and Spotify keys)

import { facetReport, facetTable } from '../src/lib/report/facets';
import { readConfig } from '../src/lib/server/config';
import { getStore } from '../src/lib/server/getStore';
import { createMockSpotifyClient } from '../src/lib/server/mockSpotify';
import { createSongService } from '../src/lib/server/songService';
import { createSpotifyClient, ensureFreshTokens, getUserTracks } from '../src/lib/server/spotify';
import type { Store } from '../src/lib/server/store';
import { productionSongDeps } from '../src/lib/server/wiring';

/** The store with every write dropped, so the report leaves the database as it found it. */
function readOnly(store: Store): Store {
  const skip = async () => {};
  return {
    ...store,
    upsertUser: skip,
    saveRange: skip,
    putSongRange: skip,
    putUsdbSongs: skip,
    appendLog: skip,
    saveFeedback: skip,
    appendEvents: skip,
    putSongMoods: skip,
  };
}

async function main() {
  const store = getStore();
  const userId = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? (await store.listUserIds())[0];
  if (!userId) throw new Error('No signed-in users yet');
  const user = await store.getUser(userId);
  if (!user) throw new Error(`No user ${userId}`);
  const userRange = await store.getRange(userId);
  if (!userRange) throw new Error(`${user.displayName} has not recorded a vocal range yet`);

  // The app's own wiring, so SPOTIFY_MOCK=1 runs it offline against the mock library.
  const config = readConfig();
  const spotify = config.spotifyMock ? createMockSpotifyClient() : createSpotifyClient(config.spotify);
  const fresh = await ensureFreshTokens(user, spotify, store);
  const tracks = await getUserTracks(spotify, fresh.spotify.accessToken);
  const reader = readOnly(store);
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
