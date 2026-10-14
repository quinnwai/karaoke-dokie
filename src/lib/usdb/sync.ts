// Fills the song-range cache for a user's library from USDB note files.
// Runs outside the web request path (USDB is slow on purpose: one request every few seconds),
// e.g. `npm run usdb:sync` from a machine that can reach USDB.
// Pass 1 fetches note files; pass 2 resolves the remaining songs, so the artist fallback can use
// every note file found in pass 1. Every song gets a data-source log entry.

import type { Track } from '../contracts';
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
  errors: number;
}

export interface SyncOptions {
  store: Store;
  usdb: Pick<UsdbClient, 'findNoteFile'>;
  tracks: Track[];
  now?: () => Date;
  onProgress?: (line: string) => void;
}

export async function syncNoteFiles({ store, usdb, tracks, now = () => new Date(), onProgress }: SyncOptions): Promise<SyncSummary> {
  const summary: SyncSummary = { checked: tracks.length, noteFile: 0, artistTypical: 0, skipped: 0, alreadyKnown: 0, errors: 0 };
  const remaining: Track[] = [];
  const failed = new Set<string>();

  for (const track of tracks) {
    const key = songKey(track.artist, track.title);
    const cached = await store.getSongRange(key);
    if (cached?.range?.source === 'note-file') {
      summary.alreadyKnown++;
      continue;
    }
    try {
      const text = await usdb.findNoteFile(track.artist, track.title);
      if (text) {
        const range = songRangeFromUltrastar(text);
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
