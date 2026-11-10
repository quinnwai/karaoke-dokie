// Computes ranges for every song in the USDB index that has no note-file range yet, most-viewed
// first, so the app covers USDB's whole catalogue rather than only signed-in users' libraries.
// A note file outranks every other source (sourceRank.ts), so it also replaces measured recordings.
// Each note file is downloaded by id through the client, which waits out USDB's countdown.
// Safe to stop and rerun: finished songs are stored as they go and skipped next time.
// With recheckFast it instead re-reads USDB songs flagged as fast lyrics and clears the flag where
// the current rule disagrees (the rule only got stricter, so unflagged songs need no check).
// With rescanDuets it instead re-reads songs whose note file was stored before duets got each
// singer's part, when USDB titles an upload as a duet. USDB can list "Song" and "Song [DUET]"
// under one key, so it takes the most-viewed upload titled as a duet (not the key's most-viewed
// upload, which may be the solo one), and stores it only when the file has both sung parts.

import type { SongRangeRecord, Store } from '../server/store';
import { songRangeFromUltrastar } from '../songs/range';
import { SOURCE_RANK, sourceRank } from '../songs/sourceRank';
import { isDuetListing, type UsdbClient } from './client';

const NOTE_FILE_REASON = 'Used the UltraStar note file for this song (from USDB).';

export interface FillSummary {
  candidates: number;
  /** Ranges stored (with recheckFast: flags cleared; with rescanDuets: duets that got their parts). */
  stored: number;
  /** No note text came back, or it could not be read. */
  failed: number;
}

export async function fillCatalogue({
  store,
  usdb,
  limit = Infinity,
  recheckFast = false,
  rescanDuets = false,
  now = () => new Date(),
  onProgress,
}: {
  store: Store;
  usdb: Pick<UsdbClient, 'downloadById'>;
  /** Stop after this many downloads. */
  limit?: number;
  recheckFast?: boolean;
  /** Re-read note files stored without duet parts whose key has an upload titled as a duet. */
  rescanDuets?: boolean;
  now?: () => Date;
  onProgress?: (line: string) => void;
}): Promise<FillSummary> {
  if (recheckFast && rescanDuets) throw new Error('Rechecking fast lyrics and rescanning duets are separate runs; pass one of them');
  // Rescanning duets only looks at uploads titled as a duet, so the dedupe below keeps each key's duet upload.
  const all = (await store.listUsdbSongs()).filter((e) => !rescanDuets || isDuetListing(e));
  // One download per song key (the most-viewed upload), skipping keys that already have notes.
  const seen = new Set<string>();
  const todo = [];
  const flagged = new Map<string, SongRangeRecord>();
  /** With rescanDuets: the record stored before, for each song to re-read. */
  const withoutParts = new Map<string, SongRangeRecord>();
  for (let i = 0; i < all.length; i += 500) {
    const batch = all.slice(i, i + 500);
    const known = await store.getSongRanges(batch.map((e) => e.key));
    for (const e of batch) {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      const rec = known.get(e.key);
      if (rescanDuets) {
        if (rec?.range?.source === 'note-file' && !rec.range.parts?.length) {
          withoutParts.set(e.key, rec);
          todo.push(e);
        }
      } else if (!recheckFast) {
        if (sourceRank(rec?.range) < SOURCE_RANK['note-file']) todo.push(e);
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
      const before = withoutParts.get(e.key);
      if (before && !fresh.parts) {
        onProgress?.(`not a duet (one sung part): ${e.artist} - ${e.title}`);
        continue;
      }
      const range = { ...fresh, usdbId: e.id };
      if (e.views !== undefined) range.usdbViews = e.views;
      if (e.rating !== undefined) range.usdbRating = e.rating;
      const at = now().toISOString();
      await store.putSongRange(e.key, {
        range,
        // A duet re-read keeps the stored names (the catalogue shows them) and says the file now came from USDB.
        log: before
          ? { ...before.log, reason: NOTE_FILE_REASON, at }
          : { trackId: '', title: e.title, artist: e.artist, outcome: 'note-file', reason: NOTE_FILE_REASON, at },
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
