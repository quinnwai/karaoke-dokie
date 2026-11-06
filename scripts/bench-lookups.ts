// Times a first load of a big Spotify library's song lookups against a database with simulated latency.
// Usage: N=11139 LAT=25 CONC=20 KNOWN=0.35 npx tsx scripts/bench-lookups.ts   (memory store, no network)
import type { Store } from '../src/lib/server/store';
import { createMemoryStore } from '../src/lib/server/memoryStore';
import { createSongService } from '../src/lib/server/songService';
import { productionSongDeps, realResolver } from '../src/lib/server/wiring';
import { songKey } from '../src/lib/songs/resolve';
import type { Track } from '../src/lib/contracts';

const N = Number(process.env.N ?? 11139), LAT = Number(process.env.LAT ?? 25), CONC = Number(process.env.CONC ?? 5), KNOWN = Number(process.env.KNOWN ?? 0.35);
function delayed(s: Store): Store {
  const out: any = {};
  let calls = 0;
  for (const k of Object.keys(s) as (keyof Store)[]) {
    const f = (s as any)[k];
    out[k] = typeof f === 'function' ? async (...a: any[]) => { calls++; await new Promise((r) => setTimeout(r, LAT)); return f(...a); } : f;
  }
  out.calls = () => calls;
  return out;
}
async function main() {
  const base = createMemoryStore();
  const tracks: Track[] = [];
  for (let i = 0; i < N; i++) {
    const a = `Artist ${i % 2500}`, t = `Song ${i}`;
    tracks.push({ id: `t${i}`, title: t, artist: a, artistId: `a${i % 2500}`, spotifyUrl: '', playRank: i });
    if (Math.random() < KNOWN) await base.putSongRange(songKey(a, t), { range: { low: 50, high: 66, tessitura: 58, source: 'note-file', confidence: 'high', fastLyrics: false }, log: { trackId: '', title: t, artist: a, outcome: 'note-file', reason: '', at: '' } });
    else if (i % 3 === 0) await base.putSongRange(songKey(a, 'seed' + i), { range: { low: 50, high: 66, tessitura: 58, source: 'audio-full', confidence: 'high', fastLyrics: false }, log: { trackId: '', title: t, artist: a, outcome: 'audio-full', reason: '', at: '' } });
  }
  const store = delayed(base) as any;
  const deps = { ...productionSongDeps(store, false), resolveSongRange: realResolver(store, { getNoteFile: async () => null } as any) };
  const svc = createSongService(store, deps, { concurrency: CONC, maxResolvesPerRequest: Number(process.env.BUDGET ?? 1000) });
  const t0 = Date.now(); let reqs = 0, done = false;
  while (!done) { const r = await svc.recommend(tracks, { low: 41, high: 72, source: 'test' }, 0, 0, { all: true }); reqs++; done = r.nextOffset === null; if (reqs > 60) break; }
  console.log(JSON.stringify({ N, LAT, CONC, requests: reqs, seconds: (Date.now() - t0) / 1000, storeCalls: store.calls() }));
}
main();
