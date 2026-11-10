// Density report (QWW-5): how one person's matches spread over the results screen's filters, for
// the main list and for Maybe: songs per decade, per label, with and without known popularity, and
// duets. A filter with only a song or two behind it is not worth a chip on the phone.

import type { Decade, Label, Match } from '../contracts';

/** The decade buckets in order: '60s' is 1969 and earlier, '20s' is 2020 on. */
export const DECADES: Decade[] = ['60s', '70s', '80s', '90s', '00s', '10s', '20s'];

export function decadeOf(year: number): Decade {
  const i = Math.floor((year - 1960) / 10);
  return DECADES[Math.min(DECADES.length - 1, Math.max(0, i))]!;
}

export interface FacetCounts {
  songs: number;
  byDecade: Record<Decade, number>;
  /** Songs with no year from USDB or Spotify, so in no decade. */
  noYear: number;
  byLabel: Record<Label, number>;
  /** Popularity from Spotify or USDB, against the flat default when there is neither (score.ts). */
  popularityKnown: number;
  popularityUnknown: number;
  duets: number;
}

export interface FacetReport {
  /** Songs with a label: Easy, Medium or Hard. */
  main: FacetCounts;
  /** The Maybe group (low-confidence ranges). */
  maybe: FacetCounts;
}

function emptyCounts(): FacetCounts {
  return {
    songs: 0,
    byDecade: { '60s': 0, '70s': 0, '80s': 0, '90s': 0, '00s': 0, '10s': 0, '20s': 0 },
    noYear: 0,
    byLabel: { easy: 0, medium: 0, hard: 0, maybe: 0 },
    popularityKnown: 0,
    popularityUnknown: 0,
    duets: 0,
  };
}

export function facetReport(matches: Match[]): FacetReport {
  const report: FacetReport = { main: emptyCounts(), maybe: emptyCounts() };
  for (const m of matches) {
    const c = m.difficulty === 'maybe' ? report.maybe : report.main;
    c.songs++;
    if (m.year === undefined) c.noYear++;
    else c.byDecade[decadeOf(m.year)]++;
    c.byLabel[m.difficulty]++;
    if (m.parts?.popularityKnown) c.popularityKnown++;
    else c.popularityUnknown++;
    if (m.range.duet === true) c.duets++;
  }
  return report;
}

/** The report as a plain-text table, one row per count, the main list and Maybe side by side. */
export function facetTable(r: FacetReport): string {
  const rows: [string, (c: FacetCounts) => number][] = [
    ['Songs', (c) => c.songs],
    ...DECADES.map((d): [string, (c: FacetCounts) => number] => [d === '60s' ? '60s and earlier' : d, (c) => c.byDecade[d]]),
    ['No year', (c) => c.noYear],
    ['Easy', (c) => c.byLabel.easy],
    ['Medium', (c) => c.byLabel.medium],
    ['Hard', (c) => c.byLabel.hard],
    ['Popularity known', (c) => c.popularityKnown],
    ['Popularity unknown', (c) => c.popularityUnknown],
    ['Duets', (c) => c.duets],
  ];
  const lines = [['', 'Main list', 'Maybe'], ...rows.map(([name, count]) => [name, String(count(r.main)), String(count(r.maybe))])];
  const width = Math.max(...lines.map(([name]) => name!.length));
  return lines.map(([name, main, maybe]) => `${name!.padEnd(width)}  ${main!.padStart(9)}  ${maybe!.padStart(5)}`).join('\n') + '\n';
}
