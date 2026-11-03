// Sanity check of Claude's mood labels against MGPHot (QWW-19). Not the gate: the gate uses the
// hand-labelled gold set. MGPHot is musicologists' annotations of 58 attributes for Billboard Hot
// 100 songs, 1958-2022: Oramas, Gouyon, Hogan, Landau and Ehmann, "MGPHot: A Dataset of
// Musicological Annotations for Popular Music (1958-2022)", TISMIR 8(1), 2025,
// doi:10.5334/tismir.236, data on Zenodo (record 15372063). Licensed CC BY-NC-ND 4.0, copyright
// SiriusXM 2025: used offline and non-commercially, and nothing from it is stored or shipped.
// Usage: npx tsx scripts/moods-mgphot.ts <mgphot folder> labels.json
// Reads mgphot_genes.tsv and mgphot_gene_values.tsv from the folder (attributes are scored 0 to
// 1), joins songs to the labels by songKey of MGPHot's Billboard artist and title, or of its
// first credited artist when that misses (as moods-billboard.ts does), and prints per mood the
// precision and recall of the labels against a proxy rule, with how common the proxy is.
// The proxy rules were fixed before any labels were compared with them. "High" is about the top
// third of songs since 1990 on that attribute; a lyric theme counts at 0.6 or more.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MOODS, type Mood } from '../src/lib/contracts';
import { scoreMood, shippedMoods } from '../src/lib/moods/gate';
import type { GoldSong } from '../src/lib/moods/gold';
import { parseLabelRun } from '../src/lib/moods/label';
import { songKey } from '../src/lib/songs/resolve';

const GENES = ['Danceability', 'Aural Intensity', 'Sad Lyrics', 'Love/Romance Lyrics'] as const;
type Genes = Record<(typeof GENES)[number], number>;

const PROXIES: Record<Mood, { rule: string; test: (g: Genes) => boolean }> = {
  upbeat: {
    rule: 'Danceability >= 0.8 or Aural Intensity >= 0.7, and Sad Lyrics < 0.6',
    test: (g) => (g.Danceability >= 0.8 || g['Aural Intensity'] >= 0.7) && g['Sad Lyrics'] < 0.6,
  },
  heartfelt: {
    rule: 'Love/Romance Lyrics >= 0.6 or Sad Lyrics >= 0.6',
    test: (g) => g['Love/Romance Lyrics'] >= 0.6 || g['Sad Lyrics'] >= 0.6,
  },
};

const lines = (text: string) => text.split(/\r?\n/).filter(Boolean).map((l) => l.split('\t'));
const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%` : 'n/a');

async function main() {
  const [dir, labelsPath] = process.argv.slice(2);
  if (!dir || !labelsPath) throw new Error('Usage: moods-mgphot.ts <mgphot folder> labels.json');
  const [geneHeader = [], ...geneRows] = lines(await readFile(join(dir, 'mgphot_genes.tsv'), 'utf8'));
  const nameCol = geneHeader.indexOf('name');
  const idCol = geneHeader.indexOf('gene_id');
  const geneIndex = new Map(geneRows.map((r) => [r[nameCol] ?? '', Number(r[idCol])]));
  for (const g of GENES) if (!geneIndex.has(g)) throw new Error(`mgphot_genes.tsv has no "${g}"`);

  const [valueHeader = [], ...valueRows] = lines(await readFile(join(dir, 'mgphot_gene_values.tsv'), 'utf8'));
  const at = (name: string) => valueHeader.indexOf(name);
  const [artistCol, titleCol, valuesCol] = [at('artist'), at('title'), at('gene_values')];
  // First MGPHot row per key wins (file order), by the full credit and by the lead artist.
  const exact = new Map<string, Genes>();
  const lead = new Map<string, Genes>();
  for (const r of valueRows) {
    const artist = r[artistCol] ?? '';
    const title = r[titleCol] ?? '';
    const values = JSON.parse(r[valuesCol] ?? '[]') as number[];
    const genes = Object.fromEntries(GENES.map((g) => [g, values[geneIndex.get(g)!] ?? NaN])) as Genes;
    const own = songKey(artist, title);
    if (!exact.has(own)) exact.set(own, genes);
    const first = songKey(artist.split(/\s+(?:and|&|with)\s+|,\s+/i)[0] ?? artist, title);
    if (!lead.has(first)) lead.set(first, genes);
  }

  const run = parseLabelRun(await readFile(labelsPath, 'utf8'));
  const matched: { key: string; genes: Genes; viaLead: boolean }[] = [];
  for (const l of run.labels) {
    const genes = exact.get(l.key) ?? lead.get(l.key);
    if (genes) matched.push({ key: l.key, genes, viaLead: !exact.has(l.key) });
  }
  // Proxy labels live only in memory, as stand-in gold labels for scoreMood.
  const proxyGold: GoldSong[] = matched.map((m) => ({
    key: m.key,
    artist: '',
    title: '',
    upbeat: PROXIES.upbeat.test(m.genes),
    heartfelt: PROXIES.heartfelt.test(m.genes),
  }));
  const shipped = shippedMoods(run.labels);
  const known = matched.filter((m) => shipped.has(m.key)).length;

  console.log(`Labels: ${run.method}, ${run.labels.length} songs. MGPHot: ${valueRows.length} songs.`);
  console.log(
    `Overlap: ${matched.length} labelled songs found in MGPHot (${matched.filter((m) => m.viaLead).length} of them by the first credited artist); ` +
      `the model knew ${known} of them.`,
  );
  for (const mood of MOODS) {
    const s = scoreMood(proxyGold, shipped, mood);
    const proxyYes = s.tp + s.fn;
    console.log(`\n${mood}: proxy ${PROXIES[mood].rule}`);
    console.log(`  proxy says yes for ${proxyYes} of ${matched.length} (${pct(proxyYes, matched.length)}); the labels say yes for ${s.tp + s.fp}`);
    console.log(
      `  precision ${s.precision === null ? 'none' : s.precision.toFixed(2)} (${s.tp} of ${s.tp + s.fp}), ` +
        `recall ${s.recall === null ? 'none' : s.recall.toFixed(2)} (${s.tp} of ${proxyYes})`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
