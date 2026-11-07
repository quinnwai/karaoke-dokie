// Scores the other mood sources against MGPHot's proxy labels (QWW-19), a provisional reference:
// the hand-labelled gold set is the real gate. Runs the gate code (gate.ts) with the proxy labels
// of the listed songs MGPHot has as the gold set, so the same seeded held-out half decides, with
// the same bars (precision and recall in each of 3 runs). Prints, per mood:
//   - the LLM's runs;
//   - AcousticBrainz, whose labels are the same every run (fixed rules over fixed data);
//   - AcousticBrainz with the LLM where it has no data: what the app shows under the import's
//     precedence (everywhere by default; with MGPHot opted in, on songs MGPHot does not cover);
// then how far the sources agree where all of them label a song.
// MGPHot is CC BY-NC-ND 4.0 (SiriusXM) and the repo is public: its files are read from a folder
// you pass, and the proxy labels stay in memory. Only the counts printed here go in the README.
// Usage: npm run moods:mgphot-check -- <mgphot folder> --songs songs.json --labels run1.json --labels run2.json --labels run3.json [--ab labels-acousticbrainz-v1.json]

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { MOODS, type Mood } from '../src/lib/contracts';
import { GATE, gateMoods, shippedMoods, sourcesAgreement, splitGold, type MoodGate, type MoodScore } from '../src/lib/moods/gate';
import { parseLabelRun, songsToLabel, toMoodRecords } from '../src/lib/moods/label';
import { mergeMoodRows, readLabelsFile } from '../src/lib/moods/merge';
import { MGPHOT_PROXIES, mgphotGold, readMgphot } from '../src/lib/moods/mgphot';
import { PROVIDERS } from '../src/lib/moods/providers';
import type { SongMoodsRecord } from '../src/lib/server/store';

const NAMES: Record<Mood, string> = { upbeat: 'Upbeat', heartfelt: 'Heartfelt' };
const pct = (n: number, of: number) => (of ? `${((100 * n) / of).toFixed(1)}%` : 'n/a');
const ratio = (value: number | null, n: number, of: number) => `${value === null ? ' none' : value.toFixed(2)} (${n} of ${of})`;
const scoreLine = (label: string, s: MoodScore) =>
  `    ${label.padEnd(6)} precision ${ratio(s.precision, s.tp, s.tp + s.fp).padEnd(18)} recall ${ratio(s.recall, s.tp, s.tp + s.fn)}`;
const toMap = (rows: readonly SongMoodsRecord[]) => new Map(rows.map((r) => [r.key, r.moods]));

function printGate(title: string, gates: MoodGate[], runNames: string[]) {
  console.log(`\n== ${title}`);
  for (const g of gates) {
    console.log(`  ${NAMES[g.mood]}: ${g.pass ? 'PASS' : 'FAIL'}`);
    console.log('   held-out half (the gate)');
    g.heldOut.forEach((s, i) => console.log(scoreLine(runNames[i]!, s)));
    console.log('   tune half');
    g.tune.forEach((s, i) => console.log(scoreLine(runNames[i]!, s)));
    for (const f of g.failures) console.log(`    - ${f}`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { songs: { type: 'string' }, labels: { type: 'string', multiple: true }, ab: { type: 'string' } },
  });
  const [dir] = positionals;
  const paths = values.labels ?? [];
  if (!dir || !values.songs || !paths.length) {
    throw new Error('Usage: moods-mgphot.ts <mgphot folder> --songs songs.json --labels run1.json [--labels run2.json ...] [--ab labels-acousticbrainz-v1.json]');
  }
  const mgphot = readMgphot(await readFile(join(dir, 'mgphot_genes.tsv'), 'utf8'), await readFile(join(dir, 'mgphot_gene_values.tsv'), 'utf8'));
  const keys = songsToLabel(JSON.parse(await readFile(values.songs, 'utf8'))).map((s) => s.key);
  const gold = mgphotGold(keys, mgphot.byKey);
  const { heldOut } = splitGold(gold.songs);

  console.log('Reference: MGPHot proxy rules, a provisional reference. The hand-labelled gold set is the real gate.');
  for (const m of MOODS) console.log(`  ${NAMES[m]}: ${MGPHOT_PROXIES[m].rule}`);
  console.log(`Songs: ${new Set(keys).size} keys, ${gold.songs.length} of them in MGPHot; ${heldOut.length} held out (the gate), ${gold.songs.length - heldOut.length} to tune on.`);
  console.log(`MGPHot says yes on the held-out half: ${MOODS.map((m) => `${NAMES[m]} ${pct(heldOut.filter((g) => g[m]).length, heldOut.length)}`).join(', ')}.`);
  console.log(
    `A mood passes with held-out precision of at least ${GATE.minPrecision} and recall of at least ${GATE.minRecall} in each of ${GATE.minRuns} runs; ` +
      'a song with no label counts as "no".',
  );

  const runs = await Promise.all(paths.map(async (p) => parseLabelRun(await readFile(p, 'utf8'))));
  const methods = new Set(runs.map((r) => r.method));
  if (methods.size > 1) throw new Error(`The runs use different methods (${[...methods].join(', ')})`);
  const llm = runs.map((r) => shippedMoods(r.labels));
  const runNames = runs.map((_, i) => `run ${i + 1}`);
  runs.forEach((r, i) => console.log(`LLM run ${i + 1} knew ${gold.songs.filter((g) => llm[i]!.has(g.key)).length} of the ${gold.songs.length} songs.`));
  printGate(`LLM ${runs[0]!.method}, ${runs.length} runs`, gateMoods(gold, llm), runNames);

  const proxy = new Map(gold.songs.map((g) => [g.key, MOODS.filter((m) => g[m])]));
  const sources: [string, ReadonlyMap<string, readonly Mood[]>][] = [
    ['MGPHot', proxy],
    ['LLM run 1', llm[0]!],
  ];
  if (values.ab) {
    const abRows = readLabelsFile(await readFile(values.ab, 'utf8'));
    const ab = toMap(abRows);
    sources.splice(1, 0, ['AcousticBrainz', ab]);
    console.log(`\nAcousticBrainz (${abRows[0]?.method ?? 'no rows'}) has data for ${gold.songs.filter((g) => ab.has(g.key)).length} of the ${gold.songs.length} songs.`);
    // Fixed rules over fixed data: one set of labels stands for every run.
    printGate('AcousticBrainz (the same labels every run)', gateMoods(gold, runs.map(() => ab)), runNames);

    const fallback = runs.map((r) => toMap(mergeMoodRows(new Map(), [...abRows, ...toMoodRecords(r.labels, r.model, PROVIDERS[r.provider].source)])));
    printGate('AcousticBrainz, then the LLM where AcousticBrainz has no data (what the app shows by default)', gateMoods(gold, fallback), runNames);
  }

  console.log(`\n== Agreement where ${sources.map(([n]) => n).join(', ')} all label a song (the LLM knew it)`);
  for (const m of MOODS) {
    const a = sourcesAgreement(sources.map(([, s]) => s), m);
    const name = (i: number) => sources[i]![0];
    const pairs = a.pairs.map((p) => `${name(p.a)} and ${name(p.b)} ${pct(p.agree, a.songs)} (kappa ${p.kappa === null ? 'none' : p.kappa.toFixed(2)})`);
    console.log(`  ${NAMES[m]}, ${a.songs} songs: all agree on ${pct(a.allAgree, a.songs)}; ${pairs.join('; ')}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
