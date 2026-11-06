// Live-data smoke test for the logged-out (catalogue) results screen. The unit and e2e tests run on
// fixtures, so they cannot tell when a deployment reads a database without the real data: that is how
// a preview once showed unknown songs, no Pick row and sliders that changed nothing (QWW-40). This
// checks what a person would see, for two ranges, and exits 1 when any check fails:
//   - the Pick row has data (several decades), duets exist
//   - 95% of the shown songs have a known popularity, a tempo and a year (90%)
//   - the first 20 songs are well known (median popularity score 0.7 or more)
//   - each slider (difficulty, popularity, tempo) moves the list: the first 10 at each end differ
// Usage: npm run smoke:live                      reads DATABASE_URL directly
//        npm run smoke:live -- --url https://<deployment>   calls the deployed API instead
//          (a protected preview needs VERCEL_BYPASS_TOKEN, the project's protection-bypass secret)

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Match, RecommendationsResponse, VocalRange } from '../src/lib/contracts';
import { catalogueTracks, loadCatalogue, recommendCatalogue } from '../src/lib/server/catalogue';
import { neonQuery } from '../src/lib/server/getStore';
import { createPostgresStore } from '../src/lib/server/postgresStore';
import { productionSongDeps } from '../src/lib/server/wiring';
import { availableFacets, DEFAULT_VIEW, orderMatches } from '../src/lib/songs/browse';
import type { SliderId } from '../src/lib/contracts';

const RANGES: [string, VocalRange][] = [
  ['F2 to C5', { low: 41, high: 72, source: 'songs' }],
  ['D#2 to A#4', { low: 39, high: 70, source: 'songs' }],
];

const share = (ms: Match[], f: (m: Match) => boolean) => ms.filter(f).length / Math.max(1, ms.length);
const ids = (ms: Match[]) => ms.slice(0, 10).map((m) => m.track.id).join('|');
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;
const first10 = (ms: Match[], f: (m: Match) => number | undefined) => median(ms.slice(0, 10).map((m) => f(m) ?? NaN).filter((n) => !Number.isNaN(n)));

// Thresholds: a healthy preview measured on Nov 6 2026 had 1,000 songs shown, 98% tempo, 95% year and
// popularity known for all; the numbers below leave room under that and sit far above a database
// without the data (0% on each). They are not tuned to be tight.

export function check(label: string, matches: Match[], range: VocalRange): string[] {
  const fails: string[] = [];
  const need = (ok: boolean, what: string) => {
    if (!ok) fails.push(`${label}: ${what}`);
  };
  need(matches.length >= 500, `only ${matches.length} songs shown (want 500 or more)`);
  const facets = availableFacets(matches);
  const decades = new Set(matches.filter((m) => typeof m.year === 'number').map((m) => Math.floor(m.year! / 10))).size;
  need(facets.decades && decades >= 3, `Pick row has no decade data (${decades} decades); a deployment without USDB years looks like this`);
  need(facets.duets, 'no duets');
  need(share(matches, (m) => !!m.parts?.popularityKnown) >= 0.95, `popularity known for only ${(100 * share(matches, (m) => !!m.parts?.popularityKnown)).toFixed(0)}% (want 95%)`);
  need(share(matches, (m) => typeof m.tempo === 'number') >= 0.95, `tempo for only ${(100 * share(matches, (m) => typeof m.tempo === 'number')).toFixed(0)}% (want 95%)`);
  need(share(matches, (m) => typeof m.year === 'number') >= 0.9, `year for only ${(100 * share(matches, (m) => typeof m.year === 'number')).toFixed(0)}% (want 90%)`);
  const first20 = matches.slice(0, 20).map((m) => m.parts?.popularity ?? 0);
  need(median(first20) >= 0.7, `the first 20 songs are not well known (median popularity ${median(first20).toFixed(2)}, want 0.7 or more)`);
  for (const id of ['difficulty', 'popularity', 'tempo'] as SliderId[]) {
    const low = orderMatches(matches, { ...DEFAULT_VIEW, [id]: 0 }, range, 'catalogue');
    const high = orderMatches(matches, { ...DEFAULT_VIEW, [id]: 1 }, range, 'catalogue');
    need(ids(low) !== ids(high), `the ${id} slider does not change the first 10 songs`);
    // The right end must hold higher values than the left, so a slider wired to the wrong field fails too.
    const field = id === 'tempo' ? (m: Match) => m.tempo : id === 'popularity' ? (m: Match) => m.parts?.popularity : null;
    if (field) {
      const gap = id === 'tempo' ? 10 : 0.05;
      need(first10(high, field) - first10(low, field) >= gap, `the ${id} slider's two ends are not ${id === 'tempo' ? 'slow to fast' : 'deep cuts to hits'} (median of the first 10: ${first10(low, field).toFixed(2)} at 0, ${first10(high, field).toFixed(2)} at 1)`);
    }
  }
  return fails;
}

async function main() {
  const { values } = parseArgs({ options: { url: { type: 'string' } } });
  let load: (range: VocalRange) => Promise<Match[]>;
  if (values.url) {
    const base = values.url.replace(/\/$/, '');
    const headers: Record<string, string> = process.env.VERCEL_BYPASS_TOKEN ? { 'x-vercel-protection-bypass': process.env.VERCEL_BYPASS_TOKEN } : {};
    load = async (r) => {
      const res = await fetch(`${base}/api/catalogue/recommendations?low=${r.low}&high=${r.high}&all=1`, { headers, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`${base} answered HTTP ${res.status} (a protected preview needs VERCEL_BYPASS_TOKEN)`);
      const body = (await res.json().catch(() => null)) as RecommendationsResponse | null;
      if (!body || !Array.isArray(body.matches)) throw new Error(`${base} did not answer with a list of matches (a login page, or an error)`);
      return body.matches;
    };
  } else {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) throw new Error('Set DATABASE_URL, or pass --url');
    console.log(`Reading database ${url.split('@')[1]?.split('?')[0] ?? '(unparsed)'} directly; use --url <deployment> to check what a deployment reads.`);
    const store = createPostgresStore(neonQuery(url));
    const tracks = catalogueTracks(await loadCatalogue(store));
    const deps = productionSongDeps(store, false);
    load = async (r) => recommendCatalogue(tracks, r, deps, { all: true }).matches;
  }
  const fails: string[] = [];
  for (const [label, range] of RANGES) {
    const matches = await load(range);
    const f = check(label, matches, range);
    console.log(`${f.length ? 'FAIL' : 'ok  '} ${label}: ${matches.length} songs; first 5: ${matches.slice(0, 5).map((m) => `${m.track.artist} - ${m.track.title}`).join('; ')}`);
    fails.push(...f);
  }
  if (fails.length) {
    console.error(`\n${fails.length} check(s) failed:\n${fails.map((f) => `- ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('\nAll live-data checks passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
