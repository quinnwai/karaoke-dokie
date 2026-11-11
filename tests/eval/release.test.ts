import { describe, expect, it } from 'vitest';
import type { Match } from '../../src/lib/contracts';
import {
  checkNeverEmpty,
  checkPlay,
  checkRecognisable,
  checkTempo,
  checkTitles,
  fitsEnd,
  isRecognisable,
  isVersionTitle,
  judgeList,
  judgeSongs,
  parseJudgeReply,
  sample,
  tempoLists,
  TEST_RANGES,
  toMarkdown,
  type JudgeLabel,
  type RangeInput,
  type SongFacts,
  verdict,
} from '../../src/lib/eval/release';
import { selectOnly } from '../../scripts/eval-release';
import { songKey } from '../../src/lib/songs/resolve';

const range = TEST_RANGES[0]!;

/** A catalogue match: id cat:<songKey>, a year by decade, a tempo and a known popularity. */
function song(i: number, over: Partial<{ artist: string; title: string; year: number; tempo: number }> = {}): Match {
  const artist = over.artist ?? `Artist ${i}`;
  const title = over.title ?? `Song ${i}`;
  return {
    track: { id: `cat:${songKey(artist, title)}`, title, artist, artistId: '', spotifyUrl: '', playRank: i, familiarity: 1, known: false },
    range: { low: 50, high: 62, source: 'note-file', confidence: 'high' } as Match['range'],
    difficulty: 'easy',
    octave: 'none',
    score: 1 - i / 1000,
    parts: { comfort: 0.5, familiarity: 1, popularity: 0.9 - i / 1000, popularityKnown: true, penalty: 0 },
    year: over.year ?? 1960 + (i % 7) * 10,
    tempo: over.tempo ?? 70 + (i % 100),
  };
}
const list = (n: number) => Array.from({ length: n }, (_, i) => song(i));
const input = (matches: Match[]): RangeInput => ({ test: range, matches });

describe('titles (criterion 4)', () => {
  it('flags version tags and square brackets', () => {
    for (const t of ['Love Shack [DUET]', 'Hells Bells (Live at River Plate)', 'Hey Jude - Remastered 2015', 'Creep (Album Version)', 'Sweat (David Guetta Remix)', 'Beautiful (feat. Lil Wayne)', 'Tears In Heaven (MTV Unplugged)']) {
      expect(isVersionTitle(t), t).toBe(true);
    }
  });

  it('passes real titles that have brackets', () => {
    for (const t of ["(I Can't Get No) Satisfaction", "Don't You (Forget About Me)", 'Sk8er Boi', 'Live Forever', '(Everything I Do) I Do It for You', 'Mixed Emotions']) {
      expect(isVersionTitle(t), t).toBe(false);
    }
  });

  it('counts a song twice under a featured artist or a version tag as a duplicate', () => {
    const ms = [song(0, { artist: 'Elton John', title: 'Rocket Man' }), song(1), song(2, { artist: 'Elton John feat. X', title: 'Rocket Man - Remastered' })];
    const c = checkTitles(input(ms));
    expect(c.pass).toBe(false);
    expect(c.value).toBe('1 version, 1 duplicate');
  });

  it('passes a clean top 50', () => {
    expect(checkTitles(input(list(60))).pass).toBe(true);
  });
});

describe('recognisable (criterion 1)', () => {
  const billboard = new Set([songKey('Wilson Phillips', 'Hold On')]);
  it('counts a Billboard song under its lead artist, or a high Deezer rank', () => {
    expect(isRecognisable(song(0, { artist: 'Wilson Phillips feat. X', title: 'Hold On' }), billboard, undefined)).toBe('billboard');
    expect(isRecognisable(song(1), billboard, { deezerRank: 700_000 })).toBe('deezer');
    expect(isRecognisable(song(2), billboard, { deezerRank: 100_000 })).toBeNull();
  });

  it('needs 15 of the top 20', () => {
    const ms = list(30);
    const facts = new Map<string, SongFacts>(ms.slice(0, 14).map((m) => [m.track.id, { deezerRank: 900_000 }]));
    expect(checkRecognisable(input(ms), new Set(), facts)).toMatchObject({ pass: false, value: '14/20' });
    facts.set(ms[14]!.track.id, { deezerRank: 900_000 });
    expect(checkRecognisable(input(ms), new Set(), facts)).toMatchObject({ pass: true, value: '15/20' });
  });
});

describe('play (criterion 6)', () => {
  it('needs 90% of the top 20 to have a preview', () => {
    const ms = list(25);
    const facts = new Map<string, SongFacts>(ms.slice(0, 17).map((m) => [m.track.id, { playable: true }]));
    expect(checkPlay(input(ms), facts).pass).toBe(false);
    facts.set(ms[17]!.track.id, { playable: true });
    expect(checkPlay(input(ms), facts)).toMatchObject({ pass: true, value: '18/20' });
  });
});

describe('never empty (criterion 3)', () => {
  it('passes when every era has songs, and names the empty combinations otherwise', () => {
    expect(checkNeverEmpty(input(list(70))).pass).toBe(true);
    const no80s = list(70).filter((m) => m.year! < 1980 || m.year! >= 1990);
    const c = checkNeverEmpty(input(no80s));
    expect(c.pass).toBe(false);
    expect(c.notes).toContain('80s + tempo at 1: 0 songs');
  });

  it('fails a range with fewer than 10 songs', () => {
    expect(checkNeverEmpty(input(list(9))).notes).toContain('max difficulty: 9 songs');
  });
});

describe('tempo judge (criterion 2)', () => {
  it('parses labels by id and drops anything malformed', () => {
    const got = parseJudgeReply('{"labels":[{"id":0,"label":"slow"},{"id":1,"label":"fast"},{"id":"2","label":"mid"},{"id":3,"label":"upbeat"}]}');
    expect([...got]).toEqual([
      [0, 'slow'],
      [3, 'upbeat'],
    ]);
    expect(parseJudgeReply('not json').size).toBe(0);
  });

  it('counts a song only when every run gives the end label; disagreement is flaky and a miss', () => {
    expect(fitsEnd(['slow', 'slow', 'slow'], 'slow')).toEqual({ fits: true, flaky: false });
    expect(fitsEnd(['slow', 'mid', 'slow'], 'slow')).toEqual({ fits: false, flaky: true });
    expect(fitsEnd(['mid', 'mid', 'mid'], 'slow')).toEqual({ fits: false, flaky: false });
    expect(fitsEnd([], 'upbeat').fits).toBe(false);
  });

  it('builds a slow and an upbeat top 20 for no era and each era, slowest songs first at the slow end', () => {
    const lists = tempoLists(input(list(300)));
    expect(lists).toHaveLength(16);
    const slow = lists.find((l) => l.era === null && l.end === 'slow')!;
    const upbeat = lists.find((l) => l.era === null && l.end === 'upbeat')!;
    expect(slow.songs).toHaveLength(20);
    expect(Math.max(...slow.songs.map((m) => m.tempo!))).toBeLessThan(Math.min(...upbeat.songs.map((m) => m.tempo!)));
    expect(lists.find((l) => l.era === '80s')!.songs.every((m) => m.year! >= 1980 && m.year! < 1990)).toBe(true);
  });

  it('passes 10/10 and 18/20, fails 9/10 or 17/20', () => {
    const songs = list(20);
    const l = { range: range.id, era: null, end: 'slow' as const, songs };
    const labels = (miss: number[]) => new Map<string, JudgeLabel[]>(songs.map((m, i) => [m.track.id.slice(4), miss.includes(i) ? ['mid', 'mid', 'mid'] : ['slow', 'slow', 'slow']]));
    expect(judgeList(l, labels([18, 19])).pass).toBe(true);
    expect(judgeList(l, labels([3])).pass).toBe(false);
    expect(judgeList(l, labels([15, 18, 19])).pass).toBe(false);
    const results = [judgeList(l, labels([])), judgeList({ ...l, end: 'upbeat' }, labels([]))];
    expect(checkTempo(range.id, results)).toMatchObject({ pass: false, value: '1/2 era-ends' });
  });

  it('sends each song to the judge once, with artist, title and year only', () => {
    const lists = tempoLists(input(list(300)));
    const songs = judgeSongs(lists);
    expect(new Set(songs.map((s) => s.key)).size).toBe(songs.length);
    expect(Object.keys(songs[0]!.song).sort()).toEqual(['artist', 'title', 'year']);
  });
});

describe('report', () => {
  it('is the same sample on every run, and the table says FAIL when any check fails', () => {
    expect(sample([...Array(100).keys()], 5)).toEqual(sample([...Array(100).keys()], 5));
    const md = toMarkdown({
      title: 'Release eval',
      checks: [checkTitles(input([song(0, { title: 'X [DUET]' })]))],
      top10: [{ range, songs: [] }],
      tempoSample: [],
      meta: [],
    });
    expect(md).toContain('## Release eval: FAIL');
    expect(md).toContain('| 4. Titles (top 50) | **FAIL** 1 version, 0 duplicate | not run');
  });
});

describe('review fixes', () => {
  it('is INCOMPLETE, not PASS, when a criterion was skipped', () => {
    const clean = TEST_RANGES.map((t) => checkTitles({ test: t, matches: list(60) }));
    expect(verdict(clean)).toBe('INCOMPLETE');
    expect(verdict([...clean, { ...clean[0]!, pass: false }])).toBe('FAIL');
  });

  it('fails an empty tempo list and names a short one', () => {
    expect(judgeList({ range: range.id, era: '60s', end: 'slow', songs: [] }, new Map()).pass).toBe(false);
    const songs = list(5);
    const r = judgeList({ range: range.id, era: '60s', end: 'slow', songs }, new Map());
    expect(checkTempo(range.id, [r]).notes[0]).toContain('(only 5 songs)');
  });

  it('reports a Deezer error apart from a missing preview', () => {
    const ms = list(20);
    const facts = new Map<string, SongFacts>(ms.map((m, i) => [m.track.id, { playable: i < 2 ? 'error' : true }]));
    expect(checkPlay(input(ms), facts)).toMatchObject({ pass: true, value: '18/20 (2 not checked: Deezer error)' });
  });

  it('passes "Theme from" titles', () => {
    expect(isVersionTitle('Do You Know Where You’re Going To (Theme from Mahogany)')).toBe(false);
  });

  it('refuses any statement that writes, including a data-modifying CTE', async () => {
    const q = selectOnly(async () => []);
    await expect(q('SELECT * FROM song_tempo WHERE key = ANY($1)')).resolves.toEqual([]);
    expect(() => q('WITH x AS (DELETE FROM song_tempo RETURNING *) SELECT * FROM x')).toThrow(/reads only/);
    expect(() => q('INSERT INTO t VALUES (1)')).toThrow(/reads only/);
  });
});
