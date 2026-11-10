// Release eval harness (QWW-52): a pass/fail table for the QWW-42 success criteria 1 to 4 and 6, on
// five fixed test ranges (src/lib/eval/release.ts). Reads the catalogue straight from Postgres with
// SELECT only, ranks it with this checkout's code, and checks what a logged-out singer would see.
//
//   1  recognisable: the bundled Billboard Year-End list (data/billboard-year-end.csv) or a high Deezer rank
//   2  tempo: an LLM judges every song in each era's slow and upbeat top 20, 3 runs in parallel, seeing
//      only artist, title and year; a song fits only when all 3 runs agree
//   3  never empty, 4  titles, 6  play: Deezer is asked whether each top-20 song has a 30 s preview
//
// Usage: npm run eval:release -- [--db production|preview] [--runs 3] [--provider anthropic|openai|gemini]
//                                [--model <id>] [--skip-judge] [--skip-play] [--out eval-out]
// Needs DATABASE_URL_UNPOOLED or DATABASE_URL (production's; --db preview reads karaoke_pr4_preview on
// the same host) and, for the judge, the first of ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY
// that is set (Claude Sonnet, or the provider's default model in moods/providers.ts). Writes <out>/release-<db>-<time>.md and .json,
// prints the Markdown, and exits 1 when any check fails.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Match } from '../src/lib/contracts';
import {
  checkNeverEmpty,
  checkPlay,
  checkRecognisable,
  checkTempo,
  checkTitles,
  judgeList,
  JUDGE_SCHEMA,
  JUDGE_SYSTEM,
  judgePrompt,
  judgeSongs,
  parseJudgeReply,
  sample,
  TEST_RANGES,
  tempoLists,
  toMarkdown,
  topTen,
  type Check,
  type JudgeLabel,
  type RangeInput,
  type SongFacts,
  VIEWS,
} from '../src/lib/eval/release';
import { isProvider, PROVIDER_NAMES, PROVIDERS } from '../src/lib/moods/providers';
import { billboardCharts } from '../src/lib/popularity/import';
import { catalogueTracks, loadCatalogue, recommendCatalogue } from '../src/lib/server/catalogue';
import { withoutDuetsAndMoods } from '../src/lib/server/features';
import { neonQuery } from '../src/lib/server/getStore';
import { createPostgresStore, type QueryFn } from '../src/lib/server/postgresStore';
import { productionSongDeps } from '../src/lib/server/wiring';

const JUDGE_BATCH = 40;
const PARALLEL = 4;

/** Every statement must be a read; anything else throws before it reaches the database. */
function selectOnly(query: QueryFn): QueryFn {
  return (text, params) => {
    if (!/^\s*(select|with)\b/i.test(text)) throw new Error(`eval:release reads only; refused: ${text.slice(0, 60)}`);
    return query(text, params);
  };
}

function databaseUrl(db: string): string {
  const url = (process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || '').trim();
  if (!url) throw new Error('Set DATABASE_URL_UNPOOLED or DATABASE_URL (production, from vercel env pull)');
  if (db === 'production') return url;
  if (db === 'preview') return url.replace(/\/neondb(\?|$)/, '/karaoke_pr4_preview$1');
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

/** Whether Deezer has a 30 s preview for the track. Deezer answers a quota error with HTTP 200 and code 4. */
async function deezerPlayable(id: number): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://api.deezer.com/track/${id}`, { signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => null)) as { preview?: string; readable?: boolean; error?: { code?: number } } | null;
    if (body?.error?.code === 4 || res.status === 429) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    return !!body && !body.error && body.readable !== false && typeof body.preview === 'string' && body.preview.length > 0;
  }
  return false;
}

async function main() {
  const { values } = parseArgs({
    options: {
      db: { type: 'string', default: 'production' },
      runs: { type: 'string', default: '3' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'skip-judge': { type: 'boolean' },
      'skip-play': { type: 'boolean' },
      out: { type: 'string', default: 'eval-out' },
    },
  });
  const db = values.db!;
  const runs = Number(values.runs);
  const query = selectOnly(neonQuery(databaseUrl(db)));
  const store = createPostgresStore(query, { autoMigrate: false });

  const [entries, deezer, billboardCsv] = await Promise.all([
    loadCatalogue(store),
    store.listSongDeezer(),
    readFile(new URL('../data/billboard-year-end.csv', import.meta.url), 'utf8'),
  ]);
  const billboard = new Set(billboardCharts(billboardCsv).keys());
  const tracks = catalogueTracks(entries);
  const deps = productionSongDeps(store, false);
  const bpm = new Map(entries.map((e) => [`cat:${e.key}`, e.tempo]));

  // What the API sends a logged-out singer: every match ranked, duet and mood markers off (QWW-43).
  const inputs: RangeInput[] = TEST_RANGES.map((test) => ({
    test,
    matches: recommendCatalogue(tracks, test.range, deps, { all: true }).matches.map(withoutDuetsAndMoods),
  }));

  const facts = new Map<string, SongFacts>();
  const fact = (id: string) => facts.get(id) ?? (facts.set(id, {}), facts.get(id)!);
  for (const t of tracks) {
    const d = deezer.get(t.key);
    if (d?.rank !== undefined) fact(t.track.id).deezerRank = d.rank;
  }

  const meta = [
    `Database: ${db} (${entries.length} catalogue songs), code: this checkout, logged out, duets and moods off.`,
    'Ranges: ' + TEST_RANGES.map((t) => t.label).join('; ') + '.',
  ];
  const checks: Check[] = [];
  for (const t of inputs) checks.push(checkRecognisable(t, billboard, facts), checkNeverEmpty(t), checkTitles(t));

  // 6. Play: ask Deezer about every top-20 song once.
  if (!values['skip-play']) {
    const top = new Map<string, Match>();
    for (const t of inputs) for (const m of VIEWS.default(t.matches, t.test.range).slice(0, 20)) top.set(m.track.id, m);
    const ids = [...top.keys()];
    const playable = await pool(ids, 5, async (id) => {
      const d = deezer.get(id.replace(/^cat:/, ''));
      return d?.deezerId ? deezerPlayable(d.deezerId) : false;
    });
    ids.forEach((id, i) => (fact(id).playable = playable[i]));
    for (const t of inputs) checks.push(checkPlay(t, facts));
    meta.push(`Play: ${ids.length} top-20 songs asked of Deezer's track API (a stored Deezer id with a non-empty preview).`);
  } else meta.push('Play: skipped (--skip-play).');

  // 2. Tempo: judge each song once per run, the runs in parallel.
  let tempoSample: Parameters<typeof toMarkdown>[0]['tempoSample'] = [];
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
    const batches: { key: string; song: { artist: string; title: string; year?: number } }[][] = [];
    for (let i = 0; i < songs.length; i += JUDGE_BATCH) batches.push(songs.slice(i, i + JUDGE_BATCH));
    const oneRun = () =>
      pool(batches, PARALLEL, async (batch) => {
        const res = await ask({
          model,
          system: JUDGE_SYSTEM,
          user: judgePrompt(batch.map((b, id) => ({ id, ...b.song }))),
          maxTokens: 4000,
          schema: JUDGE_SCHEMA,
        });
        const got = parseJudgeReply(res.text);
        return batch.map((b, id): [string, JudgeLabel] => [b.key, got.get(id) ?? 'unknown']);
      }).then((parts) => new Map(parts.flat()));
    const runMaps = await Promise.all(Array.from({ length: runs }, oneRun));
    const labels = new Map(songs.map((s) => [s.key, runMaps.map((r) => r.get(s.key) ?? 'unknown')]));
    const results = lists.map((l) => judgeList(l, labels));
    for (const t of TEST_RANGES) checks.push(checkTempo(t.id, results));
    const flaky = [...labels.values()].filter((l) => new Set(l).size > 1).length;
    meta.push(`Tempo judge: ${provider} ${model}, ${runs} runs in parallel over ${songs.length} songs; ${flaky} songs got different labels across runs (counted as misses).`);
    tempoSample = sample(
      lists.flatMap((l) => l.songs.map((m) => ({ m, l }))),
      20,
    ).map(({ m, l }) => ({
      artist: m.track.artist,
      title: m.track.title,
      year: m.year,
      bpm: bpm.get(m.track.id),
      era: l.era ?? 'any',
      end: l.end,
      labels: labels.get(m.track.id.replace(/^cat:/, '')) ?? [],
    }));
  } else meta.push('Tempo: skipped (--skip-judge).');

  const report = {
    title: `Release eval, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    checks,
    top10: inputs.map((t) => ({ range: t.test, songs: topTen(t) })),
    tempoSample,
    meta,
  };
  const md = toMarkdown(report);
  await mkdir(values.out!, { recursive: true });
  const stem = join(values.out!, `release-${db}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await writeFile(`${stem}.md`, md);
  await writeFile(`${stem}.json`, JSON.stringify(report, null, 2));
  console.log(md);
  console.error(`Wrote ${stem}.md and .json`);
  if (checks.some((c) => !c.pass)) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
