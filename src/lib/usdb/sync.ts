// Fills the song-range cache for a user's library from USDB note files.
// Runs outside the web request path (USDB is slow on purpose: one request every few seconds),
// e.g. `npm run usdb:sync` from a machine that can reach USDB.
// Phase 1 fetches one note file per artist and gives every other song an artist estimate, so a
// first-time sync is useful within minutes rather than hours. Phase 2 fetches the remaining songs'
// own note files, most-played first, replacing estimates. Every song gets a data-source log entry.
// Songs synced before ranking v2 lack USDB views/rating and the pitch histogram. Views and rating
// are backfilled with a search only (fast); the histogram needs the note file again (about 25 s
// per song), so that only happens with `rescan: true`.
// Songs synced before duets got each singer's part are re-read with `rescanDuets: true`, but only
// those USDB lists as a duet. USDB can have a song as both "Song" and "Song [DUET]" (one songKey),
// so the rescan takes the duet upload: the most-viewed index row titled as a duet, or without the
// index, the first search result whose title or edition says duet (isDuetListing).
// When the USDB song index is filled (npm run usdb:index), songs are looked up there instead of
// searched one by one: a song not in the index is a miss at no cost, and a hit is downloaded by id.

import type { SongRange, Track } from '../contracts';
import type { SongRangeRecord, Store, UsdbIndexEntry } from '../server/store';
import { songRangeFromUltrastar } from '../songs/range';
import { resolveSongRange, songKey } from '../songs/resolve';
import { MEASURED_RANK, sourceRank } from '../songs/sourceRank';
import { isDuetListing, type UsdbClient, type UsdbSong } from './client';

/** A song USDB had no note file for is not searched again for this long. */
export const MISS_RECHECK_DAYS = 90;

const USDB_NOTE_FILE_REASON = 'Used the UltraStar note file for this song (from USDB).';

export interface SyncSummary {
  checked: number;
  noteFile: number;
  artistTypical: number;
  skipped: number;
  alreadyKnown: number;
  /** Songs USDB lacked when checked in the last MISS_RECHECK_DAYS, so not searched again. */
  recentMiss: number;
  /** Already-known songs that got USDB views/rating, a pitch histogram or duet parts added. */
  updated: number;
  errors: number;
}

export interface SyncOptions {
  store: Store;
  usdb: Pick<UsdbClient, 'findSong'> & Partial<Pick<UsdbClient, 'login' | 'downloadById'>>;
  tracks: Track[];
  /** Re-download note files for known songs that lack a pitch histogram. */
  rescan?: boolean;
  /**
   * Re-download note files for known songs stored without duet parts that USDB lists as a duet
   * (title, or edition when searching; the index keeps titles only), to add each singer's part.
   */
  rescanDuets?: boolean;
  /** First fetch one note file per artist, so every song gets an artist estimate early. Default true. */
  artistsFirst?: boolean;
  now?: () => Date;
  onProgress?: (line: string) => void;
}

function withPopularity(range: SongRange, song: { id?: number; views?: number; rating?: number }): SongRange {
  const out = { ...range };
  if (song.id !== undefined) out.usdbId = song.id;
  if (song.views !== undefined) out.usdbViews = song.views;
  if (song.rating !== undefined) out.usdbRating = song.rating;
  return out;
}

export async function syncNoteFiles({
  store,
  usdb,
  tracks,
  rescan = false,
  rescanDuets = false,
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
  const indexed = (await store.usdbIndexStats()).count > 0 && usdb.downloadById !== undefined;
  const index = indexed ? await store.findUsdbSongs(tracks.map((t) => songKey(t.artist, t.title))) : new Map();
  /** With rescanDuets and the index: per song key, the most-viewed upload titled as a duet. */
  const duetIndex = new Map<string, UsdbIndexEntry>();
  if (rescanDuets && indexed) {
    for (const e of await store.listUsdbSongs()) if (isDuetListing(e) && !duetIndex.has(e.key)) duetIndex.set(e.key, e);
  }

  /**
   * The song on USDB (from the index when there is one, else a search), optionally with its notes.
   * With `duet`, only an upload USDB lists as a duet.
   */
  async function lookup(track: Track, download: boolean, duet = false): Promise<UsdbSong | null> {
    if (!indexed) return usdb.findSong(track.artist, track.title, duet ? { download, duet } : { download });
    const entry = (duet ? duetIndex : index).get(songKey(track.artist, track.title));
    if (!entry) return null;
    return { id: entry.id, views: entry.views, rating: entry.rating, noteText: download ? await usdb.downloadById!(entry.id) : null };
  }

  /** Looks one song up on USDB and stores its note-file range. False when USDB has no file for it. */
  async function fetchSong(track: Track): Promise<boolean> {
    const key = songKey(track.artist, track.title);
    looked.add(key);
    try {
      const song = await lookup(track, true);
      const text = song?.noteText;
      if (!song || !text) {
        missAt.set(key, now().toISOString());
        return false;
      }
      const range = withPopularity(songRangeFromUltrastar(text), song);
      const log = { trackId: track.id, title: track.title, artist: track.artist, outcome: 'note-file' as const, reason: USDB_NOTE_FILE_REASON, at: now().toISOString() };
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

  /**
   * Artist-typical range (or skipped) for every song still without a measured range. Note files
   * and measured recordings (rank MEASURED_RANK and up) are kept; a recording only gets the time
   * USDB was checked, so it is not searched again too soon.
   */
  async function fallbackPass(list: Track[], final: boolean) {
    for (const track of list) {
      const key = songKey(track.artist, track.title);
      if (failed.has(key)) continue;
      const previous = await store.getSongRange(key);
      const miss = missAt.get(key) ?? previous?.log.usdbMissAt;
      if (previous && sourceRank(previous.range) >= MEASURED_RANK) {
        if (miss && previous.log.usdbMissAt !== miss) await store.putSongRange(key, { ...previous, log: { ...previous.log, usdbMissAt: miss } });
        continue;
      }
      const { range, log } = await resolveSongRange(track, {
        getNoteFile: async () => null,
        getArtistSongRanges: () => store.listMeasuredRangesByArtist(artistOf(track)),
        getExternalArtistRange: async () => null,
        now,
      });
      if (miss) log.usdbMissAt = miss;
      await store.putSongRange(key, { range, log });
      if (!final) continue;
      await store.appendLog(log);
      if (range) summary.artistTypical++;
      else summary.skipped++;
      onProgress?.(`${log.outcome}: ${track.artist} - ${track.title}`);
    }
  }

  /**
   * With rescanDuets: re-reads a known song from the upload USDB lists as a duet. True when that
   * file has both singers' parts and its range was stored (with that upload's id, views and stars).
   */
  async function addDuetParts(track: Track, key: string, cached: SongRangeRecord): Promise<boolean> {
    const song = await lookup(track, true, true);
    const range = song?.noteText ? songRangeFromUltrastar(song.noteText) : null;
    if (!song || !range?.parts) return false; // no duet upload, or one that has a single sung part
    // The file can differ from the one stored before (the solo upload, or a public collection's).
    const log = { ...cached.log, reason: USDB_NOTE_FILE_REASON, at: now().toISOString() };
    await store.putSongRange(key, { range: withPopularity(range, song), log });
    summary.updated++;
    onProgress?.(`duet parts: ${track.artist} - ${track.title}`);
    return true;
  }

  // Songs we already have: skip, or top up USDB views/stars and (with rescan) the pitch histogram
  // or (with rescanDuets) duet parts.
  for (const track of tracks) {
    const key = songKey(track.artist, track.title);
    const cached = await store.getSongRange(key);
    if (cached?.range?.source !== 'note-file') {
      const miss = cached?.log.usdbMissAt;
      if (!indexed && miss && now().getTime() - Date.parse(miss) < MISS_RECHECK_DAYS * 86_400_000) {
        summary.recentMiss++;
        looked.add(key); // keep its estimate fresh in the fallback pass, but don't search again
      }
      remaining.push(track);
      continue;
    }
    summary.alreadyKnown++;
    const needsHistogram = rescan && !cached.range.pitchShare;
    const needsPopularity = cached.range.usdbViews === undefined && cached.range.usdbRating === undefined;
    const mayNeedParts = rescanDuets && !cached.range.parts?.length;
    if (!needsHistogram && !needsPopularity && !mayNeedParts) continue;
    try {
      if (mayNeedParts && (await addDuetParts(track, key, cached))) continue;
      if (!needsHistogram && !needsPopularity) continue;
      const song = await lookup(track, needsHistogram);
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
      const known = (await store.listMeasuredRangesByArtist(artist)).length > 0;
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
