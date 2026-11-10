// Corrects the octave of stored note-file ranges from recordings (src/lib/songs/octave.ts).
// Usage: npx tsx scripts/octave-fix.ts [--dry-run] [data/octave-evidence.json]   (needs DATABASE_URL)
// Safe to run again. Run it after importing new note files, which are stored as written.

import { readFile } from 'node:fs/promises';
import { getStore } from '../src/lib/server/getStore';
import { fixStoredOctaves, type OctaveEvidence } from '../src/lib/songs/octave';

async function main() {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith('--')) ?? 'data/octave-evidence.json';
  const evidence = JSON.parse(await readFile(path, 'utf8')) as OctaveEvidence;
  const summary = await fixStoredOctaves(getStore(), evidence, { dryRun: args.includes('--dry-run') });
  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
