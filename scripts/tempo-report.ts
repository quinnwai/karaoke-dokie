// Measures tempo (QWW-40) from saved data only; never calls Spotify, Deezer or writes anything.
//  1. Accuracy on the gold set (data/tempo-gold.json: songs with a commonly published tempo): per
//     source and for the combined rule, within 5% of the published tempo after folding both into
//     70 to 180, plus the same counting a double or half as a hit.
//  2. Coverage: the share of songs with a tempo, for the catalogue (no Spotify) at F2 to C5 and E2
//     to E5 as the app serves it (the best 1,000 by Top picks, and every song that fits), and for
//     the library songs stored from Spotify (the closest saved data to a signed-in person's list).
//  3. Spot check: the first ten songs with Tempo at each end, for the catalogue and the library.
//  4. With --lists (QWW-54): for each era, the 300 most popular songs of the F2 to C5 and E2 to E5 lists, and the 20
//     slowest and 20 fastest of them by the one tempo the ranking uses, with its source and the song's feel label,
//     as plain text for a person to read. --era 90s limits it to one era.
// Usage: npm run tempo:report [-- --user <spotify user id>] [--lists [--era 90s]]   (needs DATABASE_URL)

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { Match, Track, VocalRange } from '../src/lib/contracts';
import type { SongFeelRecord } from '../src/lib/server/store';
import { catalogueTracks, loadCatalogue, recommendCatalogue } from '../src/lib/server/catalogue';
import { neonQuery } from '../src/lib/server/getStore';
import { createPostgresStore } from '../src/lib/server/postgresStore';
import { productionSongDeps } from '../src/lib/server/wiring';
import { DECADES, DEFAULT_VIEW, decadeOf, orderMatches } from '../src/lib/songs/browse';
import { effectiveTempo, fitReading, readingsOf } from '../src/lib/tempo/feel';
import { combineTempo, foldBpm, ultrastarTempo } from '../src/lib/tempo/tempo';

const pct = (n: number, d: number) => `${n}/${d} (${d ? ((100 * n) / d).toFixed(1) : '0'}%)`;
const within = (a: number, b: number, tol = 0.05) => Math.abs(a - b) / b <= tol;
const name = (m: Match) => `${m.track.artist} - ${m.track.title} (${m.tempo ? Math.round(m.tempo) : '?'} bpm)`;

async function main() {
  const { values } = parseArgs({ options: { user: { type: 'string' }, lists: { type: 'boolean' }, era: { type: 'string' } } });
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('Set DATABASE_URL');
  const query = neonQuery(url);
  const store = createPostgresStore(query);
  const deps = productionSongDeps(store, false);

  // ---- 1. gold set ----
  const gold = JSON.parse(await readFile(new URL('../data/tempo-gold.json', import.meta.url), 'utf8')) as { key: string; bpm: number; source?: string }[];
  const rec = await store.getSongTempos(gold.map((g) => g.key));
  const feels = await store.getSongFeels(gold.map((g) => g.key)).catch(() => new Map<string, SongFeelRecord>());
  const sources: Record<string, (k: string) => number | null> = {
    'Deezer bpm': (k) => foldBpm(rec.get(k)?.deezerBpm),
    'Beat tracker': (k) => foldBpm(rec.get(k)?.trackerBpm),
    'UltraStar #BPM / 4': (k) => ultrastarTempo(rec.get(k)?.ultrastarBpm),
    'Combined rule': (k) => (rec.get(k) ? (combineTempo(rec.get(k)!)?.tempo ?? null) : null),
    // The reading the song's feel label picks, moved by whole octaves, as a plain bpm: what the label does to the measurement.
    // Not the gear position (effectiveTempo), which a band edge makes a rank, not a bpm. No checked tempo is used, so it is not the gold set read back.
    'Combined rule + feel label (octave pick)': (k) => {
      const feel = feels.get(k)?.feel;
      return feel ? foldBpm(fitReading(readingsOf(rec.get(k)), feel)?.value) : (rec.get(k) ? (combineTempo(rec.get(k)!)?.tempo ?? null) : null);
    },
  };
  console.log(`## Gold set: ${gold.length} songs\n`);
  console.log('| Source | Has a tempo | Within 5% | Within 5%, double or half counted |\n|---|---|---|---|');
  const misses: Record<string, string[]> = { 'Combined rule': [], 'Combined rule + feel label (octave pick)': [] };
  for (const [label, get] of Object.entries(sources)) {
    let has = 0;
    let ok = 0;
    let ok2 = 0;
    for (const g of gold) {
      const t = get(g.key);
      if (t === null) continue;
      has++;
      const pub = foldBpm(g.bpm)!;
      const hit = within(t, pub);
      if (hit) ok++;
      if (hit || within(t * 2, pub) || within(t / 2, pub)) ok2++;
      if (misses[label] && !hit) misses[label]!.push(`${g.key}: published ${g.bpm}${g.source ? ` (${g.source})` : ''}, got ${t.toFixed(1)}${feels.get(g.key) ? `, labelled ${feels.get(g.key)!.feel}` : ''}`);
    }
    console.log(`| ${label} | ${pct(has, gold.length)} | ${pct(ok, gold.length)} | ${pct(ok2, gold.length)} |`);
  }
  for (const [label, list] of Object.entries(misses)) console.log(`\n${label} misses:\n${list.map((m) => `- ${m}`).join('\n') || '- none'}`);
  console.log('');

  // ---- 2 and 3. coverage and spot check ----
  const catalogue = catalogueTracks(await loadCatalogue(store));
  console.log(`## Catalogue (no Spotify): ${catalogue.length} songs, ${pct(catalogue.filter((c) => c.tempo !== undefined).length, catalogue.length)} with a tempo\n`);
  const ranges: [string, VocalRange][] = [
    ['F2 to C5', { low: 41, high: 72, source: 'songs' }],
    ['E2 to E5', { low: 40, high: 76, source: 'songs' }],
  ];
  for (const [label, range] of ranges) {
    const { matches } = recommendCatalogue(catalogue, range, deps, { all: true });
    const fit = catalogue.length; // every catalogue song is scored; the response keeps the best 1,000
    console.log(`- ${label}: the ${matches.length} songs shown, ${pct(matches.filter((m) => m.tempo !== undefined).length, matches.length)} with a tempo (catalogue of ${fit})`);
    if (label === 'F2 to C5') {
      for (const [end, v] of [['Slow jams (0)', 0], ['Upbeat tracks (1)', 1]] as const) {
        const first = orderMatches(matches, { ...DEFAULT_VIEW, tempo: v }, range, 'catalogue').slice(0, 10);
        console.log(`  - ${end}, first 10: ${first.map(name).join('; ')}`);
      }
    }
  }

  // ---- 4. the ends of the Tempo gear in every era, for a person to read (QWW-54) ----
  if (values.lists) {
    const feelOf = await store.getSongFeels(catalogue.map((c) => c.key)).catch(() => new Map<string, SongFeelRecord>());
    const byId = new Map(catalogue.map((c) => [c.track.id, c]));
    const line = (m: Match, i: number) => {
      const c = byId.get(m.track.id);
      return `${String(i + 1).padStart(2)}. ${m.track.artist} - ${m.track.title} (${m.year ?? '?'}): ${m.tempo !== undefined ? Math.round(m.tempo) : '?'} bpm, ${c?.tempoSource ?? 'no tempo'}, labelled ${feelOf.get(c?.key ?? '')?.feel ?? 'none'}`;
    };
    // The most popular first by the song's own popularity score (the order of the served list is Top picks, which also weighs comfort).
    const popularity = (m: Match) => (m.parts?.popularityKnown ? m.parts.popularity : -1);
    for (const [label, range] of ranges) {
      const { matches } = recommendCatalogue(catalogue, range, deps, { all: true });
      for (const era of DECADES.filter((d) => !values.era || d.id === values.era)) {
        const pool = matches.filter((m) => decadeOf(m.year) === era.id).sort((a, b) => popularity(b) - popularity(a)).slice(0, 300);
        const sorted = pool.filter((m) => m.tempo !== undefined).sort((a, b) => a.tempo! - b.tempo!); // stable: equal tempos keep popularity order
        console.log(`\n### ${label}, ${era.label}: the ${pool.length} most popular songs, ${sorted.length} with a tempo`);
        console.log(`Slowest 20 by tempo:\n${sorted.slice(0, 20).map(line).join('\n')}`);
        console.log(`Fastest 20 by tempo:\n${sorted.slice(-20).reverse().map(line).join('\n')}`);
      }
    }
  }

  // The library songs stored from Spotify (a tester's own songs), matched to that person's range.
  const lib = await query(
    `SELECT s.song_key, s.log_json::json ->> 'trackId' AS track_id, s.log_json::json ->> 'artist' AS artist, s.log_json::json ->> 'title' AS title, s.range_json
     FROM song_ranges s WHERE s.skipped = false AND s.log_json::json ->> 'trackId' <> '' ORDER BY s.song_key`,
  );
  const ids = await query('SELECT user_id, low, high FROM vocal_ranges ORDER BY user_id');
  const pick = values.user ? ids.find((r) => String(r.user_id) === values.user) : ids[0];
  const userRange: VocalRange = pick ? { low: Number(pick.low), high: Number(pick.high), source: 'songs' } : { low: 41, high: 72, source: 'songs' };
  const libKeys = lib.map((r) => String(r.song_key));
  const tempos = await store.getSongTempos(libKeys);
  const libFeels = await store.getSongFeels(libKeys).catch(() => new Map<string, SongFeelRecord>());
  // The tempo the app ranks a signed-in person's songs on (songService.ts): the measured tempo, or the feel label's.
  const libTempo = (key: string) => effectiveTempo({ key, record: tempos.get(key), feel: libFeels.get(key)?.feel })?.tempo;
  const matches: Match[] = [];
  lib.forEach((r, i) => {
    const track: Track = { id: String(r.track_id), title: String(r.title), artist: String(r.artist), artistId: '', spotifyUrl: '', playRank: i, known: true };
    const m = deps.matchSong(track, JSON.parse(String(r.range_json)), userRange);
    const tempo = libTempo(String(r.song_key));
    if (m) matches.push(tempo !== undefined ? { ...m, tempo } : m);
  });
  console.log(`\n## Library songs stored from Spotify: ${lib.length} stored, ${matches.length} fit ${pick ? `${pick.user_id}'s saved range` : 'F2 to C5'}`);
  console.log(`- with a tempo: ${pct(matches.filter((m) => m.tempo !== undefined).length, matches.length)}; of all ${lib.length}: ${pct(libKeys.filter((k) => libTempo(k) !== undefined).length, lib.length)}; with a feel label: ${pct(libKeys.filter((k) => libFeels.has(k)).length, lib.length)}`);
  for (const [end, v] of [['Slow jams (0)', 0], ['Upbeat tracks (1)', 1]] as const) {
    const first = orderMatches(matches, { ...DEFAULT_VIEW, tempo: v }, userRange, 'library').slice(0, 10);
    console.log(`  - ${end}, first 10: ${first.map(name).join('; ')}`);
  }
  const bySource = new Map<string, number>();
  for (const t of tempos.values()) {
    const s = combineTempo(t)?.source ?? 'none';
    bySource.set(s, (bySource.get(s) ?? 0) + 1);
  }
  console.log(`\nSource of the library songs' measured tempo: ${[...bySource].map(([s, n]) => `${s} ${n}`).join(', ')}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
