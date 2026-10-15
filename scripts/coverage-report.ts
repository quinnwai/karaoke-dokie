// Writes a coverage report (CSV) for one signed-in person's library: every song, its range source,
// whether it fits their saved vocal range, its rank in the app, and why songs lack a note file.
// Read-only: nothing is written to the database. Estimates are worked out fresh from today's data,
// so the report shows what a new user would see.
// Usage: npm run report:coverage -- [spotifyUserId] [--out report.csv]   (needs DATABASE_URL and Spotify keys)

import { writeFile } from 'node:fs/promises';
import type { SongRange } from '../src/lib/contracts';
import { coverageCsv, coverageReport } from '../src/lib/report/coverage';
import { readConfig } from '../src/lib/server/config';
import { getStore } from '../src/lib/server/getStore';
import { createSpotifyClient, ensureFreshTokens, getUserTracks } from '../src/lib/server/spotify';
import { noteFileSource, realResolver } from '../src/lib/server/wiring';
import { songKey } from '../src/lib/songs/resolve';

async function main() {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const out = outAt >= 0 ? args[outAt + 1]! : 'coverage-report.csv';
  const store = getStore();
  const userId = args.find((a, i) => !a.startsWith('--') && i !== outAt + 1) ?? (await store.listUserIds())[0];
  if (!userId) throw new Error('No signed-in users yet');
  const user = await store.getUser(userId);
  if (!user) throw new Error(`No user ${userId}`);
  const userRange = await store.getRange(userId);
  if (!userRange) throw new Error(`${user.displayName} has not recorded a vocal range yet`);

  const spotify = createSpotifyClient(readConfig().spotify);
  const fresh = await ensureFreshTokens(user, spotify, store);
  const tracks = await getUserTracks(spotify, fresh.spotify.accessToken);
  const keys = tracks.map((t) => songKey(t.artist, t.title));
  const cached = await store.getSongRanges(keys);
  const resolve = realResolver(store, noteFileSource);
  const ranges = new Map<string, SongRange | null>();
  for (const t of tracks) {
    const key = songKey(t.artist, t.title);
    if (ranges.has(key)) continue;
    const rec = cached.get(key);
    ranges.set(key, rec?.range?.source === 'note-file' ? rec.range : (await resolve(t)).range);
  }

  const { rows, summary } = coverageReport({ tracks, ranges, index: await store.listUsdbSongs(), userRange });
  await writeFile(out, coverageCsv(rows));
  console.log(`${user.displayName}: ${JSON.stringify(summary)}`);
  console.log(`Wrote ${rows.length} songs to ${out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
