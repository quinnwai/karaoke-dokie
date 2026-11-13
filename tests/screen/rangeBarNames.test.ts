// The range chart's note names never run into each other and never run off the chart, on any phone from 360 px up (R25, QWW-57).
// A name is centred on its end unless the bar is too short for that (NAMES_APART): then the low name ends at its end and the high one
// starts at its. This is the model of that, in pixels, over many singers and songs; what a browser draws is tests/e2e/setlist-song.spec.ts's.
import { describe, expect, it } from 'vitest';
import { NAMES_APART, rangeBar, type Span } from '../../src/lib/client/display';
import type { OctaveShift, SongRange, VocalRange } from '../../src/lib/contracts';
import { sweepCases, type SweepCase } from '../songs/rangeBarFixture';

/**
 * How wide the chart's bar can be (the names' reference is the bar, which the chart's 34 px side padding frames):
 * 214 is a 360 px phone and 244 a 390 px one, 284 is a 430 px phone and 264 the phone-shaped TV on a desktop, and 199 is a 360 px desktop
 * window whose scrollbar takes 15 px. Nothing is drawn narrower, and a wider bar only makes more room.
 */
const BAR_PX = [199, 214, 244, 264, 284];
/** The widest note name at the chart's 11 px, in the widest of the fonts a page can fall back to: G#1 in Verdana and DejaVu Sans is 24.5 px (Arial 20.8, this Mac's system font 22.3). */
const NAME_PX = 25;
/** The chart's padding on each side of the bar, which a name may use. */
const SIDE_PX = 34;
/** Two names of one bar need to be at least this far apart; the model's worst case leaves 2.9 px. */
const GAP_PX = 2;

interface Box {
  from: number;
  to: number;
}

/** Where a span's two names are, in pixels from the start of the bar, as the page's CSS places them. */
function nameBoxes(span: Span, barPx: number): { low: Box; high: Box } {
  const lowAt = (span.left / 100) * barPx;
  const highAt = ((span.left + span.width) / 100) * barPx;
  if (span.width < NAMES_APART) return { low: { from: lowAt - NAME_PX, to: lowAt }, high: { from: highAt, to: highAt + NAME_PX } };
  return { low: { from: lowAt - NAME_PX / 2, to: lowAt + NAME_PX / 2 }, high: { from: highAt - NAME_PX / 2, to: highAt + NAME_PX / 2 } };
}

/** The same, if the names were always centred, which is what the chart drew when its names were only shown on a hover. */
function centredBoxes(span: Span, barPx: number): { low: Box; high: Box } {
  const lowAt = (span.left / 100) * barPx;
  const highAt = ((span.left + span.width) / 100) * barPx;
  return { low: { from: lowAt - NAME_PX / 2, to: lowAt + NAME_PX / 2 }, high: { from: highAt - NAME_PX / 2, to: highAt + NAME_PX / 2 } };
}

const song = (low: number, high: number): SongRange => ({ low, high, tessitura: (low + high) / 2, source: 'note-file', confidence: 'high', fastLyrics: false });
const user = (low: number, high: number): VocalRange => ({ low, high, source: 'test' });

/** The singers and songs of the sweep, plus the ones the check on a phone asks about: a narrow song, and ends right next to the singer's ends. */
function cases(): SweepCase[] {
  const A2_C5 = user(45, 72);
  const hand: [string, VocalRange, SongRange, OctaveShift][] = [
    ['a song of 2 semitones in the middle', A2_C5, song(58, 60), 'none'],
    ['a song of 3 semitones', A2_C5, song(60, 63), 'none'],
    ['a song of 4 semitones at the top of the range', A2_C5, song(68, 72), 'none'],
    ['a song of 2 semitones at the bottom of the range', A2_C5, song(45, 47), 'none'],
    ['ends one semitone inside the singer’s ends', A2_C5, song(46, 71), 'none'],
    ['ends the same as the singer’s ends', A2_C5, song(45, 72), 'none'],
    ['ends one semitone past the singer’s ends', A2_C5, song(44, 73), 'none'],
    ['a song of 3 semitones that is sung an octave down', A2_C5, song(72, 75), 'down'],
    ['a singer with 5 semitones and a song around them', user(60, 65), song(55, 70), 'none'],
    ['a singer with 4 semitones and a song of the same ends', user(60, 64), song(60, 64), 'none'],
  ];
  return [...sweepCases(), ...hand.map(([label, u, s, octave]) => ({ label, user: u, song: s, octave }))];
}

describe('the chart’s note names (R25)', () => {
  it('have room: a bar’s two names are never closer than GAP_PX, whatever its width, on any bar the chart can have', () => {
    for (const { label, user: u, song: s, octave } of cases()) {
      const bar = rangeBar(u, s, octave);
      for (const [which, span] of [['song', bar.song], ['user', bar.user]] as const) {
        for (const barPx of BAR_PX) {
          const { low, high } = nameBoxes(span, barPx);
          expect(high.from - low.to, `${label}: the ${which}'s names at ${barPx} px`).toBeGreaterThanOrEqual(GAP_PX);
        }
      }
    }
  });

  it('stay inside the chart: no name reaches past the padding the chart keeps on each side of its bar', () => {
    for (const { label, user: u, song: s, octave } of cases()) {
      const bar = rangeBar(u, s, octave);
      for (const [which, span] of [['song', bar.song], ['user', bar.user]] as const) {
        for (const barPx of BAR_PX) {
          const { low, high } = nameBoxes(span, barPx);
          expect(low.from, `${label}: the ${which}'s low name at ${barPx} px`).toBeGreaterThanOrEqual(-SIDE_PX);
          expect(high.to, `${label}: the ${which}'s high name at ${barPx} px`).toBeLessThanOrEqual(barPx + SIDE_PX);
        }
      }
    }
  });

  it('needed the rule: the same cases, with every name centred, ran into each other (so these cases test something)', () => {
    let touching = 0;
    for (const { user: u, song: s, octave } of cases()) {
      const bar = rangeBar(u, s, octave);
      for (const span of [bar.song, bar.user]) {
        const { low, high } = centredBoxes(span, 214);
        if (high.from - low.to < GAP_PX) touching++;
      }
    }
    expect(touching).toBeGreaterThan(5);
  });

  it('only move out for a bar that needs it: a bar of NAMES_APART percent or more keeps its names centred', () => {
    const wide = rangeBar(user(45, 72), song(50, 64), 'none'); // 14 of 31 semitones
    expect(wide.song.width).toBeGreaterThanOrEqual(NAMES_APART);
    expect(nameBoxes(wide.song, 214)).toEqual(centredBoxes(wide.song, 214));
    const narrow = rangeBar(user(45, 72), song(60, 63), 'none'); // 3 of 31
    expect(narrow.song.width).toBeLessThan(NAMES_APART);
    expect(nameBoxes(narrow.song, 214)).not.toEqual(centredBoxes(narrow.song, 214));
  });

  it('keep a limit that leaves a name its room even on the narrowest bar: NAMES_APART percent of 199 px is a name’s width and a gap', () => {
    expect((NAMES_APART / 100) * 199).toBeGreaterThanOrEqual(NAME_PX + GAP_PX);
  });
});
