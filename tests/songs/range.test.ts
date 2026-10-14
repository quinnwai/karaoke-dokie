import { describe, expect, it } from 'vitest';
import { FAST_LYRICS_SYLLABLES_PER_SECOND, songRangeFromUltrastar, syllableRate } from '../../src/lib/songs/range';
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
