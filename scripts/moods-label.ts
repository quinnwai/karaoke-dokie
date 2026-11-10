// Labels songs with moods using a language model, offline (QWW-11); nothing calls the model at request time.
// Usage: npm run moods:label -- --in songs.json --out labels.json [--provider anthropic|openai|gemini] [--model M] [--resume]
// songs.json is [{ key, artist, title, year?, genre? }], or a gold set (to label just its songs).
// Needs the provider's key: ANTHROPIC_API_KEY (the default provider), OPENAI_API_KEY or
// GEMINI_API_KEY. The labels file is rewritten after every batch, so a stopped run loses at most
// one batch: rerun with --resume to skip the songs already labelled (including those the model
// said it does not know) and ask again about songs a reply left out or got wrong.

import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { addBatch, formatLabelRun, labelSongs, newLabelRun, parseLabelRun, songsToLabel } from '../src/lib/moods/label';
import { isProvider, PROVIDER_NAMES, PROVIDERS } from '../src/lib/moods/providers';

/**
 * List prices in dollars per million tokens (input, output; thinking is output), standard tier,
 * short prompts, as published in Nov 2026. Gemini 3.8 Flash goes to $1.50 and $7.50 on Jan 1, 2027.
 */
const PRICES: Record<string, [number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-sonnet-5-5': [2, 10],
  'gpt-6-luna': [0.1, 0.5],
  'gpt-6.1-terra': [1, 5],
  'gemini-3.8-flash': [0.75, 3.75],
  'gemini-3.5-flash-lite': [0.3, 2.5],
};

async function main() {
  const { values } = parseArgs({
    options: {
      in: { type: 'string' },
      out: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      resume: { type: 'boolean' },
    },
  });
  const out = values.out;
  if (!values.in || !out) throw new Error('Usage: npm run moods:label -- --in songs.json --out labels.json [--provider P] [--model M] [--resume]');
  const provider = values.provider ?? 'anthropic';
  if (!isProvider(provider)) throw new Error(`--provider must be one of ${PROVIDER_NAMES.join(', ')}`);
  const info = PROVIDERS[provider];
  const apiKey = process.env[info.keyEnv];
  if (!apiKey) throw new Error(`Set ${info.keyEnv}`);
  const model = values.model ?? info.defaultModel;
  const songs = songsToLabel(JSON.parse(await readFile(values.in, 'utf8')));

  let run = newLabelRun(model, provider);
  if (existsSync(out)) {
    if (!values.resume) throw new Error(`${out} already exists; pass --resume to carry on with it`);
    run = parseLabelRun(await readFile(out, 'utf8'));
    if (run.provider !== provider || run.model !== model) {
      throw new Error(`${out} was labelled with ${run.provider} ${run.model}; pass --provider ${run.provider} --model ${run.model}, or start a new file`);
    }
  }

  await labelSongs({
    songs,
    model,
    ask: info.create({ apiKey }),
    done: new Set(run.labels.map((l) => l.key)),
    onBatch: async (b) => {
      run = addBatch(run, b);
      // Write then rename, so the file is never half written.
      await writeFile(`${out}.tmp`, formatLabelRun(run));
      await rename(`${out}.tmp`, out);
      const ended = b.stopReason && b.stopReason !== 'end_turn' ? `; the reply ended with ${b.stopReason}` : '';
      console.log(`${run.labels.length} / ${songs.length} labelled, ${run.dropped} answers dropped${ended}`);
    },
  });

  const labelled = new Set(run.labels.map((l) => l.key));
  const left = new Set(songs.map((s) => s.key).filter((k) => !labelled.has(k))).size;
  const known = run.labels.filter((l) => l.known);
  console.log(
    `${run.labels.length} songs labelled (${known.length} known: ${known.filter((l) => l.upbeat).length} upbeat, ` +
      `${known.filter((l) => l.heartfelt).length} heartfelt), ${run.dropped} answers dropped` +
      (left ? `, ${left} songs still without a label: rerun with --resume` : ''),
  );
  const price = PRICES[model];
  const cost = price ? `, about $${((run.inputTokens * price[0] + run.outputTokens * price[1]) / 1e6).toFixed(2)} at list prices` : '';
  console.log(`${run.calls} calls, ${run.inputTokens} tokens in, ${run.outputTokens} out${cost}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
