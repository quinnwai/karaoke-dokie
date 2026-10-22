// Builds song ranges in bulk from folders of UltraStar note files (public collections that
// were originally shared on USDB), and imports them into the store. Only computed numbers
// are kept (range, tessitura, pitch shares, fast-lyrics flag); lyrics and notes are not.
// The import also takes rows measured from full recordings (the vocal-range pipeline's export),
// which carry their own log line.

import type { DataSourceLogEntry, LogOutcome, SongRange } from '../contracts';
import type { Store } from '../server/store';
import { songRangeFromUltrastar } from '../songs/range';
import { songKey } from '../songs/resolve';
import { importReplaces, isKnownSource, SOURCE_RANK } from '../songs/sourceRank';
import { parseUltrastar } from '../songs/ultrastar';

export interface BulkRange {
  key: string;
  artist: string;
  title: string;
  /** Which collection the note file came from. */
  collection: string;
  range: SongRange;
  /** Log line for the info button. Without one, the outcome is the range's source (and note files get the note-file line). */
  outcome?: LogOutcome;
  reason?: string;
}

const NOTE_FILE_REASON = (collection: string) =>
  `Used the UltraStar note file for this song (public collection ${collection}, originally from USDB).`;

/** Decodes a note file: UTF-8 when valid, otherwise Latin-1 (older UltraStar files). */
export function decodeNoteFile(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

/** Note files outside these bounds are badly transcribed (or mash-ups), so they are dropped. */
export const PLAUSIBLE_SONG = { lowest: 28, highest: 91, widestSpan: 36 } as const;

function plausible(r: SongRange): boolean {
  return r.low >= PLAUSIBLE_SONG.lowest && r.high <= PLAUSIBLE_SONG.highest && r.high - r.low <= PLAUSIBLE_SONG.widestSpan;
}

/** Range of one note file, or null when it has no artist/title, no singable part 1, or an implausible range. */
export function rangeFromNoteText(text: string, collection: string): BulkRange | null {
  try {
    const file = parseUltrastar(text);
    const artist = file.artist.trim();
    const title = file.title.trim();
    if (!artist || !title) return null;
    const key = songKey(artist, title);
    if (key.startsWith('|') || key.endsWith('|')) return null;
    const range = songRangeFromUltrastar(file);
    return plausible(range) ? { key, artist, title, collection, range: { ...range, collection } } : null;
  } catch {
    return null;
  }
}

/** Keeps the first range seen for each song key, so earlier collections win. */
export function dedupeRanges(ranges: Iterable<BulkRange>): BulkRange[] {
  const byKey = new Map<string, BulkRange>();
  for (const r of ranges) if (!byKey.has(r.key)) byKey.set(r.key, r);
  return [...byKey.values()];
}

export interface ImportSummary {
  imported: number;
  /** Already had a range from an equal or better source: a note file, or this export's own row. */
  kept: number;
  /** Kept songs from the same collection whose fast-lyrics flag was corrected (recheckFast). */
  fastUpdated: number;
}

/**
 * Writes bulk ranges to the store, going by the source rank (sourceRank.ts): a row is written
 * over a lower-ranked one, or over the same source from another export; anything else is kept
 * as it is (with recheckFast, a kept note file only gets its fast-lyrics flag corrected). So
 * estimates and skips are upgraded, and note files are never replaced. A replaced row keeps the
 * time the USDB sync last found nothing for the song. A file with a source this app does not
 * know, or a log outcome that is not the row's source, is refused before anything is written.
 * No log rows are appended.
 */
export async function importBulkRanges(
  store: Store,
  ranges: BulkRange[],
  opts: {
    now?: () => Date;
    batchSize?: number;
    onProgress?: (done: number) => void;
    /** Also correct the fast-lyrics flag of kept songs imported earlier from the same collection. */
    recheckFast?: boolean;
  } = {},
): Promise<ImportSummary> {
  for (const r of ranges) {
    if (!isKnownSource(r.range.source)) {
      throw new Error(`Unknown range source "${r.range.source}" (${r.key}); this app imports ${Object.keys(SOURCE_RANK).join(', ')}`);
    }
    if (r.outcome !== undefined && r.outcome !== r.range.source) {
      throw new Error(`Log outcome "${r.outcome}" is not the range source "${r.range.source}" (${r.key})`);
    }
  }
  const now = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? 500;
  const summary: ImportSummary = { imported: 0, kept: 0, fastUpdated: 0 };
  for (let i = 0; i < ranges.length; i += batchSize) {
    const batch = ranges.slice(i, i + batchSize);
    const existing = await store.getSongRanges(batch.map((r) => r.key));
    for (const r of batch) {
      const old = existing.get(r.key);
      if (!importReplaces(r.range, old?.range)) {
        summary.kept++;
        if (opts.recheckFast && old?.range?.source === 'note-file' && old.range.collection === r.collection && old.range.fastLyrics !== r.range.fastLyrics) {
          await store.putSongRange(r.key, { ...old, range: { ...old.range, fastLyrics: r.range.fastLyrics } });
          summary.fastUpdated++;
        }
        continue;
      }
      const log: DataSourceLogEntry = {
        trackId: '',
        title: r.title,
        artist: r.artist,
        outcome: r.outcome ?? r.range.source,
        reason: r.reason ?? (r.range.source === 'note-file' ? NOTE_FILE_REASON(r.collection) : ''),
        at: now().toISOString(),
      };
      if (old?.log.usdbMissAt) log.usdbMissAt = old.log.usdbMissAt;
      await store.putSongRange(r.key, { range: r.range, log });
      summary.imported++;
    }
    opts.onProgress?.(Math.min(i + batchSize, ranges.length));
  }
  return summary;
}
