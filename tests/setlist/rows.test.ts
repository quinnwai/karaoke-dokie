// What a list row shows (src/lib/setlist/rows.ts, Round 6A §4): the title over "Artist · Era", a reason line, a difficulty
// badge, and the words a screen reader gets for the row's button. Presentation only: the order, the era and every place on
// every gear come from the ranking engine, in the SetlistSong it returns. The reason line is README §4's `whyOf`, run on the
// real data (QWW-57): the engine's places are percentiles among the songs that fit the singer, a null place skips its rule.

import { describe, expect, it } from 'vitest';
import type { Label } from '../../src/lib/contracts';
import { ERA_LABEL } from '../../src/lib/setlist/eras';
import { badgeOf, SWEET_SPOT, toRow, toRows, whyOf, type WhyTuner } from '../../src/lib/setlist/rows';
import { ERA_IDS, type EraId, type SetlistSong } from '../../src/lib/setlist/types';
import { ranked, rankedSong, song, type Places } from '../helpers/setlist';

/** The tuner a singer starts from: Difficulty at 0 and on, everything else off. */
const START: WhyTuner = { difficulty: 0, off: ['history', 'tempo', 'era'] };
/** Difficulty on, set at `at`. */
const sweetAt = (at: number): WhyTuner => ({ difficulty: at, off: [] });

/** A returned song with the era the engine gave it, whatever its match's year says. */
const inEra = (era: EraId | null, o: Parameters<typeof rankedSong>[1] = {}): SetlistSong => ({ ...rankedSong('s', o), era });

/** A song with exactly these places on the gears (any not given is unknown, so its rule is skipped). */
const placed = (places: Places, label: Label = 'easy'): SetlistSong => ranked(song('s', { difficulty: label }), { difficulty: null, ...places });

describe('toRow: the words', () => {
  const valerie = rankedSong('v', { title: 'Valerie', artist: 'Amy Winehouse', year: 2007, difficulty: 'medium' });

  it('says "title by artist, era, difficulty" for the row\'s button; the reason line is its description, not part of the name', () => {
    // Medium songs sit at 50 on Difficulty, far from a slider at 0, and nothing else is known: a solid pick.
    const row = toRow(valerie, START);
    expect(row.label).toBe('Valerie by Amy Winehouse, ’00s, Medium');
    expect(row.why).toBe('Solid pick');
    expect(row.label).not.toContain('Solid pick');
  });

  it.each<[Label, string]>([
    ['easy', 'Easy'],
    ['medium', 'Medium'],
    ['hard', 'Hard'],
    ['maybe', 'Maybe'],
  ])('puts the song\'s own label in it: %s says %s', (difficulty, word) => {
    const row = toRow(rankedSong('s', { title: 'Torn', artist: 'Natalie Imbruglia', year: 1997, difficulty }), START);
    expect(row.label).toBe(`Torn by Natalie Imbruglia, ’90s, ${word}`);
  });

  it('puts the artist and the era under the title: "Artist · ’00s"', () => {
    const row = toRow(valerie, START);
    expect(row.sub).toBe('Amy Winehouse · ’00s');
    expect(row.era).toBe('s00');
  });

  it('uses a middle dot between spaces and the typographic apostrophe, U+00B7 and U+2019', () => {
    const row = toRow(rankedSong('s', { artist: 'ABBA', year: 1976 }), START);
    expect(row.sub).toBe('ABBA · ’70s');
    expect(row.sub).toContain(' · ');
    expect(row.sub).toContain('’');
    expect(row.label).toContain(', ’70s, ');
  });

  it('leaves the era out of both lines for a song with no year', () => {
    const row = toRow(rankedSong('v', { title: 'Valerie', artist: 'Amy Winehouse', year: null, difficulty: 'medium' }), START);
    expect(row.era).toBeNull();
    expect(row.sub).toBe('Amy Winehouse');
    expect(row.label).toBe('Valerie by Amy Winehouse, Medium');
  });

  it.each(ERA_IDS)('names era %s with its own label in the sub-line and the button', (era) => {
    const row = toRow(inEra(era, { artist: 'Someone', title: 'Tune', difficulty: 'easy' }), START);
    expect(row.era).toBe(era);
    expect(row.sub).toBe(`Someone · ${ERA_LABEL[era]}`);
    expect(row.label).toBe(`Tune by Someone, ${ERA_LABEL[era]}, Easy`);
  });

  it('takes the era from the returned song, not from the match\'s year: the engine says which era it is', () => {
    // The match says 1995 (’90s); the engine's answer says ’00s, so that is what the row shows.
    const row = toRow(inEra('s00', { artist: 'Someone', year: 1995 }), START);
    expect(row.era).toBe('s00');
    expect(row.sub).toBe('Someone · ’00s');
    // And an engine that gives no era leaves it out, even for a match with a year.
    const none = toRow(inEra(null, { artist: 'Someone', year: 1995 }), START);
    expect(none.era).toBeNull();
    expect(none.sub).toBe('Someone');
    expect(none.label).not.toContain('’');
  });
});

describe('toRow: what it carries', () => {
  it('keeps the track id, the title and the artist, and the very match it was made from', () => {
    const m = song('id-7', { title: 'Hello', artist: 'Adele' });
    const row = toRow(ranked(m), START);
    expect(row.id).toBe('id-7');
    expect(row.title).toBe('Hello');
    expect(row.artist).toBe('Adele');
    expect(row.match).toBe(m);
  });

  it('has no lane any more: the badge took its place', () => {
    expect(toRow(rankedSong('s'), START)).not.toHaveProperty('lane');
  });

  it('carries the reason line and the badge, which are never empty and never the same thing', () => {
    const row = toRow(rankedSong('s', { difficulty: 'hard' }, { popularity: 90 }), START);
    expect(row.why).toBe('Crowd favourite');
    expect(row.badge).toBe('Hard');
    expect(row.why.length).toBeGreaterThan(0);
  });

  it('reads the reason line from the tuner it is given: the same song says another thing when Difficulty moves', () => {
    const s = rankedSong('s', { difficulty: 'medium' }); // placed at 50 on Difficulty
    expect(toRow(s, START).why).toBe('Solid pick');
    expect(toRow(s, sweetAt(55)).why).toBe('In your sweet spot');
  });
});

describe('whyOf: In your sweet spot (needs Difficulty on, and a place on it)', () => {
  it('holds when the song\'s place is within 15 of the slider, either side, edges included', () => {
    for (const place of [35, 40, 50, 59, 65]) expect(whyOf(placed({ difficulty: place }), sweetAt(50)), `place ${place}`).toBe('In your sweet spot');
    expect(SWEET_SPOT).toBe(15);
  });

  it('does not hold from just past 15 away', () => {
    for (const place of [34.9, 34, 65.1, 66, 0, 100]) expect(whyOf(placed({ difficulty: place }), sweetAt(50)), `place ${place}`).toBe('Solid pick');
  });

  it('needs Difficulty on: with the gear off, a song at the slider\'s own value is not in a sweet spot', () => {
    const off: WhyTuner = { difficulty: 50, off: ['difficulty'] };
    expect(whyOf(placed({ difficulty: 50 }), off)).toBe('Solid pick');
    expect(whyOf(placed({ difficulty: 50 }), sweetAt(50))).toBe('In your sweet spot');
  });

  it('is skipped for a song with no place on Difficulty (its range is not trusted)', () => {
    expect(whyOf(placed({ difficulty: null }), sweetAt(50))).toBe('Solid pick');
  });

  it('compares the song\'s place with the slider, as the engine placed it: Easy songs are 0 to 33, Medium 33 to 67, Hard 67 to 100', () => {
    // The default tuner has Difficulty at 0 (the Light work end): the easiest songs are in the sweet spot, Medium ones are not.
    expect(whyOf(rankedSong('e', { difficulty: 'easy' }, { difficulty: 5 }), START)).toBe('In your sweet spot');
    expect(whyOf(rankedSong('m', { difficulty: 'medium' }), START)).toBe('Solid pick');
  });
});

describe('whyOf: Crowd favourite and Deep cut (the song\'s own place on Popularity)', () => {
  it.each<[number, string | null]>([
    [100, 'Crowd favourite'],
    [85, 'Crowd favourite'],
    [84.9, null],
    [50, null],
    [35.1, null],
    [35, 'Deep cut'],
    [0, 'Deep cut'],
  ])('a place of %s says %s', (popularity, word) => {
    const why = whyOf(placed({ popularity }), START);
    expect(why).toBe(word ?? 'Solid pick');
  });

  it('is skipped for a song whose popularity is unknown', () => {
    expect(whyOf(placed({ popularity: null }), START)).toBe('Solid pick');
  });

  it('does not look at the slider: the tuner has no Popularity in it, only the song\'s own place counts', () => {
    expect(Object.keys(START)).not.toContain('popularity');
    expect(whyOf(placed({ popularity: 90 }), { difficulty: 0, off: ['popularity'] })).toBe('Crowd favourite');
  });
});

describe('whyOf: On repeat and Rediscover (the song\'s own place on History)', () => {
  it.each<[number, string | null]>([
    [100, 'On repeat'],
    [85, 'On repeat'],
    [84.9, null],
    [50, null],
    [20.1, null],
    [20, 'Rediscover'],
    [0, 'Rediscover'],
  ])('a place of %s says %s', (history, word) => {
    expect(whyOf(placed({ history }), START)).toBe(word ?? 'Solid pick');
  });

  it('never shows signed out, where every History place is null', () => {
    // A signed-out singer's songs have no place on History at all, whatever else they are.
    const signedOut = [
      placed({ popularity: 99, history: null }),
      placed({ popularity: 1, history: null }),
      placed({ difficulty: 50, history: null, tempo: 90 }),
      placed({ history: null }),
    ];
    for (const s of signedOut) {
      const why = whyOf(s, sweetAt(50));
      expect(why).not.toContain('On repeat');
      expect(why).not.toContain('Rediscover');
    }
  });

  it('shows signed in, whether or not the History gear is on: it is the song\'s own score', () => {
    expect(whyOf(placed({ history: 95 }), START)).toBe('On repeat');
    expect(whyOf(placed({ history: 5 }), { difficulty: 0, off: [] })).toBe('Rediscover');
  });
});

describe('whyOf: the order, and at most two', () => {
  it('lists the reasons in the order sweet spot, popularity, history', () => {
    expect(whyOf(placed({ difficulty: 50, popularity: 95 }), sweetAt(50))).toBe('In your sweet spot · Crowd favourite');
    expect(whyOf(placed({ popularity: 95, history: 95 }), START)).toBe('Crowd favourite · On repeat');
    expect(whyOf(placed({ difficulty: 50, history: 95 }), sweetAt(50))).toBe('In your sweet spot · On repeat');
  });

  it('keeps the first two when three hold', () => {
    expect(whyOf(placed({ difficulty: 50, popularity: 95, history: 95 }), sweetAt(50))).toBe('In your sweet spot · Crowd favourite');
    expect(whyOf(placed({ difficulty: 50, popularity: 10, history: 5 }), sweetAt(50))).toBe('In your sweet spot · Deep cut');
  });

  it('puts a Deep cut and a Rediscover together too', () => {
    expect(whyOf(placed({ popularity: 10, history: 5 }), START)).toBe('Deep cut · Rediscover');
  });

  it('joins two with a middle dot between spaces', () => {
    expect(whyOf(placed({ popularity: 95, history: 95 }), START)).toContain(' · ');
  });
});

describe('whyOf: nothing else to say', () => {
  it.each<[number | null, string]>([
    [100, 'Gets the room moving'],
    [70, 'Gets the room moving'],
    [69.9, 'Solid pick'],
    [50, 'Solid pick'],
    [25.1, 'Solid pick'],
    [25, 'Slow burner'],
    [0, 'Slow burner'],
    [null, 'Solid pick'],
  ])('a tempo place of %s says %s', (tempo, word) => {
    expect(whyOf(placed({ tempo }), START)).toBe(word);
  });

  it('is only the last resort: a song with another reason does not also get a tempo line', () => {
    expect(whyOf(placed({ popularity: 95, tempo: 99 }), START)).toBe('Crowd favourite');
    expect(whyOf(placed({ difficulty: 50, tempo: 1 }), sweetAt(50))).toBe('In your sweet spot');
  });

  it('is a solid pick for a song we know nothing about', () => {
    expect(whyOf(placed({ difficulty: null, history: null, popularity: null, tempo: null }), START)).toBe('Solid pick');
  });
});

describe('badgeOf: the song\'s own label, the word the song page shows', () => {
  it.each<[Label, string | null]>([
    ['easy', 'Easy'],
    ['medium', 'Medium'],
    ['hard', 'Hard'],
    ['maybe', null],
  ])('a %s song gets %s', (difficulty, badge) => {
    expect(badgeOf({ difficulty })).toBe(badge);
    expect(toRow(rankedSong('s', { difficulty }), START).badge).toBe(badge);
  });

  it('reads the label and not the place on Difficulty: a Medium song placed at 33.4 is Medium, where a cut at 34 would call it Easy', () => {
    // Medium places start at 33.3, so the 34 / 67 cut on the place would be wrong for these.
    for (const place of [33.3, 33.4, 33.9, 50, 66.6]) {
      expect(toRow(ranked(song('m', { difficulty: 'medium' }), { difficulty: place }), START).badge, `a Medium song at ${place}`).toBe('Medium');
    }
    // And the other way: a Hard song the engine put low is still Hard, and an Easy one placed high is still Easy.
    expect(toRow(ranked(song('h', { difficulty: 'hard' }), { difficulty: 10 }), START).badge).toBe('Hard');
    expect(toRow(ranked(song('e', { difficulty: 'easy' }), { difficulty: 90 }), START).badge).toBe('Easy');
  });

  it('has none for a Maybe song, whatever its place on Difficulty or lack of one: its range is only an estimate', () => {
    for (const place of [0, 16.7, 50, 83.3, 100, null]) {
      const row = toRow(ranked(song('m', { difficulty: 'maybe' }), { difficulty: place }), START);
      expect(row.badge, `a Maybe song placed at ${place}`).toBeNull();
      // The words still say Maybe, and the rest of the row is there all the same.
      expect(row.label).toBe('Song m by Artist m, ’90s, Maybe');
      expect(row.sub).toBe('Artist m · ’90s');
    }
  });

  it('has one for a song with no place on Difficulty, as long as it has a label to show', () => {
    expect(toRow(ranked(song('one', { difficulty: 'hard' }), { difficulty: null }), START).badge).toBe('Hard');
  });
});

describe('toRows', () => {
  const songs = [rankedSong('c', { title: 'Third' }), rankedSong('a', { title: 'First' }), rankedSong('b', { title: 'Second' })];

  it('makes one row per song and keeps their order', () => {
    const rows = toRows(songs, START);
    expect(rows.map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(rows).toHaveLength(songs.length);
    expect(rows).toEqual(songs.map((s) => toRow(s, START)));
  });

  it('has no rows for no songs', () => {
    expect(toRows([], START)).toEqual([]);
  });

  it('gives each row its own reason and badge, from its own song, in the same list', () => {
    const mixed = [
      ranked(song('a', { difficulty: 'easy' }), { difficulty: 5, popularity: 90 }),
      ranked(song('m', { difficulty: 'maybe' }), { difficulty: null, tempo: 10 }),
      ranked(song('h', { difficulty: 'hard' }), { difficulty: 90, history: 3 }),
    ];
    const rows = toRows(mixed, START);
    expect(rows.map((r) => r.badge)).toEqual(['Easy', null, 'Hard']);
    expect(rows.map((r) => r.why)).toEqual(['In your sweet spot · Crowd favourite', 'Slow burner', 'Rediscover']);
  });
});
