import { describe, expect, it } from 'vitest';
import type { Match, OctaveShift } from '../../src/lib/contracts';
import { paginate, rankMatches } from '../../src/lib/songs/rank';

const match = (id: string, playRank: number, octave: OctaveShift = 'none'): Match => ({
  track: { id, title: id, artist: 'A', artistId: 'a', spotifyUrl: `https://open.spotify.com/track/${id}`, playRank },
  range: { low: 55, high: 65, tessitura: 60, source: 'note-file', confidence: 'high', fastLyrics: false },
  difficulty: 'easy',
  octave,
});

const ids = (list: Match[]) => list.map((m) => m.track.id);

describe('rankMatches', () => {
  it('puts direct fits before octave fits, each by play rank', () => {
    const ranked = rankMatches([
      match('up1', 1, 'up'),
      match('d5', 5),
      match('down0', 0, 'down'),
      match('d2', 2),
    ]);
    expect(ids(ranked)).toEqual(['d2', 'd5', 'down0', 'up1']);
  });

  it('treats up and down shifts as one group', () => {
    expect(ids(rankMatches([match('up3', 3, 'up'), match('down4', 4, 'down'), match('up1', 1, 'up')]))).toEqual([
      'up1',
      'up3',
      'down4',
    ]);
  });

  it('keeps input order for ties', () => {
    expect(ids(rankMatches([match('b', 1), match('a', 1), match('c', 1)]))).toEqual(['b', 'a', 'c']);
  });

  it('does not change the input array', () => {
    const input = [match('b', 2), match('a', 1)];
    rankMatches(input);
    expect(ids(input)).toEqual(['b', 'a']);
  });
});

describe('paginate', () => {
  const list = [1, 2, 3, 4, 5, 6, 7];

  it('returns a page and the next offset', () => {
    expect(paginate(list, 0, 5)).toEqual({ items: [1, 2, 3, 4, 5], nextOffset: 5 });
  });

  it('returns null for nextOffset on the last page', () => {
    expect(paginate(list, 5, 5)).toEqual({ items: [6, 7], nextOffset: null });
    expect(paginate(list, 2, 5)).toEqual({ items: [3, 4, 5, 6, 7], nextOffset: null });
  });

  it('handles an offset past the end and an empty list', () => {
    expect(paginate(list, 10, 5)).toEqual({ items: [], nextOffset: null });
    expect(paginate([], 0, 5)).toEqual({ items: [], nextOffset: null });
  });

  it('clamps negative or fractional offset and limit', () => {
    expect(paginate(list, -3, 2)).toEqual({ items: [1, 2], nextOffset: 2 });
    expect(paginate(list, 1.7, 2.2)).toEqual({ items: [2, 3], nextOffset: 3 });
    expect(paginate(list, 0, 0)).toEqual({ items: [], nextOffset: null });
  });
});
