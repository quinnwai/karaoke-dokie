// The gate report for mood labels (QWW-11): per mood, precision and recall on the held-out half of
// the gold set in every labelling run (the tune half too, for tuning only), how often the two
// labellers agree, and pass or fail. Then how stable the labels are across runs.
// Usage: npm run moods:report -- --gold gold.json --labels run1.json [--labels run2.json ...] [--second second.json]
// Without --gold it reports only the stability across runs. A mood that fails stays off.

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { MOODS, type Mood } from '../src/lib/contracts';
import { GATE, gateMoods, runAgreement, shippedMoods, splitGold, type MoodScore } from '../src/lib/moods/gate';
import { parseGoldSet } from '../src/lib/moods/gold';
import { parseLabelRun } from '../src/lib/moods/label';

const NAMES: Record<Mood, string> = { upbeat: 'Upbeat', heartfelt: 'Heartfelt' };
const pct = (n: number, of: number) => (of ? `${((100 * n) / of).toFixed(1)}%` : 'n/a');
const ratio = (value: number | null, n: number, of: number) => `${value === null ? ' none' : value.toFixed(2)} (${n} of ${of})`;
const scoreLine = (label: string, s: MoodScore) =>
  `  ${label.padEnd(8)} precision ${ratio(s.precision, s.tp, s.tp + s.fp).padEnd(16)} recall ${ratio(s.recall, s.tp, s.tp + s.fn)}`;

async function main() {
  const { values } = parseArgs({
    options: { gold: { type: 'string' }, labels: { type: 'string', multiple: true }, second: { type: 'string' } },
  });
  const paths = values.labels ?? [];
  if (!paths.length) throw new Error('Usage: npm run moods:report -- --gold gold.json --labels run1.json [--labels run2.json ...] [--second second.json]');
  const runs = await Promise.all(paths.map(async (p) => parseLabelRun(await readFile(p, 'utf8'))));
  const methods = new Set(runs.map((r) => r.method));
  if (methods.size > 1) throw new Error(`The runs use different methods (${[...methods].join(', ')}); the gate compares runs of one method`);
  console.log(`Labels: ${runs[0]!.method}, ${runs.length} run${runs.length === 1 ? '' : 's'} (${paths.join(', ')})`);

  if (values.gold) {
    const gold = parseGoldSet(await readFile(values.gold, 'utf8'));
    const second = values.second ? parseGoldSet(await readFile(values.second, 'utf8')) : null;
    const { tune, heldOut } = splitGold(gold.songs);
    console.log(`Gold set: ${gold.songs.length} songs labelled by ${gold.labelledBy} on ${gold.labelledAt}; ${heldOut.length} held out, ${tune.length} to tune on.`);
    if (second) console.log(`Second labeller: ${second.songs.length} songs by ${second.labelledBy} on ${second.labelledAt}.`);
    runs.forEach((r, i) => {
      const byKey = new Map(r.labels.map((l) => [l.key, l]));
      const known = gold.songs.filter((g) => byKey.get(g.key)?.known).length;
      const missing = gold.songs.filter((g) => !byKey.has(g.key)).length;
      console.log(`Run ${i + 1} knew ${known} of the gold songs${missing ? `; ${missing} have no label in this run` : ''}.`);
    });
    console.log(`A mood passes with held-out precision of at least ${GATE.minPrecision} and recall of at least ${GATE.minRecall} in each of ${GATE.minRuns} runs${second ? `, and labellers agreeing at least ${GATE.minAgreement} of the time` : ''}.`);

    for (const g of gateMoods(gold, runs.map((r) => shippedMoods(r.labels)), second)) {
      console.log(`\n${NAMES[g.mood]}: ${g.pass ? 'PASS' : 'FAIL, stays off'}`);
      console.log('  held-out half (the gate)');
      g.heldOut.forEach((s, i) => console.log(scoreLine(`run ${i + 1}`, s)));
      console.log('  tune half (for tuning only)');
      g.tune.forEach((s, i) => console.log(scoreLine(`run ${i + 1}`, s)));
      if (g.agreement) console.log(`  labellers agree on ${g.agreement.agree} of ${g.agreement.songs} songs (${pct(g.agreement.agree, g.agreement.songs)})`);
      for (const f of g.failures) console.log(`  - ${f}`);
    }
  } else {
    console.log('No --gold: stability only. The gate needs the hand-labelled gold set.');
  }

  if (runs.length > 1) {
    const a = runAgreement(runs.map((r) => r.labels));
    console.log(`\nStability over the ${a.songs} songs labelled in all ${runs.length} runs:`);
    console.log(`  same label every time (known or not, and the same moods): ${a.same} (${pct(a.same, a.songs)})`);
    for (const m of MOODS) {
      console.log(`  same ${NAMES[m]} chip every time: ${a.sameByMood[m]} (${pct(a.sameByMood[m], a.songs)}); songs shown per run: ${a.shownByMood[m].join(', ')}`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
