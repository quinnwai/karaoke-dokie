// Fills song_tempo (QWW-40; how the tempo is chosen, in src/lib/tempo/tempo.ts). Per song:
//   1. Deezer's `bpm` for the song's matching studio versions (GET /track/<id>), the median once
//      each is folded into 70 to 180. The first version is the one popularity:deezer matched
//      (song_deezer.deezer_id); --versions N also searches for up to N studio versions in all.
//      Live, acoustic, remix, karaoke and sped-up versions are skipped.
//   2. When Deezer has no bpm for the song, a beat tracker (scripts/tempo-tracker.py, librosa) on
//      the 30 s preview of the first studio version. The audio is deleted at once.
// Songs popularity:deezer found no track for have no Deezer id and are skipped; their tempo comes
// from tempo:ultrastar. Most popular first, so a stopped run has done the songs people see.
// A song checked in the last RECHECK_DAYS is skipped, hit or miss, so a rerun only does new songs;
// --refresh looks everything up again. Stops cleanly after --max-minutes and after 20 failures in a
// row (Deezer is refusing us: its CDN cut us off at 8 requests a second); rerun to carry on.
// Every request, API or preview download, is paced at REQUESTS_PER_SECOND.
// --keys-file <file> does only the song keys listed in it (one per line), checked or not, and
// --always-track runs the beat tracker even where Deezer has a bpm: for the gold set (tempo:gold).
// --rps <n> sets the request pace (default 5).
// Usage: npm run tempo:fill [-- --max-minutes 9] [--limit N] [--versions 1] [--refresh] [--dry-run]
// Needs DATABASE_URL, and librosa for python (TEMPO_PYTHON, default python3).

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createDeezerClient, deezerQuery, matchesKey, type DeezerTrack, type DeezerTrackDetail } from '../src/lib/popularity/deezer';
import { neonQuery } from '../src/lib/server/getStore';
import { createPostgresStore } from '../src/lib/server/postgresStore';
import type { SongTempoRecord } from '../src/lib/server/store';
import { deezerTempo, isStudioVersion } from '../src/lib/tempo/tempo';

const RECHECK_DAYS = 90;
/** Songs worked at a time; the client spaces their requests to Deezer's limit. */
const CONCURRENCY = 5;
const BATCH = 100;
const STOP_AFTER_ERRORS = 20;
/** Tries per preview download: the CDN cuts some off mid-file. */
const DOWNLOAD_TRIES = 3;

/** One long-lived python process answering one beat-tracker reading at a time. */
function startTracker() {
  const child = spawn(process.env.TEMPO_PYTHON ?? 'python3', [join(import.meta.dirname, 'tempo-tracker.py')], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout });
  const waiting: ((v: { bpm?: number; error?: string }) => void)[] = [];
  lines.on('line', (l) => waiting.shift()?.(JSON.parse(l)));
  child.on('exit', () => waiting.splice(0).forEach((w) => w({ error: 'tracker exited' })));
  let queue: Promise<unknown> = Promise.resolve();
  return {
    /** Serial: python reads one file at a time. */
    read(path: string): Promise<{ bpm?: number; error?: string }> {
      const run = () => new Promise<{ bpm?: number; error?: string }>((res) => { waiting.push(res); child.stdin.write(`${path}\n`); });
      const p = queue.then(run, run);
      queue = p;
      return p;
    },
    stop: () => child.kill(),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'max-minutes': { type: 'string' },
      limit: { type: 'string' },
      versions: { type: 'string' },
      refresh: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'keys-file': { type: 'string' },
      'always-track': { type: 'boolean' },
      rps: { type: 'string' },
    },
  });
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('Set DATABASE_URL');
  const versions = Math.max(1, Number(values.versions ?? 1));
  const query = neonQuery(url);
  const store = createPostgresStore(query); // migrates: creates song_tempo
  const deadline = values['max-minutes'] ? Date.now() + Number(values['max-minutes']) * 60_000 : Infinity;

  const rows = await query(
    `SELECT d.song_key, d.deezer_id, d.rank, s.log_json::json ->> 'artist' AS artist, s.log_json::json ->> 'title' AS title
     FROM song_deezer d JOIN song_ranges s ON s.song_key = d.song_key
     WHERE s.skipped = false AND d.deezer_id IS NOT NULL ORDER BY d.rank DESC, d.song_key`,
  );
  const done = values.refresh ? new Map<string, SongTempoRecord>() : await store.listSongTempos();
  const fresh = (r: SongTempoRecord | undefined) => r?.checkedAt !== undefined && Date.now() - Date.parse(r.checkedAt) < RECHECK_DAYS * 86_400_000;
  const only = values['keys-file'] ? new Set((await readFile(values['keys-file'], 'utf8')).split('\n').map((l) => l.trim()).filter(Boolean)) : null;
  const due = only ? rows.filter((r) => only.has(String(r.song_key))) : rows.filter((r) => !fresh(done.get(String(r.song_key))));
  const todo = due.slice(0, values.limit ? Number(values.limit) : undefined);
  console.log(`${rows.length} songs with a Deezer track, ${rows.length - due.length} done in the last ${RECHECK_DAYS} days, ${due.length} due; doing ${todo.length}`);

  const deezer = createDeezerClient(values.rps ? { perSecond: Number(values.rps) } : {});
  const tracker = startTracker();
  const dir = await mkdtemp(join(tmpdir(), 'tempo-'));
  const pending: SongTempoRecord[] = [];
  const counts = { deezer: 0, tracker: 0, none: 0, errors: 0 };
  let next = 0;
  let inARow = 0;
  const flush = async () => {
    const batch = pending.splice(0);
    if (batch.length && !values['dry-run']) await store.putSongTempo(batch);
  };

  /** The preview's tempo, or undefined; the audio is deleted whatever happens. */
  async function trackPreview(previewUrl: string, name: string): Promise<number | undefined> {
    const file = join(dir, `${name}.mp3`);
    try {
      for (let i = 0; i < DOWNLOAD_TRIES; i++) {
        await deezer.wait();
        const res = await fetch(previewUrl);
        if (res.status === 403) throw new Error('Deezer CDN refused the preview download (HTTP 403)');
        if (!res.ok) continue;
        const want = Number(res.headers.get('content-length') ?? 0);
        const bytes = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
        if (!bytes.length || (want && bytes.length < want)) continue; // cut off mid-file
        await writeFile(file, bytes);
        const out = await tracker.read(file);
        return out.bpm;
      }
      return undefined;
    } finally {
      await rm(file, { force: true });
    }
  }

  async function work(row: Record<string, unknown>) {
    const key = String(row.song_key);
    const candidates: DeezerTrackDetail[] = [];
    const first = await deezer.track(Number(row.deezer_id));
    if (first && matchesKey(key, first) && isStudioVersion(first.title)) candidates.push(first);
    if (candidates.length < versions) {
      // More versions to take the median over, or the matched one was live: look for studio ones.
      const found: DeezerTrack[] = (await deezer.search(deezerQuery(String(row.artist ?? ''), String(row.title ?? ''))))
        .filter((t) => t.id !== first?.id && matchesKey(key, t) && isStudioVersion(t.title))
        .sort((a, b) => b.rank - a.rank);
      for (const t of found.slice(0, versions - candidates.length)) {
        const d = await deezer.track(t.id);
        if (d) candidates.push(d);
      }
    }
    const withBpm = candidates.filter((c) => c.bpm > 0);
    const record: SongTempoRecord = { key, checkedAt: new Date().toISOString() };
    const median = deezerTempo(candidates.map((c) => c.bpm));
    if (median !== null) {
      record.deezerBpm = Number(median.toFixed(2));
      record.deezerVersions = withBpm.length;
      counts.deezer++;
    }
    if (median === null || values['always-track']) {
      const preview = candidates.find((c) => c.preview)?.preview;
      if (preview) {
        record.previewUrl = preview;
        const bpm = await trackPreview(preview, key.replace(/[^a-z0-9]+/gi, '_').slice(0, 60) + next);
        if (bpm !== undefined) {
          record.trackerBpm = Number(bpm.toFixed(2));
          counts.tracker++;
        } else if (median === null) counts.none++;
      } else if (median === null) counts.none++;
    }
    if (values['dry-run'] && next <= 40) console.log(`${record.deezerBpm ?? 'tracker ' + (record.trackerBpm ?? 'none')}\t${key}`);
    pending.push(record);
    inARow = 0;
    if (pending.length >= BATCH) await flush();
  }

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < todo.length && Date.now() < deadline && inARow < STOP_AFTER_ERRORS) {
        const row = todo[next++]!;
        try {
          await work(row);
        } catch (err) {
          counts.errors++; // not recorded, so the next run tries again
          inARow++;
          console.warn(err instanceof Error ? err.message : err);
        }
        const n = counts.deezer + counts.tracker + counts.none + counts.errors;
        if (n % 250 === 0) console.log(`${n}/${todo.length}: ${counts.deezer} Deezer, ${counts.tracker} tracker, ${counts.none} none, ${counts.errors} errors`);
      }
    }),
  );
  await flush();
  tracker.stop();
  await rm(dir, { recursive: true, force: true });
  const n = counts.deezer + counts.tracker + counts.none + counts.errors;
  console.log(
    `Done: ${counts.deezer} Deezer bpm, ${counts.tracker} tracker, ${counts.none} none, ${counts.errors} errors${inARow >= STOP_AFTER_ERRORS ? `; stopped after ${inARow} failures in a row` : ''}${todo.length - n > 0 ? `; ${todo.length - n} left, run again to carry on` : ''}${values['dry-run'] ? ' (dry run, nothing saved)' : ''}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
