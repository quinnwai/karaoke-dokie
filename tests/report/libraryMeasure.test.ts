import { describe, expect, it } from 'vitest';
import type { SongRange, Track } from '../../src/lib/contracts';
import { measureLibrary, measureTable } from '../../src/lib/report/libraryMeasure';
import { songKey } from '../../src/lib/songs/resolve';

const song = (low: number, high: number): SongRange => ({ low, high, tessitura: (low + high) / 2, source: 'note-file', confidence: 'high', fastLyrics: false });
const track = (n: number): Track => ({ id: `t${n}`, title: `Song ${n}`, artist: 'Artist', artistId: 'a', spotifyUrl: '', playRank: n });
const RANGE = { low: 39, high: 74, source: 'songs' as const };
// Songs 0 to 399: even ones fit the range, odd ones are too high; songs 500+ are not in the catalogue.
const catalogue = new Map<string, SongRange>(Array.from({ length: 400 }, (_, n) => [songKey('Artist', `Song ${n}`), n % 2 ? song(60, 90) : song(45, 65)]));
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => track(from + i));

describe('measureLibrary', () => {
  const parts = { top: range(0, 6), recent: [track(2), track(500)], saved: range(0, 400), playlists: [track(398), ...range(600, 610)] };
  const rows = measureLibrary(parts, catalogue, RANGE);

  it('has the four cumulative steps, in order', () => {
    expect(rows.map((r) => r.step)).toEqual(['top tracks and recent plays only', '+ the newest 200 likes', '+ all likes', '+ playlists']);
  });

  it('counts distinct songs once, whichever list they are in', () => {
    // top 0-5 and recent 2, 500: 7 distinct songs, 6 in the catalogue, 3 in range (0, 2, 4).
    expect(rows[0]).toMatchObject({ librarySongs: 7, inCatalogue: 6, inRange: 3 });
    // the newest 200 likes are songs 0-199: 194 new songs, all in the catalogue, half in range.
    expect(rows[1]).toMatchObject({ librarySongs: 7 + 194, inCatalogue: 200, inRange: 100 });
    expect(rows[2]).toMatchObject({ librarySongs: 7 + 394, inCatalogue: 400, inRange: 200 });
    // playlists add song 398 already counted and ten songs outside the catalogue.
    expect(rows[3]).toMatchObject({ librarySongs: 7 + 394 + 10, inCatalogue: 400, inRange: 200 });
  });

  it('prints a markdown table with what each step adds', () => {
    const table = measureTable(rows);
    expect(table).toContain('| top tracks and recent plays only | 7 | 6 | 3 | 3 |');
    expect(table).toContain('| + all likes | 401 | 400 | 200 | +100 |');
    expect(table).toContain('| + playlists | 411 | 400 | 200 | +0 |');
  });
});
