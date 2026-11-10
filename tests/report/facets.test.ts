import { describe, expect, it } from 'vitest';
import type { Label, Match, SongRange } from '../../src/lib/contracts';
import { decadeOf, facetReport, facetTable } from '../../src/lib/report/facets';

const range = (extra: Partial<SongRange> = {}): SongRange => ({
  low: 50, high: 70, tessitura: 60, source: 'note-file', confidence: 'high', fastLyrics: false, ...extra,
});
const match = (id: string, difficulty: Label, extra: { year?: number; known?: boolean; duet?: boolean } = {}): Match => ({
  track: { id, title: id, artist: 'A', artistId: 'a', spotifyUrl: '', playRank: 0 },
  range: range(extra.duet ? { duet: true } : {}),
  difficulty,
  octave: 'none',
  ...(extra.year !== undefined ? { year: extra.year } : {}),
  ...(extra.known !== undefined ? { parts: { comfort: 1, familiarity: 1, popularity: 0.4, popularityKnown: extra.known, penalty: 0 } } : {}),
});

describe('decadeOf', () => {
  it('puts 1969 and earlier in the 60s and 2020 on in the 20s', () => {
    const cases: [number, string][] = [
      [1925, '60s'], [1969, '60s'], [1970, '70s'], [1979, '70s'], [1980, '80s'], [1999, '90s'],
      [2000, '00s'], [2009, '00s'], [2010, '10s'], [2019, '10s'], [2020, '20s'], [2027, '20s'],
    ];
    for (const [year, decade] of cases) expect(decadeOf(year), String(year)).toBe(decade);
  });
});

describe('facetReport', () => {
  const matches = [
    match('a', 'easy', { year: 1975, known: true }),
    match('b', 'easy', { year: 1979, known: false, duet: true }),
    match('c', 'medium', { year: 2003 }), // no score parts: popularity counts as unknown
    match('d', 'hard', { known: true }), // no year
    match('e', 'maybe', { year: 1961, known: false }),
    match('f', 'maybe', { year: 2021, known: true, duet: true }),
  ];

  it('counts the main list and Maybe apart, by decade, label, known popularity and duets', () => {
    const r = facetReport(matches);
    expect(r.main).toEqual({
      songs: 4,
      byDecade: { '60s': 0, '70s': 2, '80s': 0, '90s': 0, '00s': 1, '10s': 0, '20s': 0 },
      noYear: 1,
      byLabel: { easy: 2, medium: 1, hard: 1, maybe: 0 },
      popularityKnown: 2,
      popularityUnknown: 2,
      duets: 1,
    });
    expect(r.maybe).toEqual({
      songs: 2,
      byDecade: { '60s': 1, '70s': 0, '80s': 0, '90s': 0, '00s': 0, '10s': 0, '20s': 1 },
      noYear: 0,
      byLabel: { easy: 0, medium: 0, hard: 0, maybe: 2 },
      popularityKnown: 1,
      popularityUnknown: 1,
      duets: 1,
    });
  });

  it('is all zeros for no matches', () => {
    const r = facetReport([]);
    expect(r.main.songs + r.maybe.songs).toBe(0);
    expect(Object.values(r.main.byDecade).every((n) => n === 0)).toBe(true);
  });

  it('prints one row per count, the main list and Maybe side by side', () => {
    const lines = facetTable(facetReport(matches)).trimEnd().split('\n');
    expect(lines[0]).toMatch(/^\s+Main list\s+Maybe$/);
    const row = (name: string) => lines.find((l) => l.startsWith(`${name} `))!.trim().split(/\s{2,}/);
    expect(row('Songs')).toEqual(['Songs', '4', '2']);
    expect(row('60s and earlier')).toEqual(['60s and earlier', '0', '1']);
    expect(row('70s')).toEqual(['70s', '2', '0']);
    expect(row('No year')).toEqual(['No year', '1', '0']);
    expect(row('Popularity unknown')).toEqual(['Popularity unknown', '2', '1']);
    expect(row('Duets')).toEqual(['Duets', '1', '1']);
    expect(lines).toHaveLength(1 + 1 + 7 + 1 + 3 + 2 + 1);
  });
});
