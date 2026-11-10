// Looks up each song's Deezer track rank and stores it per song key in song_deezer (QWW-37; how,
// in src/lib/popularity/deezer.ts). Every stored song range is looked up: the measured catalogue
// and every song a signed-in library has resolved (artist estimates included). Artist estimates
// go first, since they are the songs with nothing else to go on, then measured songs.
// A song checked in the last RECHECK_DAYS is skipped, hit or miss, so a rerun only does new songs;
// --refresh looks everything up again. --recheck-before <time> looks up again the misses and the
// hits ranked under LOW_RANK that were checked before that time, oldest first: after a matcher fix,
// since a low rank can be a minor version matched when the main one is named differently. Pass the
// same time to every run of one recheck, so it ends. Stops cleanly after --max-minutes (rerun to
// carry on).
// Usage: npm run popularity:deezer [-- --max-minutes 9] [--limit N] [--refresh] [--recheck-before <ISO time>] [--dry-run]
// Needs DATABASE_URL. Then run npm run popularity:calibrate.

import { parseArgs } from 'node:util';
import { createDeezerClient, deezerQuery, pickDeezerHit } from '../src/lib/popularity/deezer';
import { neonQuery } from '../src/lib/server/getStore';
import { createPostgresStore } from '../src/lib/server/postgresStore';
import type { SongDeezerRecord } from '../src/lib/server/store';

/** How long a lookup, hit or miss, stands before a rerun checks the song again. */
const RECHECK_DAYS = 90;
/** Hits ranked under this are looked up again by --recheck-before. */
const LOW_RANK = 50_000;
/** Searches at a time; the client spaces them to Deezer's limit. */
const CONCURRENCY = 8;
/** Lookups saved per write. */
const BATCH = 100;
/** Failed searches in a row that stop the run: Deezer is refusing us, so carry on later. */
const STOP_AFTER_ERRORS = 20;

async function main() {
  const { values } = parseArgs({
    options: {
      'max-minutes': { type: 'string' },
      limit: { type: 'string' },
      refresh: { type: 'boolean' },
      'recheck-before': { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
  });
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('Set DATABASE_URL');
  const query = neonQuery(url);
  const store = createPostgresStore(query); // migrates: creates song_deezer
  const deadline = values['max-minutes'] ? Date.now() + Number(values['max-minutes']) * 60_000 : Infinity;

  const rows = await query(
    `SELECT song_key, log_json::json ->> 'artist' AS artist, log_json::json ->> 'title' AS title,
       range_json::json ->> 'source' AS source
     FROM song_ranges WHERE skipped = false`,
  );
  const checked = values.refresh ? new Map<string, SongDeezerRecord>() : await store.listSongDeezer();
  const recheckBefore = values['recheck-before'] ? Date.parse(values['recheck-before']) : undefined;
  if (Number.isNaN(recheckBefore)) throw new Error('--recheck-before takes an ISO time');
  const fresh = (d: SongDeezerRecord | undefined) =>
    d !== undefined &&
    Date.now() - Date.parse(d.checkedAt) < RECHECK_DAYS * 86_400_000 &&
    !(recheckBefore !== undefined && (d.rank ?? 0) < LOW_RANK && Date.parse(d.checkedAt) < recheckBefore);
  const checkedAt = (key: string) => checked.get(key)?.checkedAt ?? '';
  const due = rows
    .map((r) => ({ key: String(r.song_key), artist: String(r.artist ?? ''), title: String(r.title ?? ''), estimate: r.source === 'artist-typical' }))
    .filter((s) => s.artist && s.title && !fresh(checked.get(s.key)))
    // Artist estimates first, then never checked, then oldest checked; by key within each.
    .sort(
      (a, b) =>
        Number(b.estimate) - Number(a.estimate) ||
        (checkedAt(a.key) < checkedAt(b.key) ? -1 : checkedAt(a.key) > checkedAt(b.key) ? 1 : 0) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  const todo = due.slice(0, values.limit ? Number(values.limit) : undefined);
  console.log(`${rows.length} songs, ${rows.length - due.length} checked in the last ${RECHECK_DAYS} days, ${due.length} due; looking up ${todo.length}`);

  const deezer = createDeezerClient();
  const pending: SongDeezerRecord[] = [];
  let hits = 0;
  let misses = 0;
  let errors = 0;
  let next = 0;
  let inARow = 0;
  const flush = async () => {
    const batch = pending.splice(0);
    if (batch.length && !values['dry-run']) await store.putSongDeezer(batch);
  };
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < todo.length && Date.now() < deadline && inARow < STOP_AFTER_ERRORS) {
        const song = todo[next++]!;
        try {
          const hit = pickDeezerHit(song.key, await deezer.search(deezerQuery(song.artist, song.title)));
          const record: SongDeezerRecord = { key: song.key, checkedAt: new Date().toISOString() };
          if (hit) {
            record.rank = hit.rank;
            record.deezerId = hit.deezerId;
            hits++;
          } else misses++;
          if (values['dry-run'] && hits + misses <= 40) console.log(`${hit ? hit.rank : 'miss'}\t${song.artist} - ${song.title}${hit ? `\t(${hit.artist} - ${hit.title})` : ''}`);
          pending.push(record);
          inARow = 0;
          if (pending.length >= BATCH) await flush();
        } catch (err) {
          errors++; // not recorded, so the next run tries again
          inARow++;
          console.warn(err instanceof Error ? err.message : err);
        }
        const done = hits + misses + errors;
        if (done % 500 === 0) console.log(`${done}/${todo.length}: ${hits} hits, ${misses} misses, ${errors} errors`);
      }
    }),
  );
  await flush();
  const left = todo.length - (hits + misses + errors);
  console.log(
    `Done: ${hits} hits, ${misses} misses, ${errors} errors${inARow >= STOP_AFTER_ERRORS ? `; stopped after ${inARow} failures in a row` : ''}${left > 0 ? `; ${left} left, run again to carry on` : ''}${values['dry-run'] ? ' (dry run, nothing saved)' : ''}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
