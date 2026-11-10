// Which mood label the store keeps when several sources label a song (QWW-11, QWW-19). The store
// has one row per song, and the most trusted source wins: music experts' MGPHot annotations
// first (stored only when the owner opts in; see moods-mgphot-import.ts), then AcousticBrainz's
// audio models, then a language model's memory of the song. A row
// replaces the song's current row unless that row came from a more trusted source, so an LLM
// import never overwrites an MGPHot row, while a relabel from the same source (a newer method,
// or a rerun) replaces the older one. A source that labels a song with no mood still wins: it
// says the song has neither mood.

import { MOODS, type Mood } from '../contracts';
import type { SongMoodsRecord } from '../server/store';
import { AB_SOURCE } from './acousticbrainz';
import { parseLabelRun, toMoodRecords } from './label';
import { MGPHOT_SOURCE } from './mgphot';
import { PROVIDERS } from './providers';

const RANK = new Map<string, number>([
  [MGPHOT_SOURCE, 3],
  [AB_SOURCE, 2],
  ...Object.values(PROVIDERS).map((p) => [p.source, 1] as [string, number]),
]);

/** Higher is more trusted. A source not listed ranks below every listed one. */
export const sourceRank = (source: string): number => RANK.get(source) ?? 0;

/**
 * The rows to write: for each key, the last incoming row that no more trusted row (in the store
 * now, or earlier in the list) outranks. Keys whose current row wins are left out, so writing
 * the result never lowers a song's source.
 */
export function mergeMoodRows(current: ReadonlyMap<string, SongMoodsRecord>, incoming: readonly SongMoodsRecord[]): SongMoodsRecord[] {
  const winners = new Map<string, SongMoodsRecord>();
  for (const row of incoming) {
    const now = winners.get(row.key) ?? current.get(row.key);
    if (now && sourceRank(now.source) > sourceRank(row.source)) continue;
    winners.set(row.key, row);
  }
  return [...winners.values()];
}

// ---------- label files ----------

/** A source's labels as committed: one row per song it has data for, keys and moods only. */
export interface MoodRowsFile {
  source: string;
  method: string;
  songs: { key: string; moods: Mood[] }[];
}

/** JSON with one song per line, so the file stays small and diffs read well. Every row must be the given source's and method's. */
export function formatMoodRows({ comment, source, method }: { comment: string; source: string; method: string }, rows: readonly SongMoodsRecord[]): string {
  if (rows.some((r) => r.source !== source || r.method !== method)) throw new Error(`A labels file holds only ${source} rows made with ${method}`);
  const head = JSON.stringify({ _comment: comment, source, method }, null, 2).replace(/\n}$/, '');
  const lines = rows.map((r) => `    ${JSON.stringify({ key: r.key, moods: r.moods })}`).join(',\n');
  return `${head},\n  "songs": [\n${lines}\n  ]\n}\n`;
}

const isMood = (m: unknown): m is Mood => (MOODS as unknown[]).includes(m);

/**
 * Store rows from a labels file: a run from moods:label (the songs the model knew, under its
 * provider's source), or a source's rows (formatMoodRows). Anything else is refused.
 */
export function readLabelsFile(text: string): SongMoodsRecord[] {
  const data = JSON.parse(text) as Partial<MoodRowsFile> & { calls?: unknown };
  if (data.calls !== undefined) {
    const run = parseLabelRun(text);
    return toMoodRecords(run.labels, run.model, PROVIDERS[run.provider].source);
  }
  const { source, method, songs } = data;
  const ok =
    typeof source === 'string' &&
    typeof method === 'string' &&
    Array.isArray(songs) &&
    songs.every((s) => typeof s?.key === 'string' && Array.isArray(s.moods) && s.moods.every(isMood));
  if (!ok) throw new Error('Not a labels file (expected a moods:label run, or source, method and songs with key and moods)');
  return songs.map((s) => ({ key: s.key, moods: MOODS.filter((m) => s.moods.includes(m)), method, source }));
}
