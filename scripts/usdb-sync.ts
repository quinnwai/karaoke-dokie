// Fills song ranges for signed-in users' libraries from USDB note files.
// Usage: npm run usdb:sync [-- <spotifyUserId>]   (default: every user in the database)
// Needs DATABASE_URL, SPOTIFY_CLIENT_ID/SECRET/REDIRECT_URI, USDB_USERNAME, USDB_PASSWORD.
// Run from a machine that can reach usdb.animux.de. Requests are spaced 2.5 s apart.

import { getStore } from '../src/lib/server/getStore';
import { readConfig } from '../src/lib/server/config';
import { createSpotifyClient, ensureFreshTokens, getUserTracks } from '../src/lib/server/spotify';
import { createUsdbClient } from '../src/lib/usdb/client';
import { syncNoteFiles } from '../src/lib/usdb/sync';

async function main() {
  const username = process.env.USDB_USERNAME;
  const password = process.env.USDB_PASSWORD;
  if (!username || !password) throw new Error('Set USDB_USERNAME and USDB_PASSWORD');
  const store = getStore();
  const config = readConfig();
  const spotify = createSpotifyClient(config.spotify);
  const usdb = createUsdbClient({ username, password });
  const ids = process.argv[2] ? [process.argv[2]] : await store.listUserIds();
  if (!ids.length) console.log('No signed-in users yet. Sign in on the site first.');

  for (const id of ids) {
    const user = await store.getUser(id);
    if (!user) {
      console.log(`No user ${id}`);
      continue;
    }
    const fresh = await ensureFreshTokens(user, spotify, store);
    const tracks = await getUserTracks(spotify, fresh.spotify.accessToken);
    console.log(`${user.displayName}: ${tracks.length} songs`);
    const summary = await syncNoteFiles({ store, usdb, tracks, onProgress: (l) => console.log(`  ${l}`) });
    console.log(JSON.stringify(summary));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
