// Mood labels from a language model (QWW-11): Claude, GPT or Gemini (providers.ts), made offline
// and stored; nothing calls the model at request time. The model gets a batch of about 25 songs
// (artist and title, plus year and genre when known; no lyrics, no audio), answers yes or no per
// mood, and may say it does not know a song. Code
// decides what ships: replies are parsed strictly, songs it does not know get no label, and the
// gate (gate.ts) decides which moods are right often enough to show as chips.

import { MOODS, type Mood } from '../contracts';
import type { SongMoodsRecord } from '../server/store';
import type { Ask, AskRequest } from './ask';
import { isProvider, type Provider } from './providers';

/** Bump when the prompt or the request changes: the method names it, so a relabel replaces older rows. */
export const PROMPT_VERSION = 'moods-v1';
export const BATCH_SIZE = 25;
/** Room for the model's thinking (on by default in Claude 5 models) as well as 25 short answers. */
const MAX_TOKENS = 16_000;

export interface SongToLabel {
  key: string;
  artist: string;
  title: string;
  year?: number;
  genre?: string;
}

/** The model's answer for one song. Moods only count when it knows the song. */
export interface MoodLabel {
  key: string;
  known: boolean;
  upbeat: boolean;
  heartfelt: boolean;
}

export const moodsMethod = (model: string): string => `${model}/${PROMPT_VERSION}`;

/** The moods a label gives a song, in MOODS order (only meaningful when it knows the song). */
export const moodsOf = (l: MoodLabel): Mood[] => MOODS.filter((m) => l[m]);

// The mood wording follows the owner's definitions on QWW-11. Precision comes first because a
// chip lives or dies on it: the songs under "Heartfelt" must be heartfelt.
export const SYSTEM_PROMPT = `You label songs for a karaoke app. Singers can filter their song list with two mood chips:

- upbeat: energetic, happy and danceable. A lively, feel-good song that gets people moving.
- heartfelt: love, heartbreak or a ballad. The song is mainly about love, longing or loss, or it is a slow, emotional ballad.

A song can be both, either or neither. Judge the original recording by this artist from what you know about it; you get only the artist and title, and the year and genre when known.

A chip that shows the wrong songs is worse than one that misses some, so answer true only when you are confident the mood fits. If you do not know this exact song well enough to say how it sounds and what it is about, set "known" to false and both moods to false.

Reply with JSON only: {"labels": [{"key": "...", "known": true, "upbeat": false, "heartfelt": true}]}, one item per song, with each song's key copied exactly as given.`;

/** The reply's shape, enforced by the API (structured outputs) and checked again by parseLabels. */
export const LABELS_SCHEMA = {
  type: 'object',
  properties: {
    labels: {
      type: 'array',
      items: {
        type: 'object',
        // "known" comes before the moods so the model commits to knowing the song first.
        properties: {
          key: { type: 'string' },
          known: { type: 'boolean' },
          upbeat: { type: 'boolean' },
          heartfelt: { type: 'boolean' },
        },
        required: ['key', 'known', 'upbeat', 'heartfelt'],
        additionalProperties: false,
      },
    },
  },
  required: ['labels'],
  additionalProperties: false,
};

/** One request for a batch: the instructions, then one JSON line per song. */
export function labelRequest(songs: SongToLabel[], model: string): AskRequest {
  const lines = songs.map((s) =>
    JSON.stringify({
      key: s.key,
      artist: s.artist,
      title: s.title,
      ...(s.year !== undefined ? { year: s.year } : {}),
      ...(s.genre ? { genre: s.genre } : {}),
    }),
  );
  return {
    model,
    system: SYSTEM_PROMPT,
    user: `Label these ${songs.length} songs:\n${lines.join('\n')}`,
    maxTokens: MAX_TOKENS,
    schema: LABELS_SCHEMA,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isLabel(v: unknown): v is MoodLabel {
  return (
    isRecord(v) &&
    Object.keys(v).length === 4 &&
    typeof v.key === 'string' &&
    typeof v.known === 'boolean' &&
    typeof v.upbeat === 'boolean' &&
    typeof v.heartfelt === 'boolean'
  );
}

export interface ParsedLabels {
  labels: MoodLabel[];
  /**
   * Items dropped: malformed, a key not in the batch, or a key given more than once (every copy
   * goes, since the model said two things about one song). A reply that is not JSON of the
   * expected shape counts every song in the batch.
   */
  dropped: number;
}

/** Strictly reads the model's reply for a batch. Songs it left out are simply not labelled. */
export function parseLabels(text: string, batchKeys: readonly string[]): ParsedLabels {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { labels: [], dropped: batchKeys.length };
  }
  if (!isRecord(body) || Object.keys(body).length !== 1 || !Array.isArray(body.labels)) {
    return { labels: [], dropped: batchKeys.length };
  }
  const wanted = new Set(batchKeys);
  const valid = body.labels.filter((item): item is MoodLabel => isLabel(item) && wanted.has(item.key));
  const times = new Map<string, number>();
  for (const l of valid) times.set(l.key, (times.get(l.key) ?? 0) + 1);
  const labels = valid
    .filter((l) => times.get(l.key) === 1)
    .map((l) => ({ key: l.key, known: l.known, upbeat: l.upbeat, heartfelt: l.heartfelt }));
  return { labels, dropped: body.labels.length - labels.length };
}

/**
 * Store rows for the labels: one per song the model knew (moods may be empty); none for the rest.
 * The source is the provider's (PROVIDERS[p].source), which the import's precedence reads.
 */
export function toMoodRecords(labels: readonly MoodLabel[], model: string, source: string): SongMoodsRecord[] {
  return labels
    .filter((l) => l.known)
    .map((l) => ({ key: l.key, moods: moodsOf(l), method: moodsMethod(model), source }));
}

/** Songs to label from moods:label's input: a list of songs, or a gold set (its songs, without the hand labels). */
export function songsToLabel(data: unknown): SongToLabel[] {
  const list = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.songs) ? data.songs : null;
  if (!list) throw new Error('Expected a list of songs, or a gold set with a "songs" list');
  return list.map((s: unknown, i) => {
    if (!isRecord(s) || typeof s.key !== 'string' || typeof s.artist !== 'string' || typeof s.title !== 'string') {
      throw new Error(`Song ${i + 1} needs a key, an artist and a title`);
    }
    const song: SongToLabel = { key: s.key, artist: s.artist, title: s.title };
    if (typeof s.year === 'number') song.year = s.year;
    if (typeof s.genre === 'string' && s.genre.trim()) song.genre = s.genre.trim();
    return song;
  });
}

// ---------- a labelling run, as moods:label saves it ----------

export interface LabelRun {
  provider: Provider;
  model: string;
  method: string;
  /** API calls made, and tokens in and out (thinking included), for the cost. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Answers that could not be used (see parseLabels). */
  dropped: number;
  labels: MoodLabel[];
}

export interface BatchResult {
  labels: MoodLabel[];
  dropped: number;
  inputTokens: number;
  outputTokens: number;
  /** "end_turn" normally; "max_tokens" or "refusal" mean the reply was cut short or declined. */
  stopReason: string | null;
}

export const newLabelRun = (model: string, provider: Provider = 'anthropic'): LabelRun => ({
  provider,
  model,
  method: moodsMethod(model),
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  dropped: 0,
  labels: [],
});

export function addBatch(run: LabelRun, b: BatchResult): LabelRun {
  return {
    ...run,
    calls: run.calls + 1,
    inputTokens: run.inputTokens + b.inputTokens,
    outputTokens: run.outputTokens + b.outputTokens,
    dropped: run.dropped + b.dropped,
    labels: [...run.labels, ...b.labels],
  };
}

/** JSON with one label per line, so the file stays small and diffs read well. */
export function formatLabelRun(run: LabelRun): string {
  const { labels, ...head } = run;
  const top = JSON.stringify(head, null, 2).replace(/\n}$/, '');
  const rows = labels.map((l) => `    ${JSON.stringify(l)}`).join(',\n');
  return `${top},\n  "labels": [\n${rows}\n  ]\n}\n`;
}

/** Reads a labels file. Files from before there were providers have none and came from Claude. */
export function parseLabelRun(text: string): LabelRun {
  const run = JSON.parse(text) as Partial<LabelRun>;
  const counts = [run.calls, run.inputTokens, run.outputTokens, run.dropped];
  if (typeof run.model !== 'string' || typeof run.method !== 'string' || counts.some((n) => typeof n !== 'number')) {
    throw new Error('Not a labels file from moods:label (no model, method or token counts)');
  }
  if (run.provider !== undefined && !isProvider(run.provider)) throw new Error(`Not a labels file from moods:label (unknown provider ${String(run.provider)})`);
  if (!Array.isArray(run.labels) || !run.labels.every(isLabel)) throw new Error('Not a labels file from moods:label (bad labels)');
  return { ...run, provider: run.provider ?? 'anthropic' } as LabelRun;
}

/**
 * Labels the songs that are not labelled yet, a batch at a time in input order, and hands each
 * batch to onBatch so the caller can save as it goes. A song the reply left out or that was
 * dropped stays unlabelled, so a rerun picks it up. An error from ask (after its retries) stops
 * the run; batches already handed over are kept.
 */
export async function labelSongs({
  songs,
  model,
  ask,
  done = new Set(),
  batchSize = BATCH_SIZE,
  onBatch,
}: {
  songs: SongToLabel[];
  model: string;
  ask: Ask;
  /** Keys labelled by an earlier run. */
  done?: ReadonlySet<string>;
  batchSize?: number;
  onBatch: (batch: BatchResult) => Promise<void> | void;
}): Promise<{ asked: number; labelled: number }> {
  const seen = new Set(done);
  const todo = songs.filter((s) => !seen.has(s.key) && seen.add(s.key));
  let labelled = 0;
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    const reply = await ask(labelRequest(batch, model));
    const { labels, dropped } = parseLabels(reply.text, batch.map((s) => s.key));
    labelled += labels.length;
    await onBatch({ labels, dropped, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, stopReason: reply.stopReason });
  }
  return { asked: todo.length, labelled };
}
