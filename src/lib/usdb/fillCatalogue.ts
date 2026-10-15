// Computes ranges for every song in the USDB index that has no note-file range yet, most-viewed
// first, so the app covers USDB's whole catalogue rather than only signed-in users' libraries.
// Each note file is downloaded by id through the client, which waits out USDB's countdown.
// Safe to stop and rerun: finished songs are stored as they go and skipped next time.

import type { Store } from '../server/store';
import { songRangeFromUltrastar } from '../songs/range';
import type { UsdbClient } from './client';

export interface FillSummary {
  candidates: number;
  stored: number;
  /** No note text came back, or it could not be read. */
  failed: number;
}

export async function fillCatalogue({
  store,
  usdb,
  limit = Infinity,
  now = () => new Date(),
  onProgress,
}: {
  store: Store;
  usdb: Pick<UsdbClient, 'downloadById'>;
  /** Stop after this many downloads. */
  limit?: number;
  now?: () => Date;
  onProgress?: (line: string) => void;
}): Promise<FillSummary> {
  const all = await store.listUsdbSongs();
  // One download per song key (the most-viewed upload), skipping keys that already have notes.
  const seen = new Set<string>();
  const todo = [];
  for (let i = 0; i < all.length; i += 500) {
    const batch = all.slice(i, i + 500);
    const known = await store.getSongRanges(batch.map((e) => e.key));
    for (const e of batch) {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      if (known.get(e.key)?.range?.source !== 'note-file') todo.push(e);
    }
  }
  const summary: FillSummary = { candidates: todo.length, stored: 0, failed: 0 };
  onProgress?.(`${todo.length} songs to fetch`);

  for (const e of todo.slice(0, limit)) {
    try {
      const text = await usdb.downloadById(e.id);
      if (!text) throw new Error('no note text');
      const range = { ...songRangeFromUltrastar(text), usdbId: e.id };
      if (e.views !== undefined) range.usdbViews = e.views;
      if (e.rating !== undefined) range.usdbRating = e.rating;
      await store.putSongRange(e.key, {
        range,
        log: { trackId: '', title: e.title, artist: e.artist, outcome: 'note-file', reason: 'Used the UltraStar note file for this song (from USDB).', at: now().toISOString() },
      });
      summary.stored++;
      onProgress?.(`${summary.stored}/${Math.min(todo.length, limit)} ${e.artist} - ${e.title}`);
    } catch (err) {
      summary.failed++;
      onProgress?.(`failed: ${e.artist} - ${e.title}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return summary;
}
