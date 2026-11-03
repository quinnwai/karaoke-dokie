// Turns a filled-in gold-set sheet (a copy of data/moods/gold-set-template.csv with y or n in the
// upbeat and heartfelt columns) into the gold-set JSON that moods:report reads, with who labelled
// it and when (QWW-11). Rows with both mood cells empty are left out.
// Usage: npm run moods:gold -- filled.csv --by "Quinn-Wai" --out data/moods/gold-set.json [--at 2026-11-05]

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { goldFromCsv } from '../src/lib/moods/gold';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { by: { type: 'string' }, out: { type: 'string' }, at: { type: 'string' } },
  });
  const [path] = positionals;
  if (!path || !values.by || !values.out) throw new Error('Usage: npm run moods:gold -- filled.csv --by "Name" --out gold.json [--at YYYY-MM-DD]');
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local date
  const { gold, skipped } = goldFromCsv(await readFile(path, 'utf8'), { labelledBy: values.by, labelledAt: values.at ?? today });
  const file = {
    _comment:
      'Hand labels for the mood gate (QWW-11): y means the labeller would expect the song under that chip. Made with npm run moods:gold from a copy of data/moods/gold-set-template.csv.',
    ...gold,
  };
  await writeFile(values.out, JSON.stringify(file, null, 2) + '\n');
  console.log(`${gold.songs.length} songs labelled by ${gold.labelledBy} on ${gold.labelledAt}; ${skipped} left blank`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
