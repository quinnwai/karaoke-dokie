import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from '../../src/lib/moods/csv';
import { goldFromCsv, goldTemplateCsv, parseGoldSet, pickGoldSongs, type GoldCandidate } from '../../src/lib/moods/gold';

describe('csv', () => {
  it('reads quoted commas, doubled quotes, line breaks in quotes, CRLF, a byte-order mark and blank lines', () => {
    const text = '﻿year,title,artist\r\n1991,"Right Here, Right Now",Jesus Jones\r\n\r\n2004,"She Said ""Hey""",X\r\n1999,"Two\nLines",Y';
    expect(parseCsv(text)).toEqual([
      ['year', 'title', 'artist'],
      ['1991', 'Right Here, Right Now', 'Jesus Jones'],
      ['2004', 'She Said "Hey"', 'X'],
      ['1999', 'Two\nLines', 'Y'],
    ]);
  });

  it('writes what it reads', () => {
    const rows = [['key', 'title'], ['a|1', 'Hey, Soul Sister'], ['a|2', 'Say "When"'], ['a|3', ''], ['a|4', 7]];
    expect(parseCsv(toCsv(rows))).toEqual([['key', 'title'], ['a|1', 'Hey, Soul Sister'], ['a|2', 'Say "When"'], ['a|3', ''], ['a|4', '7']]);
    expect(toCsv([['a', 'b,c']])).toBe('a,"b,c"\n');
  });
});

describe('gold set sheet', () => {
  const songs = [
    { key: 'train|hey soul sister', artist: 'Train', title: 'Hey, Soul Sister', year: 2010 },
    { key: 'whitney houston|i will always love you', artist: 'Whitney Houston', title: 'I Will Always Love You', year: 1992 },
    { key: 'a|no year', artist: 'A', title: 'No Year' },
  ];

  it('has empty mood columns to fill in', () => {
    expect(parseCsv(goldTemplateCsv(songs))).toEqual([
      ['key', 'artist', 'title', 'year', 'upbeat', 'heartfelt'],
      ['train|hey soul sister', 'Train', 'Hey, Soul Sister', '2010', '', ''],
      ['whitney houston|i will always love you', 'Whitney Houston', 'I Will Always Love You', '1992', '', ''],
      ['a|no year', 'A', 'No Year', '', '', ''],
    ]);
  });

  const by = { labelledBy: 'Quinn-Wai', labelledAt: '2026-11-05' };
  const filled = (cells: [string, string][]) => {
    const [header, ...rows] = parseCsv(goldTemplateCsv(songs));
    return toCsv([header!, ...rows.map((r, i) => [...r.slice(0, 4), ...(cells[i] ?? ['', ''])])]);
  };

  it('reads y or n per mood, with who labelled it and when, and skips songs left blank', () => {
    const { gold, skipped } = goldFromCsv(filled([['Y', 'no'], ['n', ' yes '], ['', '']]), by);
    expect(skipped).toBe(1);
    expect(gold).toEqual({
      labelledBy: 'Quinn-Wai',
      labelledAt: '2026-11-05',
      songs: [
        { key: 'train|hey soul sister', artist: 'Train', title: 'Hey, Soul Sister', year: 2010, upbeat: true, heartfelt: false },
        { key: 'whitney houston|i will always love you', artist: 'Whitney Houston', title: 'I Will Always Love You', year: 1992, upbeat: false, heartfelt: true },
      ],
    });
  });

  it('names the line of a half-filled row, an unclear answer, or a song listed twice', () => {
    expect(() => goldFromCsv(filled([['y', '']]), by)).toThrow('Line 2: heartfelt is ""; use y or n');
    expect(() => goldFromCsv(filled([['y', 'n'], ['maybe', 'n']]), by)).toThrow('Line 3: upbeat is "maybe"');
    const twice = toCsv([['key', 'artist', 'title', 'year', 'upbeat', 'heartfelt'], ['a|1', 'A', '1', '', 'y', 'n'], ['a|1', 'A', '1', '', 'n', 'n']]);
    expect(() => goldFromCsv(twice, by)).toThrow('Line 3: a|1 is listed twice');
    expect(() => goldFromCsv('key,artist,title\na|1,A,1\n', by)).toThrow('The sheet has no "upbeat" column');
  });

  it('parseGoldSet reads the JSON back and refuses other files', () => {
    const { gold } = goldFromCsv(filled([['y', 'n']]), by);
    expect(parseGoldSet(JSON.stringify({ _comment: 'hand labels', ...gold }))).toEqual({ _comment: 'hand labels', ...gold });
    expect(() => parseGoldSet(JSON.stringify({ model: 'm', labels: [] }))).toThrow('Not a gold set');
    expect(() => parseGoldSet(JSON.stringify({ ...gold, songs: [{ key: 'a|1', upbeat: 'y', heartfelt: 'n' }] }))).toThrow('Not a gold set');
  });
});

describe('pickGoldSongs', () => {
  // 4 decades of 40 songs, 5 of them mostly rap; artists repeat every 25 songs.
  const candidates: GoldCandidate[] = [1990, 2000, 2010, 2020].flatMap((decade) =>
    Array.from({ length: 40 }, (_, i) => ({
      key: `artist ${(decade + i) % 25}|song ${decade + i}`,
      artist: `Artist ${(decade + i) % 25}`,
      title: `Song ${decade + i}`,
      year: decade + (i % 10),
      rap: i < 5,
    })),
  );

  it('takes the same number from each decade, some rap in each, and no artist twice', () => {
    const picked = pickGoldSongs(candidates, 20);
    expect(picked).toHaveLength(20);
    const perDecade = (d: number) => picked.filter((p) => Math.floor(p.year / 10) * 10 === d);
    for (const d of [1990, 2000, 2010, 2020]) {
      expect(perDecade(d)).toHaveLength(5);
      expect(perDecade(d).filter((p) => p.rap).length).toBeGreaterThanOrEqual(1);
    }
    expect(new Set(picked.map((p) => p.key.split('|')[0])).size).toBe(20);
  });

  it('is the same for a seed, in a shuffled order', () => {
    const picked = pickGoldSongs(candidates, 20);
    expect(pickGoldSongs([...candidates].reverse(), 20)).toEqual(picked);
    expect(pickGoldSongs(candidates, 20, 'other seed')).not.toEqual(picked);
    const years = picked.map((p) => p.year);
    expect(years).not.toEqual([...years].sort((a, b) => a - b));
  });

  it('tops up a decade from its other songs when one kind runs short', () => {
    const c = (artist: string, year: number, rap = false): GoldCandidate => ({ key: `${artist}|${year}`, artist, title: String(year), year, rap });
    // The 2000s' sung songs are all by artists the 1990s already used, so rap songs fill in.
    const few = [c('a', 1990), c('b', 1991), c('c', 1992), c('d', 1993), c('a', 2000), c('b', 2001), c('c', 2002), c('d', 2003), c('e', 2004, true), c('f', 2005, true), c('g', 2006, true)];
    const picked = pickGoldSongs(few, 8);
    expect(picked.filter((p) => p.year < 2000)).toHaveLength(4);
    expect(picked.filter((p) => p.year >= 2000).map((p) => p.artist).sort()).toEqual(['e', 'f', 'g']);
  });
});
