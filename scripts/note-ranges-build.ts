// Computes song ranges from folders of UltraStar note files and writes them to a JSON file.
// Usage: npx tsx scripts/note-ranges-build.ts --out ranges.json <name>=<folder> [<name>=<folder> ...]
// Earlier folders win when two have the same song. The output has computed numbers only, no lyrics.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeNoteFile, dedupeRanges, rangeFromNoteText, type BulkRange } from '../src/lib/notes/bulkImport';

async function* noteFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* noteFiles(path);
    else if (entry.name.toLowerCase().endsWith('.txt')) yield path;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  if (outAt < 0 || !args[outAt + 1]) throw new Error('Usage: --out ranges.json name=folder ...');
  const out = args[outAt + 1]!;
  const sources = args.filter((_, i) => i !== outAt && i !== outAt + 1).map((a) => a.split('=') as [string, string]);

  const all: BulkRange[] = [];
  for (const [name, dir] of sources) {
    let files = 0;
    let ok = 0;
    for await (const path of noteFiles(dir)) {
      files++;
      const r = rangeFromNoteText(decodeNoteFile(await readFile(path)), name);
      if (r) {
        all.push(r);
        ok++;
      }
    }
    console.log(`${name}: ${ok} of ${files} files read`);
  }
  const ranges = dedupeRanges(all);
  await writeFile(out, JSON.stringify({ builtAt: new Date().toISOString(), count: ranges.length, ranges }));
  console.log(`${ranges.length} unique songs written to ${out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
