// Imports song popularity from our own karaoke data (QWW-6) into song_popularity: KaraFun
// karaoke-video views and Billboard Year-End Hot 100 ranks, merged per song key
// (src/lib/popularity/import.ts). Both files are needed, since a row replaces the song's whole
// earlier row: a run with one file would drop the other's numbers. Prints how many keys there are,
// how many have views and a chart entry, and the view percentiles (the 99th calibrates
// KARAOKE_VIEWS_FULL in src/lib/songs/score.ts).
// Usage: npm run popularity:import -- --karafun karafun_songs.csv --billboard billboard_songs.csv [--dry-run]
// Writes to Postgres with DATABASE_URL, otherwise to an in-memory store that is thrown away;
// --dry-run reads and summarises the files without opening any store.

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { billboardCharts, karafunViews, mergePopularity, popularitySummary } from '../src/lib/popularity/import';
import { getStore, pickStoreKind } from '../src/lib/server/getStore';

const USAGE = 'Usage: npm run popularity:import -- --karafun karafun_songs.csv --billboard billboard_songs.csv [--dry-run]';
const BATCH = 500;

async function main() {
  const { values } = parseArgs({ options: { karafun: { type: 'string' }, billboard: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
  if (!values.karafun || !values.billboard) throw new Error(USAGE);
  const views = karafunViews(await readFile(values.karafun, 'utf8'));
  const charts = billboardCharts(await readFile(values.billboard, 'utf8'));
  const records = mergePopularity(views, charts);
  console.log(JSON.stringify(popularitySummary(records)));
  if (values['dry-run']) {
    console.log('Dry run: nothing written.');
    return;
  }
  if (pickStoreKind() === 'memory') console.error('No DATABASE_URL: writing to an in-memory store, which is thrown away.');
  const store = getStore();
  for (let i = 0; i < records.length; i += BATCH) {
    await store.putSongPopularity(records.slice(i, i + BATCH));
    console.log(`${Math.min(i + BATCH, records.length)} / ${records.length}`);
  }
  console.log(`Wrote ${records.length} rows.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
