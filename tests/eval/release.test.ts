import { describe, expect, it } from 'vitest';
import type { Match, SongRange } from '../../src/lib/contracts';
import {
  checkNeverEmpty,
  checkPlay,
  checkRecognisable,
  checkSungAsWritten,
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
  tunerDefaultList,
  type Check,
  type JudgeLabel,
  type RangeInput,
  type SongFacts,
  verdict,
} from '../../src/lib/eval/release';
import { loadHarnessCatalogue, selectOnly } from '../../scripts/eval-release';
import { loadCatalogue } from '../../src/lib/server/catalogue';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import type { SongCanonical } from '../../src/lib/server/store';
import { songKey } from '../../src/lib/songs/resolve';
import { prepareSetlist } from '../../src/lib/songs/setlist';

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

describe('the catalogue the harness grades (QWW-49)', () => {
  const stored = (artist: string, title: string) => {
    const range: SongRange = { low: 55, high: 67, tessitura: 61, source: 'note-file', confidence: 'high', fastLyrics: false };
    return {
      key: `${artist}|${title}`.toLowerCase(),
      artist,
      title,
      range,
      log: { trackId: '', title, artist, outcome: range.source, reason: 'Measured.', at: '2026-11-11T00:00:00.000Z' },
    };
  };
  /** A record as the title build writes it: the clean title to show, for a row that still has the title it had then. */
  const folded = (row: ReturnType<typeof stored>, intoKey: string, title: string): SongCanonical => ({
    key: row.key,
    canonicalKey: intoKey,
    title,
    artist: row.artist,
    method: 'titles-v1',
    reason: row.key === intoKey ? 'same' : 'folded',
    sourceTitle: row.title,
    sourceArtist: row.artist,
  });

  it('is the list the app serves: one row per song, with its clean title, not the rows as stored', async () => {
    const store = createMemoryStore();
    const rows = [stored('Aaliyah', "I Don't Wanna"), stored('Aaliyah', 'I Don’t Wanna'), stored('10cc', 'Dreadlock Holiday (Album Version)'), stored('Toto', 'Africa')];
    for (const r of rows) await store.putSongRange(r.key, { range: r.range, log: r.log });
    await store.putSongPopularity([
      { key: rows[0]!.key, karaokeViews: 1_000, source: 'test' },
      { key: rows[1]!.key, karaokeViews: 40_000_000, source: 'test' },
    ]);
    await store.putSongCanonical([
      folded(rows[0]!, rows[1]!.key, 'I Don’t Wanna'), // the same song under another spelling: folded into the more popular row
      folded(rows[1]!, rows[1]!.key, 'I Don’t Wanna'),
      folded(rows[2]!, rows[2]!.key, 'Dreadlock Holiday'), // the version tag is gone
    ]);

    const loaded = await loadHarnessCatalogue(store);
    expect(loaded.map((m) => `${m.artist} - ${m.title}`).sort()).toEqual(['10cc - Dreadlock Holiday', 'Aaliyah - I Don’t Wanna', 'Toto - Africa']);
    // The harness used to read the rows as stored, which is four, with the tag, and a song twice.
    expect(await loadCatalogue(store)).toHaveLength(4);
  });
});

describe('the test ranges (QWW-58)', () => {
  it('are one per voice type, from bass to soprano, and Quinn-Wai\'s own ranges (MIDI, C4 = 60)', () => {
    const byId = Object.fromEntries(TEST_RANGES.map((t) => [t.id, [t.range.low, t.range.high]]));
    expect(byId).toEqual({
      bass: [40, 64], // E2 to E4
      'f2-f4': [41, 65],
      baritone: [45, 69], // A2 to A4
      tenor: [48, 72], // C3 to C5
      alto: [53, 77], // F3 to F5
      mezzo: [57, 81], // A3 to A5
      soprano: [60, 84], // C4 to C6
      'low-male': [41, 72], // F2 to C5
      beginner: [55, 69], // G3 to A4
    });
    expect(new Set(TEST_RANGES.map((t) => t.id)).size).toBe(TEST_RANGES.length);
  });

  it('are named by voice type, with the notes', () => {
    const label = (id: string) => TEST_RANGES.find((t) => t.id === id)!.label;
    expect(label('bass')).toBe('Bass (E2-E4)');
    expect(label('baritone')).toBe('Baritone (A2-A4)');
    expect(label('tenor')).toBe('Tenor (C3-C5)');
    expect(label('alto')).toBe('Alto (F3-F5)');
    expect(label('mezzo')).toBe('Mezzo (A3-A5)');
    expect(label('soprano')).toBe('Soprano (C4-C6)');
    expect(label('f2-f4')).toContain('F2-F4');
    expect(label('f2-f4')).toContain('Quinn-Wai');
  });
});

describe('sung as written (criterion 9, QWW-58)', () => {
  /** A top 20 where the first `written` songs are sung as written and the rest an octave away, alternating down and up. */
  const top20 = (written: number): Match[] => list(20).map((m, i): Match => (i < written ? m : { ...m, octave: i % 2 ? 'up' : 'down' }));

  it('needs 15 of the top 20 sung as written', () => {
    expect(checkSungAsWritten(range, top20(14))).toMatchObject({ criterion: 9, range: range.id, pass: false, value: '14/20', want: '>=15/20' });
    expect(checkSungAsWritten(range, top20(15))).toMatchObject({ pass: true, value: '15/20' });
    expect(checkSungAsWritten(range, top20(20))).toMatchObject({ pass: true, value: '20/20', notes: [] });
  });

  it('names the songs that need an octave jump, and which way', () => {
    const c = checkSungAsWritten(range, top20(18));
    expect(c.notes).toHaveLength(2);
    expect(c.notes[0]).toContain('sung an octave down');
    expect(c.notes[1]).toContain('sung an octave up');
    expect(c.notes[0]).toContain(top20(18)[18]!.track.title);
  });

  it('reads only the first 20 songs of the list', () => {
    const later = [...top20(20), ...list(10).map((m): Match => ({ ...m, octave: 'down' }))];
    expect(checkSungAsWritten(range, later)).toMatchObject({ pass: true, value: '20/20' });
  });

  it('fails a list of fewer than 20 songs, like criterion 1', () => {
    expect(checkSungAsWritten(range, list(19))).toMatchObject({ pass: false, value: '19/19' });
    expect(checkSungAsWritten(range, [])).toMatchObject({ pass: false, value: '0/0' });
  });

  it('counts only a song with no octave shift, whatever else it carries', () => {
    expect(checkSungAsWritten(range, list(20).map((m): Match => ({ ...m, octave: 'up' }))).value).toBe('0/20');
  });
});

describe('the tuner\'s default list (QWW-58)', () => {
  it('is the engine\'s list for a logged-out singer with the defaults: songs sung as written first, whatever their popularity', () => {
    const popularJump: Match = { ...song(0), octave: 'down', parts: { ...song(0).parts!, popularity: 0.95 } };
    const quietWritten: Match = { ...song(1), parts: { ...song(1).parts!, popularity: 0.4 } };
    const list2 = tunerDefaultList(prepareSetlist([{ match: popularJump }, { match: quietWritten }], range.range));
    expect(list2.map((m) => m.track.id)).toEqual([quietWritten.track.id, popularJump.track.id]);
  });

  it('keeps every song: the jumps follow', () => {
    const ms = list(30).map((m, i): Match => (i % 3 === 0 ? { ...m, octave: 'up' } : m));
    expect(tunerDefaultList(prepareSetlist(ms.map((match) => ({ match })), range.range))).toHaveLength(30);
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

  it('needs criterion 9 on every range for a PASS (QWW-58)', () => {
    const all = (criterion: Check['criterion']): Check[] => TEST_RANGES.map((t) => ({ criterion, range: t.id, pass: true, value: 'ok', want: 'ok', notes: [] }));
    const before = [1, 2, 3, 4, 6].flatMap((c) => all(c as Check['criterion']));
    expect(verdict(before)).toBe('INCOMPLETE');
    expect(verdict([...before, ...all(9)])).toBe('PASS');
    expect(verdict([...before, ...all(9).slice(1)])).toBe('INCOMPLETE'); // one range without it
  });

  it('puts criterion 9 in the table, with its target', () => {
    const md = toMarkdown({ title: 'Release eval', checks: [checkSungAsWritten(range, list(20))], top10: [{ range, songs: [] }], tempoSample: [], meta: [] });
    expect(md).toContain('| 9. Sung as written (top 20) | PASS 20/20 |');
    expect(md).toContain('9 at least 15 of the top 20 sung as written');
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
