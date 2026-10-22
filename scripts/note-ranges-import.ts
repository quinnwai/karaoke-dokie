// Imports a ranges file into the database: one made by note-ranges-build.ts, or the vocal-range
// pipeline's export of measured recordings (karaoke_ranges.json).
// Usage: npx tsx scripts/note-ranges-import.ts ranges.json [--recheck-fast]   (needs DATABASE_URL)
// A row replaces a lower-ranked source or the same source from another export; note files are
// never replaced (src/lib/songs/sourceRank.ts). With --recheck-fast, note-file songs imported
// earlier from the same collection get their fast-lyrics flag corrected.

import { readFile } from 'node:fs/promises';
import { getStore } from '../src/lib/server/getStore';
import { importBulkRanges, type BulkRange } from '../src/lib/notes/bulkImport';

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: note-ranges-import.ts ranges.json');
  const { ranges } = JSON.parse(await readFile(path, 'utf8')) as { ranges: BulkRange[] };
  const summary = await importBulkRanges(getStore(), ranges, {
    onProgress: (done) => console.log(`${done} / ${ranges.length}`),
    recheckFast: process.argv.includes('--recheck-fast'),
  });
  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
