import { describe, expect, it } from 'vitest';
import type { Match } from '../../src/lib/contracts';
import { check } from '../../scripts/smoke-live';
import { allMatchesWithFacts } from '../fixtures/screen';

const range = { low: 45, high: 72, source: 'songs' as const };

function many(n: number, f: (m: Match, i: number) => Match): Match[] {
  const base = allMatchesWithFacts().matches;
  return Array.from({ length: n }, (_, i) => {
    const m = base[i % base.length]!;
    return f({ ...m, track: { ...m.track, id: `t${i}`, playRank: i } }, i);
  });
}

describe('the live-data smoke check', () => {
  it('passes for a list with years, popularity and tempo, and well-known songs first', () => {
    const list = many(600, (m, i) => ({
      ...m,
      year: 1960 + (i % 6) * 10,
      tempo: 70 + (i % 100),
      range: { ...m.range, duet: i % 20 === 0 },
      parts: { comfort: (i % 7) / 7, familiarity: 0.5, popularity: Math.max(0.1, 0.99 - i / 700), popularityKnown: true, penalty: 0 },
    }));
    expect(check('fixture', list, range)).toEqual([]);
  });

  it('fails for a list from a database without the data: no years, popularity or tempo', () => {
    const list = many(600, (m) => {
      const { year: _y, yearSource: _s, tempo: _t, ...rest } = m;
      return { ...rest, parts: { comfort: 0.5, familiarity: 0.5, popularity: 0.4, popularityKnown: false, penalty: 0 } };
    });
    const fails = check('bare', list, range).join('\n');
    expect(fails).toMatch(/no decade data/);
    expect(fails).toMatch(/popularity known for only 0%/);
    expect(fails).toMatch(/tempo for only 0%/);
    expect(fails).toMatch(/not well known/);
    expect(fails).toMatch(/popularity slider does not change/);
    expect(fails).toMatch(/tempo slider does not change/);
  });
});
