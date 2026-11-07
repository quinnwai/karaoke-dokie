import { describe, expect, it } from 'vitest';
import { billboardCharts, karafunViews, leadArtist, mergePopularity, popularitySummary } from '../../src/lib/popularity/import';

// Made-up songs and numbers in the two files' own layout, extra columns included. The real files
// never come into the repository.
const KARAFUN = [
  'view_rank,artist,title,status,view_count_total,app_key',
  '1,The Examples,First Song,ranged,5500000,the examples|first song',
  '2,Lead Singer,Duet Song,ranged,240000,lead singer|duet song',
  '3,"Band, The",Second Song,skipped,12000,"band, the|second song"',
  '4,The Examples,First Song,candidates_rejected,800,the examples|first song',
].join('\n');

const BILLBOARD = [
  'year,rank,title,artist_credit,low,high',
  '2003,40,First Song,The Examples,A3,C5',
  '2004,15,First Song,The Examples,A3,C5',
  '2002,9,Duet Song,Lead Singer and The Guest,G3,D5',
  '2001,9,Duet Song,Lead Singer and The Guest,G3,D5',
  '1999,70,Party Song,Rapper featuring Hook Singer,,',
  '2010,55,Band Song,Hootie & the Players,,',
].join('\n');

describe('KaraFun views', () => {
  it('keeps the app_key as the song key and the largest view count when a song is listed twice', () => {
    expect(karafunViews(KARAFUN)).toEqual(
      new Map([
        ['the examples|first song', 5_500_000],
        ['lead singer|duet song', 240_000],
        ['band, the|second song', 12_000],
      ]),
    );
  });

  it('refuses a file without the columns, or with a view count or key it cannot read', () => {
    expect(() => karafunViews('artist,title,app_key\nA,B,a|b')).toThrow('karafun_songs.csv has no view_count_total column');
    const row = (views: string, key = 'a|b') => `app_key,view_count_total\n${key},${views}`;
    for (const bad of ['', '5.5M', '-3', '1e6']) expect(() => karafunViews(row(bad))).toThrow(`row 1: view_count_total "${bad}"`);
    for (const key of ['|title', 'artist|', 'no bar']) expect(() => karafunViews(row('10', key))).toThrow('is not an artist|title key');
  });
});

describe('Billboard Year-End charts', () => {
  it('keeps each song’s best rank and that chart’s year, the earlier year on a tie', () => {
    const charts = billboardCharts(BILLBOARD);
    expect(charts.get('the examples|first song')).toEqual({ rank: 15, year: 2004 });
    expect(charts.get('lead singer and the guest|duet song')).toEqual({ rank: 9, year: 2001 });
  });

  it('files a multi-artist credit under the lead artist too, and a featured artist only under the lead', () => {
    const charts = billboardCharts(BILLBOARD);
    expect(charts.get('lead singer|duet song')).toEqual({ rank: 9, year: 2001 });
    // songKey already drops "featuring ...", so the credit and the lead artist are one key.
    expect(charts.get('rapper|party song')).toEqual({ rank: 70, year: 1999 });
    // A band keeps its whole name; its cut-off first word is an extra key no song has.
    expect(charts.get('hootie & the players|band song')).toEqual({ rank: 55, year: 2010 });
    expect([...charts.keys()].sort()).toEqual([
      'hootie & the players|band song',
      'hootie|band song',
      'lead singer and the guest|duet song',
      'lead singer|duet song',
      'rapper|party song',
      'the examples|first song',
    ]);
  });

  it('keeps the better rank when a lead-artist key is also another row’s credit', () => {
    const charts = billboardCharts('year,rank,title,artist_credit\n2000,87,Song,Singer with Band\n2001,32,Song,Singer\n2002,90,Song,Singer');
    expect(charts.get('singer|song')).toEqual({ rank: 32, year: 2001 });
  });

  it('reads the first artist of a credit', () => {
    expect(leadArtist('Lead Singer and The Guest')).toBe('Lead Singer');
    expect(leadArtist('One & Two')).toBe('One');
    expect(leadArtist('One, Two and Three')).toBe('One');
    expect(leadArtist('One with Two')).toBe('One');
    expect(leadArtist('One featuring Two')).toBe('One');
    expect(leadArtist('One feat. Two')).toBe('One');
    expect(leadArtist('One / Two')).toBe('One');
    expect(leadArtist('The Group: Singer One, Singer Two')).toBe('The Group');
    expect(leadArtist('The Duo (One and Two) featuring Three')).toBe('The Duo');
    expect(leadArtist('Solo')).toBe('Solo');
    expect(leadArtist('Brandy and Monica')).toBe('Brandy');
    expect(leadArtist('Andy Grammer')).toBe('Andy Grammer'); // "and" only between words
  });

  it('refuses a rank outside 1 to 100, a bad year, a missing column or a row without a title', () => {
    const row = (year: string, rank: string, title = 'Song') => `year,rank,title,artist_credit\n${year},${rank},${title},Artist`;
    for (const rank of ['0', '101', 'x', '']) expect(() => billboardCharts(row('2001', rank))).toThrow(`billboard_songs.csv row 1: rank "${rank}"`);
    expect(() => billboardCharts(row('01', '5'))).toThrow('year "01"');
    expect(() => billboardCharts(row('2001', '5', ''))).toThrow('row 1: no artist_credit or title');
    expect(() => billboardCharts('year,rank,title\n2001,5,Song')).toThrow('billboard_songs.csv has no artist_credit column');
  });
});

describe('merging the two files', () => {
  const records = mergePopularity(karafunViews(KARAFUN), billboardCharts(BILLBOARD));

  it('gives every key in either file one record, in key order, with the numbers it has and their source', () => {
    expect(records.map((r) => r.key)).toEqual([...records.map((r) => r.key)].sort());
    const byKey = new Map(records.map((r) => [r.key, r]));
    expect(byKey.get('the examples|first song')).toStrictEqual({ key: 'the examples|first song', karaokeViews: 5_500_000, chartRank: 15, chartYear: 2004, source: 'karafun+billboard' });
    expect(byKey.get('lead singer|duet song')).toStrictEqual({ key: 'lead singer|duet song', karaokeViews: 240_000, chartRank: 9, chartYear: 2001, source: 'karafun+billboard' });
    expect(byKey.get('band, the|second song')).toStrictEqual({ key: 'band, the|second song', karaokeViews: 12_000, source: 'karafun' });
    expect(byKey.get('rapper|party song')).toStrictEqual({ key: 'rapper|party song', chartRank: 70, chartYear: 1999, source: 'billboard' });
    expect(records).toHaveLength(7);
  });

  it('sums up keys, views and chart entries, with nearest-rank view percentiles', () => {
    expect(popularitySummary(records)).toEqual({
      keys: 7,
      withViews: 3,
      withChart: 6,
      withBoth: 2,
      viewPercentiles: { p10: 12_000, p25: 12_000, p50: 240_000, p75: 5_500_000, p90: 5_500_000, p99: 5_500_000, max: 5_500_000 },
    });
    const hundred = Array.from({ length: 100 }, (_, i) => ({ key: `a|${i}`, karaokeViews: i + 1, source: 'karafun' }));
    expect(popularitySummary(hundred).viewPercentiles).toMatchObject({ p10: 10, p50: 50, p99: 99, max: 100 });
    expect(popularitySummary([{ key: 'a|b', chartRank: 1, chartYear: 2000, source: 'billboard' }])).toMatchObject({ withViews: 0, viewPercentiles: null });
  });
});
