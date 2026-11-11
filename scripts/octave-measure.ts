// How often do the octave rules put a note file in its recording's octave? Measured over the songs that have both
// (pairs from scripts/octave-pairs.py), with the real octaveMove (src/lib/songs/octave.ts).
// Usage: npx tsx scripts/octave-measure.ts pairs.json
//
// Two views, both against the recording's octave (the nearest whole octave to its typical note):
//   with the song's own recording: what the shipped fix does to songs that have one. Right by construction, apart from
//     mostly-rap recordings the builder does not trust.
//   leave-one-out: each song as if its own recording did not exist and its artist's median came from the artist's
//     other songs. This is what songs with no recording of their own get. Mostly-rap recordings are left out of this
//     view, since the recording is the truth here and pitch tracking of rap is not.
// "Before" is as written; "rules before" is the artist rule alone (typicalHigh = Infinity); "rules now" is the shipped one.

import { readFile } from 'node:fs/promises';
import type { SongRange } from '../src/lib/contracts';
import { buildOctaveEvidence, octaveMove, octaveToward, type OctaveEvidence, type OctavePair } from '../src/lib/songs/octave';
import { songKey } from '../src/lib/songs/resolve';

const pct = (n: number, of: number) => `${((100 * n) / of).toFixed(1)}%`;
const noteFile = (p: OctavePair): SongRange => ({
  low: Math.round(p.noteAsStored) - 5,
  high: Math.round(p.noteAsStored) + 6,
  tessitura: p.noteAsStored,
  source: 'note-file',
  confidence: 'high',
  fastLyrics: false,
});

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: octave-measure.ts pairs.json');
  const pairs = JSON.parse(await readFile(file, 'utf8')) as OctavePair[];
  const keyOf = (p: OctavePair) => songKey(p.artist, p.title);
  const artistOf = (p: OctavePair) => keyOf(p).split('|')[0]!;
  const truth = (p: OctavePair) => octaveToward(p.noteAsStored, p.recording);

  // With the song's own recording, the evidence the shipped fix uses.
  const own = buildOctaveEvidence(pairs);
  const withOwn = pairs.map((p) => ({ p, move: octaveMove(keyOf(p), noteFile(p), own)?.semitones ?? 0 }));
  const offBefore = pairs.filter((p) => truth(p) !== 0).length;
  const offAfter = withOwn.filter(({ p, move }) => move !== truth(p)).length;
  const rap = pairs.filter((p) => p.rap);
  const rapKept = rap.filter((p) => Object.hasOwn(own.songs, keyOf(p))).length;
  console.log(`With the song's own recording (${pairs.length} songs with a note file and a recording)`);
  console.log(`  note-file octave disagrees with the recording: as written ${offBefore} (${pct(offBefore, pairs.length)}); after the fix ${offAfter} (${pct(offAfter, pairs.length)})`);
  console.log(`  what is left is mostly-rap recordings the builder does not trust: ${rap.length} songs, ${rapKept} kept as evidence, ${rap.length - rapKept} not`);

  // Leave-one-out over the songs whose recording is trustworthy as the truth.
  const byArtist = new Map<string, OctavePair[]>();
  for (const p of pairs) byArtist.set(artistOf(p), [...(byArtist.get(artistOf(p)) ?? []), p]);
  const trusted = pairs.filter((p) => !p.rap);
  const rows = trusted.map((p) => {
    const others = (byArtist.get(artistOf(p)) ?? []).filter((q) => q !== p);
    const evidence: OctaveEvidence = { songs: {}, artists: buildOctaveEvidence(others).artists };
    const range = noteFile(p);
    const key = keyOf(p);
    return {
      truth: truth(p),
      before: octaveMove(key, range, evidence, Infinity)?.semitones ?? 0,
      now: octaveMove(key, range, evidence),
    };
  });
  const wrong = (get: (r: (typeof rows)[number]) => number) => rows.filter((r) => get(r) !== r.truth).length;
  const asWritten = wrong(() => 0);
  const rulesBefore = wrong((r) => r.before);
  const rulesNow = wrong((r) => r.now?.semitones ?? 0);
  console.log(`\nLeave-one-out, as if the song had no recording of its own (${rows.length} songs, mostly-rap recordings left out)`);
  console.log(`  note-file octave disagrees with the recording: as written ${asWritten} (${pct(asWritten, rows.length)}); rules before ${rulesBefore} (${pct(rulesBefore, rows.length)}); rules now ${rulesNow} (${pct(rulesNow, rows.length)})`);
  for (const from of ['artist', 'pitch'] as const) {
    const moved = rows.filter((r) => r.now?.from === from);
    const right = moved.filter((r) => r.now!.semitones === r.truth).length;
    console.log(`  moved by ${from}: ${moved.length} songs, ${right} right (${pct(right, moved.length)})`);
  }
  const newlyMoved = rows.filter((r) => r.before === 0 && (r.now?.semitones ?? 0) !== 0);
  const newlyRight = newlyMoved.filter((r) => r.now!.semitones === r.truth).length;
  const broken = newlyMoved.filter((r) => r.truth === 0).length;
  console.log(`  songs the new rules moved that the old ones left alone: ${newlyMoved.length}, ${newlyRight} now right, ${broken} were right as written and are now wrong`);

  // How often a note file is an octave too high, by its typical note: the calibration behind TYPICAL_HIGH.
  // tests/fixtures/octave-calibration.json holds these counts, and a test keeps TYPICAL_HIGH between the bins.
  const bins = new Map<number, [number, number]>();
  for (const p of trusted) {
    const bin = Math.floor(p.noteAsStored);
    const [n, tooHigh] = bins.get(bin) ?? [0, 0];
    bins.set(bin, [n + 1, tooHigh + (truth(p) < 0 ? 1 : 0)]);
  }
  const sorted = [...bins].filter(([bin]) => bin >= 60).sort(([a], [b]) => a - b);
  console.log(`\nNote file an octave too high, by typical note (${trusted.length} songs, mostly-rap recordings left out)`);
  for (const [bin, [n, tooHigh]] of sorted) console.log(`  ${bin} to ${bin + 1}: ${tooHigh} of ${n} (${pct(tooHigh, n)})`);
  console.log(`calibration ${JSON.stringify(Object.fromEntries(sorted))}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
