// Writes mood labels from moods:label into the database (QWW-11). Songs the model knew get one row
// each (possibly with no moods); songs it did not know get none. A row replaces the song's earlier
// row, whatever its method. Which moods are shown is up to the gate, not the import.
// Usage: npm run moods:import -- labels.json   (needs DATABASE_URL)

import { readFile } from 'node:fs/promises';
import { getStore, pickStoreKind } from '../src/lib/server/getStore';
import { parseLabelRun, toMoodRecords } from '../src/lib/moods/label';

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: npm run moods:import -- labels.json');
  const run = parseLabelRun(await readFile(path, 'utf8'));
  const records = toMoodRecords(run.labels, run.model);
  if (pickStoreKind() === 'memory') console.error('No DATABASE_URL: writing to an in-memory store, which is thrown away.');
  const store = getStore();
  for (let i = 0; i < records.length; i += 500) {
    await store.putSongMoods(records.slice(i, i + 500));
    console.log(`${Math.min(i + 500, records.length)} / ${records.length}`);
  }
  console.log(JSON.stringify({ method: run.method, labels: run.labels.length, stored: records.length, unknown: run.labels.length - records.length }));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
