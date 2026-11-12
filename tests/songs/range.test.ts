import { describe, expect, it } from 'vitest';
import type { SongPart, SongRange } from '../../src/lib/contracts';
import { PLAUSIBLE_SONG as PLAUSIBLE_SONG_FROM_IMPORT } from '../../src/lib/notes/bulkImport';
import { shiftRange } from '../../src/lib/songs/octave';
import {
  FAST_LYRICS_SYLLABLES_PER_SECOND,
  NARROW_SPAN,
  PLAUSIBLE_SONG,
  STRAY_GAP,
  applyNarrowRule,
  fastShare,
  gentleRange,
  isNarrow,
  isPlausible,
  octaveCorrection,
  songRangeFromUltrastar,
  syllableRate,
  trimmedRange,
} from '../../src/lib/songs/range';
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
  // One change since, on purpose (QWW-60): a solo song of 5 semitones or fewer is low confidence
  // (the 1% trim gives these fixtures the same range, since each note carries far more than 1%).
  const song = (notes: [number, number][]) => '#BPM:120\n' + notes.map(([pitch, len], i) => `: ${i * 8} ${len} ${pitch} la`).join('\n') + '\nE\n';
  const twoOctavesHigh = song(Array.from({ length: 12 }, (_, i) => [26 + (i % 5), 4]));
  const shout = song([...Array.from({ length: 30 }, (_, i): [number, number] => [i % 2 ? 2 : 4, 4]), [19, 1]]);
  const before: [name: string, text: string, part: number, json: string][] = [
    ['ballad.txt', fixture('ballad.txt'), 1, '{"low":58,"high":62,"tessitura":60,"source":"note-file","confidence":"low","fastLyrics":false,"pitchShare":[[58,0.2],[59,0.2],[60,0.2],[61,0.2],[62,0.2]]}'],
    ['comma-bpm.txt', fixture('comma-bpm.txt'), 1, '{"low":60,"high":60,"tessitura":60,"source":"note-file","confidence":"low","fastLyrics":false,"pitchShare":[[60,1]]}'],
    ['crlf-bom.txt', fixture('crlf-bom.txt'), 1, '{"low":65,"high":69,"tessitura":66.6,"source":"note-file","confidence":"low","fastLyrics":false,"pitchShare":[[65,0.4],[67,0.4],[69,0.2]]}'],
    ['fast.txt', fixture('fast.txt'), 1, '{"low":60,"high":62,"tessitura":60.6,"source":"note-file","confidence":"low","fastLyrics":true,"pitchShare":[[60,0.6],[61,0.2],[62,0.2]]}'],
    ['low-song.txt', fixture('low-song.txt'), 1, '{"low":36,"high":48,"tessitura":42,"source":"note-file","confidence":"high","fastLyrics":false,"pitchShare":[[36,0.333],[42,0.333],[48,0.333]]}'],
    ['melisma.txt', fixture('melisma.txt'), 1, '{"low":60,"high":60,"tessitura":60,"source":"note-file","confidence":"low","fastLyrics":false,"pitchShare":[[60,1]]}'],
    ['rap.txt', fixture('rap.txt'), 1, '{"low":57,"high":69,"tessitura":63.8,"source":"note-file","confidence":"high","fastLyrics":false,"pitchShare":[[57,0.2],[62,0.4],[69,0.4]]}'],
    ['relative.txt', fixture('relative.txt'), 1, '{"low":60,"high":65,"tessitura":62.75,"source":"note-file","confidence":"low","fastLyrics":false,"pitchShare":[[60,0.25],[62,0.25],[64,0.25],[65,0.25]]}'],
    ['solo.txt', fixture('solo.txt'), 1, '{"low":55,"high":67,"tessitura":62.5,"source":"note-file","confidence":"high","fastLyrics":false,"pitchShare":[[55,0.167],[60,0.167],[62,0.167],[64,0.167],[67,0.333]]}'],
    ['two octaves high', twoOctavesHigh, 1, '{"low":62,"high":66,"tessitura":63.75,"source":"note-file","confidence":"low","fastLyrics":false,"pitchShare":[[62,0.25],[63,0.25],[64,0.167],[65,0.167],[66,0.167]]}'],
    ['one-beat shout', shout, 1, '{"low":62,"high":64,"tessitura":63.13223140495868,"source":"note-file","confidence":"low","fastLyrics":false,"pitchShare":[[62,0.496],[64,0.496],[79,0.008]]}'],
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

describe('the narrow-range rule (QWW-60)', () => {
  // A note file as range.ts stores it: the usual 5% trim of its histogram, and the histogram's mean as the typical note.
  const noteFile = (pitchShare: [number, number][], extra: Partial<SongRange> = {}): SongRange => {
    const { low, high } = trimmedRange(pitchShare.map(([midi, length]) => ({ midi, length })));
    const total = pitchShare.reduce((sum, [, share]) => sum + share, 0);
    const tessitura = pitchShare.reduce((sum, [midi, share]) => sum + midi * share, 0) / total;
    return { low, high, tessitura, source: 'note-file', confidence: 'high', fastLyrics: false, pitchShare, ...extra };
  };
  // Mostly two notes, with a little singing below and above them that the 5% trim drops and a 1% trim keeps: 56 to 58 becomes 52 to 61.
  const STRAY: [number, number][] = [[52, 0.015], [55, 0.03], [56, 0.5], [57, 0.4], [58, 0.03], [61, 0.025]];
  // Are You Bored Yet? by Wallows, as production stores it (the octave fix had moved it): G3 to A3 with 69% of the singing on G#3.
  const WALLOWS: SongRange = {
    low: 55,
    high: 57,
    tessitura: 56.130472103004294,
    source: 'note-file',
    confidence: 'high',
    fastLyrics: false,
    octaveFrom: 'recording',
    pitchShare: [[48, 0.009], [54, 0.012], [55, 0.058], [56, 0.688], [57, 0.198], [58, 0.022], [59, 0.013]],
  };

  it('measures a note file of 5 semitones or fewer again with a 1% trim, and keeps its confidence when that is wider', () => {
    const stored = noteFile(STRAY);
    expect(stored).toMatchObject({ low: 56, high: 58 });
    expect(applyNarrowRule(stored)).toEqual({ ...stored, low: 52, high: 61 });
  });

  it('marks what the 1% trim still leaves at 5 semitones or fewer as low confidence, with the widened range (Are You Bored Yet?)', () => {
    expect(gentleRange(WALLOWS)).toEqual({ low: 54, high: 59, octaves: 0, gap: 1 });
    expect(applyNarrowRule(WALLOWS)).toEqual({ ...WALLOWS, low: 54, high: 59, confidence: 'low' });
  });

  it('drops a pitch with exactly 1% of the time, as the 5% trim drops one with exactly 5%, and keeps one with more', () => {
    // The shares sum to 1, so 0.01 is exactly the cut: at most 1% is dropped at each end.
    expect(gentleRange(noteFile([[52, 0.01], [56, 0.49], [57, 0.5]]))).toMatchObject({ low: 56, high: 57 });
    expect(gentleRange(noteFile([[52, 0.011], [56, 0.489], [57, 0.5]]))).toMatchObject({ low: 52, high: 57 });
    expect(trimmedRange([{ midi: 52, length: 5 }, { midi: 56, length: 45 }, { midi: 57, length: 50 }])).toEqual({ low: 56, high: 57 });
  });

  it('counts 5 semitones as narrow and 6 as wide, before and after the 1% trim', () => {
    const six = noteFile([[56, 0.5], [62, 0.5]]);
    expect(isNarrow(six)).toBe(false);
    expect(applyNarrowRule(six)).toBe(six);
    // 5 before the finer trim and 6 after it: wide, so not marked.
    const fiveThenSix = noteFile([[55, 0.015], [56, 0.485], [61, 0.5]]);
    expect(fiveThenSix).toMatchObject({ low: 56, high: 61 });
    expect(isNarrow(fiveThenSix)).toBe(true);
    expect(applyNarrowRule(fiveThenSix)).toEqual({ ...fiveThenSix, low: 55, high: 61 });
    // 5 before and 5 after: marked.
    const five = noteFile([[56, 0.5], [61, 0.5]]);
    expect(applyNarrowRule(five)).toEqual({ ...five, confidence: 'low' });
  });

  it('marks a recording of 5 semitones or fewer and leaves its range as it is, whatever its histogram would give', () => {
    const recording = noteFile(STRAY, { source: 'audio-full', method: 'pyin-v1/app-range-v1' });
    expect(gentleRange(recording)).toEqual({ low: 52, high: 61, octaves: 0, gap: 3 });
    expect(applyNarrowRule(recording)).toEqual({ ...recording, confidence: 'low' });
    const wide = { ...recording, low: 50, high: 60 };
    expect(applyNarrowRule(wide)).toBe(wide);
  });

  it('leaves duets with parts, artist estimates and wide ranges as they are', () => {
    const part = { low: 56, high: 58, tessitura: 57, fastLyrics: false };
    const duet = noteFile(STRAY, { duet: true, parts: [part, part] });
    expect(isNarrow(duet)).toBe(false);
    expect(applyNarrowRule(duet)).toBe(duet);
    for (const source of ['artist-typical', 'artist-external'] as const) {
      const estimate = noteFile(STRAY, { source, confidence: 'low' });
      expect(applyNarrowRule(estimate)).toBe(estimate);
    }
    const wide = noteFile([[50, 0.5], [60, 0.5]]);
    expect(applyNarrowRule(wide)).toBe(wide);
  });

  it('only marks a narrow note file that has no histogram, or one that does not describe the song', () => {
    const { pitchShare: _, ...bare } = noteFile(STRAY);
    expect(applyNarrowRule(bare)).toEqual({ ...bare, confidence: 'low' });
    // A typical note 6 semitones off the histogram's mean is nowhere near it at any whole octave.
    const stale = { ...noteFile(STRAY), tessitura: 62.5 };
    expect(gentleRange(stale)).toBeNull();
    expect(applyNarrowRule(stale)).toEqual({ ...stale, confidence: 'low' });
  });

  it('does not widen to pitches no song has: a note file with junk notes keeps its range and is marked', () => {
    // 1.5% of the time on a pitch above G6 (as in a production note file that reaches G17): the 5% trim drops it, the 1% trim would keep it.
    const junkHigh = noteFile([[56, 0.5], [57, 0.485], [100, 0.015]]);
    expect(junkHigh).toMatchObject({ low: 56, high: 57 });
    expect(gentleRange(junkHigh)).toEqual({ low: 56, high: 100, octaves: 0, gap: 43 });
    expect(applyNarrowRule(junkHigh)).toEqual({ ...junkHigh, confidence: 'low' });
    // A pitch below E1, a span of only 14 semitones: still no song's.
    const junkLow = noteFile([[27, 0.015], [40, 0.5], [41, 0.485]]);
    expect(applyNarrowRule(junkLow)).toEqual({ ...junkLow, confidence: 'low' });
    // Junk on one side and a believable stray note on the other: the 1% trim as a whole is not believable, so the range stays and is marked.
    const mixed = noteFile([[52, 0.015], [56, 0.485], [57, 0.485], [100, 0.015]]);
    expect(applyNarrowRule(mixed)).toEqual({ ...mixed, confidence: 'low' });
  });

  it('does not widen to a stray note: a pitch far from every other sung pitch is a typo in the file (Pretty Maids All in a Row)', () => {
    // 2.1% of the time on D#2, 16 semitones below the rest: the 5% trim drops it, the 1% trim would keep it and make a Hard song of a Maybe.
    const eagles = noteFile([[39, 0.021], [55, 0.766], [56, 0.115], [58, 0.098]]);
    expect(eagles).toMatchObject({ low: 55, high: 58 });
    expect(gentleRange(eagles)).toEqual({ low: 39, high: 58, octaves: 0, gap: 16 });
    expect(applyNarrowRule(eagles)).toEqual({ ...eagles, confidence: 'low' });
  });

  it('widens over steps of 7 semitones and refuses steps of 8, counting only pitches that are sung and are inside the 1% trim', () => {
    const step = (gap: number) => noteFile([[56 - gap, 0.015], [56, 0.5], [57, 0.485]]);
    expect(STRAY_GAP).toBe(8);
    expect(applyNarrowRule(step(7))).toMatchObject({ low: 49, high: 57, confidence: 'high' });
    expect(applyNarrowRule(step(8))).toEqual({ ...step(8), confidence: 'low' });
    // A bin with no sung time (a share rounded to 0) is not a pitch that is sung: the step is 8 across it, not 4 and 4.
    const hole = noteFile([[48, 0.015], [52, 0], [56, 0.5], [57, 0.485]]);
    expect(gentleRange(hole)).toMatchObject({ gap: 8 });
    expect(applyNarrowRule(hole)).toEqual({ ...hole, confidence: 'low' });
    // A far pitch that the 1% trim drops does not count: the trim is 51 to 57 and its widest step is 5.
    const dropped = noteFile([[30, 0.005], [51, 0.015], [56, 0.49], [57, 0.49]]);
    expect(gentleRange(dropped)).toMatchObject({ low: 51, high: 57, gap: 5 });
    expect(applyNarrowRule(dropped)).toMatchObject({ low: 51, high: 57, confidence: 'high' });
  });

  it('judges a range plausible by the bounds the import uses (E1 to G6, 36 semitones at most)', () => {
    expect(PLAUSIBLE_SONG).toEqual({ lowest: 28, highest: 91, widestSpan: 36 });
    expect(PLAUSIBLE_SONG).toBe(PLAUSIBLE_SONG_FROM_IMPORT);
    expect(isPlausible({ low: 28, high: 64 })).toBe(true);
    expect(isPlausible({ low: 55, high: 91 })).toBe(true);
    expect(isPlausible({ low: 27, high: 40 })).toBe(false);
    expect(isPlausible({ low: 60, high: 92 })).toBe(false);
    expect(isPlausible({ low: 40, high: 77 })).toBe(false); // 37 semitones
    expect(isPlausible({ low: 40, high: 76 })).toBe(true);
  });

  it('does not take a low-confidence note file back to high when the 1% trim widens it', () => {
    const rap = noteFile(STRAY, { confidence: 'low' });
    expect(applyNarrowRule(rap)).toEqual({ ...rap, low: 52, high: 61 });
  });

  it('is idempotent: a second pass changes nothing', () => {
    for (const stored of [noteFile(STRAY), WALLOWS, noteFile(STRAY, { source: 'audio-full' }), noteFile([[56, 0.5], [61, 0.5]])]) {
      const once = applyNarrowRule(stored);
      expect(once).not.toBe(stored);
      expect(applyNarrowRule(once)).toBe(once);
    }
  });

  describe('octaves', () => {
    // The octave fix moves a stored range and its histogram together (shiftRange), so the rule's new low and high
    // are in the stored octave: widening what was moved must not move it back, or an octave further.
    it.each([[-12, 'recording'], [12, 'artist'], [-24, 'pitch']] as const)('keeps a range moved %i semitones in its octave (histogram moved with it)', (semitones, octaveFrom) => {
      const moved = { ...shiftRange(noteFile(STRAY), semitones), octaveFrom };
      expect(applyNarrowRule(moved)).toEqual({ ...moved, low: 52 + semitones, high: 61 + semitones });
      const wallows = { ...shiftRange(WALLOWS, semitones), octaveFrom };
      expect(applyNarrowRule(wallows)).toEqual({ ...wallows, low: 54 + semitones, high: 59 + semitones, confidence: 'low' });
    });

    it('puts the new range in the stored octave when the histogram was left in the note file’s octave', () => {
      const file = noteFile(STRAY);
      const moved: SongRange = { ...shiftRange(file, -12), pitchShare: file.pitchShare, octaveFrom: 'recording' };
      expect(gentleRange(moved)).toEqual({ low: 40, high: 49, octaves: -1, gap: 3 });
      expect(applyNarrowRule(moved)).toMatchObject({ low: 40, high: 49, confidence: 'high' });
    });

    it('gives the same range whether or not the song was moved', () => {
      for (const stored of [noteFile(STRAY), WALLOWS]) {
        const there = applyNarrowRule(shiftRange(stored, 12));
        const back = applyNarrowRule(stored);
        expect(there).toEqual(shiftRange(back, 12));
      }
    });
  });

  it('never narrows a range, and leaves every narrow one either wide or low confidence (500 seeded histograms)', () => {
    let seed = 20261112;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    let narrow = 0;
    let widened = 0;
    for (let i = 0; i < 500; i++) {
      const base = 45 + Math.floor(next() * 25);
      const pitches = new Set<number>();
      const count = 2 + Math.floor(next() * 7);
      while (pitches.size < count) pitches.add(base + Math.floor(next() * 12));
      const weights = [...pitches].map((midi, j): [number, number] => [midi, j === 0 ? 4 + next() * 20 : next()]);
      const sum = weights.reduce((a, [, w]) => a + w, 0);
      const histogram = weights.map(([midi, w]): [number, number] => [midi, Math.round((w / sum) * 1000) / 1000]).sort((a, b) => a[0] - b[0]);
      const stored = noteFile(histogram);
      const out = applyNarrowRule(stored);
      expect(out.low).toBeLessThanOrEqual(stored.low);
      expect(out.high).toBeGreaterThanOrEqual(stored.high);
      if (isNarrow(stored)) {
        narrow++;
        if (out.high - out.low > NARROW_SPAN) widened++;
        expect(out.confidence).toBe(out.high - out.low > NARROW_SPAN ? 'high' : 'low');
      } else {
        expect(out).toBe(stored);
      }
      expect(applyNarrowRule(out)).toBe(out);
    }
    // The sweep reaches both outcomes.
    expect(widened).toBeGreaterThan(10);
    expect(narrow - widened).toBeGreaterThan(10);
  });
});

describe('songRangeFromUltrastar and narrow ranges (QWW-60)', () => {
  // One note after another, each [midi, beats], written as UltraStar pitches (midi 60 is pitch 0).
  const file = (notes: [number, number][]) => '#BPM:120\n' + notes.map(([midi, beats], i) => `: ${i * 1000} ${beats} ${midi - 60} la`).join('\n') + '\nE\n';

  it('measures a song sung on a few notes with the 1% trim, and keeps it confident when that is wider than 5 semitones', () => {
    // 15, 30, 500, 400, 30 and 25 beats on 52, 55, 56, 57, 58 and 61: the 5% trim gives 56 to 58, the 1% trim 52 to 61.
    const range = songRangeFromUltrastar(file([[52, 15], [55, 30], [56, 500], [57, 400], [58, 30], [61, 25]]));
    expect(range).toMatchObject({ low: 52, high: 61, confidence: 'high', source: 'note-file' });
  });

  it('marks a song that is still 5 semitones or fewer low confidence, so it lands in the Maybe group', () => {
    const range = songRangeFromUltrastar(file([[56, 900], [57, 100]]));
    expect(range).toMatchObject({ low: 56, high: 57, confidence: 'low' });
  });

  it('keeps the range in the corrected octave when the file was written an octave or more off', () => {
    // The same song written 2 octaves too high (typical note 80.5): range.ts moves it down until it is under C5, an octave
    // above where it was written here, and the histogram the 1% trim reads moves with it, so the widened range is in that octave too.
    const range = songRangeFromUltrastar(file([[52 + 24, 15], [55 + 24, 30], [56 + 24, 500], [57 + 24, 400], [58 + 24, 30], [61 + 24, 25]]));
    expect(range).toMatchObject({ low: 52 + 12, high: 61 + 12, confidence: 'high' });
    expect(range.pitchShare![0]![0]).toBe(range.low);
    expect(range.pitchShare!.at(-1)![0]).toBe(range.high);
  });

  it('leaves a duet as it is measured: the 5% trim, each part its own, and high confidence', () => {
    const duet = songRangeFromUltrastar(fixture('duet.txt'));
    expect(duet).toMatchObject({ low: 60, high: 62, confidence: 'high', duet: true });
    expect(duet.parts).toHaveLength(2);
  });
});
