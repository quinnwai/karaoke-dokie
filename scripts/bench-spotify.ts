// Times reading a big saved-songs library through the real Spotify client against a simulated Spotify:
// each request takes LAT ms, and more than LIMIT requests in any 30 s window answer 429 with Retry-After.
// Usage: N=11139 LAT=150 LIMIT=300 npx tsx scripts/bench-spotify.ts   (no network, real timers)
import { createSpotifyClient } from '../src/lib/server/spotify';

const N = Number(process.env.N ?? 11139), LAT = Number(process.env.LAT ?? 150), LIMIT = Number(process.env.LIMIT ?? 300);
const stamps: number[] = [];
let ok = 0, limited = 0, maxRate = 0;
const fake = async (input: string): Promise<Response> => {
  const now = Date.now();
  while (stamps.length && now - stamps[0]! > 30_000) stamps.shift();
  await new Promise((r) => setTimeout(r, LAT));
  if (stamps.length >= LIMIT) {
    limited++;
    return new Response('', { status: 429, headers: { 'retry-after': '3' } });
  }
  stamps.push(now);
  maxRate = Math.max(maxRate, stamps.length);
  ok++;
  const offset = Number(new URL(input).searchParams.get('offset') ?? 0);
  const items = Array.from({ length: Math.max(0, Math.min(50, N - offset)) }, (_, i) => ({
    track: { id: `t${offset + i}`, name: `Song ${offset + i}`, artists: [{ id: 'a', name: 'Artist' }], external_urls: { spotify: '' }, album: { release_date: '2000' } },
  }));
  return new Response(JSON.stringify({ items, next: null, total: N }), { status: 200 });
};
async function main() {
  const client = createSpotifyClient({ clientId: 'x', clientSecret: 'y', redirectUri: 'z' } as never, fake as never);
  const t0 = Date.now();
  const tracks = await client.getSavedTracks('token');
  console.log(JSON.stringify({ N, LAT, LIMIT, songs: tracks.length, seconds: (Date.now() - t0) / 1000, requests: ok, rateLimited: limited, mostIn30s: maxRate }));
}
main().catch((e) => { console.error(e); process.exit(1); });
