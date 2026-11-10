// The tuner reducer against spec §4 and §4a, the sheet geometry against §3, and the request the tuner sends.

import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../src/lib/setlist/defaults';
import { eraOf, ERA_LABEL } from '../../src/lib/setlist/eras';
import { modeAfterDrag, RACK_FULL, RACK_MINI, sheetLayout } from '../../src/lib/setlist/sheet';
import { initialTuner, isOn, toRequest, tunerReducer } from '../../src/lib/setlist/tuner';
import type { TunerAction } from '../../src/lib/setlist/tuner';
import { GEAR_IDS, type EraId, type TunerState } from '../../src/lib/setlist/types';

const run = (s: TunerState, ...actions: TunerAction[]) => actions.reduce(tunerReducer, s);
/** The tuner everyone starts from: it takes no sign-in state, the ranking engine decides what counts. */
const start = initialTuner();

describe('first load (spec §2, §11)', () => {
  it('starts every gear at its default value, with History, Tempo and Era off', () => {
    expect(start).toMatchObject({ difficulty: DEFAULTS.difficulty, history: DEFAULTS.history, popularity: DEFAULTS.popularity, tempo: DEFAULTS.tempo, mini: false });
    expect(start.eras).toEqual(DEFAULTS.eras);
    expect(start.off).toEqual(DEFAULTS.off);
    expect([...start.off].sort()).toEqual(['era', 'history', 'tempo']);
    // It is the same for a signed-in singer: initialTuner has no sign-in argument.
    expect(initialTuner({})).toEqual(start);
  });

  it('is the ranking decision QWW-47 posted: Difficulty 0, History 100, Popularity 100, Tempo 50, Era with no picks', () => {
    // The one place the numbers are written out, so a change of default is a visible decision. Every other test reads DEFAULTS.
    expect(DEFAULTS).toMatchObject({ difficulty: 0, history: 100, popularity: 100, tempo: 50, open: 'difficulty', mini: false });
    expect(DEFAULTS.eras).toEqual([]);
    expect(DEFAULTS.off).toEqual(['history', 'tempo', 'era']);
  });

  it('shows Difficulty first, the first gear that is on, to everyone', () => {
    expect(start.open).toBe(DEFAULTS.open);
    expect(start.open).toBe('difficulty');
  });

  it('can start in mini mode (?mini=1)', () => {
    expect(initialTuner({ mini: true }).mini).toBe(true);
    expect(initialTuner({ mini: false }).mini).toBe(false);
    // Nothing else changes with it.
    expect(initialTuner({ mini: true })).toEqual({ ...start, mini: true });
  });

  it('copies the defaults, so changing a state or tapping an era never changes them', () => {
    const s = initialTuner();
    s.eras.push('s80');
    s.off.push('difficulty');
    expect(DEFAULTS.eras).toEqual([]);
    expect(DEFAULTS.off).toEqual(['history', 'tempo', 'era']);
    expect(initialTuner()).toEqual(start);
    const tapped = run(start, { type: 'era', era: 's80' });
    expect(tapped.eras).toEqual(['s80']);
    expect(DEFAULTS.eras).toEqual([]);
  });

  it('keeps the defaults frozen, so nothing can change them by accident', () => {
    expect(Object.isFrozen(DEFAULTS)).toBe(true);
    expect(Object.isFrozen(DEFAULTS.eras)).toBe(true);
    expect(Object.isFrozen(DEFAULTS.off)).toBe(true);
  });
});

describe('sliders (spec §4)', () => {
  it('an input sets the value, turns the gear on and makes it the open gear', () => {
    const s = run(start, { type: 'input', gear: 'tempo', value: 90 });
    expect(s.tempo).toBe(90);
    expect(isOn(s, 'tempo')).toBe(true);
    expect(s.open).toBe('tempo');
    // The others are untouched.
    expect(s.difficulty).toBe(start.difficulty);
    expect(isOn(s, 'era')).toBe(false);
  });

  it('keeps values whole and inside 0 to 100', () => {
    expect(run(start, { type: 'input', gear: 'tempo', value: 54.6 }).tempo).toBe(55);
    expect(run(start, { type: 'input', gear: 'tempo', value: 140 }).tempo).toBe(100);
    expect(run(start, { type: 'input', gear: 'tempo', value: -3 }).tempo).toBe(0);
    expect(run(start, { type: 'input', gear: 'tempo', value: Number.NaN }).tempo).toBe(0);
  });

  it('a press on an off slider turns it on at the default value (a tap on the default fires no input)', () => {
    const s = run(start, { type: 'touch', gear: 'tempo' });
    expect(s.tempo).toBe(DEFAULTS.tempo);
    expect(isOn(s, 'tempo')).toBe(true);
    expect(s.open).toBe('tempo');
  });

  it('a press on an off History turns it on at its default too: the tuner does not know who is signed in', () => {
    const s = run(start, { type: 'touch', gear: 'history' });
    expect(s.history).toBe(DEFAULTS.history);
    expect(isOn(s, 'history')).toBe(true);
    expect(s.open).toBe('history');
  });

  it('a press on a slider that is on changes nothing', () => {
    const s = run(start, { type: 'input', gear: 'difficulty', value: 60 }, { type: 'input', gear: 'tempo', value: 70 });
    expect(run(s, { type: 'touch', gear: 'difficulty' })).toBe(s);
  });
});

describe('reset and the off state (spec §4a)', () => {
  it('Tempo 90, then reset: back to the default, off, still the open gear', () => {
    const s = run(start, { type: 'input', gear: 'tempo', value: 90 }, { type: 'reset', gear: 'tempo' });
    expect(s.tempo).toBe(DEFAULTS.tempo);
    expect(isOn(s, 'tempo')).toBe(false);
    expect(s.open).toBe('tempo');
  });

  it.each(GEAR_IDS)('%s: moved, then reset, is back at the value first load gave it, off, and the open gear', (gear) => {
    // First load and Reset read one DEFAULTS, so they cannot disagree (spec §11).
    const s = run(start, { type: 'input', gear, value: 77 }, { type: 'reset', gear });
    expect(s[gear]).toBe(start[gear]);
    expect(s[gear]).toBe(DEFAULTS[gear]);
    expect(isOn(s, gear)).toBe(false);
    expect(s.open).toBe(gear);
  });

  it('touching a reset gear again resumes from the default: ArrowRight on a reset Tempo gives the default + 1', () => {
    // The spec says 46 because its mock default is 45; the real default is DEFAULTS.tempo.
    const reset = run(start, { type: 'input', gear: 'tempo', value: 90 }, { type: 'reset', gear: 'tempo' });
    const s = run(reset, { type: 'input', gear: 'tempo', value: reset.tempo + 1 });
    expect(s.tempo).toBe(DEFAULTS.tempo + 1);
    expect(isOn(s, 'tempo')).toBe(true);
  });

  it('does not list a gear twice when it is reset twice', () => {
    const s = run(start, { type: 'reset', gear: 'tempo' }, { type: 'reset', gear: 'tempo' });
    expect(s.off.filter((g) => g === 'tempo')).toHaveLength(1);
  });

  it('Era: changed, then reset, goes back to the default picks and off', () => {
    const s = run(start, { type: 'era', era: 's80' }, { type: 'era', era: 's90' }, { type: 'reset', gear: 'era' });
    expect(s.eras).toEqual(DEFAULTS.eras);
    expect(isOn(s, 'era')).toBe(false);
    expect(s.open).toBe('era');
  });

  it('Era off is not the same as Era on with nothing picked: both hold no eras, and only the off list tells them apart', () => {
    const range = { low: 45, high: 72 };
    expect(start.eras).toEqual([]);
    expect(isOn(start, 'era')).toBe(false); // off: every era counts
    // Picked, then taken out by hand: Era stays on with nothing picked (the engine answers "no-era-picked").
    const none = run(start, { type: 'era', era: 's80' }, { type: 'era', era: 's80' });
    expect(none.eras).toEqual([]);
    expect(isOn(none, 'era')).toBe(true);
    // Reset puts it off again.
    const reset = run(none, { type: 'reset', gear: 'era' });
    expect(reset.eras).toEqual([]);
    expect(isOn(reset, 'era')).toBe(false);
    // The request keeps the two apart, which is all the engine has to go on.
    expect(toRequest(none, range)).toMatchObject({ eras: [] });
    expect(toRequest(none, range).off).not.toContain('era');
    expect(toRequest(reset, range).off).toContain('era');
  });
});

describe('era buttons (spec §4, test 17)', () => {
  it('with Era off, a tap picks the era on top of what the gear holds, and turns Era on: it holds none by default, so just that one', () => {
    const s = run(start, { type: 'era', era: 's80' });
    expect(s.eras).toEqual([...DEFAULTS.eras, 's80']);
    expect(s.eras).toEqual(['s80']);
    expect(isOn(s, 'era')).toBe(true);
    expect(s.open).toBe('era');
  });

  it('the tap applies to the picks Era holds while it is off (spec test 17): they stay and the tapped one joins', () => {
    // A state that holds parked picks, as the design's mock did: '80s joins '90s, '00s and '10s.
    const parked: TunerState = { ...start, eras: ['s90', 's00', 's10'] };
    expect(isOn(parked, 'era')).toBe(false);
    const s = run(parked, { type: 'era', era: 's80' });
    expect(s.eras).toEqual(['s90', 's00', 's10', 's80']);
    expect(isOn(s, 'era')).toBe(true);
  });

  it('a tap on a picked era removes it', () => {
    const s = run(start, { type: 'era', era: 's80' }, { type: 'era', era: 's90' }, { type: 'era', era: 's80' });
    expect(s.eras).toEqual(['s90']);
  });
});

describe('tabs and the handle', () => {
  it('a tab sets the open gear only', () => {
    const s = run(start, { type: 'open', gear: 'era' });
    expect(s.open).toBe('era');
    expect(s.off).toEqual(start.off);
  });

  it('sets the sheet mode', () => {
    expect(run(start, { type: 'mini', mini: true }).mini).toBe(true);
    expect(run(start, { type: 'mini', mini: true }, { type: 'mini', mini: false }).mini).toBe(false);
  });
});

describe('the request sent to the ranking engine', () => {
  const range = { low: 45, high: 72 };

  it('carries the range, every gear value, what is off and the picked eras, and nothing else', () => {
    const request = toRequest(start, range);
    expect(request).toEqual({
      range,
      gears: { difficulty: DEFAULTS.difficulty, history: DEFAULTS.history, popularity: DEFAULTS.popularity, tempo: DEFAULTS.tempo },
      off: [...DEFAULTS.off],
      eras: [...DEFAULTS.eras],
    });
    // No sign-in state (the engine knows who is signed in) and no page: the screen asks for the whole list.
    expect(Object.keys(request).sort()).toEqual(['eras', 'gears', 'off', 'range']);
  });

  it('carries only the notes of the range, not the rest of a VocalRange', () => {
    const request = toRequest(start, { low: 45, high: 72, source: 'test' } as { low: number; high: number });
    expect(request.range).toEqual({ low: 45, high: 72 });
  });

  it('sends the state as it is: History is not forced off, the engine decides what counts', () => {
    const on: TunerState = { ...start, off: [] };
    expect(toRequest(on, range).off).toEqual([]);
    const historyOn = run(start, { type: 'input', gear: 'history', value: 80 });
    expect(toRequest(historyOn, range).off).not.toContain('history');
    expect(toRequest(historyOn, range).gears.history).toBe(80);
  });

  it('lists the parts that are off in the order the state holds them, once each', () => {
    const s = run(start, { type: 'reset', gear: 'popularity' }, { type: 'reset', gear: 'difficulty' }, { type: 'reset', gear: 'popularity' });
    expect(toRequest(s, range).off).toEqual([...DEFAULTS.off, 'popularity', 'difficulty']);
  });

  it('hands over copies: changing the request never changes the state', () => {
    const s = run(start, { type: 'era', era: 's80' });
    const request = toRequest(s, range);
    request.off.push('difficulty');
    request.eras.push('s20');
    request.gears.tempo = 1;
    request.range.low = 1;
    expect(s.off).not.toContain('difficulty');
    expect(s.eras).toEqual(['s80']);
    expect(s.tempo).toBe(DEFAULTS.tempo);
    expect(range.low).toBe(45);
  });
});

describe('sheet geometry (spec §3)', () => {
  it('is 416 px expanded and 164 px mini, with the compact layout only in mini', () => {
    expect(sheetLayout(false, null)).toEqual({ dragging: false, rackHeight: RACK_FULL, compact: false });
    expect(sheetLayout(true, null)).toEqual({ dragging: false, rackHeight: RACK_MINI, compact: true });
    expect([RACK_FULL, RACK_MINI]).toEqual([416, 164]);
  });

  it('test 8: dragging up 80 px from mini grows the rack and leaves the compact layout at once', () => {
    expect(sheetLayout(true, -80)).toEqual({ dragging: true, rackHeight: 244, compact: false });
    // Just a nudge: the compact layout stays until the sheet has grown past 8 px.
    expect(sheetLayout(true, -8).compact).toBe(true);
    expect(sheetLayout(true, -9).compact).toBe(false);
  });

  it('never grows past the full rack or shrinks past the mini rack', () => {
    expect(sheetLayout(true, -900).rackHeight).toBe(RACK_FULL);
    expect(sheetLayout(false, 900).rackHeight).toBe(RACK_MINI);
    expect(sheetLayout(true, 40).rackHeight).toBe(RACK_MINI);
    expect(sheetLayout(false, -40).rackHeight).toBe(RACK_FULL);
  });

  it('test 9: from expanded, 30 px down stays expanded and 80 px down goes mini; from mini, 80 px up expands', () => {
    expect(modeAfterDrag(false, 30)).toBe(false);
    expect(modeAfterDrag(false, 80)).toBe(true);
    expect(modeAfterDrag(true, -80)).toBe(false);
    expect(modeAfterDrag(true, -30)).toBe(true);
    // Exactly the snap distance is not enough.
    expect(modeAfterDrag(false, 50)).toBe(false);
    expect(modeAfterDrag(true, -50)).toBe(true);
    // Pulling the wrong way changes nothing.
    expect(modeAfterDrag(false, -80)).toBe(false);
    expect(modeAfterDrag(true, 80)).toBe(true);
  });
});

describe('eras', () => {
  it('labels use the typographic apostrophe (U+2019)', () => {
    expect(ERA_LABEL.pre).toBe('Pre-’70s');
    expect(ERA_LABEL.s90).toBe('’90s');
    expect(ERA_LABEL.s90).toContain('’');
  });

  it('puts a release year in its era; no year, no era', () => {
    const era: EraId | null = eraOf(1959);
    expect(era).toBe('pre');
    expect(eraOf(1969)).toBe('pre');
    expect(eraOf(1970)).toBe('s70');
    expect(eraOf(1989)).toBe('s80');
    expect(eraOf(1999)).toBe('s90');
    expect(eraOf(2000)).toBe('s00');
    expect(eraOf(2019)).toBe('s10');
    expect(eraOf(2020)).toBe('s20');
    expect(eraOf(undefined)).toBeNull();
  });
});
