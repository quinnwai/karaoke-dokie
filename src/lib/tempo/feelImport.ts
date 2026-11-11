// What `npm run tempo:feel` decides (QWW-54), kept here so it can be tested without a database: whether a write may go
// ahead, which rows it would write, and what they do to the Tempo gear.

import { effectiveTempo, feelOfTempo, type SongFeelRecord } from './feel';
import { feelRows, type FeelFile } from './feelFile';
import { tempoOf, type SongTempoRecord } from './tempo';

/** The database agents build and measure in. */
export const SCRATCH_DB = 'karaoke_pr4_preview';

/**
 * Why a write to `db` is refused, or null when it may go ahead. The scratch database takes writes; any other
 * (production's neondb) only when --production is given together with --confirm-database naming that database.
 */
export function writeRefusal(db: string, flags: { production?: boolean; confirmDatabase?: string }): string | null {
  if (db === SCRATCH_DB) return null;
  if (flags.production && flags.confirmDatabase === db) return null;
  return `Refusing to write to ${db}. This step writes to ${SCRATCH_DB}; for another database pass both --production and --confirm-database ${db}.`;
}

export interface FeelPlan {
  rows: SongFeelRecord[];
  /** Labels in the file that no catalogue song matches. */
  unmatched: number;
  /** The rows that are missing or different in song_feel; a row only differing in its time is not one. */
  toWrite: SongFeelRecord[];
  added: number;
  /** What the labels do to the songs they label, against the measured rule alone. */
  effect: { sameBand: number; moved: number; noMeasured: number; fromLabelAlone: number; halved: number; doubled: number; clamped: number };
  /** One line for each song that moves to another band: catalogue position (1 is the most popular), song, old and new tempo. */
  moves: string[];
}

export function planFeelImport(input: {
  /** The catalogue, most popular first. */
  catalogue: { key: string; artist: string; title: string }[];
  tempos: ReadonlyMap<string, SongTempoRecord>;
  current: ReadonlyMap<string, SongFeelRecord>;
  file: FeelFile;
}): FeelPlan {
  const { catalogue, tempos, current, file } = input;
  const { rows, unmatched } = feelRows(file, new Set(catalogue.map((c) => c.key)));
  const toWrite = rows.filter((r) => {
    const c = current.get(r.key);
    return !c || c.feel !== r.feel || c.source !== r.source;
  });
  const at = new Map(catalogue.map((c, i) => [c.key, { c, i }]));
  const effect = { sameBand: 0, moved: 0, noMeasured: 0, fromLabelAlone: 0, halved: 0, doubled: 0, clamped: 0 };
  const moves: string[] = [];
  for (const r of rows) {
    const hit = at.get(r.key)!;
    const measured = tempoOf(tempos.get(r.key), r.key);
    const eff = effectiveTempo({ key: r.key, record: tempos.get(r.key), feel: r.feel })!;
    if (measured === undefined) effect.noMeasured++;
    else if (feelOfTempo(measured) === feelOfTempo(eff.tempo)) effect.sameBand++;
    else {
      effect.moved++;
      moves.push(`${String(hit.i + 1).padStart(5)}. ${hit.c.artist} - ${hit.c.title}: ${Math.round(measured)} bpm (${feelOfTempo(measured)}) -> ${Math.round(eff.tempo)} (${r.feel})`);
    }
    if (eff.adjusted && eff.adjusted !== 'compressed') effect[eff.adjusted]++; // a labelled song is never squeezed
    if (eff.source === 'feel') effect.fromLabelAlone++;
  }
  return { rows, unmatched, toWrite, added: toWrite.filter((r) => !current.has(r.key)).length, effect, moves };
}
