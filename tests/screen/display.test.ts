// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { difficultyLabel, octaveWording, rangeBar, reasonsForSlider, scalePosition, sourceTooltip } from '../../src/lib/client/display';
import { SLIDER_IDS, type SongRange, type Track, type VocalRange } from '../../src/lib/contracts';
import { reasonsFor } from '../../src/lib/songs/score';
import { source } from '../fixtures/screen';

const user: VocalRange = { low: 45, high: 72, source: 'test' }; // A2 to C5
const song = (low: number, high: number): SongRange => ({ low, high, tessitura: (low + high) / 2, source: 'note-file', confidence: 'high', fastLyrics: false });

describe('rangeBar', () => {
  it('places both ranges on one padded scale', () => {
    const bar = rangeBar(user, song(50, 64), 'none');
    // scale is 43..74 (31 semitones)
    expect(bar.user).toEqual({ left: 6.45, width: 87.1, low: 'A2', high: 'C5' });
    expect(bar.song.low).toBe('D3');
    expect(bar.song.high).toBe('E4');
    expect(bar.song.left).toBeCloseTo((7 / 31) * 100, 1);
    expect(bar.song.width).toBeCloseTo((14 / 31) * 100, 1);
  });

  it('widens the scale when the song goes past the user', () => {
    const bar = rangeBar(user, song(40, 76), 'none');
    expect(bar.song.left).toBeCloseTo((2 / 40) * 100, 1);
    expect(bar.song.left + bar.song.width).toBeCloseTo((38 / 40) * 100, 1);
    expect(bar.user.left).toBeGreaterThan(bar.song.left);
  });

  it('shows the notes the user will sing for octave matches', () => {
    expect(rangeBar(user, song(58, 77), 'down').song).toMatchObject({ low: 'A#2', high: 'F4' });
    expect(rangeBar(user, song(40, 52), 'up').song).toMatchObject({ low: 'E3', high: 'E4' });
  });

  it('keeps spans inside 0..100', () => {
    for (const [lo, hi] of [[30, 90], [45, 72], [60, 61]] as const) {
      const bar = rangeBar(user, song(lo, hi), 'none');
      for (const s of [bar.user, bar.song]) {
        expect(s.left).toBeGreaterThanOrEqual(0);
        expect(s.left + s.width).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('wording', () => {
  it('octave matches use plain words', () => {
    expect(octaveWording('up')).toBe('Sing it higher than the artist');
    expect(octaveWording('down')).toBe('Sing it lower than the artist');
    expect(octaveWording('none')).toBeNull();
    for (const o of ['up', 'down'] as const) expect(octaveWording(o)).not.toMatch(/octave|transpose|key/i);
  });

  it('difficulty labels', () => {
    expect(['easy', 'medium', 'hard', 'maybe'].map((d) => difficultyLabel(d as 'easy'))).toEqual(['Easy', 'Medium', 'Hard', 'Maybe']);
  });
});

describe('reasonsForSlider', () => {
  const RANGE_REASONS = [
    'In your sweet spot',
    'Mostly comfortable',
    'A few notes near your high end',
    'A few notes near your low end',
    'Spends time at your high end',
    'Spends time at your low end',
  ];

  const LISTENING_REASONS = [
    'In your top songs this month',
    'In your top songs of the past 6 months',
    'Played recently',
    'One of your all-time top songs',
    'In your playlists',
    'You play this a lot',
    'You know this one',
  ];

  it('leads with the range reason when the difficulty slider moved last', () => {
    for (const range of RANGE_REASONS) {
      expect(reasonsForSlider(['Played recently', range], 'difficulty')).toEqual([range, 'Played recently']);
      expect(reasonsForSlider(['Crowd favourite', range], 'popularity')).toEqual(['Crowd favourite', range]);
    }
  });

  it('leads with the listening reason when the familiarity slider moved last', () => {
    for (const heard of LISTENING_REASONS) {
      expect(reasonsForSlider(['In your sweet spot', heard], 'familiarity')).toEqual([heard, 'In your sweet spot']);
      expect(reasonsForSlider([heard, 'In your sweet spot'], 'difficulty')).toEqual(['In your sweet spot', heard]);
      expect(reasonsForSlider([heard, 'Crowd favourite'], 'popularity')).toEqual(['Crowd favourite', heard]);
    }
  });

  it('matches every reason a song can get to its own slider and to no other', () => {
    const bySlider = { difficulty: new Set<string>(), familiarity: new Set<string>(), popularity: new Set<string>() };
    const none = { comfort: 0, familiarity: 0, popularity: 0, penalty: 0 };
    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      for (const side of ['top', 'bottom'] as const) reasonsFor({ ...none, comfort: 0.9 }, { difficulty, side }).forEach((r) => bySlider.difficulty.add(r));
    }
    for (const comfort of [0.6, 0.9]) reasonsFor({ ...none, comfort }).forEach((r) => bySlider.difficulty.add(r));
    const heard: Partial<Track>[] = [{}, { topLists: ['short_term'] }, { topLists: ['medium_term'] }, { recentPlays: 1 }, { topLists: ['long_term'] }, { inPlaylist: true }];
    for (const t of heard) {
      for (const familiarity of [0.3, 0.6]) reasonsFor({ ...none, familiarity }, undefined, t).forEach((r) => bySlider.familiarity.add(r));
    }
    reasonsFor({ ...none, popularity: 0.9 }).forEach((r) => bySlider.popularity.add(r));
    expect([...bySlider.difficulty].sort()).toEqual([...RANGE_REASONS].sort());
    expect([...bySlider.familiarity].sort()).toEqual([...LISTENING_REASONS].sort());
    expect([...bySlider.popularity]).toEqual(['Crowd favourite']);

    for (const [slider, reasons] of Object.entries(bySlider)) {
      for (const reason of reasons) {
        for (const lead of SLIDER_IDS) expect(reasonsForSlider(['Other', reason], lead)[0]).toBe(lead === slider ? reason : 'Other');
      }
    }
  });

  it('keeps the order when no slider leads, and copes with no reasons', () => {
    expect(reasonsForSlider(['Crowd favourite', 'In your sweet spot'], null)).toEqual(['Crowd favourite', 'In your sweet spot']);
    expect(reasonsForSlider(undefined, 'difficulty')).toEqual([]);
  });
});

describe('sourceTooltip', () => {
  it('explains the outcome and adds the reason', () => {
    expect(sourceTooltip(source(0))).toBe('Measured from a note-by-note file of this song. Matched a note file by title and artist.');
    expect(sourceTooltip(source(1))).toBe(
      'From a recording of this song. Measured from the full recording: vocals separated and pitch-tracked, 74 s of clear singing.',
    );
    expect(sourceTooltip(source(8))).toBe("Estimated from this artist's usual singing range. No note file found, used The Blue Hearts's usual range.");
  });

  it('covers every outcome and missing data', () => {
    expect(sourceTooltip({ ...source(0), outcome: 'artist-external', reason: '' })).toBe('Estimated from published info about this artist.');
    expect(sourceTooltip({ ...source(0), outcome: 'audio-full', reason: '' })).toBe('From a recording of this song.');
    expect(sourceTooltip({ ...source(0), outcome: 'skipped', reason: ' ' })).toMatch(/couldn't find/);
    expect(sourceTooltip(undefined)).toMatch(/don't have details/);
  });

  it('says a Maybe song’s range is an estimate', () => {
    expect(sourceTooltip(source(9), true)).toBe(
      'From a recording of this song. Measured from the full recording: vocals separated and pitch-tracked, 9 s of clear singing. ' +
        'This range is only an estimate, so the song is a maybe: it fits your range, give or take a couple of notes.',
    );
    expect(sourceTooltip(undefined, true)).toMatch(/don't have details.* This range is only an estimate/);
  });
});

describe('scalePosition', () => {
  it('maps C2..C6 to 0..100 and clamps', () => {
    expect(scalePosition(36)).toBe(0);
    expect(scalePosition(60)).toBe(50);
    expect(scalePosition(84)).toBe(100);
    expect(scalePosition(20)).toBe(0);
    expect(scalePosition(100)).toBe(100);
  });
});
