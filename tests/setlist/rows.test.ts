// What a list row shows (src/lib/setlist/rows.ts, spec §5): the title over "Artist · Era", the song's mini difficulty lane,
// and the words a screen reader gets for the row's button. Presentation only: the order, the era and the lane's place on
// Difficulty all come from the ranking engine, in the SetlistSong it returns.

import { describe, expect, it } from 'vitest';
import type { Label } from '../../src/lib/contracts';
import { EASY, HARD, MID, rowLane } from '../../src/lib/setlist/art';
import { ERA_LABEL } from '../../src/lib/setlist/eras';
import { toRow, toRows } from '../../src/lib/setlist/rows';
import { ERA_IDS, type EraId, type SetlistSong } from '../../src/lib/setlist/types';
import { ranked, rankedSong, song } from '../helpers/setlist';

/** A returned song with the era the engine gave it, whatever its match's year says. */
const inEra = (era: EraId | null, o: Parameters<typeof rankedSong>[1] = {}): SetlistSong => ({ ...rankedSong('s', o), era });

describe('toRow: the words', () => {
  const valerie = rankedSong('v', { title: 'Valerie', artist: 'Amy Winehouse', year: 2007, difficulty: 'medium' });

  it('says "title by artist, era, difficulty" for the row\'s button', () => {
    expect(toRow(valerie).label).toBe('Valerie by Amy Winehouse, ’00s, Medium');
  });

  it.each<[Label, string]>([
    ['easy', 'Easy'],
    ['medium', 'Medium'],
    ['hard', 'Hard'],
    ['maybe', 'Maybe'],
  ])('ends the label with the song\'s own label: %s says %s', (difficulty, word) => {
    const row = toRow(rankedSong('s', { title: 'Torn', artist: 'Natalie Imbruglia', year: 1997, difficulty }));
    expect(row.label).toBe(`Torn by Natalie Imbruglia, ’90s, ${word}`);
  });

  it('puts the artist and the era under the title: "Artist · ’00s"', () => {
    const row = toRow(valerie);
    expect(row.sub).toBe('Amy Winehouse · ’00s');
    expect(row.era).toBe('s00');
  });

  it('uses a middle dot between spaces and the typographic apostrophe, U+00B7 and U+2019', () => {
    const row = toRow(rankedSong('s', { artist: 'ABBA', year: 1976 }));
    expect(row.sub).toBe('ABBA · ’70s');
    expect(row.sub).toContain(' · ');
    expect(row.sub).toContain('’');
    expect(row.label).toContain(', ’70s, ');
  });

  it('leaves the era out of both lines for a song with no year', () => {
    const row = toRow(rankedSong('v', { title: 'Valerie', artist: 'Amy Winehouse', year: null, difficulty: 'medium' }));
    expect(row.era).toBeNull();
    expect(row.sub).toBe('Amy Winehouse');
    expect(row.label).toBe('Valerie by Amy Winehouse, Medium');
  });

  it.each(ERA_IDS)('names era %s with its own label in the sub-line and the button', (era) => {
    const row = toRow(inEra(era, { artist: 'Someone', title: 'Tune', difficulty: 'easy' }));
    expect(row.era).toBe(era);
    expect(row.sub).toBe(`Someone · ${ERA_LABEL[era]}`);
    expect(row.label).toBe(`Tune by Someone, ${ERA_LABEL[era]}, Easy`);
  });

  it('takes the era from the returned song, not from the match\'s year: the engine says which era it is', () => {
    // The match says 1995 (’90s); the engine's answer says ’00s, so that is what the row shows.
    const row = toRow(inEra('s00', { artist: 'Someone', year: 1995 }));
    expect(row.era).toBe('s00');
    expect(row.sub).toBe('Someone · ’00s');
    // And an engine that gives no era leaves it out, even for a match with a year.
    const none = toRow(inEra(null, { artist: 'Someone', year: 1995 }));
    expect(none.era).toBeNull();
    expect(none.sub).toBe('Someone');
    expect(none.label).not.toContain('’');
  });
});

describe('toRow: what it carries', () => {
  it('keeps the track id, the title and the artist, and the very match it was made from', () => {
    const m = song('id-7', { title: 'Hello', artist: 'Adele' });
    const row = toRow(ranked(m));
    expect(row.id).toBe('id-7');
    expect(row.title).toBe('Hello');
    expect(row.artist).toBe('Adele');
    expect(row.match).toBe(m);
  });

  it('draws the lane from the song\'s place on Difficulty, the engine\'s word for it', () => {
    expect(toRow(ranked(song('s'), { difficulty: 80 })).lane).toEqual(rowLane(80));
    expect(toRow(ranked(song('s'), { difficulty: 0 })).lane).toEqual(rowLane(0));
    expect(toRow(ranked(song('s'), { difficulty: 100 })).lane).toEqual(rowLane(100));
  });

  it('reads the place, not the label: a Hard song the engine put at 10 draws the lane for 10', () => {
    const row = toRow(ranked(song('s', { difficulty: 'hard' }), { difficulty: 10 }));
    expect(row.lane).toEqual(rowLane(10));
    expect(row.lane?.color).toBe(EASY);
    // The words still say what the label says.
    expect(row.label.endsWith(', Hard')).toBe(true);
  });

  it('has no lane when the place on Difficulty is unknown (the song\'s range is not trusted), and no difficulty field', () => {
    const row = toRow(ranked(song('one', { difficulty: 'hard' }), { difficulty: null }));
    expect(row.lane).toBeNull();
    expect(row).not.toHaveProperty('difficulty');
    // The rest of the row is there all the same.
    expect(row.label).toBe('Song one by Artist one, ’90s, Hard');
  });

  it('has no lane for a Maybe song, whatever its place on Difficulty: its range is only an estimate, so no difficulty is shown', () => {
    for (const place of [0, 16.7, 50, 83.3, 100]) {
      const row = toRow(ranked(song('m', { difficulty: 'maybe' }), { difficulty: place }));
      expect(row.lane, `a Maybe song placed at ${place}`).toBeNull();
      // The words still say Maybe, and the rest of the row is there all the same.
      expect(row.label).toBe('Song m by Artist m, ’90s, Maybe');
      expect(row.sub).toBe('Artist m · ’90s');
    }
  });

  it('has no lane for a Maybe song with no place either, while a sure song at the same place has one', () => {
    expect(toRow(ranked(song('m', { difficulty: 'maybe' }), { difficulty: null })).lane).toBeNull();
    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      expect(toRow(ranked(song('s', { difficulty }), { difficulty: 50 })).lane, `a ${difficulty} song placed at 50`).toEqual(rowLane(50));
    }
  });

  it('does not read the other gears: History, Popularity and Tempo places change nothing on the row', () => {
    const plain = toRow(ranked(song('s'), { difficulty: 40 }));
    const loaded = toRow(ranked(song('s'), { difficulty: 40, history: 100, popularity: 0, tempo: 55 }));
    expect(loaded).toEqual(plain);
  });

  // The default places (the middle of each label's third) fall in the tier the label names.
  it.each<[Label, string]>([
    ['easy', EASY],
    ['medium', MID],
    ['hard', HARD],
  ])('draws a %s song at its default place in the tier colour of that label', (difficulty, color) => {
    const row = toRow(rankedSong('s', { difficulty }));
    expect(row.lane).not.toBeNull();
    expect(row.lane?.color).toBe(color);
  });

  // The cuts are exact thirds (laneColor): whole numbers as in the spec, and a place with a decimal in the tier it is in.
  it.each<[number, string]>([
    [0, EASY],
    [33, EASY],
    [33.3, EASY],
    [33.4, MID],
    [34, MID],
    [66, MID],
    [66.6, MID],
    [66.7, HARD],
    [66.9, HARD],
    [67, HARD],
    [100, HARD],
  ])('colours a place of %s as %s', (place, color) => {
    expect(toRow(ranked(song('s'), { difficulty: place })).lane?.color).toBe(color);
  });
});

describe('toRows', () => {
  const songs = [rankedSong('c', { title: 'Third' }), rankedSong('a', { title: 'First' }), rankedSong('b', { title: 'Second' })];

  it('draws a lane for each sure song and none for a Maybe song, in the same list', () => {
    const mixed = [rankedSong('a', { difficulty: 'easy' }), rankedSong('m', { difficulty: 'maybe' }), rankedSong('h', { difficulty: 'hard' })];
    expect(toRows(mixed).map((r) => r.lane !== null)).toEqual([true, false, true]);
  });

  it('makes one row per song and keeps their order', () => {
    const rows = toRows(songs);
    expect(rows.map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(rows).toHaveLength(songs.length);
    expect(rows).toEqual(songs.map((s) => toRow(s)));
  });

  it('has no rows for no songs', () => {
    expect(toRows([])).toEqual([]);
  });

  it('gives each row its own lane, from its own place', () => {
    const rows = toRows([ranked(song('a'), { difficulty: 10 }), ranked(song('b'), { difficulty: 50 }), ranked(song('c'), { difficulty: null })]);
    expect(rows.map((r) => r.lane)).toEqual([rowLane(10), rowLane(50), null]);
  });
});
