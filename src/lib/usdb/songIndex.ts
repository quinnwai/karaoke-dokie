// Our copy of USDB's song list: id, artist, title, views, stars and last-changed time, no note text.
// With it, a sync knows which songs USDB has without searching for each one, and goes straight to
// the note file by id. The approach (read the list 100 rows at a time sorted by id for a full
// copy, or newest-changed first and stop at the last known change for an update) follows
// USDB Syncer (https://github.com/bohning/usdb_syncer, GPLv3); this is an independent implementation.
// A full read is about 330 pages; at one request every 2.5 s that is about 14 minutes.

import type { Store, UsdbIndexEntry } from '../server/store';
import { songKey } from '../songs/resolve';
import { USDB_LIST_PAGE_SIZE, type UsdbClient, type UsdbSongRow } from './client';

/** USDB ids stay below this (about 32,600 in October 2026); a guard against paging forever. */
export const MAX_LIST_START = 100_000;

export interface IndexSummary {
  pages: number;
  songs: number;
  mode: 'full' | 'update';
}

function toEntry(row: UsdbSongRow): UsdbIndexEntry {
  const e: UsdbIndexEntry = { id: row.id, key: songKey(row.artist, row.title), artist: row.artist, title: row.title };
  if (row.views !== undefined) e.views = row.views;
  if (row.rating !== undefined) e.rating = row.rating;
  if (row.lastChange !== undefined) e.lastChange = row.lastChange;
  return e;
}

/**
 * Fills or refreshes the USDB song index. Reads everything when the index is empty or `full` is
 * set; otherwise only songs changed since the newest change already indexed.
 */
export async function updateUsdbIndex({
  store,
  usdb,
  full = false,
  onProgress,
}: {
  store: Store;
  usdb: Pick<UsdbClient, 'listSongs'>;
  full?: boolean;
  onProgress?: (line: string) => void;
}): Promise<IndexSummary> {
  const { count, newestChange } = await store.usdbIndexStats();
  const mode = full || count === 0 || newestChange === null ? 'full' : 'update';
  const summary: IndexSummary = { pages: 0, songs: 0, mode };
  for (let start = 0; start < MAX_LIST_START; start += USDB_LIST_PAGE_SIZE) {
    const rows = await usdb.listSongs(mode === 'full' ? { order: 'id', start } : { order: 'lastchange', descending: true, start });
    summary.pages++;
    const fresh = mode === 'full' ? rows : rows.filter((r) => r.lastChange === undefined || r.lastChange >= newestChange!);
    await store.putUsdbSongs(fresh.map(toEntry));
    summary.songs += fresh.length;
    onProgress?.(`page ${summary.pages}: ${summary.songs} songs`);
    if (rows.length < USDB_LIST_PAGE_SIZE || fresh.length < rows.length) break;
  }
  return summary;
}
