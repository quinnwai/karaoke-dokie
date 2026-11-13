// Feel labels for the keys a request needs (QWW-54). Labels are new data, and a database that has not been given the
// song_feel table yet (an older one read without the app's migration, as the release harness does) must not break the
// page, so a missing table reads as "no labels" and the songs keep their measured tempo (src/lib/tempo/feel.ts
// effectiveTempo). Any other failure is thrown, like the other reads in a catalogue fill: the cache drops a failed fill and
// asks again, where a swallowed one would keep every unlabelled tempo for the cache's whole lifetime.

import type { SongFeelRecord } from '../tempo/feel';
import type { QueryFn } from './postgresStore';
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

/** True for Postgres' "relation already exists" (code 42P07), as Neon, pg and pg-mem word it. */
function isExistingTable(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return e?.code === '42P07' || /relation "?[\w.]+"? already exists/i.test(String(e?.message ?? ''));
}

/** Why `name` cannot be a backup table of song_feel, or null: song_feel_bak_ and then lower case letters, digits and underscores. */
export function backupTableRefusal(name: string): string | null {
  return /^song_feel_bak_[a-z0-9_]{1,40}$/.test(name)
    ? null
    : `--backup must name a table like song_feel_bak_qww54b (song_feel_bak_, then lower case letters, digits and underscores), not "${name}".`;
}

export type SongFeelBackup = { status: 'created' | 'kept'; rows: number } | { status: 'nothing-to-back-up' };

/**
 * Copies song_feel into `table` before a write that changes rows, so the old labels can be put back (QWW-54). It never
 * overwrites: a table that already exists is kept as it is, so a rerun after a stop keeps the copy made before the first
 * write, and with no song_feel yet there is nothing to back up. The name goes into the SQL text, so it is checked here too.
 */
export async function backupSongFeel(query: QueryFn, table: string): Promise<SongFeelBackup> {
  const refusal = backupTableRefusal(table);
  if (refusal) throw new Error(refusal);
  let status: 'created' | 'kept' = 'created';
  try {
    await query(`CREATE TABLE ${table} AS SELECT * FROM song_feel`);
  } catch (err) {
    if (isMissingTable(err)) return { status: 'nothing-to-back-up' };
    if (!isExistingTable(err)) throw err;
    status = 'kept';
  }
  const rows = Number((await query(`SELECT count(*) AS n FROM ${table}`))[0]?.n);
  return { status, rows };
}
