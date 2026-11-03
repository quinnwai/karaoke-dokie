// MGPHot as a mood source (QWW-19). MGPHot is music experts' scores from 0 to 1 on 58 attributes
// for 21,299 Billboard Hot 100 songs, 1958 to 2022: Oramas, Gouyon, Hogan, Landau and Ehmann,
// "MGPHot: A Dataset of Musicological Annotations for Popular Music (1958-2022)", TISMIR 8(1),
// 2025, doi:10.5334/tismir.236, data on Zenodo (record 15372063). Licensed CC BY-NC-ND 4.0,
// copyright SiriusXM 2025, and used non-commercially. The No Derivatives term may not allow
// sharing labels adapted from it, so by default it is only an offline check of the other sources
// (moods:mgphot-check, which keeps its proxy labels in memory); its labels reach the store, and the
// app, only when the owner opts in (moods:mgphot-import --show-in-app). The repo is public, so its
// files are read from a local folder and nothing derived from them is committed.
// Two proxy rules turn four attributes into the chips. They were fixed before they were compared
// with any labels: "high" is about the top third of songs since 1990 on that attribute, and a
// lyric theme counts at 0.6 or more.

import { MOODS, type Mood } from '../contracts';
import type { SongMoodsRecord } from '../server/store';
import { songKey } from '../songs/resolve';
import type { GoldSet } from './gold';

export const MGPHOT_METHOD = 'mgphot-proxy-v1';
export const MGPHOT_SOURCE = 'mgphot';

export const MGPHOT_GENES = ['Danceability', 'Aural Intensity', 'Sad Lyrics', 'Love/Romance Lyrics'] as const;
export type MgphotGenes = Record<(typeof MGPHOT_GENES)[number], number>;

export const MGPHOT_PROXIES: Record<Mood, { rule: string; test: (g: MgphotGenes) => boolean }> = {
  upbeat: {
    rule: 'Danceability >= 0.8 or Aural Intensity >= 0.7, and Sad Lyrics < 0.6',
    test: (g) => (g.Danceability >= 0.8 || g['Aural Intensity'] >= 0.7) && g['Sad Lyrics'] < 0.6,
  },
  heartfelt: {
    rule: 'Love/Romance Lyrics >= 0.6 or Sad Lyrics >= 0.6',
    test: (g) => g['Love/Romance Lyrics'] >= 0.6 || g['Sad Lyrics'] >= 0.6,
  },
};

export const mgphotMoods = (g: MgphotGenes): Mood[] => MOODS.filter((m) => MGPHOT_PROXIES[m].test(g));

/** The first artist of a credit like "A and B", "A & B", "A with B" or "A, B"; the pipeline keys duets by it. */
export const leadArtist = (credit: string): string => credit.split(/\s+(?:and|&|with)\s+|,\s+/i)[0] ?? credit;

const tsv = (text: string) =>
  text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split('\t'));

export interface MgphotSongs {
  /** Songs (rows) in mgphot_gene_values.tsv. */
  songs: number;
  /**
   * The four attributes per song key: songKey of the Billboard artist and title, plus songKey of
   * the first credited artist and title where no song has that key (how the earlier check joined
   * duets). The first row in file order wins a key.
   */
  byKey: Map<string, MgphotGenes>;
  /** Keys that come from the first credited artist only. */
  viaLead: number;
}

/** Reads mgphot_genes.tsv (gene_id and name) and mgphot_gene_values.tsv (artist, title and gene_values, a JSON list indexed by gene_id). */
export function readMgphot(genesTsv: string, valuesTsv: string): MgphotSongs {
  const [geneHeader = [], ...geneRows] = tsv(genesTsv);
  const [nameCol, idCol] = [geneHeader.indexOf('name'), geneHeader.indexOf('gene_id')];
  if (nameCol < 0 || idCol < 0) throw new Error('mgphot_genes.tsv needs gene_id and name columns');
  const geneIndex = new Map(geneRows.map((r) => [r[nameCol] ?? '', Number(r[idCol])]));
  for (const g of MGPHOT_GENES) if (!geneIndex.has(g)) throw new Error(`mgphot_genes.tsv has no "${g}"`);

  const [valueHeader = [], ...valueRows] = tsv(valuesTsv);
  const col = (name: string) => {
    const i = valueHeader.indexOf(name);
    if (i < 0) throw new Error(`mgphot_gene_values.tsv has no ${name} column`);
    return i;
  };
  const [artistCol, titleCol, valuesCol] = [col('artist'), col('title'), col('gene_values')];
  const exact = new Map<string, MgphotGenes>();
  const lead = new Map<string, MgphotGenes>();
  valueRows.forEach((r, i) => {
    const values = JSON.parse(r[valuesCol] ?? '[]') as unknown[];
    const genes = Object.fromEntries(MGPHOT_GENES.map((g) => [g, values[geneIndex.get(g)!]])) as MgphotGenes;
    // A missing score would read as "no" under every rule, so it is an error, not a label.
    if (!MGPHOT_GENES.every((g) => typeof genes[g] === 'number' && Number.isFinite(genes[g]))) {
      throw new Error(`mgphot_gene_values.tsv line ${i + 2}: missing ${MGPHOT_GENES.join(', ')}`);
    }
    const artist = r[artistCol] ?? '';
    const title = r[titleCol] ?? '';
    const own = songKey(artist, title);
    if (!exact.has(own)) exact.set(own, genes);
    const first = songKey(leadArtist(artist), title);
    if (!lead.has(first)) lead.set(first, genes);
  });
  const byKey = new Map(exact);
  let viaLead = 0;
  for (const [key, genes] of lead) {
    if (byKey.has(key)) continue;
    byKey.set(key, genes);
    viaLead++;
  }
  return { songs: valueRows.length, byKey, viaLead };
}

/** Store rows: one per key, with the moods the proxy rules give (possibly none). */
export function mgphotRecords(byKey: ReadonlyMap<string, MgphotGenes>): SongMoodsRecord[] {
  return [...byKey].map(([key, genes]) => ({ key, moods: mgphotMoods(genes), method: MGPHOT_METHOD, source: MGPHOT_SOURCE }));
}

/**
 * MGPHot's proxy labels as a stand-in gold set for the gate code, over the given song keys that
 * MGPHot has (each key once). A provisional reference only; the hand-labelled gold set is the
 * real gate. Kept in memory and never saved, since it is derived from MGPHot.
 */
export function mgphotGold(keys: readonly string[], byKey: ReadonlyMap<string, MgphotGenes>): GoldSet {
  const songs = [...new Set(keys)].flatMap((key) => {
    const genes = byKey.get(key);
    if (!genes) return [];
    return [{ key, artist: '', title: '', upbeat: MGPHOT_PROXIES.upbeat.test(genes), heartfelt: MGPHOT_PROXIES.heartfelt.test(genes) }];
  });
  return { labelledBy: 'MGPHot proxy rules (provisional reference)', labelledAt: '', songs };
}
