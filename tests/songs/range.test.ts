import { describe, expect, it } from 'vitest';
import { FAST_LYRICS_SYLLABLES_PER_SECOND, octaveCorrection, songRangeFromUltrastar, syllableRate, trimmedRange } from '../../src/lib/songs/range';
import { parseUltrastar } from '../../src/lib/songs/ultrastar';
import { fixture } from './fixture';

describe('songRangeFromUltrastar', () => {
  it('takes low/high from pitched notes and a length-weighted tessitura', () => {
    const range = songRangeFromUltrastar(parseUltrastar(fixture('solo.txt')));
    expect(range.low).toBe(55); // G3
    expect(range.high).toBe(67); // G4
    expect(range.tessitura).toBeCloseTo(62.5, 5);
    expect(range.source).toBe('note-file');
    expect(range.confidence).toBe('high');
  });

  it('ignores freestyle and rap notes, keeps golden notes', () => {
    const range = songRangeFromUltrastar(parseUltrastar(fixture('rap.txt')));
    expect(range.low).toBe(57);
    expect(range.high).toBe(69); // golden note
    expect(range.tessitura).toBeCloseTo(63.8, 5);
  });

  it('accepts raw file text', () => {
    expect(songRangeFromUltrastar(fixture('solo.txt')).low).toBe(55);
  });

  it('uses P1 for duets unless a part is given', () => {
    const duet = parseUltrastar(fixture('duet.txt'));
    expect(songRangeFromUltrastar(duet)).toMatchObject({ low: 60, high: 62 });
    expect(songRangeFromUltrastar(duet, 2)).toMatchObject({ low: 67, high: 72 });
  });

  it('throws for a missing part or a file with no pitched notes', () => {
    expect(() => songRangeFromUltrastar(parseUltrastar(fixture('solo.txt')), 2)).toThrow(/part/);
    expect(() => songRangeFromUltrastar('#BPM:100\nR 0 4 0 yo\nF 4 4 0 hey\n')).toThrow(/pitched/);
  });
});

describe('fast lyrics', () => {
  it(`uses a threshold of ${FAST_LYRICS_SYLLABLES_PER_SECOND} syllables per second`, () => {
    expect(FAST_LYRICS_SYLLABLES_PER_SECOND).toBe(4.5);
  });

  it('a slow ballad is not fast', () => {
    const file = parseUltrastar(fixture('ballad.txt'));
    expect(syllableRate(file.players[0]!, file.bpm)).toBeCloseTo(1.3, 2); // 13 notes start inside the first 10 s
    expect(songRangeFromUltrastar(file).fastLyrics).toBe(false);
  });

  it('a fast verse after a slow intro is fast (busiest 10 s window)', () => {
    const file = parseUltrastar(fixture('fast.txt'));
    expect(syllableRate(file.players[0]!, file.bpm)).toBeCloseTo(5, 2);
    expect(songRangeFromUltrastar(file).fastLyrics).toBe(true);
  });

  it('does not count "~" held-vowel continuations as syllables', () => {
    const file = parseUltrastar(fixture('melisma.txt'));
    expect(syllableRate(file.players[0]!, file.bpm)).toBeLessThan(4.5);
    expect(songRangeFromUltrastar(file).fastLyrics).toBe(false);
  });

  it('counts rap syllables toward the pace', () => {
    const rap = Array.from({ length: 60 }, (_, i) => `R ${i * 4} 3 0 yo`).join('\n');
    const file = parseUltrastar(`#BPM:300\n: 0 4 0 a\n${rap}\n`);
    expect(songRangeFromUltrastar(file).fastLyrics).toBe(true);
  });
});

describe('outliers and octave errors', () => {
  const song = (notes: [number, number][]) => '#BPM:120\n' + notes.map(([pitch, len], i) => `: ${i * 8} ${len} ${pitch} la`).join('\n') + '\nE\n';

  it('drops extreme pitches that cover at most 5% of sung time', () => {
    const notes = [{ midi: 40, length: 1 }, ...Array.from({ length: 20 }, (_, i) => ({ midi: 55 + (i % 10), length: 4 })), { midi: 80, length: 1 }];
    expect(trimmedRange(notes)).toEqual({ low: 55, high: 64 });
  });

  it('keeps an extreme pitch that is held long enough to matter', () => {
    expect(trimmedRange([{ midi: 50, length: 10 }, { midi: 60, length: 80 }, { midi: 70, length: 10 }])).toEqual({ low: 50, high: 70 });
  });

  it('a one-beat shout does not set the top of the range', () => {
    const body: [number, number][] = Array.from({ length: 30 }, (_, i) => [i % 2 ? 2 : 4, 4]);
    expect(songRangeFromUltrastar(song([...body, [19, 1]]))).toMatchObject({ low: 62, high: 64 });
  });

  it('only moves songs whose typical note is outside E2 to C5', () => {
    expect(octaveCorrection(64)).toBe(0);
    expect(octaveCorrection(42)).toBe(0); // a bass song stays put
    expect(octaveCorrection(88)).toBe(-24); // E6, as in a real USDB file
    expect(octaveCorrection(70)).toBe(0); // a high female song stays put
    expect(octaveCorrection(79)).toBe(-12);
    expect(octaveCorrection(30)).toBe(12);
  });

  it('shifts a note file written two octaves too high back down', () => {
    // Pitch 28 = E6 with C4 = 0; the melody sits around E4 once corrected.
    const range = songRangeFromUltrastar(song(Array.from({ length: 12 }, (_, i) => [26 + (i % 5), 4])));
    expect(range.tessitura).toBeGreaterThanOrEqual(62);
    expect(range.tessitura).toBeLessThan(67);
    expect(range).toMatchObject({ low: 62, high: 66 });
  });
});
