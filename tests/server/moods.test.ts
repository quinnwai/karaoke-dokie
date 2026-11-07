import { describe, expect, it } from 'vitest';
import type { Match } from '../../src/lib/contracts';
import { attachMoods, matchKey, parseShippedMoods } from '../../src/lib/server/moods';
import type { SongMoodsRecord } from '../../src/lib/server/store';

const match = (id: string, artist: string, title: string): Match => ({
  track: { id, title, artist, artistId: '', spotifyUrl: '', playRank: 0 },
  range: { low: 50, high: 60, tessitura: 55, source: 'note-file', confidence: 'high', fastLyrics: false },
  difficulty: 'easy',
  octave: 'none',
});

function store(records: SongMoodsRecord[]) {
  const calls: string[][] = [];
  return {
    calls,
    async getSongMoods(keys: string[]) {
      calls.push(keys);
      return new Map(records.filter((r) => keys.includes(r.key)).map((r) => [r.key, r]));
    },
  };
}

describe('shipped moods', () => {
  it('parses MOODS_SHIPPED and ignores unknown names', () => {
    expect(parseShippedMoods(undefined)).toEqual([]);
    expect(parseShippedMoods('heartfelt, UPBEAT,party')).toEqual(['upbeat', 'heartfelt']);
  });

  it('keys library songs by artist and title, and catalogue songs by their id', () => {
    expect(matchKey(match('abc', 'Queen', 'Bohemian Rhapsody - Remastered 2011'))).toBe('queen|bohemian rhapsody');
    expect(matchKey(match('cat:abba|dancing queen', 'ABBA', 'Dancing Queen'))).toBe('abba|dancing queen');
  });

  it('attaches only shipped moods, in one read, and leaves unlabelled songs alone', async () => {
    const s = store([
      { key: 'abba|dancing queen', moods: ['upbeat', 'heartfelt'], method: 'm', source: 'claude' },
      { key: 'adele|someone like you', moods: ['heartfelt'], method: 'm', source: 'claude' },
    ]);
    const matches = [match('cat:abba|dancing queen', 'ABBA', 'Dancing Queen'), match('t2', 'Adele', 'Someone Like You'), match('t3', 'X', 'Y')];
    const out = await attachMoods(matches, s, ['upbeat']);
    expect(out.map((m) => m.moods)).toEqual([['upbeat'], undefined, undefined]);
    expect(s.calls).toHaveLength(1);
  });

  it('does nothing, and reads nothing, when no mood has shipped', async () => {
    const s = store([{ key: 'x|y', moods: ['upbeat'], method: 'm', source: 'claude' }]);
    const matches = [match('t3', 'X', 'Y')];
    expect(await attachMoods(matches, s, [])).toBe(matches);
    expect(s.calls).toHaveLength(0);
  });
});
