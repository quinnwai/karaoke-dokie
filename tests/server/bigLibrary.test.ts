// QWW-31: a library of 11,139 liked songs, with Easy by the Commodores liked 3,283rd, goes through the real
// Spotify client, library build, lookups and matcher, and Easy comes out with no octave mark for F2 to C5.
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { createSongService } from '../../src/lib/server/songService';
import { createSpotifyClient, getUserTracks } from '../../src/lib/server/spotify';
import { productionSongDeps, realResolver } from '../../src/lib/server/wiring';
import { songKey } from '../../src/lib/songs/resolve';

const TOTAL = 11_139;
const EASY_AT = 3282; // 0-based: the 3,283rd like
const cfg = { clientId: 'x', clientSecret: 'y', redirectUri: 'http://localhost/cb' };

function spotifyWithBigLibrary() {
  const track = (i: number) =>
    i === EASY_AT
      ? { id: 'easy', name: 'Easy', artists: [{ id: 'c', name: 'Commodores' }], external_urls: { spotify: '' }, album: { release_date: '1977' } }
      : { id: `t${i}`, name: `Song ${i}`, artists: [{ id: `a${i % 900}`, name: `Artist ${i % 900}` }], external_urls: { spotify: '' }, album: { release_date: '2000' } };
  const f = async (input: string): Promise<Response> => {
    const u = new URL(input);
    const body = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    if (u.pathname.endsWith('/me/tracks')) {
      const offset = Number(u.searchParams.get('offset') ?? 0);
      const items = Array.from({ length: Math.max(0, Math.min(50, TOTAL - offset)) }, (_, i) => ({ track: track(offset + i) }));
      return body({ items, total: TOTAL, next: null });
    }
    return body({ items: [], next: null });
  };
  return createSpotifyClient(cfg as never, f as never, async () => {});
}

describe('a big Spotify library', () => {
  it('reaches every liked song, including the 3,283rd, and shows Easy with no octave shift for F2 to C5', async () => {
    const store = createMemoryStore();
    // The stored range after the octave fix (53 to 66); before it, 65 to 78 gave 8vb.
    await store.putSongRange(songKey('Commodores', 'Easy'), {
      range: { low: 53, high: 66, tessitura: 59.15, source: 'note-file', confidence: 'high', fastLyrics: false, octaveFrom: 'recording' },
      log: { trackId: '', title: 'Easy', artist: 'Commodores', outcome: 'note-file', reason: '', at: '' },
    });
    const tracks = await getUserTracks(spotifyWithBigLibrary(), 'tok');
    expect(tracks).toHaveLength(TOTAL);
    expect(tracks.some((t) => t.id === 'easy')).toBe(true);

    const deps = { ...productionSongDeps(store, false), resolveSongRange: realResolver(store, { getNoteFile: async () => null }) };
    const service = createSongService(store, deps);
    let response = await service.recommend(tracks, { low: 41, high: 72, source: 'test' }, 0, 0, { all: true });
    for (let n = 0; response.nextOffset !== null && n < 20; n++) {
      response = await service.recommend(tracks, { low: 41, high: 72, source: 'test' }, 0, 0, { all: true });
    }
    expect(response.nextOffset).toBeNull();
    const easy = response.matches.find((m) => m.track.id === 'easy');
    expect(easy).toMatchObject({ octave: 'none', difficulty: 'easy' });
    expect(easy?.range).toMatchObject({ low: 53, high: 66 });
  }, 60_000);
});
