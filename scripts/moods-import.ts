// Writes mood labels into the database (QWW-11, QWW-19) from one or more labels files: runs from
// moods:label (one row per song the model knew, possibly with no moods; none for songs it did
// not know) and source files such as data/moods/labels-acousticbrainz-v1.json. Precedence
// decides each song's row (merge.ts): MGPHot first, then AcousticBrainz, then an LLM, so a file
// never overwrites a row from a more trusted source, in the store or in another file. Between
// equals the later row wins, so a relabel replaces the old one. MGPHot rows come in only through
// moods:mgphot-import --show-in-app. Which moods are shown is up to MOODS_SHIPPED, not the import.
// Usage: npm run moods:import -- labels.json [more.json ...] [--dry-run]   (needs DATABASE_URL)

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { getStore, pickStoreKind } from '../src/lib/server/getStore';
import { mergeMoodRows, readLabelsFile } from '../src/lib/moods/merge';
import type { SongMoodsRecord } from '../src/lib/server/store';

async function main() {
  const { values, positionals: paths } = parseArgs({ allowPositionals: true, options: { 'dry-run': { type: 'boolean' } } });
  if (!paths.length) throw new Error('Usage: npm run moods:import -- labels.json [more.json ...] [--dry-run]');
  const incoming: SongMoodsRecord[] = [];
  for (const path of paths) {
    const rows = readLabelsFile(await readFile(path, 'utf8'));
    const methods = [...new Set(rows.map((r) => `${r.source} ${r.method}`))].join(', ') || 'no rows';
    console.log(`${path}: ${rows.length} rows (${methods})`);
    incoming.push(...rows);
  }

  if (pickStoreKind() === 'memory') console.error('No DATABASE_URL: reading and writing an in-memory store, which is thrown away.');
  const store = getStore();
  const current = await store.getSongMoods([...new Set(incoming.map((r) => r.key))]);
  const toWrite = mergeMoodRows(current, incoming);
  const bySource = new Map<string, number>();
  for (const r of toWrite) bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1);
  console.log(
    `${toWrite.length} rows to write (${[...bySource].map(([s, n]) => `${s} ${n}`).join(', ') || 'none'}); ` +
      `${incoming.length - toWrite.length} rows not written, as a more trusted or later row has the song.`,
  );
  if (values['dry-run']) {
    console.log('Dry run: nothing written.');
    return;
  }
  for (let i = 0; i < toWrite.length; i += 500) {
    await store.putSongMoods(toWrite.slice(i, i + 500));
    console.log(`${Math.min(i + 500, toWrite.length)} / ${toWrite.length}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
