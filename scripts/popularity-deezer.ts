// Looks up each song's Deezer track rank and stores it per song key in song_deezer (QWW-37; how,
// in src/lib/popularity/deezer.ts). Every stored song range is looked up: the measured catalogue
// and every song a signed-in library has resolved (artist estimates included). Artist estimates
// go first, since they are the songs with nothing else to go on, then measured songs.
// A song checked in the last RECHECK_DAYS is skipped, hit or miss, so a rerun only does new songs;
// --refresh looks everything up again. --recheck-before <time> looks up again the misses and the
// hits ranked under LOW_RANK that were checked before that time, oldest first: after a matcher fix,
// since a low rank can be a minor version matched when the main one is named differently.
// --refresh-before <time> looks up again every song checked before that time, hits included (QWW-67:
// a matcher fix that can replace a wrong version, and the first run that stores the matched track).
// Pass the same time to every run of one recheck or refresh, so it ends. Stops cleanly after
// --max-minutes (rerun to carry on).
// Each lookup is findDeezerTrack's (QWW-67): the plain search, then a search naming every act, the artist's
// top tracks and a search on the title alone when the search has no original. A hit is read by its id once more for its release
// date, except in a dry run. --save <file> writes what a run would store as JSON, for
// scripts/deezer-report.ts --overlay to show the lists with it before anything is written. --keys <file>
// (a JSON array of song keys) looks up only those songs, e.g. the ones a list shows.
// Usage: npm run popularity:deezer [-- --max-minutes 9] [--limit N] [--refresh] [--recheck-before <ISO time>]
//          [--refresh-before <ISO time>] [--keys <file>] [--dry-run] [--save <file>]
// Needs DATABASE_URL. Then run npm run popularity:calibrate.

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createDeezerClient, findDeezerTrack, type DeezerRoute } from '../src/lib/popularity/deezer';
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

/** An ISO time option as epoch ms, or undefined when not given. */
function timeOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new Error(`--${name} takes an ISO time`);
  return at;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'max-minutes': { type: 'string' },
      limit: { type: 'string' },
      refresh: { type: 'boolean' },
      'recheck-before': { type: 'string' },
      'refresh-before': { type: 'string' },
      keys: { type: 'string' },
      'dry-run': { type: 'boolean' },
      save: { type: 'string' },
    },
  });
  const only = values.keys ? new Set(JSON.parse(await readFile(values.keys, 'utf8')) as string[]) : undefined;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('Set DATABASE_URL');
  const query = neonQuery(url);
  // A dry run reads only, so it does not migrate either: the new columns (QWW-67) are added by the first write or the app.
  const store = createPostgresStore(query, { autoMigrate: !values['dry-run'] });
  const deadline = values['max-minutes'] ? Date.now() + Number(values['max-minutes']) * 60_000 : Infinity;

  const rows = await query(
    `SELECT song_key, log_json::json ->> 'artist' AS artist, log_json::json ->> 'title' AS title,
       range_json::json ->> 'source' AS source
     FROM song_ranges WHERE skipped = false`,
  );
  const stored = await store.listSongDeezer();
  const checked = values.refresh ? new Map<string, SongDeezerRecord>() : stored;
  const recheckBefore = timeOption(values['recheck-before'], 'recheck-before');
  const refreshBefore = timeOption(values['refresh-before'], 'refresh-before');
  const fresh = (d: SongDeezerRecord | undefined) =>
    d !== undefined &&
    Date.now() - Date.parse(d.checkedAt) < RECHECK_DAYS * 86_400_000 &&
    !(recheckBefore !== undefined && (d.rank ?? 0) < LOW_RANK && Date.parse(d.checkedAt) < recheckBefore) &&
    !(refreshBefore !== undefined && Date.parse(d.checkedAt) < refreshBefore);
  const checkedAt = (key: string) => checked.get(key)?.checkedAt ?? '';
  const due = rows
    .map((r) => ({ key: String(r.song_key), artist: String(r.artist ?? ''), title: String(r.title ?? ''), estimate: r.source === 'artist-typical' }))
    .filter((s) => s.artist && s.title && (!only || only.has(s.key)) && !fresh(checked.get(s.key)))
    // Artist estimates first, then never checked, then oldest checked; by key within each.
    .sort(
      (a, b) =>
        Number(b.estimate) - Number(a.estimate) ||
        (checkedAt(a.key) < checkedAt(b.key) ? -1 : checkedAt(a.key) > checkedAt(b.key) ? 1 : 0) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  const todo = due.slice(0, values.limit ? Number(values.limit) : undefined);
  console.log(
    `${rows.length} songs${only ? ` (${only.size} keys asked for)` : ''}, ${rows.length - due.length} not due, ${due.length} due; looking up ${todo.length}`,
  );

  const deezer = createDeezerClient();
  const pending: SongDeezerRecord[] = [];
  const saved: SongDeezerRecord[] = [];
  let hits = 0;
  let misses = 0;
  let errors = 0;
  let calls = 0;
  let next = 0;
  let inARow = 0;
  // What each lookup did to the stored row: a miss that now has a match, a match that is now a miss, another track.
  const changes = { found: 0, lost: 0, switched: 0, same: 0, unchecked: 0 };
  // Where each hit was found (QWW-67).
  const routes: Record<DeezerRoute, number> = { search: 0, acts: 0, artist: 0, title: 0, hand: 0 };
  let shown = 0;
  const flush = async () => {
    const batch = pending.splice(0);
    if (batch.length && !values['dry-run']) await store.putSongDeezer(batch);
  };
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < todo.length && Date.now() < deadline && inARow < STOP_AFTER_ERRORS) {
        const song = todo[next++]!;
        try {
          // Our title too: a version it names ("(Live at Donington)") is not passed over (QWW-59).
          const found = await findDeezerTrack(deezer, song.artist, song.title, { releaseDate: !values['dry-run'] });
          calls += found.calls;
          const hit = found.hit;
          const record: SongDeezerRecord = { key: song.key, checkedAt: new Date().toISOString() };
          if (hit) {
            record.rank = hit.rank;
            record.deezerId = hit.deezerId;
            record.title = hit.title;
            if (hit.album !== undefined) record.album = hit.album;
            if (hit.releaseDate !== undefined) record.releaseDate = hit.releaseDate;
            if (hit.duration !== undefined) record.duration = hit.duration;
            routes[found.route!]++;
            hits++;
          } else misses++;
          if (values['dry-run'] && hits + misses <= 40) console.log(`${hit ? hit.rank : 'miss'}\t${song.artist} - ${song.title}${hit ? `\t(${hit.artist} - ${hit.title}, ${found.route})` : ''}`);
          const was = stored.get(song.key);
          const change = !was ? 'unchecked' : was.rank === undefined ? (hit ? 'found' : 'same') : !hit ? 'lost' : was.deezerId === hit.deezerId ? 'same' : 'switched';
          changes[change]++;
          if (values['dry-run'] && (change === 'found' || change === 'lost' || change === 'switched') && shown++ < 80) {
            console.log(`${change}\t${song.artist} - ${song.title}\t${was?.deezerId ?? '-'} -> ${hit ? `${hit.deezerId} ${hit.artist} - ${hit.title} [${hit.album ?? ''}] (rank ${hit.rank}, ${found.route})` : 'miss'}`);
          }
          pending.push(record);
          if (values.save) saved.push(record);
          inARow = 0;
          if (pending.length >= BATCH) await flush();
        } catch (err) {
          errors++; // not recorded, so the next run tries again
          inARow++;
          console.warn(err instanceof Error ? err.message : err);
        }
        const done = hits + misses + errors;
        if (done % 500 === 0) console.log(`${done}/${todo.length}: ${hits} hits, ${misses} misses, ${errors} errors, ${calls} calls`);
      }
    }),
  );
  await flush();
  if (values.save) await writeFile(values.save, JSON.stringify(saved));
  const left = todo.length - (hits + misses + errors);
  console.log(
    `Done: ${hits} hits, ${misses} misses, ${errors} errors, ${calls} Deezer calls${inARow >= STOP_AFTER_ERRORS ? `; stopped after ${inARow} failures in a row` : ''}${left > 0 ? `; ${left} left, run again to carry on` : ''}${values['dry-run'] ? ' (dry run, nothing saved)' : ''}`,
  );
  console.log(
    `Hits by route: ${routes.search} plain search, ${routes.acts} search naming every act, ${routes.artist} artist's top tracks, ${routes.title} title alone, ${routes.hand} hand-checked`,
  );
  console.log(
    `Against the stored rows: ${changes.found} misses now matched, ${changes.lost} matches now misses, ${changes.switched} matched to another track, ${changes.same} unchanged, ${changes.unchecked} never looked up before`,
  );
  if (values.save) console.log(`Wrote ${saved.length} lookups to ${values.save}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
