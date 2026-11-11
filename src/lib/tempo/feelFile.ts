// The feel labels file (data/tempo-feel.json, QWW-54) and how it becomes song_feel rows. The labels are made offline
// (see data/tempo-feel.md for how) and kept in the repo, so the production step needs no model and no key: it only
// reads this file. A label is for one song, which the catalogue may know under more than one key (the full credit
// "Mariah Carey & Boyz II Men" and the lead artist "Mariah Carey"), so a label lists every key it applies to.

import { isFeel, type Feel, type SongFeelRecord } from './feel';

export interface FeelFile {
  /** What made the labels: the model or person and the prompt version, for example "claude-opus-5-5/feel-v1". It becomes each row's source. */
  method: string;
  /** ISO date the labels were made. */
  labeledAt: string;
  /** `method` names what made this label when it was not the file's: a second look at a song the first pass called mid. */
  labels: { keys: string[]; feel: Feel; method?: string }[];
}

/** Reads and checks the file; throws on the first thing wrong, naming the label, so a bad file writes nothing. */
export function parseFeelFile(text: string): FeelFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('feel file: not valid JSON');
  }
  const f = raw as Partial<FeelFile> | null;
  if (!f || typeof f !== 'object') throw new Error('feel file: expected an object');
  if (typeof f.method !== 'string' || !f.method.trim()) throw new Error('feel file: "method" is missing');
  if (typeof f.labeledAt !== 'string' || Number.isNaN(Date.parse(f.labeledAt))) throw new Error('feel file: "labeledAt" must be a date');
  if (!Array.isArray(f.labels)) throw new Error('feel file: "labels" must be a list');
  const seen = new Map<string, Feel>();
  f.labels.forEach((l, i) => {
    const where = `feel file: label ${i + 1}`;
    if (!l || !Array.isArray(l.keys) || l.keys.length === 0 || l.keys.some((k) => typeof k !== 'string' || !k.includes('|'))) {
      throw new Error(`${where}: "keys" must be a list of song keys ("artist|title")`);
    }
    if (!isFeel(l.feel)) throw new Error(`${where}: "feel" must be slow, mid or upbeat`);
    if (l.method !== undefined && (typeof l.method !== 'string' || !l.method.trim())) throw new Error(`${where}: "method" must be a non-empty string when given`);
    for (const k of l.keys) {
      const was = seen.get(k);
      if (was !== undefined && was !== l.feel) throw new Error(`${where}: ${k} is labelled both ${was} and ${l.feel}`);
      seen.set(k, l.feel);
    }
  });
  return { method: f.method, labeledAt: f.labeledAt, labels: f.labels };
}

/**
 * One song_feel row per key that is a song of the catalogue, in the file's order; a key the file has twice gives one
 * row. `unmatched` counts the labels none of whose keys is in the catalogue.
 */
export function feelRows(file: FeelFile, catalogueKeys: ReadonlySet<string>): { rows: SongFeelRecord[]; unmatched: number } {
  const rows = new Map<string, SongFeelRecord>();
  let unmatched = 0;
  for (const l of file.labels) {
    const known = l.keys.filter((k) => catalogueKeys.has(k));
    if (!known.length) unmatched++;
    for (const key of known) if (!rows.has(key)) rows.set(key, { key, feel: l.feel, source: l.method ?? file.method, labeledAt: file.labeledAt });
  }
  return { rows: [...rows.values()], unmatched };
}
