// Builds data/octave-evidence.json (src/lib/songs/octave.ts) from the pairs file made by octave-pairs.py.
// Usage: npx tsx scripts/octave-evidence-build.ts pairs.json [--out data/octave-evidence.json]
// Computed numbers only: a typical note per song and per artist, no audio, no lyrics. Songs whose recording is
// mostly rap are left out (pitch tracking is unreliable there), and so are duets and multi-artist credits for
// the artist medians.

import { readFile, writeFile } from 'node:fs/promises';
import type { OctaveEvidence } from '../src/lib/songs/octave';
import { artistOfKey } from '../src/lib/songs/octave';
import { songKey } from '../src/lib/songs/resolve';

interface Pair {
  artist: string;
  title: string;
  recording: number;
  rap: boolean;
  duet: boolean;
  multi: boolean;
}

const round = (n: number) => Math.round(n * 100) / 100;
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

async function main() {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const out = outAt >= 0 ? args[outAt + 1]! : 'data/octave-evidence.json';
  const input = args.find((a, i) => outAt < 0 || (i !== outAt && i !== outAt + 1));
  if (!input) throw new Error('Usage: octave-evidence-build.ts pairs.json [--out file]');
  const pairs = JSON.parse(await readFile(input, 'utf8')) as Pair[];

  const evidence: OctaveEvidence = { songs: {}, artists: {} };
  const byArtist = new Map<string, number[]>();
  for (const p of pairs) {
    if (p.rap) continue;
    const key = songKey(p.artist, p.title);
    if (key.startsWith('|') || key.endsWith('|')) continue;
    evidence.songs[key] = round(p.recording);
    if (p.duet || p.multi) continue;
    const artist = artistOfKey(key);
    byArtist.set(artist, [...(byArtist.get(artist) ?? []), p.recording]);
  }
  for (const [artist, values] of [...byArtist].sort(([a], [b]) => a.localeCompare(b))) evidence.artists[artist] = round(median(values));
  evidence.songs = Object.fromEntries(Object.entries(evidence.songs).sort(([a], [b]) => a.localeCompare(b)));

  await writeFile(out, JSON.stringify({ builtAt: new Date().toISOString(), ...evidence }));
  console.log(`${Object.keys(evidence.songs).length} songs and ${Object.keys(evidence.artists).length} artists written to ${out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
