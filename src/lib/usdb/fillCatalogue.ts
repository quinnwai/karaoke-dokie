// Computes ranges for every song in the USDB index that has no note-file range yet, most-viewed
// first, so the app covers USDB's whole catalogue rather than only signed-in users' libraries.
// Each note file is downloaded by id through the client, which waits out USDB's countdown.
// Safe to stop and rerun: finished songs are stored as they go and skipped next time.
// With recheckFast it instead re-reads USDB songs flagged as fast lyrics and clears the flag where
// the current rule disagrees (the rule only got stricter, so unflagged songs need no check).

import type { SongRangeRecord, Store } from '../server/store';
import { songRangeFromUltrastar } from '../songs/range';
import type { UsdbClient } from './client';

export interface FillSummary {
  candidates: number;
  /** Ranges stored (with recheckFast: flags cleared). */
  stored: number;
  /** No note text came back, or it could not be read. */
  failed: number;
}

export async function fillCatalogue({
  store,
  usdb,
  limit = Infinity,
  recheckFast = false,
  now = () => new Date(),
  onProgress,
}: {
  store: Store;
  usdb: Pick<UsdbClient, 'downloadById'>;
  /** Stop after this many downloads. */
  limit?: number;
  recheckFast?: boolean;
  now?: () => Date;
  onProgress?: (line: string) => void;
}): Promise<FillSummary> {
  const all = await store.listUsdbSongs();
  // One download per song key (the most-viewed upload), skipping keys that already have notes.
  const seen = new Set<string>();
  const todo = [];
  const flagged = new Map<string, SongRangeRecord>();
  for (let i = 0; i < all.length; i += 500) {
    const batch = all.slice(i, i + 500);
    const known = await store.getSongRanges(batch.map((e) => e.key));
    for (const e of batch) {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      const rec = known.get(e.key);
      if (!recheckFast) {
        if (rec?.range?.source !== 'note-file') todo.push(e);
      } else if (rec?.range?.source === 'note-file' && rec.range.fastLyrics && rec.range.usdbId === e.id) {
        flagged.set(e.key, rec);
        todo.push(e);
      }
    }
  }
  const summary: FillSummary = { candidates: todo.length, stored: 0, failed: 0 };
  onProgress?.(`${todo.length} songs to fetch`);

  for (const e of todo.slice(0, limit)) {
    try {
      const text = await usdb.downloadById(e.id);
      if (!text) throw new Error('no note text');
      const fresh = songRangeFromUltrastar(text);
      const old = flagged.get(e.key);
      if (old?.range) {
        if (!fresh.fastLyrics) {
          await store.putSongRange(e.key, { ...old, range: { ...old.range, fastLyrics: false } });
          summary.stored++;
        }
        onProgress?.(`${fresh.fastLyrics ? 'still fast' : 'cleared'}: ${e.artist} - ${e.title}`);
        continue;
      }
      const range = { ...fresh, usdbId: e.id };
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
