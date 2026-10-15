// Fills the song-range cache for a user's library from USDB note files.
// Runs outside the web request path (USDB is slow on purpose: one request every few seconds),
// e.g. `npm run usdb:sync` from a machine that can reach USDB.
// Phase 1 fetches one note file per artist and gives every other song an artist estimate, so a
// first-time sync is useful within minutes rather than hours. Phase 2 fetches the remaining songs'
// own note files, most-played first, replacing estimates. Every song gets a data-source log entry.
// Songs synced before ranking v2 lack USDB views/rating and the pitch histogram. Views and rating
// are backfilled with a search only (fast); the histogram needs the note file again (about 25 s
// per song), so that only happens with `rescan: true`.

import type { SongRange, Track } from '../contracts';
import type { Store } from '../server/store';
import { songRangeFromUltrastar } from '../songs/range';
import { resolveSongRange, songKey } from '../songs/resolve';
import type { UsdbClient } from './client';

/** A song USDB had no note file for is not searched again for this long. */
export const MISS_RECHECK_DAYS = 90;

export interface SyncSummary {
  checked: number;
  noteFile: number;
  artistTypical: number;
  skipped: number;
  alreadyKnown: number;
  /** Songs USDB lacked when checked in the last MISS_RECHECK_DAYS, so not searched again. */
  recentMiss: number;
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
  /** First fetch one note file per artist, so every song gets an artist estimate early. Default true. */
  artistsFirst?: boolean;
  now?: () => Date;
  onProgress?: (line: string) => void;
}

function withPopularity(range: SongRange, song: { views?: number; rating?: number }): SongRange {
  const out = { ...range };
  if (song.views !== undefined) out.usdbViews = song.views;
  if (song.rating !== undefined) out.usdbRating = song.rating;
  return out;
}

export async function syncNoteFiles({
  store,
  usdb,
  tracks,
  rescan = false,
  artistsFirst = true,
  now = () => new Date(),
  onProgress,
}: SyncOptions): Promise<SyncSummary> {
  const summary: SyncSummary = { checked: tracks.length, noteFile: 0, artistTypical: 0, skipped: 0, alreadyKnown: 0, recentMiss: 0, updated: 0, errors: 0 };
  // Log in before the first song, so a bad password stops the run instead of failing every song.
  await usdb.login?.();
  const artistOf = (t: Track) => songKey(t.artist, '').split('|')[0]!;
  /** Songs already looked up on USDB in this run (found, missing or failed). */
  const looked = new Set<string>();
  /** Songs USDB had no note file for in this run, with the time we checked. */
  const missAt = new Map<string, string>();
  /** Lookups that errored: left unstored so the next run tries again. */
  const failed = new Set<string>();
  const remaining: Track[] = [];

  /** Looks one song up on USDB and stores its note-file range. False when USDB has no file for it. */
  async function fetchSong(track: Track): Promise<boolean> {
    const key = songKey(track.artist, track.title);
    looked.add(key);
    try {
      const song = await usdb.findSong(track.artist, track.title);
      const text = song?.noteText;
      if (!song || !text) {
        missAt.set(key, now().toISOString());
        return false;
      }
      const range = withPopularity(songRangeFromUltrastar(text), song);
      const log = { trackId: track.id, title: track.title, artist: track.artist, outcome: 'note-file' as const, reason: 'Used the UltraStar note file for this song (from USDB).', at: now().toISOString() };
      await store.putSongRange(key, { range, log });
      await store.appendLog(log);
      summary.noteFile++;
      onProgress?.(`note file: ${track.artist} - ${track.title}`);
      return true;
    } catch (err) {
      summary.errors++;
      failed.add(key);
      onProgress?.(`error: ${track.artist} - ${track.title}: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /** Artist-typical range (or skipped) for every song still without a note file. */
  async function fallbackPass(list: Track[], final: boolean) {
    for (const track of list) {
      const key = songKey(track.artist, track.title);
      if (failed.has(key) || (await store.getSongRange(key))?.range?.source === 'note-file') continue;
      const previous = await store.getSongRange(key);
      const { range, log } = await resolveSongRange(track, {
        getNoteFile: async () => null,
        getArtistSongRanges: () => store.listNoteFileRangesByArtist(artistOf(track)),
        getExternalArtistRange: async () => null,
        now,
      });
      const miss = missAt.get(key) ?? previous?.log.usdbMissAt;
      if (miss) log.usdbMissAt = miss;
      await store.putSongRange(key, { range, log });
      if (!final) continue;
      await store.appendLog(log);
      if (range) summary.artistTypical++;
      else summary.skipped++;
      onProgress?.(`${log.outcome}: ${track.artist} - ${track.title}`);
    }
  }

  // Songs we already have: skip, or top up USDB views/stars and (with rescan) the pitch histogram.
  for (const track of tracks) {
    const key = songKey(track.artist, track.title);
    const cached = await store.getSongRange(key);
    if (cached?.range?.source !== 'note-file') {
      const miss = cached?.log.usdbMissAt;
      if (miss && now().getTime() - Date.parse(miss) < MISS_RECHECK_DAYS * 86_400_000) {
        summary.recentMiss++;
        looked.add(key); // keep its estimate fresh in the fallback pass, but don't search again
      }
      remaining.push(track);
      continue;
    }
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
  }

  if (artistsFirst) {
    // Phase 1: one note file per artist (their most-played song USDB has, up to 2 tries), so every
    // song by that artist gets an estimate within the first pass instead of at the very end.
    // Each artist's other songs get their estimate as soon as that artist is covered, so results
    // improve steadily, most-played artists first.
    const byArtist = new Map<string, Track[]>();
    for (const t of remaining) byArtist.set(artistOf(t), [...(byArtist.get(artistOf(t)) ?? []), t]);
    const tries = new Map<string, number>();
    const covered = new Set<string>();
    for (const track of remaining) {
      const artist = artistOf(track);
      if (covered.has(artist) || (tries.get(artist) ?? 0) >= 2 || looked.has(songKey(track.artist, track.title))) continue;
      const known = (await store.listNoteFileRangesByArtist(artist)).length > 0;
      if (!known) tries.set(artist, (tries.get(artist) ?? 0) + 1);
      if (known || (await fetchSong(track))) {
        covered.add(artist);
        await fallbackPass(byArtist.get(artist)!, false);
      }
    }
    await fallbackPass(remaining, false);
    onProgress?.('artist estimates ready; now fetching the remaining songs');
  }

  // Phase 2: every other song, most-played first. Each note file found replaces the estimate.
  for (const track of remaining) {
    if (!looked.has(songKey(track.artist, track.title))) await fetchSong(track);
  }
  await fallbackPass(remaining, true);
  return summary;
}
