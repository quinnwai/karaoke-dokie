import { describe, expect, it } from 'vitest';
import { withOverlay } from '../../scripts/deezer-report';
import type { SongDeezerRecord, SongPopularityRecord } from '../../src/lib/server/store';

describe('deezer-report --overlay (QWW-67)', () => {
  const stored = new Map<string, SongPopularityRecord>([
    ['toto|africa', { key: 'toto|africa', karaokeViews: 40_000, source: 'karafun', deezerRank: 964_180, deezerId: 1 }],
    ['kehlani|folded', { key: 'kehlani|folded', source: 'deezer', deezerRank: 794_554, deezerId: 2 }],
  ]);
  const store = {
    getSongPopularity: async (keys: string[]) => new Map(keys.flatMap((k) => (stored.has(k) ? [[k, { ...stored.get(k)! }] as const] : []))),
  };

  it("reads a dry run's lookups in place of the stored ones", async () => {
    const overlay = new Map<string, SongDeezerRecord>([
      ['toto|africa', { key: 'toto|africa', checkedAt: '2026-11-12T08:00:00.000Z' }],
      ['kehlani|folded', { key: 'kehlani|folded', checkedAt: '2026-11-12T08:00:00.000Z' }],
      ['lana del rey|summertime sadness', { key: 'lana del rey|summertime sadness', rank: 813_635, deezerId: 16149860, checkedAt: '2026-11-12T08:00:00.000Z' }],
    ]);
    const read = await withOverlay(store, overlay).getSongPopularity(['toto|africa', 'kehlani|folded', 'lana del rey|summertime sadness', 'nobody|x']);
    // A miss keeps the song's other popularity, and a song whose only row was its Deezer rank has none.
    expect(read.get('toto|africa')).toStrictEqual({ key: 'toto|africa', karaokeViews: 40_000, source: 'karafun' });
    expect(read.has('kehlani|folded')).toBe(false);
    expect(read.get('lana del rey|summertime sadness')).toStrictEqual({
      key: 'lana del rey|summertime sadness',
      source: 'deezer',
      deezerRank: 813_635,
      deezerId: 16149860,
    });
    expect(read.has('nobody|x')).toBe(false);
  });
});
