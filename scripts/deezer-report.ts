// Read-only report of the row ▶ (QWW-67): how many songs in a logged-out list have no Deezer track, so their ▶ is dim.
// For one range (default F#2 to C5, Quinn-Wai's range on 12 Nov), at the Setlist tuner's defaults, for every era and
// for each era alone, in the whole list and in its top 100. With --overlay, the same lists again with the lookups a
// `popularity:deezer --dry-run --save <file>` would write in place of the stored ones, so a recheck is judged before it
// writes. --songs prints named songs (song keys, "artist|title") before and after. --keys-out writes every catalogue
// song's key, in any range, as JSON: the songs a logged-out list can show, for popularity:deezer --keys.
//   node --import tsx scripts/deezer-report.ts [--low 42] [--high 72] [--overlay <file>] [--songs '<key>;<key>'] [--out <file>]
//     [--keys-out <file>]
// Needs DATABASE_URL_UNPOOLED or DATABASE_URL. Reads only (SELECT), like eval:release.

import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { EraId } from '../src/lib/contracts';
import { catalogueKey, catalogueTracks, loadCatalogue, prepareCatalogue } from '../src/lib/server/catalogue';
import { neonQuery } from '../src/lib/server/getStore';
import { createPostgresStore } from '../src/lib/server/postgresStore';
import type { SongDeezerRecord, SongPopularityRecord, Store } from '../src/lib/server/store';
import { productionSongDeps } from '../src/lib/server/wiring';
import { rankPrepared } from '../src/lib/songs/setlist';
import { DEFAULTS, DEFAULT_OFF, ERA_LABEL } from '../src/lib/songs/setlistConfig';
import { selectOnly } from './eval-release';

const ERAS = Object.keys(ERA_LABEL) as EraId[];
const TOP = 100;

/** One song of a list, as the report reads it. */
interface Row {
  key: string;
  artist: string;
  title: string;
  era: EraId | null;
  deezerId?: number;
}

/**
 * The store with `overlay`'s lookups in place of the stored ones, as getSongPopularity reads them (the rank and the track
 * the row's ▶ plays). A song whose only row was its Deezer rank has no row once the lookup misses.
 */
export function withOverlay<S extends Pick<Store, 'getSongPopularity'>>(store: S, overlay: Map<string, SongDeezerRecord>): S {
  return {
    ...store,
    async getSongPopularity(keys: string[]) {
      const out = await store.getSongPopularity(keys);
      for (const key of keys) {
        const d = overlay.get(key);
        if (!d) continue;
        const was: SongPopularityRecord = out.get(key) ?? { key, source: 'deezer' };
        const { deezerRank: _rank, deezerId: _id, ...rest } = was;
        if (d.rank !== undefined) out.set(key, { ...rest, deezerRank: d.rank, ...(d.deezerId !== undefined ? { deezerId: d.deezerId } : {}) });
        else if (was.source === 'deezer') out.delete(key);
        else out.set(key, rest);
      }
      return out;
    },
  };
}

/**
 * Every era's list and each era's own, logged out at the tuner's defaults, as POST /api/setlist answers them. `keys` gets
 * every catalogue song's key when given.
 */
async function lists(store: Parameters<typeof loadCatalogue>[0] & Store, low: number, high: number, keys?: string[]): Promise<Map<EraId | 'all', Row[]>> {
  const entries = await loadCatalogue(store, undefined, { canonical: true });
  for (const e of keys ? entries : []) keys!.push(e.key);
  const prepared = prepareCatalogue(catalogueTracks(entries), { low, high }, productionSongDeps(store, false)).prepared;
  const gears = { difficulty: DEFAULTS.difficulty, history: DEFAULTS.history, popularity: DEFAULTS.popularity, tempo: DEFAULTS.tempo };
  const out = new Map<EraId | 'all', Row[]>();
  for (const era of ['all', ...ERAS] as const) {
    const state =
      era === 'all'
        ? { gears, off: [...DEFAULT_OFF], eras: [], loggedIn: false }
        : { gears, off: DEFAULT_OFF.filter((p) => p !== 'era'), eras: [era], loggedIn: false };
    out.set(
      era,
      rankPrepared(prepared, state).songs.map(({ match, era: e }) => ({
        key: catalogueKey(match.track.id) ?? match.track.id,
        artist: match.track.artist,
        title: match.track.title,
        era: e,
        ...(match.deezerId !== undefined ? { deezerId: match.deezerId } : {}),
      })),
    );
  }
  return out;
}

const pct = (n: number, of: number) => `${of ? ((100 * n) / of).toFixed(1) : '0.0'}%`;
const dim = (rows: Row[]) => rows.filter((r) => r.deezerId === undefined).length;

async function main() {
  const { values } = parseArgs({
    options: {
      low: { type: 'string', default: '42' },
      high: { type: 'string', default: '72' },
      overlay: { type: 'string' },
      songs: { type: 'string' },
      out: { type: 'string' },
      'keys-out': { type: 'string' },
    },
  });
  const url = (process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || '').trim();
  if (!url) throw new Error('Set DATABASE_URL_UNPOOLED or DATABASE_URL');
  const store = createPostgresStore(selectOnly(neonQuery(url)), { autoMigrate: false });
  const [low, high] = [Number(values.low), Number(values.high)];

  const overlay = new Map<string, SongDeezerRecord>();
  if (values.overlay) for (const r of JSON.parse(await readFile(values.overlay, 'utf8')) as SongDeezerRecord[]) overlay.set(r.key, r);
  const catalogue: string[] = [];
  const before = await lists(store, low, high, catalogue);
  const after = overlay.size ? await lists(withOverlay(store, overlay), low, high) : null;
  if (values['keys-out']) {
    await writeFile(values['keys-out'], JSON.stringify(catalogue));
    console.error(`Wrote ${catalogue.length} catalogue keys to ${values['keys-out']}`);
  }

  console.log(`Range ${low} to ${high} (MIDI), logged out, the tuner's defaults. Dim ▶ = no Deezer track.${overlay.size ? ` After: ${overlay.size} lookups from ${values.overlay}.` : ''}\n`);
  const head = after ? '| Era | Songs | Dim ▶ now | Dim ▶ after | Top 100 now | Top 100 after |' : '| Era | Songs | Dim ▶ | Top 100 |';
  console.log(head);
  console.log(head.replace(/[^|]+/g, '---'));
  for (const [era, rows] of before) {
    const label = era === 'all' ? 'All eras' : ERA_LABEL[era];
    const top = rows.slice(0, TOP);
    if (!after) {
      console.log(`| ${label} | ${rows.length} | ${dim(rows)} (${pct(dim(rows), rows.length)}) | ${dim(top)} |`);
      continue;
    }
    const a = after.get(era)!;
    console.log(
      `| ${label} | ${rows.length} | ${dim(rows)} (${pct(dim(rows), rows.length)}) | ${dim(a)} (${pct(dim(a), a.length)}) | ${dim(top)} | ${dim(a.slice(0, TOP))} |`,
    );
  }

  if (values.songs) {
    const stored = await store.listSongDeezer();
    const all = before.get('all')!;
    console.log('\n| Song | Place | Stored track | After |');
    console.log('|---|---|---|---|');
    for (const key of values.songs.split(';').map((k) => k.trim()).filter(Boolean)) {
      const at = all.findIndex((r) => r.key === key);
      const s = stored.get(key);
      const o = overlay.get(key);
      const show = (d: SongDeezerRecord | undefined) =>
        !d ? 'never looked up' : d.deezerId === undefined ? 'none' : `${d.deezerId}${d.title ? ` "${d.title}"` : ''}${d.album ? ` (${d.album})` : ''}`;
      console.log(`| ${key} | ${at < 0 ? 'not in list' : `#${at + 1} ${all[at]!.era ?? ''}`} | ${show(s)} | ${o ? show(o) : 'not looked up'} |`);
    }
  }

  if (values.out) {
    const dump = Object.fromEntries([...before].map(([era, rows]) => [era, rows]));
    await writeFile(values.out, JSON.stringify(after ? { before: dump, after: Object.fromEntries(after) } : { before: dump }, null, 1));
    console.error(`Wrote ${values.out}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
