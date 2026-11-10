import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Match } from '../../src/lib/contracts';
import { check, onScreen, previewProblems } from '../../scripts/smoke-live';
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
      deezerId: 1000 + i,
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
    expect(fails).toMatch(/only 0% of the first 20 songs on screen have a Deezer id/);
  });
});

describe('the live-data smoke check, edge cases', () => {
  const healthy = (i: number, m: Match): Match => ({
    ...m,
    year: 1960 + (i % 6) * 10,
    tempo: 70 + (i % 100),
    parts: { comfort: 0.5, familiarity: 0.5, popularity: Math.max(0.1, 0.99 - i / 700), popularityKnown: true, penalty: 0 },
    range: { ...m.range, duet: i % 20 === 0 },
    deezerId: 1000 + i,
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

describe('the play check (QWW-48)', () => {
  const healthy = (i: number, m: Match): Match => ({
    ...m,
    year: 1960 + (i % 6) * 10,
    tempo: 70 + (i % 100),
    parts: { comfort: 0.5, familiarity: 0.5, popularity: Math.max(0.1, 0.99 - i / 700), popularityKnown: true, penalty: 0 },
    range: { ...m.range, duet: i % 20 === 0 },
    deezerId: 1000 + i,
  });

  afterEach(() => vi.unstubAllGlobals());

  it('fails when 3 of the first 20 songs on screen have no Deezer id, and passes with 2', () => {
    const without = (n: number) => {
      const list = many(600, (m, i) => healthy(i, m));
      const shown = new Set(onScreen(list, range).slice(0, n).map((m) => m.track.id));
      return list.map((m): Match => {
        if (!shown.has(m.track.id)) return m;
        const { deezerId: _id, ...rest } = m;
        return rest;
      });
    };
    expect(check('x', without(3), range).join('\n')).toMatch(/only 85% of the first 20 songs on screen have a Deezer id/);
    expect(check('x', without(2), range)).toEqual([]);
  });

  it("plays each song as a phone does: our redirect to Deezer's CDN, then audio from the link", async () => {
    const cdn = (id: number) => `https://cdnt-preview.dzcdn.net/api/1/${id}.mp3?hdnea=exp=1~hmac=x`;
    const fetch = vi.fn(async (url: string) => {
      const id = Number(url.split('/').pop()!.split('.')[0]);
      if (url.startsWith('https://deploy.example/api/preview/')) {
        if (id === 3) return new Response('{"error":"no-preview"}', { status: 404 });
        if (id === 4) return new Response(null, { status: 302, headers: { location: 'https://evil.example/a.mp3' } });
        return new Response(null, { status: 302, headers: { location: cdn(id) } });
      }
      if (id === 5) return new Response('denied', { status: 403, headers: { 'content-type': 'text/plain' } });
      return new Response('ID', { status: 206, headers: { 'content-type': 'audio/mpeg' } });
    });
    vi.stubGlobal('fetch', fetch);
    const base = many(1, (m) => m)[0]!;
    const songs: Match[] = [1, 2, 3, 4, 5].map((id, i) => ({ ...base, deezerId: id, track: { ...base.track, title: `Song ${i + 1}` } }));
    songs.push({ ...base, track: { ...base.track, title: 'No id' } });
    const { playable, problems } = await previewProblems('https://deploy.example', { 'x-vercel-protection-bypass': 'secret' }, songs);
    expect(playable).toBe(2);
    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).toMatch(/Song 3: \/api\/preview\/3 answered HTTP 404/);
    expect(problems.join('\n')).toMatch(/Song 4: \/api\/preview\/4 answered HTTP 302 to https:\/\/evil.example\/a.mp3/);
    expect(problems.join('\n')).toMatch(/Song 5: Deezer's link answered HTTP 403 \(text\/plain\)/);
    expect(problems.join('\n')).toMatch(/No id: no Deezer id/);
    // Our route gets the bypass header and is not followed; Deezer's link is asked for its first bytes only.
    expect(fetch.mock.calls[0]).toEqual(['https://deploy.example/api/preview/1', expect.objectContaining({ redirect: 'manual', headers: { 'x-vercel-protection-bypass': 'secret' } })]);
    expect(fetch.mock.calls[1]).toEqual([cdn(1), expect.objectContaining({ headers: { range: 'bytes=0-1' } })]);
  });
});
