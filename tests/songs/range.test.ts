import { describe, expect, it } from 'vitest';
import type { SongPart, SongRange } from '../../src/lib/contracts';
import { FAST_LYRICS_SYLLABLES_PER_SECOND, fastShare, octaveCorrection, songRangeFromUltrastar, syllableRate, trimmedRange } from '../../src/lib/songs/range';
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

describe('duet parts', () => {
  const PART_ONE = { singer: 'Singer One', low: 60, high: 62, tessitura: 61, pitchShare: [[60, 0.5], [62, 0.5]], fastLyrics: false };
  const PART_TWO = { singer: 'Singer Two', low: 67, high: 72, tessitura: 70 + 1 / 3, pitchShare: [[67, 0.333], [72, 0.667]], fastLyrics: false };

  it("gives a duet each singer's range and name, keeping the asked-for part on top", () => {
    const duet = parseUltrastar(fixture('duet.txt'));
    expect(songRangeFromUltrastar(duet)).toMatchObject({ low: 60, high: 62, duet: true, parts: [PART_ONE, PART_TWO] });
    expect(songRangeFromUltrastar(duet, 2)).toMatchObject({ low: 67, high: 72, duet: true, parts: [PART_ONE, PART_TWO] });
  });

  it('counts lines both singers sing (P3) in each part', () => {
    const text = ['#BPM:120', 'P1', ': 0 4 0 a', ': 4 4 2 b', 'P2', ': 8 4 7 c', ': 12 4 9 d', 'P3', ': 16 8 -5 both', 'E'].join('\n');
    const { parts } = songRangeFromUltrastar(text);
    expect(parts).toMatchObject([
      { low: 55, high: 62, pitchShare: [[55, 0.5], [60, 0.25], [62, 0.25]] },
      { low: 55, high: 69, pitchShare: [[55, 0.5], [67, 0.25], [69, 0.25]] },
    ]);
  });

  it('is not a duet when P2 is empty or has no sung pitches', () => {
    const solo = ['#BPM:120', 'P1', ': 0 4 0 a', ': 4 4 2 b'];
    const alone = JSON.stringify(songRangeFromUltrastar([...solo, 'E'].join('\n')));
    for (const p2 of [[], ['R 8 4 0 yo', 'F 12 4 0 hey'], [': 8 0 5 x']]) {
      const range = songRangeFromUltrastar([...solo, 'P2', ...p2, 'E'].join('\n'));
      expect(range).not.toHaveProperty('duet');
      expect(range).not.toHaveProperty('parts');
      expect(JSON.stringify(range)).toBe(alone);
    }
  });

  it('takes singer names from the older #DUETSINGERP1/#DUETSINGERP2 headers, and #P1/#P2 over them', () => {
    const older = fixture('duet.txt').replace('#P1:Singer One', '#DUETSINGERP1:Old One').replace('#P2:Singer Two', '#DUETSINGERP2:Old Two');
    expect(songRangeFromUltrastar(older).parts?.map((p) => p.singer)).toEqual(['Old One', 'Old Two']);
    const both = fixture('duet.txt').replace('#P1:Singer One', '#P1:Singer One\n#DUETSINGERP1:Old One');
    expect(songRangeFromUltrastar(both).parts?.[0]?.singer).toBe('Singer One');
    const unnamed = fixture('duet.txt').replace(/#P[12]:.*\n/g, '');
    expect(songRangeFromUltrastar(unnamed).parts?.map((p) => 'singer' in p)).toEqual([false, false]);
  });

  it('fixes the octave and flags fast lyrics per part', () => {
    // BPM 150, so a beat is 0.1 s. P1: one syllable a second, written two octaves too high.
    // P2: five syllables a second, written where it is sung.
    const p1 = Array.from({ length: 20 }, (_, i) => `: ${i * 10} 4 ${26 + (i % 5)} la`);
    const p2 = Array.from({ length: 100 }, (_, i) => `: ${i * 2} 1 0 la`);
    const text = ['#BPM:150', 'P1', ...p1, 'P2', ...p2, 'E'].join('\n');
    const range = songRangeFromUltrastar(text);
    expect(range.parts).toMatchObject([
      { low: 62, high: 66, fastLyrics: false },
      { low: 60, high: 60, tessitura: 60, fastLyrics: true },
    ]);
    const top = ({ low, high, tessitura, pitchShare, fastLyrics }: SongPart | SongRange) => ({ low, high, tessitura, pitchShare, fastLyrics });
    expect(top(range)).toEqual(top(range.parts![0]!));
    expect(top(songRangeFromUltrastar(text, 2))).toEqual(top(range.parts![1]!));
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

  // BPM 150: one beat is 0.1 s. `notes` is [beat, syllable] pairs.
  const song = (notes: [number, string][]) =>
    ['#TITLE:T', '#ARTIST:A', '#BPM:150', '#GAP:0', ...notes.map(([b, syl]) => `: ${b} 1 0 ${syl}`), 'E'].join('\n');
  const run = (from: number, count: number, everyBeats: number, syl = 'la'): [number, string][] =>
    Array.from({ length: count }, (_, i) => [from + Math.round(i * everyBeats), syl]);

  it('does not flag a slow song for one busy 10 s run', () => {
    // 200 s at one syllable a second, with a 10 s run at about 5.5 a second in the middle.
    const text = song([...run(0, 100, 10), ...run(1000, 55, 1.8), ...run(1200, 100, 10)]);
    const file = parseUltrastar(text);
    expect(syllableRate(file.players[0]!, file.bpm)).toBeGreaterThan(4.5);
    expect(fastShare(file.players[0]!, file.bpm)).toBeLessThan(0.1);
    expect(songRangeFromUltrastar(text).fastLyrics).toBe(false);
  });

  it('flags a song with a long fast stretch', () => {
    // A minute at about 5.5 syllables a second, then a minute at one a second.
    const text = song([...run(0, 330, 1.8), ...run(700, 60, 10)]);
    expect(songRangeFromUltrastar(text).fastLyrics).toBe(true);
  });

  it('does not count "~a"-style continuations as new syllables', () => {
    // Six notes a second, but every other one finishes the previous syllable.
    const notes = run(0, 600, 1.667).map(([b], i): [number, string] => [b, i % 2 ? '~a' : 'la']);
    const file = parseUltrastar(song(notes));
    expect(syllableRate(file.players[0]!, file.bpm)).toBeLessThan(3.5);
    expect(songRangeFromUltrastar(song(notes)).fastLyrics).toBe(false);
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

describe('ranges stay as they were before duet parts', () => {
  // Every fixture's range as JSON, computed before duets got each singer's part (commit fd3fde1),
  // plus two made-up songs for the octave fix and the outlier trim. Solo songs must come out
  // byte for byte the same; a duet keeps these top-level fields (P1's, or the part asked for).
  const song = (notes: [number, number][]) => '#BPM:120\n' + notes.map(([pitch, len], i) => `: ${i * 8} ${len} ${pitch} la`).join('\n') + '\nE\n';
  const twoOctavesHigh = song(Array.from({ length: 12 }, (_, i) => [26 + (i % 5), 4]));
  const shout = song([...Array.from({ length: 30 }, (_, i): [number, number] => [i % 2 ? 2 : 4, 4]), [19, 1]]);
  const before: [name: string, text: string, part: number, json: string][] = [
    ['ballad.txt', fixture('ballad.txt'), 1, '{"low":58,"high":62,"tessitura":60,"source":"note-file","confidence":"high","fastLyrics":false,"pitchShare":[[58,0.2],[59,0.2],[60,0.2],[61,0.2],[62,0.2]]}'],
    ['comma-bpm.txt', fixture('comma-bpm.txt'), 1, '{"low":60,"high":60,"tessitura":60,"source":"note-file","confidence":"high","fastLyrics":false,"pitchShare":[[60,1]]}'],
    ['crlf-bom.txt', fixture('crlf-bom.txt'), 1, '{"low":65,"high":69,"tessitura":66.6,"source":"note-file","confidence":"high","fastLyrics":false,"pitchShare":[[65,0.4],[67,0.4],[69,0.2]]}'],
    ['fast.txt', fixture('fast.txt'), 1, '{"low":60,"high":62,"tessitura":60.6,"source":"note-file","confidence":"high","fastLyrics":true,"pitchShare":[[60,0.6],[61,0.2],[62,0.2]]}'],
    ['low-song.txt', fixture('low-song.txt'), 1, '{"low":36,"high":48,"tessitura":42,"source":"note-file","confidence":"high","fastLyrics":false,"pitchShare":[[36,0.333],[42,0.333],[48,0.333]]}'],
    ['melisma.txt', fixture('melisma.txt'), 1, '{"low":60,"high":60,"tessitura":60,"source":"note-file","confidence":"high","fastLyrics":false,"pitchShare":[[60,1]]}'],
    ['rap.txt', fixture('rap.txt'), 1, '{"low":57,"high":69,"tessitura":63.8,"source":"note-file","confidence":"high","fastLyrics":false,"pitchShare":[[57,0.2],[62,0.4],[69,0.4]]}'],
    ['relative.txt', fixture('relative.txt'), 1, '{"low":60,"high":65,"tessitura":62.75,"source":"note-file","confidence":"high","fastLyrics":false,"pitchShare":[[60,0.25],[62,0.25],[64,0.25],[65,0.25]]}'],
    ['solo.txt', fixture('solo.txt'), 1, '{"low":55,"high":67,"tessitura":62.5,"source":"note-file","confidence":"high","fastLyrics":false,"pitchShare":[[55,0.167],[60,0.167],[62,0.167],[64,0.167],[67,0.333]]}'],
    ['two octaves high', twoOctavesHigh, 1, '{"low":62,"high":66,"tessitura":63.75,"source":"note-file","confidence":"high","fastLyrics":false,"pitchShare":[[62,0.25],[63,0.25],[64,0.167],[65,0.167],[66,0.167]]}'],
    ['one-beat shout', shout, 1, '{"low":62,"high":64,"tessitura":63.13223140495868,"source":"note-file","confidence":"high","fastLyrics":false,"pitchShare":[[62,0.496],[64,0.496],[79,0.008]]}'],
    ['duet.txt', fixture('duet.txt'), 1, '{"low":60,"high":62,"tessitura":61,"source":"note-file","confidence":"high","fastLyrics":false,"pitchShare":[[60,0.5],[62,0.5]]}'],
    ['duet.txt', fixture('duet.txt'), 2, '{"low":67,"high":72,"tessitura":70.33333333333333,"source":"note-file","confidence":"high","fastLyrics":false,"pitchShare":[[67,0.333],[72,0.667]]}'],
  ];

  it.each(before)('%s, part %i', (name, text, part, json) => {
    const range = songRangeFromUltrastar(text, part);
    if (name === 'duet.txt') {
      const { duet: _duet, parts: _parts, ...topLevel } = range;
      expect(JSON.stringify(topLevel)).toBe(json);
    } else {
      expect(JSON.stringify(range)).toBe(json);
    }
  });
});
