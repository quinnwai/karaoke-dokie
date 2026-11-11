import { describe, expect, it } from 'vitest';
import { ERA_IDS, type EraId, type Match } from '../../src/lib/contracts';
import {
  checkNeverEmpty,
  checkPlay,
  checkRecognisable,
  checkTempo,
  checkTitles,
  fitsEnd,
  handCheck,
  isRecognisable,
  isVersionTitle,
  judgeList,
  judgeSongs,
  parseJudgeReply,
  shuffled,
  tempoLists,
  TEST_RANGES,
  toMarkdown,
  type JudgeLabel,
  type RangeInput,
  type SongFacts,
  type TestRange,
  verdict,
  VIEWS,
} from '../../src/lib/eval/release';
import { selectOnly } from '../../scripts/eval-release';
import { setlistFor } from '../../src/lib/server/setlistService';
import { prepareSetlist } from '../../src/lib/songs/setlist';
import { DEFAULT_OFF, DEFAULTS } from '../../src/lib/songs/setlistConfig';
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
/** The songs as the tuner's engine holds them for one test range (what POST /api/setlist ranks). */
const input = (matches: Match[], test: TestRange = range): RangeInput => ({ test, prepared: prepareSetlist(matches.map((match) => ({ match })), test.range) });
/** The judge's labels by song key, the same for every song unless `of` gives a song its own. */
const votes = (songs: Match[], all: JudgeLabel[], of: (m: Match, i: number) => JudgeLabel[] | undefined = () => undefined) =>
  new Map<string, JudgeLabel[]>(songs.map((m, i) => [m.track.id.slice(4), of(m, i) ?? all]));

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

  it('counts a title with a curly apostrophe and one with a straight one as the same song', () => {
    const ms = [song(0, { artist: 'Ricky Martin', title: 'Livin’ la vida loca' }), song(1, { artist: 'Ricky Martin', title: "Livin' La Vida Loca" })];
    expect(checkTitles(input(ms)).value).toBe('0 version, 1 duplicate');
  });
});

describe('the lists are the tuner engine’s (POST /api/setlist)', () => {
  // Labels and ranges vary, so every gear moves the order.
  const songs = list(300).map((m, i): Match => ({ ...m, difficulty: (['easy', 'medium', 'hard'] as const)[i % 3]!, range: { ...m.range, low: 44 + (i % 17), high: 56 + (i % 17) } }));
  const t = input(songs);
  const base = { matches: songs, logs: new Map(), prepared: t.prepared };
  const route = (req: Omit<Parameters<typeof setlistFor>[2], 'range' | 'limit'>) =>
    setlistFor(base, null, { ...req, range: { low: range.range.low, high: range.range.high }, limit: 200 }).songs.map((s) => s.match.track.id);
  const ids = (ms: Match[]) => ms.slice(0, 200).map((m) => m.track.id);
  const { eras: _eras, ...gears } = DEFAULTS;

  it('ranks the first list as the route does for the tuner as it opens', () => {
    expect(ids(VIEWS.default(t.prepared))).toEqual(route({ gears, off: [...DEFAULT_OFF], eras: [] }));
  });

  it('ranks a tempo end as the route does with Tempo alone and one era picked', () => {
    const off = ['difficulty', 'history', 'popularity'] as const;
    expect(ids(VIEWS.eraTempo(t.prepared, 's80', 'slow'))).toEqual(route({ gears: { ...gears, tempo: 0 }, off: [...off], eras: ['s80'] }));
    expect(ids(VIEWS.eraTempo(t.prepared, null, 'upbeat'))).toEqual(route({ gears: { ...gears, tempo: 100 }, off: [...off, 'era'], eras: [] }));
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
    expect(c.notes).toContain('’80s + tempo at 100: 0 songs');
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

  it('counts a song when 2 of 3 runs give the end label, not when 1 of 3 does', () => {
    expect(fitsEnd(['slow', 'slow', 'slow'], 'slow')).toBe(true);
    expect(fitsEnd(['slow', 'mid', 'slow'], 'slow')).toBe(true);
    expect(fitsEnd(['upbeat', 'upbeat', 'slow'], 'upbeat')).toBe(true);
    expect(fitsEnd(['mid', 'slow', 'mid'], 'slow')).toBe(false);
    expect(fitsEnd(['slow', 'unknown', 'upbeat'], 'slow')).toBe(false);
    expect(fitsEnd(['slow', 'slow', 'mid'], 'upbeat')).toBe(false);
    expect(fitsEnd([], 'upbeat')).toBe(false);
  });

  it('builds a slow and an upbeat top 20 for Era off and each era, slowest songs first at the slow end', () => {
    const lists = tempoLists(input(list(300)));
    expect(lists.map((l) => `${l.era ?? 'off'} ${l.end}`)).toEqual([null, ...ERA_IDS].flatMap((e) => [`${e ?? 'off'} slow`, `${e ?? 'off'} upbeat`]));
    const slow = lists.find((l) => l.era === null && l.end === 'slow')!;
    const upbeat = lists.find((l) => l.era === null && l.end === 'upbeat')!;
    expect(slow.songs).toHaveLength(20);
    expect(Math.max(...slow.songs.map((m) => m.tempo!))).toBeLessThan(Math.min(...upbeat.songs.map((m) => m.tempo!)));
    expect(lists.find((l) => l.era === 's80')!.songs.every((m) => m.year! >= 1980 && m.year! < 1990)).toBe(true);
  });

  it('ranks the tempo ends on tempo alone: a popular mid-tempo song does not reach the slow end', () => {
    const slowSongs = Array.from({ length: 25 }, (_, i) => song(100 + i, { year: 1995, tempo: 60 + i }));
    const hit = song(0, { year: 1995, tempo: 120 });
    const top = tempoLists(input([hit, ...slowSongs])).find((l) => l.era === 's90' && l.end === 'slow')!;
    expect(top.songs.map((m) => m.track.id)).toEqual(slowSongs.slice(0, 20).map((m) => m.track.id));
  });

  it('passes an end at 18 of its top 20, fails it at 17, wherever the misses sit', () => {
    const songs = list(20);
    const l = { range: range.id, era: null, end: 'slow' as const, songs };
    const split: JudgeLabel[] = ['slow', 'mid', 'slow'];
    const oneOfThree: JudgeLabel[] = ['mid', 'slow', 'mid'];
    const labels = (miss: number[]) => votes(songs, split, (_, i) => (miss.includes(i) ? oneOfThree : undefined));
    expect(judgeList(l, labels([18, 19]))).toMatchObject({ counted: 18, pass: true });
    expect(judgeList(l, labels([0, 1]))).toMatchObject({ counted: 18, pass: true });
    expect(judgeList(l, labels([17, 18, 19]))).toMatchObject({ counted: 17, pass: false });
    expect(judgeList(l, labels([0, 1, 2]))).toMatchObject({ counted: 17, pass: false, missed: ['Artist 0 - Song 0 (mid, slow, mid)', 'Artist 1 - Song 1 (mid, slow, mid)', 'Artist 2 - Song 2 (mid, slow, mid)'] });
    const results = [judgeList(l, labels([])), judgeList({ ...l, end: 'upbeat' }, labels([]))];
    const c = checkTempo(range.id, results);
    expect(c).toMatchObject({ pass: false, value: '1/2 era-ends' });
    expect(c.notes).toHaveLength(1);
    expect(c.notes[0]).toMatch(/^any era upbeat: 0\/20 count\. Not counted: Artist 0 - Song 0 \(slow, mid, slow\); /);
  });

  it('grades only the top 20 of a longer list', () => {
    const songs = list(25);
    const l = { range: range.id, era: null, end: 'slow' as const, songs };
    expect(judgeList(l, votes(songs, ['slow', 'slow', 'slow'], (_, i) => (i < 3 ? ['mid', 'mid', 'mid'] : undefined)))).toMatchObject({ counted: 17, pass: false });
  });

  it('sends each run the songs in its own order, not sorted by stored tempo', () => {
    const songs = judgeSongs(tempoLists(input(list(300))));
    const runs = [1, 2, 3].map((seed) => shuffled(songs, seed));
    for (const order of runs) expect([...order].sort((a, b) => a.key.localeCompare(b.key))).toEqual([...songs].sort((a, b) => a.key.localeCompare(b.key)));
    expect(runs[0]).toEqual(shuffled(songs, 1));
    expect(runs[0]).not.toEqual(songs);
    expect(runs[0]).not.toEqual(runs[1]);
    expect(runs[1]).not.toEqual(runs[2]);
  });

  it('grades an era whose pool is thin like the rest: it fails unless 18 songs count', () => {
    // The ’20s: 30 songs fit, 6 of them slow, so mid songs fill out the slow end. The ’90s: 12 songs, all slow.
    // The ’00s: 18 songs, all slow. The ’70s: no songs at all.
    const s20 = Array.from({ length: 30 }, (_, i) => song(i, { year: 2021, tempo: 60 + i }));
    const s90 = Array.from({ length: 12 }, (_, i) => song(100 + i, { year: 1995, tempo: 60 + i }));
    const s00 = Array.from({ length: 18 }, (_, i) => song(200 + i, { year: 2005, tempo: 60 + i }));
    const slowOnes = new Set([...s20.slice(0, 6), ...s90, ...s00]);
    const all = [...s20, ...s90, ...s00];
    const lists = tempoLists(input(all));
    const results = lists.map((l) => judgeList(l, votes(all, ['mid', 'mid', 'mid'], (m) => (slowOnes.has(m) ? ['slow', 'slow', 'slow'] : undefined))));
    const slowEnd = (era: EraId) => results.find((r) => r.list.era === era && r.list.end === 'slow')!;
    expect(slowEnd('s20')).toMatchObject({ counted: 6, pass: false });
    expect(slowEnd('s20').list.songs).toHaveLength(20);
    expect(slowEnd('s90')).toMatchObject({ counted: 12, pass: false });
    expect(slowEnd('s00')).toMatchObject({ counted: 18, pass: true });
    expect(slowEnd('s70')).toMatchObject({ counted: 0, pass: false });
    const c = checkTempo(range.id, results);
    expect(c.pass).toBe(false);
    expect(c.value).toMatch(/\/16 era-ends$/);
    const note = (start: string) => c.notes.filter((n) => n.startsWith(start));
    expect(note('’20s slow: 6/20 count. Not counted: ')).toHaveLength(1);
    expect(note('’90s slow: 12/20 count (only 12 songs in the pool)')).toEqual(['’90s slow: 12/20 count (only 12 songs in the pool)']);
    expect(note('’70s slow: 0/20 count (only 0 songs in the pool)')).toHaveLength(1);
  });

  it('sends each song to the judge once, with artist, title and year only', () => {
    const lists = tempoLists(input(list(300)));
    const songs = judgeSongs(lists);
    expect(new Set(songs.map((s) => s.key)).size).toBe(songs.length);
    expect(Object.keys(songs[0]!.song).sort()).toEqual(['artist', 'title', 'year']);
  });
});

describe('report', () => {
  it('says FAIL when any check fails', () => {
    const md = toMarkdown({
      title: 'Release eval',
      checks: [checkTitles(input([song(0, { title: 'X [DUET]' })]))],
      top10: [{ range, songs: [] }],
      handCheck: null,
      meta: [],
    });
    expect(md).toContain('## Release eval: FAIL');
    expect(md).toContain('| 4. Titles (top 50) | **FAIL** 1 version, 0 duplicate | not run');
  });

  it("lists the ’90s slow and upbeat top 20 for F2 to C5, as graded, for Quinn-Wai's hand check", () => {
    const songs = list(300);
    const lists = tempoLists(input(songs));
    const h = handCheck(lists, votes(songs, ['slow', 'mid', 'slow']));
    expect(h).toMatchObject({ range: 'low-male', era: 's90' });
    expect(h.ends.map((e) => [e.end, e.songs.length])).toEqual([
      ['slow', 20],
      ['upbeat', 20],
    ]);
    expect(h.ends[0]!.songs.every((s) => s.counts && s.year! >= 1990 && s.year! < 2000)).toBe(true);
    expect(h.ends[1]!.songs.some((s) => s.counts)).toBe(false);
    const md = toMarkdown({ title: 'Release eval', checks: [], top10: [], handCheck: h, meta: [] });
    expect(md).toContain('### Tempo hand check: Low male (Quinn-Wai, F2-C5), ’90s');
    expect(md).toContain('**Slow end, top 20: 20 count**');
    expect(md).toContain('**Upbeat end, top 20: 0 count**');
    expect(md).toContain('| slow, mid, slow | **no** |');
  });
});

describe('review fixes', () => {
  it('is INCOMPLETE, not PASS, when a criterion was skipped', () => {
    const clean = TEST_RANGES.map((t) => checkTitles(input(list(60), t)));
    expect(verdict(clean)).toBe('INCOMPLETE');
    expect(verdict([...clean, { ...clean[0]!, pass: false }])).toBe('FAIL');
  });

  it('fails an empty tempo list and names a short one', () => {
    expect(judgeList({ range: range.id, era: 'pre', end: 'slow', songs: [] }, new Map()).pass).toBe(false);
    const songs = list(5);
    const r = judgeList({ range: range.id, era: 'pre', end: 'slow', songs }, new Map());
    expect(checkTempo(range.id, [r]).notes[0]).toContain('(only 5 songs in the pool)');
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
