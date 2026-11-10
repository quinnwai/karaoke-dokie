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

describe('the live-data smoke check, edge cases', () => {
  const healthy = (i: number, m: Match): Match => ({
    ...m,
    year: 1960 + (i % 6) * 10,
    tempo: 70 + (i % 100),
    parts: { comfort: 0.5, familiarity: 0.5, popularity: Math.max(0.1, 0.99 - i / 700), popularityKnown: true, penalty: 0 },
    range: { ...m.range, duet: i % 20 === 0 },
  });

  it('does not count songs with no year as a decade', () => {
    // two real decades, the rest without a year
    const list = many(600, (m, i) => {
      const h = healthy(i, m);
      if (i % 3) delete h.year;
      return { ...h, ...(i % 3 === 0 ? { year: i % 2 ? 1985 : 1995 } : {}) };
    });
    expect(check('x', list, range).join('\n')).toMatch(/no decade data/);
  });

  it('wants duets in a list unless the deployment hides them (DUETS_AND_MOODS off, QWW-43)', () => {
    const list = many(600, (m, i) => {
      const { range, ...rest } = healthy(i, m);
      const { duet: _d, ...solo } = range;
      return { ...rest, range: solo };
    });
    expect(check('x', list, range).join('\n')).toMatch(/no duets/);
    expect(check('x', list, range, { duets: true }).join('\n')).toMatch(/no duets/);
    expect(check('x', list, range, { duets: false })).toEqual([]);
  });

  it('fails when coverage is just under the bar', () => {
    const list = many(600, (m, i) => {
      const h = healthy(i, m);
      if (i % 12 === 0) delete h.tempo; // 8% without a tempo
      return h;
    });
    expect(check('x', list, range).join('\n')).toMatch(/tempo for only 92%/);
  });
});
