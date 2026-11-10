// MGPHot's mood labels (QWW-19): the proxy rules in src/lib/moods/mgphot.ts applied to every
// MGPHot song, keyed by songKey of its artist and title, plus its first credited artist for
// duets. Prints how many songs get each mood. MGPHot is CC BY-NC-ND 4.0 (SiriusXM), and the No
// Derivatives term may not allow sharing labels adapted from it, so by default nothing is stored
// and MGPHot stays an offline check (moods:mgphot-check). Only with --show-in-app, the owner's
// explicit opt-in, do the rows go to the store (DATABASE_URL) as method mgphot-proxy-v1 and source
// mgphot, and so on screen for every mood MOODS_SHIPPED lists. MGPHot is then the most trusted
// source (merge.ts): its rows replace any song's earlier row, and later imports keep them. To take
// them out again, delete them (DELETE FROM song_moods WHERE source = 'mgphot') and rerun
// moods:import. The repo is public, so the files are read from a folder you pass and nothing is
// written into the repo.
// Usage: npm run moods:mgphot-import -- <mgphot folder> [--dry-run] [--show-in-app]
// The folder holds mgphot_genes.tsv and mgphot_gene_values.tsv from Zenodo record 15372063.
// --dry-run writes nothing even with --show-in-app.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { getStore, pickStoreKind } from '../src/lib/server/getStore';
import { MGPHOT_METHOD, mgphotRecords, readMgphot } from '../src/lib/moods/mgphot';
import { mergeMoodRows } from '../src/lib/moods/merge';

const pct = (n: number, of: number) => (of ? `${((100 * n) / of).toFixed(1)}%` : 'n/a');

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'dry-run': { type: 'boolean' }, 'show-in-app': { type: 'boolean' } } });
  const [dir] = positionals;
  if (!dir) throw new Error('Usage: npm run moods:mgphot-import -- <mgphot folder> [--dry-run] [--show-in-app]');
  const mgphot = readMgphot(await readFile(join(dir, 'mgphot_genes.tsv'), 'utf8'), await readFile(join(dir, 'mgphot_gene_values.tsv'), 'utf8'));
  const rows = mgphotRecords(mgphot.byKey);
  const upbeat = rows.filter((r) => r.moods.includes('upbeat')).length;
  const heartfelt = rows.filter((r) => r.moods.includes('heartfelt')).length;
  console.log(
    `MGPHot: ${mgphot.songs} songs -> ${rows.length} song keys (${mgphot.viaLead} by the first credited artist). ` +
      `Upbeat ${upbeat} (${pct(upbeat, rows.length)}), Heartfelt ${heartfelt} (${pct(heartfelt, rows.length)}), ` +
      `neither ${rows.filter((r) => !r.moods.length).length}. Method ${MGPHOT_METHOD}.`,
  );
  if (values['dry-run']) {
    console.log('Dry run: nothing written.');
    return;
  }
  if (!values['show-in-app']) {
    console.log('Nothing written: MGPHot labels reach the store, and the app, only with --show-in-app (its licence is CC BY-NC-ND 4.0; see data/moods/README.md).');
    return;
  }

  if (pickStoreKind() === 'memory') console.error('No DATABASE_URL: writing to an in-memory store, which is thrown away.');
  const store = getStore();
  const current = await store.getSongMoods(rows.map((r) => r.key));
  const toWrite = mergeMoodRows(current, rows);
  for (let i = 0; i < toWrite.length; i += 500) {
    await store.putSongMoods(toWrite.slice(i, i + 500));
    console.log(`${Math.min(i + 500, toWrite.length)} / ${toWrite.length}`);
  }
  console.log(JSON.stringify({ method: MGPHOT_METHOD, keys: rows.length, written: toWrite.length, replaced: current.size }));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
