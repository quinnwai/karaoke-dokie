// Builds song ranges in bulk from folders of UltraStar note files (public collections that
// were originally shared on USDB), and imports them into the store. Only computed numbers
// are kept (range, tessitura, pitch shares, fast-lyrics flag); lyrics and notes are not.

import type { SongRange } from '../contracts';
import type { Store } from '../server/store';
import { songRangeFromUltrastar } from '../songs/range';
import { songKey } from '../songs/resolve';
import { parseUltrastar } from '../songs/ultrastar';

export interface BulkRange {
  key: string;
  artist: string;
  title: string;
  /** Which collection the note file came from. */
  collection: string;
  range: SongRange;
}

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
  /** Already had a range from a note file (USDB sync or an earlier import). */
  kept: number;
}

/**
 * Writes bulk ranges to the store. Songs that already have a note-file range are kept as they
 * are; songs with only an estimate or a skip are upgraded. No log rows are appended.
 */
export async function importBulkRanges(
  store: Store,
  ranges: BulkRange[],
  opts: { now?: () => Date; batchSize?: number; onProgress?: (done: number) => void } = {},
): Promise<ImportSummary> {
  const now = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? 500;
  const summary: ImportSummary = { imported: 0, kept: 0 };
  for (let i = 0; i < ranges.length; i += batchSize) {
    const batch = ranges.slice(i, i + batchSize);
    const existing = await store.getSongRanges(batch.map((r) => r.key));
    for (const r of batch) {
      if (existing.get(r.key)?.range?.source === 'note-file') {
        summary.kept++;
        continue;
      }
      await store.putSongRange(r.key, {
        range: r.range,
        log: {
          trackId: '',
          title: r.title,
          artist: r.artist,
          outcome: 'note-file',
          reason: `Used the UltraStar note file for this song (public collection ${r.collection}, originally from USDB).`,
          at: now().toISOString(),
        },
      });
      summary.imported++;
    }
    opts.onProgress?.(Math.min(i + batchSize, ranges.length));
  }
  return summary;
}
