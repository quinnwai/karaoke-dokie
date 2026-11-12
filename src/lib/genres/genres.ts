// The genre a song shows (QWW-61). USDB's #GENRE, typed by whoever made the note file, when the song has one: it is the
// richer label. Otherwise Deezer's genres for the album of the song's Deezer track, from song_genre (npm run genres:deezer,
// src/lib/genres/deezer.ts), which covers songs no note file describes, most library songs among them.
//
// song_genre is new data, and a database that has not been given the table yet (one read without the app's migration, as
// the release harness does) must not break the page: a missing table reads as "no Deezer genres", and every song shows what
// it showed before. Any other failure is thrown, like the other reads in a catalogue fill: the cache drops a failed fill and
// asks again, where a swallowed one would hide the Deezer genres for the cache's whole lifetime.

import { isMissingTable } from '../server/songFeel';
import type { Store } from '../server/store';

/** True for a genre with something in it: USDB rows can hold an empty one. */
export const hasGenre = (genre: string | undefined): genre is string => Boolean(genre?.trim());

/** The genre a song shows: USDB's when it has one, else Deezer's album genres ("Pop, Rock"), else none. */
export function shownGenre(usdb: string | undefined, deezer: string | undefined): string | undefined {
  if (hasGenre(usdb)) return usdb;
  return hasGenre(deezer) ? deezer : undefined;
}

/** Deezer's genres for the keys that have some, by song key; misses are left out. */
export async function readSongGenres(store: Partial<Pick<Store, 'getSongGenres'>>, keys: string[]): Promise<Map<string, string>> {
  if (!store.getSongGenres || !keys.length) return new Map();
  let rows;
  try {
    rows = await store.getSongGenres(keys);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    console.warn(`song_genre does not exist, showing USDB's genres only: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    return new Map();
  }
  const out = new Map<string, string>();
  for (const [key, row] of rows) if (hasGenre(row.genres)) out.set(key, row.genres);
  return out;
}
