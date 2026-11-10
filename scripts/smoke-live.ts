// Live-data smoke test for the logged-out (catalogue) results screen. The unit and e2e tests run on
// fixtures, so they cannot tell when a deployment reads a database without the real data: that is how
// a preview once showed unknown songs, no Pick row and sliders that changed nothing (QWW-40). This
// checks what a person would see, for two ranges, and exits 1 when any check fails:
//   - the Pick row has data (several decades), duets exist (unless the deployment hides them, see --duets)
//   - 95% of the shown songs have a known popularity, a tempo and a year (90%)
//   - the first 20 songs are well known (median popularity score 0.7 or more)
//   - each slider (difficulty, popularity, tempo) moves the list: the first 10 at each end differ
//   - 90% of the first 20 songs on screen have a Deezer id, which the row's play button needs (QWW-48); with --url,
//     90% of them also play: the deployment's /api/preview redirects to Deezer, and Deezer sends audio
// Usage: npm run smoke:live                      reads DATABASE_URL directly
//        npm run smoke:live -- --url https://<deployment>   calls the deployed API instead
//          (a protected preview needs VERCEL_BYPASS_TOKEN, the project's protection-bypass secret, or in a checkout
//          linked to the project: vercel env run -- npm run smoke:live -- --url <preview>)
//          Duets are hidden unless the deployment has DUETS_AND_MOODS=on (QWW-43), so its API sends none
//          and this does not look for them; add --duets for a deployment that has the switch on. Reading
//          the database always looks for them, because the data must be there for the day it is switched on.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Match, RecommendationsResponse, VocalRange } from '../src/lib/contracts';
import { catalogueTracks, loadCatalogue, recommendCatalogue } from '../src/lib/server/catalogue';
import { neonQuery } from '../src/lib/server/getStore';
import { createPostgresStore } from '../src/lib/server/postgresStore';
import { productionSongDeps } from '../src/lib/server/wiring';
import { isDeezerPreviewLink } from '../src/lib/server/preview';
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

export function check(label: string, matches: Match[], range: VocalRange, opts: { duets: boolean } = { duets: true }): string[] {
  const fails: string[] = [];
  const need = (ok: boolean, what: string) => {
    if (!ok) fails.push(`${label}: ${what}`);
  };
  need(matches.length >= 500, `only ${matches.length} songs shown (want 500 or more)`);
  const facets = availableFacets(matches);
  const decades = new Set(matches.filter((m) => typeof m.year === 'number').map((m) => Math.floor(m.year! / 10))).size;
  need(facets.decades && decades >= 3, `Pick row has no decade data (${decades} decades); a deployment without USDB years looks like this`);
  if (opts.duets) need(facets.duets, 'no duets');
  need(share(matches, (m) => !!m.parts?.popularityKnown) >= 0.95, `popularity known for only ${(100 * share(matches, (m) => !!m.parts?.popularityKnown)).toFixed(0)}% (want 95%)`);
  need(share(matches, (m) => typeof m.tempo === 'number') >= 0.95, `tempo for only ${(100 * share(matches, (m) => typeof m.tempo === 'number')).toFixed(0)}% (want 95%)`);
  need(share(matches, (m) => typeof m.year === 'number') >= 0.9, `year for only ${(100 * share(matches, (m) => typeof m.year === 'number')).toFixed(0)}% (want 90%)`);
  const first20 = matches.slice(0, 20).map((m) => m.parts?.popularity ?? 0);
  need(median(first20) >= 0.7, `the first 20 songs are not well known (median popularity ${median(first20).toFixed(2)}, want 0.7 or more)`);
  // Without song_deezer the row's play button is disabled on every song (QWW-48).
  const withId = share(onScreen(matches, range), (m) => typeof m.deezerId === 'number');
  need(withId >= 0.9, `only ${(100 * withId).toFixed(0)}% of the first 20 songs on screen have a Deezer id for the play button (want 90%)`);
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

/** The first 20 songs as the screen shows them before any control is touched. */
export function onScreen(matches: Match[], range: VocalRange): Match[] {
  return orderMatches(matches, DEFAULT_VIEW, range, 'catalogue').slice(0, 20);
}

/**
 * With --url: plays the songs' previews as a phone does (QWW-48). The deployment's /api/preview/<id> must redirect to
 * Deezer's CDN, and the link must answer with audio. A song without a Deezer id counts as not playable.
 */
export async function previewProblems(base: string, headers: Record<string, string>, songs: Match[]): Promise<{ playable: number; problems: string[] }> {
  const problems: string[] = [];
  let playable = 0;
  for (const m of songs) {
    const name = `${m.track.artist} - ${m.track.title}`;
    if (typeof m.deezerId !== 'number') {
      problems.push(`${name}: no Deezer id`);
      continue;
    }
    // One at a time, to stay far under Deezer's limit.
    const res = await fetch(`${base}/api/preview/${m.deezerId}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const to = res.headers.get('location') ?? '';
    if (res.status !== 302 || !isDeezerPreviewLink(to)) {
      problems.push(`${name}: /api/preview/${m.deezerId} answered HTTP ${res.status}${to ? ` to ${to.split('?')[0]}` : ''}`);
      continue;
    }
    const audio = await fetch(to, { headers: { range: 'bytes=0-1' }, signal: AbortSignal.timeout(15_000) });
    const type = audio.headers.get('content-type') ?? '';
    await audio.body?.cancel();
    if ((audio.status !== 200 && audio.status !== 206) || !type.startsWith('audio/')) {
      problems.push(`${name}: Deezer's link answered HTTP ${audio.status} (${type || 'no type'})`);
      continue;
    }
    playable++;
  }
  return { playable, problems };
}

async function main() {
  const { values } = parseArgs({ options: { url: { type: 'string' }, duets: { type: 'boolean' } } });
  // A deployment sends duets only with DUETS_AND_MOODS=on; the database always has them (QWW-43).
  const duets = !values.url || values.duets === true;
  let load: (range: VocalRange) => Promise<Match[]>;
  // A protected preview takes the project's bypass secret, or the short-lived token that `vercel env run` gives a
  // checkout linked to the project (sent to the deployment only, never to Deezer).
  const bypass: Record<string, string> = process.env.VERCEL_BYPASS_TOKEN
    ? { 'x-vercel-protection-bypass': process.env.VERCEL_BYPASS_TOKEN }
    : process.env.VERCEL_OIDC_TOKEN
      ? { 'x-vercel-trusted-oidc-idp-token': process.env.VERCEL_OIDC_TOKEN }
      : {};
  if (values.url) {
    const base = values.url.replace(/\/$/, '');
    load = async (r) => {
      const res = await fetch(`${base}/api/catalogue/recommendations?low=${r.low}&high=${r.high}&all=1`, { headers: bypass, signal: AbortSignal.timeout(60_000) });
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
    const f = check(label, matches, range, { duets });
    if (values.url) {
      const shown = onScreen(matches, range);
      const { playable, problems } = await previewProblems(values.url.replace(/\/$/, ''), bypass, shown);
      console.log(`     ${label}: ${playable} of the first ${shown.length} songs play${problems.length ? `; not: ${problems.join('; ')}` : ''}`);
      if (playable < 0.9 * shown.length) f.push(`${label}: only ${playable} of the first ${shown.length} songs play a preview (want 90%)`);
    }
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
