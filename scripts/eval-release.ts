// Release eval harness (QWW-52): a pass/fail table for the QWW-42 success criteria 1 to 4 and 6, on
// five fixed test ranges (src/lib/eval/release.ts). Reads the catalogue straight from Postgres with
// SELECT only, ranks it with this checkout's tuner engine (POST /api/setlist), and checks what a
// logged-out singer would see.
//
//   1  recognisable: the bundled Billboard Year-End list (data/billboard-year-end.csv) or a high Deezer rank
//   2  tempo: an LLM judges every song in each era's slow and upbeat top 20, 3 runs in parallel, seeing
//      only artist, title and year; a song counts when 2 of the 3 runs give the end's label, and an end
//      passes with 18 of its top 20 counting
//   3  never empty, 4  titles, 6  play: Deezer is asked whether each top-20 song has a 30 s preview
//
// Usage: npm run eval:release -- [--db production|preview] [--provider anthropic|openai|gemini]
//                                [--model <id>] [--skip-judge] [--skip-play] [--out eval-out]
// Needs DATABASE_URL_UNPOOLED or DATABASE_URL (production's; --db preview reads karaoke_pr4_preview on
// the same host) and, for the judge, the first of ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY
// that is set (Claude Sonnet, or the provider's default model in moods/providers.ts). Writes <out>/release-<db>-<time>.md and .json,
// prints the Markdown, and exits 1 unless every criterion ran and passed.

import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Match } from '../src/lib/contracts';
import {
  checkNeverEmpty,
  checkPlay,
  checkRecognisable,
  checkTempo,
  checkTitles,
  handCheck,
  judgeList,
  JUDGE_RUNS,
  JUDGE_SCHEMA,
  JUDGE_SYSTEM,
  judgePrompt,
  judgeSongs,
  parseJudgeReply,
  shuffled,
  TEST_RANGES,
  tempoLists,
  toMarkdown,
  verdict,
  topTen,
  type Check,
  type JudgeLabel,
  type RangeInput,
  type Report,
  type SongFacts,
  VIEWS,
} from '../src/lib/eval/release';
import { isProvider, PROVIDER_NAMES, PROVIDERS } from '../src/lib/moods/providers';
import { billboardCharts } from '../src/lib/popularity/import';
import { catalogueTracks, loadCatalogue, prepareCatalogue } from '../src/lib/server/catalogue';
import { neonQuery } from '../src/lib/server/getStore';
import { createPostgresStore, type QueryFn } from '../src/lib/server/postgresStore';
import { productionSongDeps } from '../src/lib/server/wiring';

const JUDGE_BATCH = 40;
const PARALLEL = 4;

/**
 * Every statement must be a plain read; anything else throws before it reaches the database. A
 * statement that names a writing command anywhere (a data-modifying CTE included) is refused too.
 */
const WRITES = /\b(insert|update|delete|merge|upsert|create|alter|drop|truncate|grant|revoke|copy|vacuum|call|do)\b/i;
export function selectOnly(query: QueryFn): QueryFn {
  return (text, params) => {
    if (!/^\s*(select|with)\b/i.test(text) || WRITES.test(text)) throw new Error(`eval:release reads only; refused: ${text.slice(0, 60)}`);
    return query(text, params);
  };
}

function databaseUrl(db: string): string {
  const url = (process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || '').trim();
  if (!url) throw new Error('Set DATABASE_URL_UNPOOLED or DATABASE_URL (production, from vercel env pull)');
  if (db === 'production') return url;
  if (db === 'preview') {
    const u = new URL(url);
    if (u.pathname !== '/neondb') throw new Error(`--db preview expects production's URL (database neondb), got ${u.pathname}`);
    u.pathname = '/karaoke_pr4_preview';
    return u.toString();
  }
  throw new Error(`--db must be production or preview, not ${db}`);
}

/** Runs `f` over `items`, at most `n` at a time, keeping order. */
async function pool<T, R>(items: T[], n: number, f: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await f(items[i]!);
      }
    }),
  );
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Whether Deezer has a 30 s preview for the track, or 'error' when it could not be asked (quota still
 * hit after retries, network). Deezer answers a quota error with HTTP 200 and code 4.
 */
async function deezerPlayable(id: number): Promise<boolean | 'error'> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://api.deezer.com/track/${id}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    const body = (await res.json().catch(() => null)) as { preview?: string; readable?: boolean; error?: { code?: number } } | null;
    if (body?.error?.code === 4 || res.status === 429) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (!body) return 'error';
    return !body.error && body.readable !== false && typeof body.preview === 'string' && body.preview.length > 0;
  }
  return 'error';
}

async function main() {
  const { values } = parseArgs({
    options: {
      db: { type: 'string', default: 'production' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'skip-judge': { type: 'boolean' },
      'skip-play': { type: 'boolean' },
      out: { type: 'string', default: 'eval-out' },
    },
  });
  const db = values.db!;
  const query = selectOnly(neonQuery(databaseUrl(db)));
  const store = createPostgresStore(query, { autoMigrate: false });

  const [entries, deezer, billboardCsv] = await Promise.all([
    // As the app loads it (wiring.ts): one row per song, with its clean title (QWW-49's song_canonical).
    loadCatalogue(store, undefined, { canonical: true }),
    store.listSongDeezer(),
    readFile(new URL('../data/billboard-year-end.csv', import.meta.url), 'utf8'),
  ]);
  // The app retries a failed read of the clean titles within a minute; a graded run must not use the stored ones.
  if (entries.degraded) throw new Error('Could not read song_canonical, so the titles would be as stored, not as the app shows them. Run again.');
  const billboard = new Set(billboardCharts(billboardCsv).keys());
  const tracks = catalogueTracks(entries);
  const deps = productionSongDeps(store, false);

  // The songs POST /api/setlist ranks for a logged-out singer: the range filter, then every song's place on every gear.
  const inputs: RangeInput[] = TEST_RANGES.map((test) => ({ test, prepared: prepareCatalogue(tracks, test.range, deps).prepared }));

  const facts = new Map<string, SongFacts>();
  const fact = (id: string) => facts.get(id) ?? (facts.set(id, {}), facts.get(id)!);
  for (const t of tracks) {
    const d = deezer.get(t.key);
    if (d?.rank !== undefined) fact(t.track.id).deezerRank = d.rank;
  }

  const meta = [
    `Database: ${db} (${entries.length} catalogue songs, titles as the app shows them), code: this checkout, logged out.`,
    'Lists: the tuner engine (POST /api/setlist). Criteria 1, 4 and 6 read the list as the tuner opens (Popularity and Difficulty on); criterion 2 reads each era with Tempo alone at each end.',
    'Ranges: ' + TEST_RANGES.map((t) => t.label).join('; ') + '.',
  ];
  const checks: Check[] = [];
  for (const t of inputs) checks.push(checkRecognisable(t, billboard, facts), checkNeverEmpty(t), checkTitles(t));

  // 6. Play: ask Deezer about every top-20 song once.
  if (!values['skip-play']) {
    const top = new Map<string, Match>();
    for (const t of inputs) for (const m of VIEWS.default(t.prepared).slice(0, 20)) top.set(m.track.id, m);
    const ids = [...top.keys()];
    const playable = await pool(ids, 5, async (id): Promise<boolean | 'error'> => {
      const d = deezer.get(id.replace(/^cat:/, ''));
      return d?.deezerId ? deezerPlayable(d.deezerId) : false;
    });
    ids.forEach((id, i) => (fact(id).playable = playable[i]));
    for (const t of inputs) checks.push(checkPlay(t, facts));
    meta.push(`Play: ${ids.length} top-20 songs asked of Deezer's track API (a stored Deezer id with a non-empty preview).`);
  } else meta.push('Play: skipped (--skip-play).');

  // 2. Tempo: judge each song once per run, the runs in parallel.
  let hand: Report['handCheck'] = null;
  if (!values['skip-judge']) {
    // The first provider with a key, unless --provider names one.
    const keyOf = (p: keyof typeof PROVIDERS) => process.env[PROVIDERS[p].keyEnv]?.trim();
    const provider = values.provider ?? PROVIDER_NAMES.find((p) => keyOf(p));
    if (!isProvider(provider) || !keyOf(provider)) {
      throw new Error(`The tempo judge needs one of ${PROVIDER_NAMES.map((p) => PROVIDERS[p].keyEnv).join(', ')} (or --skip-judge)`);
    }
    const model = values.model ?? (provider === 'anthropic' ? 'claude-sonnet-5-5' : PROVIDERS[provider].defaultModel);
    const ask = PROVIDERS[provider].create({ apiKey: keyOf(provider)! });
    const lists = inputs.flatMap(tempoLists);
    const songs = judgeSongs(lists);
    // Ids the replies left out or mangled: they count as unknown, so this says how much the judge failed to answer.
    let missing = 0;
    // Each run sees the songs in its own shuffled order, never the lists' order (sorted by stored tempo).
    const oneRun = (run: number) => {
      const order = shuffled(songs, run + 1);
      const batches: (typeof songs)[] = [];
      for (let i = 0; i < order.length; i += JUDGE_BATCH) batches.push(order.slice(i, i + JUDGE_BATCH));
      return pool(batches, PARALLEL, async (batch) => {
        const res = await ask({
          model,
          system: JUDGE_SYSTEM,
          user: judgePrompt(batch.map((b, id) => ({ id, ...b.song }))),
          maxTokens: 4000,
          schema: JUDGE_SCHEMA,
        });
        const got = parseJudgeReply(res.text);
        missing += batch.length - batch.filter((_, id) => got.has(id)).length;
        return batch.map((b, id): [string, JudgeLabel] => [b.key, got.get(id) ?? 'unknown']);
      }).then((parts) => new Map(parts.flat()));
    };
    const runMaps = await Promise.all(Array.from({ length: JUDGE_RUNS }, (_, run) => oneRun(run)));
    const labels = new Map(songs.map((s) => [s.key, runMaps.map((r) => r.get(s.key) ?? 'unknown')]));
    const results = lists.map((l) => judgeList(l, labels));
    for (const t of TEST_RANGES) checks.push(checkTempo(t.id, results));
    const split = [...labels.values()].filter((l) => new Set(l).size > 1).length;
    meta.push(
      `Tempo judge: ${provider} ${model}, ${JUDGE_RUNS} runs in parallel over ${songs.length} songs, each run in its own shuffled order; the runs split on ${split} songs, and ${missing} of ${JUDGE_RUNS * songs.length} answers were missing from the replies (counted as unknown).`,
    );
    hand = handCheck(lists, labels);
  } else meta.push('Tempo: skipped (--skip-judge).');

  const report: Report = {
    title: `Release eval, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    checks,
    top10: inputs.map((t) => ({ range: t.test, songs: topTen(t) })),
    handCheck: hand,
    meta,
  };
  report.meta.push('Not checked by the harness: 1b (Quinn-Wai recognises 8 of the top 10, list below), 2b (Quinn-Wai hand-checks the tempo lists below), 5 (octave), 7 (design), 8 (funnel). Criterion 4 flags every variant, including one that is the more popular version.');
  const md = toMarkdown(report);
  await mkdir(values.out!, { recursive: true });
  const stem = join(values.out!, `release-${db}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await writeFile(`${stem}.md`, md);
  await writeFile(`${stem}.json`, JSON.stringify(report, null, 2));
  console.log(md);
  console.error(`Wrote ${stem}.md and .json`);
  if (verdict(checks) !== 'PASS') process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
