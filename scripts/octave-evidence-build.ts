// Builds data/octave-evidence.json (src/lib/songs/octave.ts) from the pairs file made by octave-pairs.py.
// Usage: npx tsx scripts/octave-evidence-build.ts pairs.json [--out data/octave-evidence.json]
// Computed numbers only: a typical note per song and per artist, no audio, no lyrics. Songs whose recording is
// mostly rap are left out unless the recording agrees with the note file at a whole octave (pitch tracking is
// unreliable there), and they never count toward an artist; neither do duets and multi-artist credits.

import { readFile, writeFile } from 'node:fs/promises';
import { buildOctaveEvidence, type OctavePair } from '../src/lib/songs/octave';

async function main() {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const out = outAt >= 0 ? args[outAt + 1]! : 'data/octave-evidence.json';
  const input = args.find((a, i) => outAt < 0 || (i !== outAt && i !== outAt + 1));
  if (!input) throw new Error('Usage: octave-evidence-build.ts pairs.json [--out file]');
  const pairs = JSON.parse(await readFile(input, 'utf8')) as OctavePair[];

  const evidence = buildOctaveEvidence(pairs);
  await writeFile(out, JSON.stringify({ builtAt: new Date().toISOString(), ...evidence }));
  console.log(`${Object.keys(evidence.songs).length} songs and ${Object.keys(evidence.artists).length} artists written to ${out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
