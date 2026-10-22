import { describe, expect, it } from 'vitest';
import type { SongRange } from '../../src/lib/contracts';
import { artistTypicalRange, narrowExternalArtistRange } from '../../src/lib/songs/artistFallback';

const r = (low: number, high: number, tessitura: number, extra: Partial<SongRange> = {}): SongRange => ({
  low,
  high,
  tessitura,
  source: 'note-file',
  confidence: 'high',
  fastLyrics: true,
  ...extra,
});

describe('artistTypicalRange', () => {
  it('takes the median low, high and tessitura of the artist’s other songs', () => {
    const range = artistTypicalRange([r(50, 70, 60), r(45, 75, 58), r(52, 64, 57)]);
    expect(range).toEqual({
      low: 50,
      high: 70,
      tessitura: 58,
      source: 'artist-typical',
      confidence: 'low',
      fastLyrics: false,
    });
  });

  it('averages the two middle values for an even count', () => {
    expect(artistTypicalRange([r(50, 70, 60), r(52, 74, 61)])).toMatchObject({ low: 51, high: 72, tessitura: 60.5 });
  });

  it('is not pulled by one outlier song', () => {
    const range = artistTypicalRange([r(50, 70, 60), r(51, 71, 61), r(30, 95, 70)]);
    expect(range).toMatchObject({ low: 50, high: 71 });
  });

  it('only uses measured ranges, so guesses do not feed further guesses', () => {
    const range = artistTypicalRange([r(50, 70, 60), r(30, 40, 35, { source: 'artist-typical', confidence: 'low' })]);
    expect(range).toMatchObject({ low: 50, high: 70, tessitura: 60 });
  });

  it('uses measured recordings alongside note files, counting each recording once', () => {
    const recording = (low: number, mbid: string, extra: Partial<SongRange> = {}) =>
      r(low, 70, 60, { source: 'audio-full', confidence: 'high', mbid, ...extra });
    // "It's" and "It’s" rows of one recording share an mbid; a low-confidence recording still counts.
    const range = artistTypicalRange([r(50, 70, 60), recording(40, 'x'), recording(40, 'x'), recording(56, 'y', { confidence: 'low' })]);
    expect(range).toMatchObject({ low: 50, source: 'artist-typical', confidence: 'low' });
    expect(artistTypicalRange([recording(44, 'x'), recording(44, 'x')])).toMatchObject({ low: 44 });
  });

  it('returns null with no usable songs', () => {
    expect(artistTypicalRange([])).toBeNull();
    expect(artistTypicalRange([r(50, 70, 60, { source: 'artist-external' })])).toBeNull();
  });
});

describe('narrowExternalArtistRange', () => {
  it('trims a quarter of the span from each end', () => {
    expect(narrowExternalArtistRange(40, 80)).toEqual({
      low: 50,
      high: 70,
      tessitura: 60,
      source: 'artist-external',
      confidence: 'low',
      fastLyrics: false,
    });
  });

  it('keeps fractional results and accepts swapped bounds', () => {
    expect(narrowExternalArtistRange(70, 48)).toMatchObject({ low: 53.5, high: 64.5, tessitura: 59 });
  });
});
