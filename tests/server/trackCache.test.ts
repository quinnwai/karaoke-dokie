import { describe, expect, it } from 'vitest';
import type { Track } from '../../src/lib/contracts';
import { createTrackCache } from '../../src/lib/server/trackCache';

const tracks = (n: number): Track[] => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: 's', artist: 'a', artistId: 'a', spotifyUrl: '', playRank: i }));

describe('track cache', () => {
  it('shares one load between requests that arrive together (QWW-31: list and known songs)', async () => {
    const cache = createTrackCache();
    let loads = 0;
    const load = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 20));
      return tracks(3);
    };
    const [a, b] = await Promise.all([cache.get('u', load), cache.get('u', load)]);
    expect(loads).toBe(1);
    expect(a).toBe(b);
    expect(await cache.get('u', load)).toBe(a);
    expect(loads).toBe(1);
  });

  it('does not keep a failed load, so the next request tries again', async () => {
    const cache = createTrackCache();
    let loads = 0;
    const flaky = async () => {
      if (loads++ === 0) throw new Error('spotify down');
      return tracks(1);
    };
    await expect(cache.get('u', flaky)).rejects.toThrow('spotify down');
    expect(await cache.get('u', flaky)).toHaveLength(1);
    expect(loads).toBe(2);
  });

  it('keeps users apart and expires after the TTL', async () => {
    let clock = 0;
    const cache = createTrackCache(1000, () => clock);
    await cache.get('a', async () => tracks(1));
    expect(cache.peek('a')).toHaveLength(1);
    expect(cache.peek('b')).toBeNull();
    clock = 1001;
    expect(cache.peek('a')).toBeNull();
  });
});
