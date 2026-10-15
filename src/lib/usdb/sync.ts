// Fills the song-range cache for a user's library from USDB note files.
// Runs outside the web request path (USDB is slow on purpose: one request every few seconds),
// e.g. `npm run usdb:sync` from a machine that can reach USDB.
// Pass 1 fetches note files; pass 2 resolves the remaining songs, so the artist fallback can use
// every note file found in pass 1. Every song gets a data-source log entry.
// Songs synced before ranking v2 lack USDB views/rating and the pitch histogram. Views and rating
// are backfilled with a search only (fast); the histogram needs the note file again (about 25 s
// per song), so that only happens with `rescan: true`.

import type { SongRange, Track } from '../contracts';
import type { Store } from '../server/store';
import { songRangeFromUltrastar } from '../songs/range';
import { resolveSongRange, songKey } from '../songs/resolve';
import type { UsdbClient } from './client';

export interface SyncSummary {
  checked: number;
  noteFile: number;
  artistTypical: number;
  skipped: number;
  alreadyKnown: number;
  /** Already-known songs that got USDB views/rating or a pitch histogram added. */
  updated: number;
  errors: number;
}

export interface SyncOptions {
  store: Store;
  usdb: Pick<UsdbClient, 'findSong'> & Partial<Pick<UsdbClient, 'login'>>;
  tracks: Track[];
  /** Re-download note files for known songs that lack a pitch histogram. */
  rescan?: boolean;
  now?: () => Date;
  onProgress?: (line: string) => void;
}

function withPopularity(range: SongRange, song: { views?: number; rating?: number }): SongRange {
  const out = { ...range };
  if (song.views !== undefined) out.usdbViews = song.views;
  if (song.rating !== undefined) out.usdbRating = song.rating;
  return out;
}

export async function syncNoteFiles({ store, usdb, tracks, rescan = false, now = () => new Date(), onProgress }: SyncOptions): Promise<SyncSummary> {
  const summary: SyncSummary = { checked: tracks.length, noteFile: 0, artistTypical: 0, skipped: 0, alreadyKnown: 0, updated: 0, errors: 0 };
  // Log in before the first song, so a bad password stops the run instead of failing every song.
  await usdb.login?.();
  const remaining: Track[] = [];
  const failed = new Set<string>();

  for (const track of tracks) {
    const key = songKey(track.artist, track.title);
    const cached = await store.getSongRange(key);
    if (cached?.range?.source === 'note-file') {
      summary.alreadyKnown++;
      const needsHistogram = rescan && !cached.range.pitchShare;
      const needsPopularity = cached.range.usdbViews === undefined && cached.range.usdbRating === undefined;
      if (!needsHistogram && !needsPopularity) continue;
      try {
        const song = await usdb.findSong(track.artist, track.title, { download: needsHistogram });
        if (song) {
          const base = needsHistogram && song.noteText ? songRangeFromUltrastar(song.noteText) : cached.range;
          await store.putSongRange(key, { range: withPopularity(base, song), log: cached.log });
          summary.updated++;
          onProgress?.(`updated: ${track.artist} - ${track.title}`);
        }
      } catch (err) {
        summary.errors++;
        onProgress?.(`error: ${track.artist} - ${track.title}: ${err instanceof Error ? err.message : err}`);
      }
      continue;
    }
    try {
      const song = await usdb.findSong(track.artist, track.title);
      const text = song?.noteText;
      if (song && text) {
        const range = withPopularity(songRangeFromUltrastar(text), song);
        const log = { trackId: track.id, title: track.title, artist: track.artist, outcome: 'note-file' as const, reason: 'Used the UltraStar note file for this song (from USDB).', at: now().toISOString() };
        await store.putSongRange(key, { range, log });
        await store.appendLog(log);
        summary.noteFile++;
        onProgress?.(`note file: ${track.artist} - ${track.title}`);
        continue;
      }
    } catch (err) {
      summary.errors++;
      failed.add(key);
      onProgress?.(`error: ${track.artist} - ${track.title}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    remaining.push(track);
  }

  for (const track of remaining) {
    const artistKey = songKey(track.artist, '').split('|')[0]!;
    const { range, log } = await resolveSongRange(track, {
      getNoteFile: async () => null,
      getArtistSongRanges: () => store.listNoteFileRangesByArtist(artistKey),
      getExternalArtistRange: async () => null,
      now,
    });
    await store.putSongRange(songKey(track.artist, track.title), { range, log });
    await store.appendLog(log);
    if (range) summary.artistTypical++;
    else summary.skipped++;
    onProgress?.(`${log.outcome}: ${track.artist} - ${track.title}`);
  }
  return summary;
}
