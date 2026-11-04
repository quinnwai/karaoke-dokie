import { describe, expect, it } from 'vitest';
import type { Match, SongRange, TimeRange, Track, VocalRange } from '../../src/lib/contracts';
import { matchSong, toMatch } from '../../src/lib/songs/match';
import { rankMatches } from '../../src/lib/songs/rank';
import {
  CHART_FLOOR,
  comfortScore,
  familiarityScore,
  KARAOKE_VIEWS_FULL,
  pitchComfort,
  popularityKnown,
  popularityScore,
  reasonsFor,
  scoreMatch,
  UNKNOWN_POPULARITY,
  withKaraokePopularity,
} from '../../src/lib/songs/score';
import { songRangeFromUltrastar } from '../../src/lib/songs/range';

const user: VocalRange = { low: 48, high: 72, source: 'test' }; // C3-C5, centre C4
const track = (id: string, extra: Partial<Track> = {}): Track => ({ id, title: id, artist: 'A', artistId: 'a', spotifyUrl: '', playRank: 0, ...extra });
const song = (low: number, high: number, extra: Partial<SongRange> = {}): SongRange => ({
  low,
  high,
  tessitura: (low + high) / 2,
  source: 'note-file',
  confidence: 'high',
  fastLyrics: false,
  ...extra,
});
const match = (t: Track, r: SongRange): Match => {
  const fit = matchSong(user, r)!;
  return scoreMatch(user, { track: t, range: r, ...fit });
};

describe('comfort', () => {
  it('is 1 in the middle half of the range and falls to 0 at the edges', () => {
    expect(pitchComfort(user, 60)).toBe(1);
    expect(pitchComfort(user, 54)).toBe(1); // exactly halfway to the edge
    expect(pitchComfort(user, 69)).toBeCloseTo(0.5);
    expect(pitchComfort(user, 72)).toBe(0);
  });

  it('weighs the time spent on each pitch, not just the extremes', () => {
    // Reaches C5, but 95% of it sits on C4: a few notes at the edge make it Medium, not Hard.
    const mostlyMiddle = song(60, 72, { pitchShare: [[60, 0.95], [72, 0.05]] });
    expect(comfortScore(user, mostlyMiddle, 'none')).toBeCloseTo(0.95);
    expect(matchSong(user, mostlyMiddle)!.difficulty).toBe('medium');
  });

  it('applies the octave shift', () => {
    const high = song(72, 84, { pitchShare: [[72, 1]] });
    expect(comfortScore(user, high, 'down')).toBe(1); // sung as C4
  });

  it('estimates from the typical note when there is no histogram', () => {
    expect(comfortScore(user, song(57, 63), 'none')).toBe(1);
    expect(comfortScore(user, song(48, 72), 'none')).toBeCloseTo(0.7);
  });

  it('note files now carry a pitch histogram that sums to about 1', () => {
    const r = songRangeFromUltrastar('#BPM:120\n: 0 4 0 a\n: 8 4 2 b\n: 16 8 4 c\nE\n');
    expect(r.pitchShare).toEqual([[60, 0.25], [62, 0.25], [64, 0.5]]);
  });
});

describe('familiarity and popularity', () => {
  it('uses the familiarity field, else falls with play rank', () => {
    expect(familiarityScore(track('x', { familiarity: 0.8 }))).toBe(0.8);
    expect(familiarityScore(track('x', { playRank: 0 }))).toBe(1);
    expect(familiarityScore(track('x', { playRank: 20 }))).toBe(0.5);
  });

  it('averages Spotify and USDB popularity, using whichever exists', () => {
    expect(popularityScore(track('x', { popularity: 80 }), song(55, 65))).toBeCloseTo(0.8);
    expect(popularityScore(track('x'), song(55, 65, { usdbViews: 99_999, usdbRating: 5 }))).toBeCloseTo(1);
    expect(popularityScore(track('x', { popularity: 40 }), song(55, 65, { usdbRating: 4 }))).toBeCloseTo(0.6);
    expect(popularityScore(track('x'), song(55, 65))).toBe(UNKNOWN_POPULARITY);
  });

  it('marks popularity as known when Spotify popularity, USDB views or USDB stars are there', () => {
    const known = (t: Track, r: SongRange) => match(t, r).parts!.popularityKnown;
    expect(known(track('x', { popularity: 0 }), song(55, 65))).toBe(true);
    expect(known(track('x'), song(55, 65, { usdbViews: 0 }))).toBe(true);
    expect(known(track('x'), song(55, 65, { usdbRating: 3 }))).toBe(true);
    const unknown = match(track('x'), song(55, 65));
    expect(unknown.parts).toMatchObject({ popularityKnown: false, popularity: UNKNOWN_POPULARITY });
  });
});

describe('karaoke popularity (KaraFun views, Billboard Year-End charts)', () => {
  const plain = song(55, 65);
  const karaoke = (views?: number, chartRank?: number, extra: Partial<SongRange> = {}) =>
    withKaraokePopularity(song(55, 65, extra), { karaokeViews: views, chartRank });

  it('scores karaoke views on a log scale that is full at KARAOKE_VIEWS_FULL', () => {
    expect(popularityScore(track('x'), karaoke(KARAOKE_VIEWS_FULL))).toBeCloseTo(1);
    expect(popularityScore(track('x'), karaoke(KARAOKE_VIEWS_FULL * 20))).toBe(1);
    expect(popularityScore(track('x'), karaoke(56_000))).toBeCloseTo(0.7, 2); // the median KaraFun song
    expect(popularityScore(track('x'), karaoke(1_000))).toBeCloseTo(0.445, 3);
    expect(popularityScore(track('x'), karaoke(0))).toBe(0);
  });

  it('averages karaoke views with Spotify and USDB, whichever are there', () => {
    const full = karaoke(KARAOKE_VIEWS_FULL, undefined, { usdbRating: 4 });
    expect(popularityScore(track('x'), full)).toBeCloseTo((0.8 + 1) / 2);
    expect(popularityScore(track('x', { popularity: 40 }), full)).toBeCloseTo((0.4 + 0.8 + 1) / 3);
  });

  it('gives a Year-End song at least 0.6, and a top-20 one at least 0.75, without ever lowering a song', () => {
    expect(popularityScore(track('x'), karaoke(undefined, 20))).toBe(CHART_FLOOR.top20);
    expect(popularityScore(track('x'), karaoke(undefined, 21))).toBe(CHART_FLOOR.top100);
    expect(popularityScore(track('x'), karaoke(undefined, 100))).toBe(CHART_FLOOR.top100);
    expect(CHART_FLOOR).toEqual({ top100: 0.6, top20: 0.75 });
    // Few karaoke views (0.445) are raised to the floor; many (1) stay as they are.
    expect(popularityScore(track('x'), karaoke(1_000, 50))).toBe(0.6);
    expect(popularityScore(track('x'), karaoke(KARAOKE_VIEWS_FULL, 90))).toBeCloseTo(1);
    expect(popularityScore(track('x', { popularity: 10 }), karaoke(undefined, 3))).toBe(0.75);
  });

  it('marks popularity as known with karaoke views or a chart entry alone', () => {
    expect(popularityKnown(track('x'), karaoke(0))).toBe(true);
    expect(popularityKnown(track('x'), karaoke(undefined, 100))).toBe(true);
    expect(popularityKnown(track('x'), karaoke())).toBe(false);
    expect(match(track('x'), karaoke(undefined, 100)).parts).toMatchObject({ popularityKnown: true, popularity: 0.6 });
  });

  it('calls a top-20 Year-End song a crowd favourite, and not one that only made the top 100', () => {
    const catalogue = track('cat', { familiarity: 1, known: false });
    expect(match(catalogue, karaoke(undefined, 12)).reasons).toEqual(['In your sweet spot', 'Crowd favourite']);
    expect(match(catalogue, karaoke(undefined, 60)).reasons).toEqual(['In your sweet spot']);
    expect(match(catalogue, karaoke(KARAOKE_VIEWS_FULL)).reasons).toEqual(['In your sweet spot', 'Crowd favourite']);
  });

  it('scores on a copy: the range passed in is left alone, and nothing to add means no copy', () => {
    const record = { key: 'the examples|first song', karaokeViews: 9_000, chartRank: 7, chartYear: 2004, source: 'karafun+billboard' };
    const scored = withKaraokePopularity(plain, record);
    expect(scored).toStrictEqual({ ...plain, karaokeViews: 9_000, chartRank: 7 });
    expect(plain).toStrictEqual(song(55, 65));
    expect(withKaraokePopularity(plain, undefined)).toBe(plain);
    expect(withKaraokePopularity(plain, { karaokeViews: undefined })).toBe(plain);
  });

  it('keeps the karaoke popularity when a duet is scored on one singer’s part', () => {
    const duet = karaoke(undefined, 5, {
      duet: true,
      parts: [
        { low: 56, high: 64, tessitura: 60, fastLyrics: false },
        { low: 40, high: 80, tessitura: 60, fastLyrics: false },
      ],
    });
    const m = scoreMatch(user, toMatch(track('d'), duet, matchSong(user, duet)!));
    expect(m.part).toBe(1);
    expect(m.parts).toMatchObject({ popularity: CHART_FLOOR.top20, popularityKnown: true });
  });
});

describe('ranking', () => {
  it('puts a comfortable song you know ahead of a hard one you play slightly more', () => {
    const easy = match(track('easy', { familiarity: 0.7 }), song(57, 63));
    const hard = match(track('hard', { familiarity: 0.8 }), song(48, 72, { pitchShare: [[48, 0.5], [72, 0.5]] }));
    expect(rankMatches([hard, easy]).map((m) => m.track.id)).toEqual(['easy', 'hard']);
  });

  it('lets a Hard song reach the top 5 through familiarity and popularity', () => {
    const favourite = match(track('fav', { familiarity: 1, popularity: 95 }), song(50, 72, { pitchShare: [[50, 0.1], [60, 0.8], [72, 0.1]] }));
    expect(favourite.difficulty).toBe('hard');
    const filler = Array.from({ length: 10 }, (_, i) => match(track(`f${i}`, { familiarity: 0.1, popularity: 20 }), song(56, 64)));
    const top5 = rankMatches([...filler, favourite]).slice(0, 5).map((m) => m.track.id);
    expect(top5[0]).toBe('fav');
  });

  it('penalties lower a song without removing it', () => {
    const plain = match(track('plain', { familiarity: 0.5 }), song(57, 63));
    const fast = match(track('fast', { familiarity: 0.5 }), song(57, 63, { fastLyrics: true }));
    const guessed = match(track('guessed', { familiarity: 0.5 }), song(57, 63, { source: 'artist-typical', confidence: 'low' }));
    const shifted = match(track('shifted', { familiarity: 0.5 }), song(69, 75));
    expect(shifted.octave).toBe('down');
    expect(guessed.difficulty).toBe('maybe');
    const order = rankMatches([shifted, guessed, fast, plain]).map((m) => m.track.id);
    // The guessed range is in the Maybe group, after every song with a label.
    expect(order).toEqual(['plain', 'fast', 'shifted', 'guessed']);
    expect(fast.score!).toBeCloseTo(plain.score! - 0.05);
    expect(guessed.score!).toBeCloseTo(plain.score! - 0.1);
    expect(shifted.parts!.penalty).toBeCloseTo(0.1);
  });

  it('multiplies comfort and familiarity, so a song must be both', () => {
    // Quinn's example: very comfortable but barely played vs. well known but only moderately comfortable.
    const laGrange = match(track('lagrange', { familiarity: 0.15, known: true, popularity: 80 }), song(56, 64));
    const favourite = match(track('fav', { familiarity: 0.8, known: true, popularity: 80 }), song(50, 70, { pitchShare: [[51, 0.4], [60, 0.6]] }));
    expect(laGrange.parts!.comfort).toBeGreaterThan(favourite.parts!.comfort);
    expect(rankMatches([laGrange, favourite]).map((m) => m.track.id)).toEqual(['fav', 'lagrange']);
    expect(laGrange.score!).toBeCloseTo(0.85 * laGrange.parts!.comfort * 0.15 + 0.15 * laGrange.parts!.popularity);
  });

  it('ranks saved-only songs after every song you know', () => {
    const savedOnly = match(track('saved', { familiarity: 0.15, known: false, popularity: 100 }), song(57, 63));
    const known = match(track('known', { familiarity: 0.2, known: true, popularity: 0 }), song(50, 70, { pitchShare: [[50, 0.5], [60, 0.5]] }));
    expect(savedOnly.score!).toBeGreaterThan(known.score!);
    expect(rankMatches([savedOnly, known]).map((m) => m.track.id)).toEqual(['known', 'saved']);
  });

  it('treats cached tracks without a known flag as known unless saved-only', () => {
    const old = match(track('old', { familiarity: 0.15 }), song(57, 63));
    const played = match(track('played', { familiarity: 0.2 }), song(50, 70, { pitchShare: [[50, 0.5], [60, 0.5]] }));
    expect(rankMatches([old, played]).map((m) => m.track.id)).toEqual(['played', 'old']);
  });

  it('breaks score ties by comfort, then familiarity', () => {
    const a: Match = { track: track('a'), range: song(55, 65), difficulty: 'easy', octave: 'none', score: 0.5, parts: { comfort: 0.6, familiarity: 0.2, popularity: 0, penalty: 0 } };
    const b: Match = { ...a, track: track('b'), parts: { comfort: 0.8, familiarity: 0.1, popularity: 0, penalty: 0 } };
    const c: Match = { ...a, track: track('c'), parts: { comfort: 0.8, familiarity: 0.3, popularity: 0, penalty: 0 } };
    expect(rankMatches([a, b, c]).map((m) => m.track.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('reasons', () => {
  // A library song in the user's 4-week top list, as buildLibrary records it.
  const thisMonth = { known: true, topLists: ['short_term'] as TimeRange[] };

  it('names the one or two biggest contributors', () => {
    expect(reasonsFor({ comfort: 0.9, familiarity: 0.8, popularity: 0.9, penalty: 0 }, undefined, thisMonth)).toEqual([
      'In your sweet spot',
      'In your top songs this month',
    ]);
    expect(reasonsFor({ comfort: 0.3, familiarity: 0.1, popularity: 0.9, penalty: 0 })).toEqual(['Crowd favourite']);
    expect(reasonsFor({ comfort: 0.2, familiarity: 0.1, popularity: 0.2, penalty: 0 })).toEqual([]);
  });

  it('follows the difficulty label, so a Hard song never says sweet spot', () => {
    const p = { comfort: 0.9, familiarity: 0.8, popularity: 0.9, penalty: 0 };
    expect(reasonsFor(p, { difficulty: 'easy', side: 'top' })[0]).toBe('In your sweet spot');
    expect(reasonsFor(p, { difficulty: 'medium', side: 'top' })[0]).toBe('A few notes near your high end');
    expect(reasonsFor(p, { difficulty: 'hard', side: 'bottom' }, thisMonth)).toEqual(['Spends time at your low end', 'In your top songs this month']);
  });

  it('says which end of your range a song leans on: high end or low end', () => {
    const p = { comfort: 0.9, familiarity: 0, popularity: 0, penalty: 0 };
    expect(reasonsFor(p, { difficulty: 'medium', side: 'top' })).toEqual(['A few notes near your high end']);
    expect(reasonsFor(p, { difficulty: 'medium', side: 'bottom' })).toEqual(['A few notes near your low end']);
    expect(reasonsFor(p, { difficulty: 'hard', side: 'top' })).toEqual(['Spends time at your high end']);
    expect(reasonsFor(p, { difficulty: 'hard', side: 'bottom' })).toEqual(['Spends time at your low end']);
  });

  it('says nothing about where a Maybe song sits, since its range is an estimate', () => {
    const p = { comfort: 0.9, familiarity: 0.8, popularity: 0.9, penalty: 0.1 };
    expect(reasonsFor(p, { difficulty: 'maybe', side: 'top' }, thisMonth)).toEqual(['In your top songs this month', 'Crowd favourite']);
    const rough = match(track('r', { familiarity: 0.9, ...thisMonth }), song(56, 64, { source: 'audio-full', confidence: 'low' }));
    expect(rough).toMatchObject({ difficulty: 'maybe', reasons: ['In your top songs this month'] });
    expect(rough.parts!.penalty).toBeCloseTo(0.1);
  });

  it('names the list that shows you know a song, and its time frame', () => {
    const p = { comfort: 0, familiarity: 0.8, popularity: 0, penalty: 0 };
    const reason = (t: Partial<Track>) => reasonsFor(p, undefined, { known: true, ...t });
    expect(reason({ topLists: ['short_term'] })).toEqual(['In your top songs this month']);
    expect(reason({ topLists: ['medium_term'] })).toEqual(['In your top songs, past 6 months']);
    expect(reason({ recentPlays: 1 })).toEqual(['Played recently']);
    expect(reason({ topLists: ['long_term'] })).toEqual(['In your top songs, past year']);
    expect(reason({ inPlaylist: true })).toEqual(['In your playlists']);
  });

  it('picks the 4-week list first, then the 6-month list, recent plays, the 1-year list, playlists', () => {
    const p = { comfort: 0, familiarity: 0.8, popularity: 0, penalty: 0 };
    const reason = (t: Partial<Track>) => reasonsFor(p, undefined, { known: true, ...t });
    const everywhere: Partial<Track> = { topLists: ['short_term', 'medium_term', 'long_term'], recentPlays: 3, inPlaylist: true, saved: true };
    expect(reason(everywhere)).toEqual(['In your top songs this month']);
    expect(reason({ ...everywhere, topLists: ['medium_term', 'long_term'] })).toEqual(['In your top songs, past 6 months']);
    expect(reason({ ...everywhere, topLists: ['long_term'] })).toEqual(['Played recently']);
    expect(reason({ ...everywhere, topLists: ['long_term'], recentPlays: undefined })).toEqual(['In your top songs, past year']);
    expect(reason({ ...everywhere, topLists: undefined, recentPlays: undefined })).toEqual(['In your playlists']);
  });

  it('says how much you play a song when its track does not say where you heard it', () => {
    // Libraries cached before buildLibrary recorded the lists, and test tracks.
    const p = { comfort: 0, familiarity: 0.6, popularity: 0, penalty: 0 };
    expect(reasonsFor(p)).toEqual(['You play this a lot']);
    expect(reasonsFor(p, undefined, { known: true })).toEqual(['You play this a lot']);
    expect(reasonsFor({ ...p, familiarity: 0.59 }, undefined, { known: true })).toEqual(['You know this one']);
    expect(reasonsFor({ ...p, familiarity: 0.3 })).toEqual(['You know this one']);
    expect(match(track('old', { familiarity: 0.9 }), song(57, 63)).reasons).toEqual(['In your sweet spot', 'You play this a lot']);
  });

  it('keeps the 0.3 threshold and the weight of the listening reason', () => {
    const at = (familiarity: number, popularity = 0) => reasonsFor({ comfort: 0, familiarity, popularity, penalty: 0 }, undefined, thisMonth);
    expect(at(0.29)).toEqual([]);
    expect(at(0.3)).toEqual(['In your top songs this month']);
    // Weighed as 0.35 × familiarity against 0.15 × popularity: 0.35 × 0.35 < 0.15 × 0.9 < 0.35 × 0.4.
    expect(at(0.35, 0.9)).toEqual(['Crowd favourite', 'In your top songs this month']);
    expect(at(0.4, 0.9)).toEqual(['In your top songs this month', 'Crowd favourite']);
  });

  it('never gives a listening reason for a song you do not know, such as a catalogue song', () => {
    const p = { comfort: 0.9, familiarity: 1, popularity: 0.9, penalty: 0 };
    const easy = { difficulty: 'easy' as const, side: 'top' as const };
    expect(reasonsFor(p, easy, { known: false })).toEqual(['In your sweet spot', 'Crowd favourite']);
    expect(reasonsFor({ ...p, familiarity: 0.4 }, easy, { known: false })).toEqual(['In your sweet spot', 'Crowd favourite']);
    // Not even when the track says where it was heard.
    expect(reasonsFor(p, easy, { known: false, topLists: ['short_term'], recentPlays: 5, inPlaylist: true })).toEqual(['In your sweet spot', 'Crowd favourite']);
    expect(reasonsFor(p, easy, thisMonth)).toEqual(['In your sweet spot', 'In your top songs this month']);

    // A catalogue track has familiarity 1 so comfort alone decides its fit, and is not known.
    const popular = song(57, 63, { usdbViews: 99_999, usdbRating: 5 });
    const catalogue = match(track('cat', { familiarity: 1, known: false }), popular);
    const library = match(track('lib', { familiarity: 1, ...thisMonth }), popular);
    expect(catalogue.reasons).toEqual(['In your sweet spot', 'Crowd favourite']);
    expect(library.reasons).toEqual(['In your sweet spot', 'In your top songs this month']);
    expect(catalogue.score).toBeCloseTo(library.score!);
  });

  it('keeps the reasons of saved-only songs, whose familiarity is below the threshold', () => {
    const savedOnly = match(track('saved', { familiarity: 0.15, known: false, saved: true }), song(57, 63));
    const unflagged = match(track('old', { familiarity: 0.15 }), song(57, 63));
    expect(savedOnly.reasons).toEqual(['In your sweet spot']);
    expect(unflagged.reasons).toEqual(savedOnly.reasons);
  });

  it('gives a scored match reasons that match its label and its listening', () => {
    const hard = match(track('h', { familiarity: 0.9 }), song(60, 71, { pitchShare: [[60, 0.85], [71, 0.15]] }));
    expect(hard.difficulty).toBe('hard');
    expect(hard.parts!.comfort).toBeGreaterThan(0.8);
    expect(hard.reasons).not.toContain('In your sweet spot');
    expect(hard.reasons![0]).toBe('Spends time at your high end');
    const played = match(track('p', { familiarity: 0.9, known: true, topLists: ['long_term'], recentPlays: 2 }), song(57, 63));
    expect(played.reasons).toEqual(['In your sweet spot', 'Played recently']);
  });
});
