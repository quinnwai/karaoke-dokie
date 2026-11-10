// Fills song ranges for signed-in users' libraries from USDB note files.
// Usage: npm run usdb:sync [-- [--rescan] [--rescan-duets] <spotifyUserId>]   (default: every user in the database)
// --rescan re-downloads note files for songs synced before pitch histograms existed (~25 s each).
// --rescan-duets re-downloads songs stored before duets had each singer's part, only those USDB
// lists as a duet (title or edition says "duet"), taking the duet upload when USDB also has a solo one.
// Without --live it reads no real Spotify: --snapshot <file> (or SPOTIFY_SNAPSHOT) or the offline mock. --live reads the
// stored library and brings it up to date from Spotify (--save-snapshot <file> also writes it out); it spends the shared quota.
// Needs DATABASE_URL, for --live SPOTIFY_CLIENT_ID/SECRET/REDIRECT_URI, USDB_USERNAME, USDB_PASSWORD.
// Run from a machine that can reach usdb.animux.de. Requests are spaced 2.5 s apart.

import { getStore } from '../src/lib/server/getStore';
import { readScriptLibrary } from '../src/lib/server/scriptLibrary';
import { createUsdbClient } from '../src/lib/usdb/client';
import { syncNoteFiles } from '../src/lib/usdb/sync';

async function main() {
  const username = process.env.USDB_USERNAME;
  const password = process.env.USDB_PASSWORD;
  if (!username || !password) throw new Error('Set USDB_USERNAME and USDB_PASSWORD');
  const store = getStore();
  const usdb = createUsdbClient({ username, password });
  const args = process.argv.slice(2);
  const rescan = args.includes('--rescan');
  const rescanDuets = args.includes('--rescan-duets');
  const userArg = args.find((a, i) => !a.startsWith('--') && !['--snapshot', '--save-snapshot'].includes(args[i - 1] ?? ''));
  const ids = userArg ? [userArg] : await store.listUserIds();
  if (!ids.length) console.log('No signed-in users yet. Sign in on the site first.');

  for (const id of ids) {
    const user = await store.getUser(id);
    if (!user) {
      console.log(`No user ${id}`);
      continue;
    }
    const { tracks, source } = await readScriptLibrary(user, { script: 'usdb-sync', argv: args, env: process.env, store });
    console.log(`${user.displayName}: ${tracks.length} songs (${source})`);
    const summary = await syncNoteFiles({ store, usdb, tracks, rescan, rescanDuets, onProgress: (l) => console.log(`  ${l}`) });
    console.log(JSON.stringify(summary));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
