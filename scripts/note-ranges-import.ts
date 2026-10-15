// Imports a ranges file made by note-ranges-build.ts into the database.
// Usage: npx tsx scripts/note-ranges-import.ts ranges.json   (needs DATABASE_URL)
// Songs that already have a note-file range are left alone.

import { readFile } from 'node:fs/promises';
import { getStore } from '../src/lib/server/getStore';
import { importBulkRanges, type BulkRange } from '../src/lib/notes/bulkImport';

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: note-ranges-import.ts ranges.json');
  const { ranges } = JSON.parse(await readFile(path, 'utf8')) as { ranges: BulkRange[] };
  const summary = await importBulkRanges(getStore(), ranges, {
    onProgress: (done) => console.log(`${done} / ${ranges.length}`),
  });
  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
