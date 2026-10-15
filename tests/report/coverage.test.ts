import { describe, expect, it } from 'vitest';
import type { SongRange, Track } from '../../src/lib/contracts';
import { coverageCsv, coverageReport, looseKey } from '../../src/lib/report/coverage';
import { songKey } from '../../src/lib/songs/resolve';

const track = (id: string, artist: string, title: string, playRank: number): Track => ({ id, artist, title, artistId: 'a', spotifyUrl: '', playRank });
const range = (low: number, high: number, source: SongRange['source'] = 'note-file', usdbId?: number): SongRange => ({
  low, high, tessitura: (low + high) / 2, source, confidence: source === 'note-file' ? 'high' : 'low', fastLyrics: false, ...(usdbId ? { usdbId } : {}),
});
const user = { low: 48, high: 72, source: 'test' as const };

describe('looseKey', () => {
  it('ignores "The", "&" vs "and", punctuation and co-artists', () => {
    expect(looseKey('The Killers', 'Mr. Brightside')).toBe(looseKey('Killers', 'Mr Brightside'));
    expect(looseKey('Simon & Garfunkel', 'Bridge Over Troubled Water')).toBe(looseKey('Simon', 'Bridge over troubled water'));
    expect(looseKey('Dua Lipa, DaBaby', 'Levitating')).toBe(looseKey('Dua Lipa', 'Levitating'));
    expect(looseKey('A', 'Rock & Roll')).toBe(looseKey('A', 'Rock and Roll'));
  });
});

describe('coverageReport', () => {
  const tracks = [
    track('1', 'Queen', 'Bohemian Rhapsody', 0),
    track('2', 'The Killers', 'Mr. Brightside', 1),
    track('3', 'Queen', 'Obscure B-Side', 2),
    track('4', 'Nobody Band', 'Unknown', 3),
    track('5', 'Mariah Carey', 'Emotions', 4),
  ];
  const ranges = new Map<string, SongRange | null>([
    [songKey('Queen', 'Bohemian Rhapsody'), range(55, 67, 'note-file', 11)],
    [songKey('The Killers', 'Mr. Brightside'), null],
    [songKey('Queen', 'Obscure B-Side'), range(54, 66, 'artist-typical')],
    [songKey('Mariah Carey', 'Emotions'), range(50, 96)],
  ]);
  const index = [
    { id: 11, key: songKey('Queen', 'Bohemian Rhapsody'), artist: 'Queen', title: 'Bohemian Rhapsody' },
    { id: 12, key: songKey('Queen', 'Somebody to Love'), artist: 'Queen', title: 'Somebody to Love' },
    { id: 20, key: songKey('Killers', 'Mr Brightside'), artist: 'Killers', title: 'Mr Brightside' },
  ];

  it('lists every song with its source, fit, app rank and why it has no note file', () => {
    const { rows, summary } = coverageReport({ tracks, ranges, index, userRange: user });
    expect(summary).toEqual({ songs: 5, noteFile: 2, artistEstimate: 1, none: 2, shown: 2, nameMismatches: 1 });
    const [bo, mr, ob, un, em] = rows;
    expect(bo).toMatchObject({ playOrder: 1, status: 'note file', songRange: 'G3–G4', fit: 'fits', why: '', usdbLink: 'https://usdb.animux.de/index.php?link=detail&id=11' });
    expect(bo!.appRank).not.toBeNull();
    expect(mr).toMatchObject({ status: 'none', why: 'On USDB under a slightly different name', usdbMatch: 'Killers - Mr Brightside', appRank: null });
    expect(ob).toMatchObject({ status: 'artist estimate', why: 'Not on USDB (USDB has 2 other songs by this artist)' });
    expect(un).toMatchObject({ status: 'none', why: 'Artist not on USDB', fit: '' });
    expect(em).toMatchObject({ status: 'note file', fit: 'wider than your range', appRank: null });
  });

  it('writes a CSV with a header and quotes cells that need it', () => {
    const { rows } = coverageReport({ tracks: [track('1', 'A, B', 'Say "Hi"', 0)], ranges: new Map(), index: [], userRange: user });
    const csv = coverageCsv(rows).split('\n');
    expect(csv[0]).toBe('Play order,Title,Artist,Range from,Song range,Fits you?,Rank in app,Score,Reasons,Why no note file,Possible USDB match,USDB link');
    expect(csv[1]).toBe('1,"Say ""Hi""","A, B",none,,,,,,Artist not on USDB,,');
  });
});
