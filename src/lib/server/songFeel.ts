// Feel labels for the keys a request needs (QWW-54). Labels are new data, and a database that has not been given the
// song_feel table yet (an older one read without the app's migration, as the release harness does) must not break the
// page, so a missing table reads as "no labels" and the songs keep their measured tempo (src/lib/tempo/feel.ts
// effectiveTempo). Any other failure is thrown, like the other reads in a catalogue fill: the cache drops a failed fill and
// asks again, where a swallowed one would keep every unlabelled tempo for the cache's whole lifetime.

import type { SongFeelRecord } from '../tempo/feel';
import type { Store } from './store';

/** True for Postgres' "relation does not exist" (code 42P01), as Neon, pg and pg-mem word it. */
export function isMissingTable(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return e?.code === '42P01' || /relation "?[\w.]+"? does not exist/i.test(String(e?.message ?? ''));
}

export async function readSongFeels(store: Partial<Pick<Store, 'getSongFeels'>>, keys: string[]): Promise<Map<string, SongFeelRecord>> {
  if (!store.getSongFeels || !keys.length) return new Map();
  try {
    return await store.getSongFeels(keys);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    console.warn(`song_feel does not exist, ranking on the measured tempo: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    return new Map();
  }
}
