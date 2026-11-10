// Writes a coverage report (CSV) for one signed-in person's library: every song, its range source,
// whether it fits their saved vocal range, its rank in the app, and why songs lack a note file.
// Read-only: nothing is written to the database. Estimates are worked out fresh from today's data,
// so the report shows what a new user would see.
// Usage: npm run report:coverage -- [spotifyUserId] [--out report.csv] [--live | --snapshot library.json]   (needs DATABASE_URL)
// Without --live no real Spotify is read: a snapshot (or SPOTIFY_SNAPSHOT) or the offline mock. --live needs the Spotify keys and
// spends the shared quota; --save-snapshot <file> with it writes the library out for later runs.

import { writeFile } from 'node:fs/promises';
import type { SongRange } from '../src/lib/contracts';
import { coverageCsv, coverageReport } from '../src/lib/report/coverage';
import { getStore } from '../src/lib/server/getStore';
import { readScriptLibrary } from '../src/lib/server/scriptLibrary';
import { noteFileSource, realResolver } from '../src/lib/server/wiring';
import { songKey } from '../src/lib/songs/resolve';

async function main() {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const out = outAt >= 0 ? args[outAt + 1]! : 'coverage-report.csv';
  const store = getStore();
  const userId = args.find((a, i) => !a.startsWith('--') && i !== outAt + 1 && !['--snapshot', '--save-snapshot'].includes(args[i - 1] ?? '')) ?? (await store.listUserIds())[0];
  if (!userId) throw new Error('No signed-in users yet');
  const user = await store.getUser(userId);
  if (!user) throw new Error(`No user ${userId}`);
  const userRange = await store.getRange(userId);
  if (!userRange) throw new Error(`${user.displayName} has not recorded a vocal range yet`);

  const { tracks } = await readScriptLibrary(user, { script: 'coverage-report', argv: args, env: process.env, store });
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
