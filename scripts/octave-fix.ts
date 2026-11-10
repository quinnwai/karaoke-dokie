// Corrects the octave of stored note-file ranges (src/lib/songs/octave.ts).
// Usage: npx tsx scripts/octave-fix.ts [--dry-run] [--after <song key>] [--show <song key>]... [--sample <n>] [evidence.json]
// Needs DATABASE_URL: the database it reads and, without --dry-run, rewrites. It prints that database's host and name first.
// Reads the whole song_ranges table, 1,000 rows at a time, and rewrites only the rows the evidence disagrees with.
// Safe to run again, and to stop and run again: a corrected song matches its evidence and does not move. Every page
// prints its last song key; `--after <that key>` skips what a stopped run had done. It runs no schema migration, so a
// dry run reads and nothing else. --show prints the move of a song that has one, --sample the first n moves.
// Run it after importing new note files, which are stored as written, and while nothing else writes song ranges.

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { midiToNoteName } from '../src/lib/audio/notes';
import { readOnlyStore } from '../src/lib/report/readOnlyStore';
import { neonQuery } from '../src/lib/server/getStore';
import { createPostgresStore } from '../src/lib/server/postgresStore';
import { fixStoredOctaves, type OctaveEvidence } from '../src/lib/songs/octave';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'dry-run': { type: 'boolean' }, after: { type: 'string' }, show: { type: 'string', multiple: true }, sample: { type: 'string' } },
  });
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('Set DATABASE_URL');
  const dryRun = values['dry-run'] === true;
  const evidence = JSON.parse(await readFile(positionals[0] ?? 'data/octave-evidence.json', 'utf8')) as OctaveEvidence;
  const show = new Set(values.show ?? []);
  const sample = Number(values.sample ?? 0);
  if (!Number.isInteger(sample) || sample < 0) throw new Error(`--sample takes a whole number, not "${values.sample}"`);

  const store = createPostgresStore(neonQuery(url), { autoMigrate: false });
  const target = new URL(url);
  console.log(`${dryRun ? 'Dry run (nothing is written)' : 'Writing'} on database ${target.pathname.slice(1)} at ${target.hostname}, from ${values.after ? `after ${values.after}` : 'the start'}`);
  let sampled = 0;
  const summary = await fixStoredOctaves(dryRun ? readOnlyStore(store) : store, evidence, {
    dryRun,
    after: values.after,
    onMove: (key, move, range) => {
      if (!show.has(key) && sampled >= sample) return;
      if (!show.has(key)) sampled++;
      const after = `${midiToNoteName(range.low + move.semitones)}-${midiToNoteName(range.high + move.semitones)}`;
      console.log(
        `move ${key}: ${midiToNoteName(range.low)}-${midiToNoteName(range.high)} (typical ${range.tessitura.toFixed(1)}) -> ${after} (${move.semitones > 0 ? '+' : ''}${move.semitones}, ${move.from})`,
      );
    },
    onPage: (lastKey, s) => console.log(`page done, last key ${JSON.stringify(lastKey)}: checked ${s.checked}, ${dryRun ? 'would move' : 'moved'} ${s.moved}`),
  });
  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
