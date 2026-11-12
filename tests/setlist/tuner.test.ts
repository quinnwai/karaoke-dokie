// The tuner reducer against spec §4 and §4a, the sheet geometry against §3, and the request the tuner sends.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Match } from '../../src/lib/contracts';
import { DEFAULTS } from '../../src/lib/setlist/defaults';
import { eraOf, ERA_LABEL } from '../../src/lib/setlist/eras';
import { GEAR_META, SHEET_GEARS, SHEET_PARTS } from '../../src/lib/setlist/gears';
import { modeAfterDrag, neonVars, RACK_FULL, RACK_MINI, sheetLayout } from '../../src/lib/setlist/sheet';
import { initialTuner, isOn, toRequest, tunerReducer } from '../../src/lib/setlist/tuner';
import type { TunerAction } from '../../src/lib/setlist/tuner';
import { ERA_IDS, GEAR_IDS, TUNER_PARTS, type EraId, type GearId, type TunerState } from '../../src/lib/setlist/types';
import { mockPage } from '../fixtures/setlist';
import { setlistAnswer } from '../helpers/setlistServer';

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
    // Era on with nothing picked is only a state set by hand (the test hook, an old state), since unpicking the last era turns Era
    // off (R23): the engine answers it with "no-era-picked".
    const none = run(start, { type: 'patch', patch: { off: DEFAULTS.off.filter((part) => part !== 'era') } });
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

  // R23 (QWW-57) replaces round 5's spec §4a, "picked and empty means no songs": unpicking the last era turns Era off.
  it.each(ERA_IDS)('R23: %s picked and then unpicked is Era off with nothing picked, and Era still the open part', (era) => {
    const picked = run(start, { type: 'era', era });
    expect(isOn(picked, 'era')).toBe(true);
    const s = run(picked, { type: 'era', era });
    expect(s.eras).toEqual([]);
    expect(isOn(s, 'era')).toBe(false);
    expect(s.open).toBe('era');
    // Nothing else moved: it is first load's state, with Era the open part.
    expect(s).toEqual({ ...start, open: 'era' });
  });

  it('R23: only the last pick turns Era off: with two picked, taking one out leaves Era on with the other', () => {
    const two = run(start, { type: 'era', era: 's80' }, { type: 'era', era: 's90' });
    const one = run(two, { type: 'era', era: 's80' });
    expect(one.eras).toEqual(['s90']);
    expect(isOn(one, 'era')).toBe(true);
    expect(isOn(run(one, { type: 'era', era: 's90' }), 'era')).toBe(false);
  });

  it('R23: after that, a tap picks just that era and turns Era on again', () => {
    const off = run(start, { type: 'era', era: 's80' }, { type: 'era', era: 's80' });
    const again = run(off, { type: 'era', era: 's00' });
    expect(again.eras).toEqual(['s00']);
    expect(isOn(again, 'era')).toBe(true);
  });

  it('R23: unpicking the one pick Era holds while it is off leaves it off, listed off once', () => {
    const held: TunerState = { ...start, eras: ['s90'] };
    const s = run(held, { type: 'era', era: 's90' });
    expect(s.eras).toEqual([]);
    expect(isOn(s, 'era')).toBe(false);
    expect(s.off.filter((part) => part === 'era')).toHaveLength(1);
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

  it('R22: while Era is off the request names no era, whatever picks the state still holds, so no era filter applies', () => {
    const held: TunerState = { ...start, eras: ['s90', 's00', 's10'] };
    expect(isOn(held, 'era')).toBe(false);
    expect(toRequest(held, range).eras).toEqual([]);
    expect(toRequest(held, range).off).toContain('era');
    expect(toRequest(held, range)).toEqual(toRequest(start, range));
    // With Era on the picks go as they are.
    expect(toRequest({ ...held, off: [] }, range).eras).toEqual(['s90', 's00', 's10']);
  });
});

// R22 and R23 against the engine: the mocked server of the e2e specs ranks the 25 mock songs the way the real route does.
describe('Era off and the engine (R22, R23)', () => {
  const range = { low: 45, high: 72 };
  // The 25 mock songs and one with no year: Era off lists it, and every era filter leaves it out.
  const base = mockPage();
  const first = base.matches[0]!;
  const undated: Match = { ...first, year: undefined, track: { ...first.track, id: 'cat:no-year-song', title: 'No Year Song' } };
  const page = { ...base, matches: [...base.matches, undated] };
  const answer = (s: TunerState) => setlistAnswer(page, toRequest(s, range), false);
  const ids = (r: ReturnType<typeof answer>) => r.songs.map((song) => song.match.track.id);

  it('R22: with Era off the count is every song that fits and the list holds every one of them, a song with no year too', () => {
    const everything = answer(start);
    expect(everything.total).toBe(page.matches.length);
    expect(everything.total).toBe(26);
    expect(ids(everything)).toHaveLength(26);
    expect(ids(everything)).toContain('cat:no-year-song');
    expect(everything.empty).toBeUndefined();
    // Era on with all seven eras picked is not that: the song with no year has no era.
    const allSeven = answer({ ...start, eras: [...ERA_IDS], off: DEFAULTS.off.filter((part) => part !== 'era') });
    expect(allSeven.total).toBe(25);
    expect(ids(allSeven)).not.toContain('cat:no-year-song');
  });

  it('R22: the answer is the same whatever picks the state still holds while Era is off', () => {
    expect(answer({ ...start, eras: ['s80', 's20'] })).toEqual(answer(start));
  });

  it('R23: pick one era, then unpick it: Era is off and the list shows every era, as at first load', () => {
    const picked = run(start, { type: 'era', era: 's80' });
    expect(answer(picked).total).toBe(4);
    expect(ids(answer(picked))).not.toContain('cat:no-year-song');
    const unpicked = run(picked, { type: 'era', era: 's80' });
    expect(isOn(unpicked, 'era')).toBe(false);
    expect(answer(unpicked).empty).toBeUndefined();
    expect(answer(unpicked).total).toBe(26);
    expect(answer(unpicked)).toEqual(answer(start));
  });

  it('keeps the engine\'s answer for Era on with nothing picked, for a request that still asks it (the test hook, an old state)', () => {
    const none = run(start, { type: 'patch', patch: { off: DEFAULTS.off.filter((part) => part !== 'era') } });
    expect(answer(none)).toMatchObject({ songs: [], total: 0, empty: 'no-era-picked' });
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

// QWW-57, Quinn-Wai's decision 1 (11 Nov): where the expanded sheet cannot fit inside the screen at all, the handle keeps
// the sheet in mini. The screen measures that (src/lib/setlist/fit.ts) and tells the sheet as `canExpand`.
describe('sheet geometry when the sheet cannot expand', () => {
  const MINI_LAYOUT = { dragging: false, rackHeight: RACK_MINI, compact: true };

  it('stays at the mini rack and the compact layout, whether or not the tuner is in mini', () => {
    expect(sheetLayout(true, null, false)).toEqual(MINI_LAYOUT);
    // The full layout is never drawn: not even for a tuner that says expanded.
    expect(sheetLayout(false, null, false)).toEqual(MINI_LAYOUT);
  });

  it('an upward drag does not grow the rack, and does not leave the compact layout either', () => {
    expect(sheetLayout(true, -80, false)).toEqual({ dragging: true, rackHeight: RACK_MINI, compact: true });
    expect(sheetLayout(true, -9, false)).toEqual({ dragging: true, rackHeight: RACK_MINI, compact: true });
    expect(sheetLayout(true, -900, false).rackHeight).toBe(RACK_MINI);
    expect(sheetLayout(false, -900, false)).toEqual({ dragging: true, rackHeight: RACK_MINI, compact: true });
  });

  it('a drag down does not shrink it below the mini rack', () => {
    expect(sheetLayout(true, 40, false).rackHeight).toBe(RACK_MINI);
    expect(sheetLayout(false, 900, false).rackHeight).toBe(RACK_MINI);
  });

  it('the rack never exceeds RACK_MINI, whatever the drag', () => {
    for (const mini of [true, false]) {
      for (const dragY of [null, -900, -300, -80, -9, -1, 0, 1, 40, 80, 900]) {
        const { rackHeight, compact } = sheetLayout(mini, dragY, false);
        expect(rackHeight, `mini ${mini}, drag ${dragY}`).toBe(RACK_MINI);
        expect(compact, `mini ${mini}, drag ${dragY}`).toBe(true);
      }
    }
  });

  it('is the layout it always was when it can expand, and when nothing is said', () => {
    for (const mini of [true, false]) {
      for (const dragY of [null, -900, -80, -9, 0, 40, 900]) {
        expect(sheetLayout(mini, dragY, true), `mini ${mini}, drag ${dragY}`).toEqual(sheetLayout(mini, dragY));
      }
    }
    expect(sheetLayout(true, -80)).toEqual({ dragging: true, rackHeight: 244, compact: false });
    expect(sheetLayout(false, null)).toEqual({ dragging: false, rackHeight: RACK_FULL, compact: false });
  });
});

// Round 6A §5, §8, §9: how a part's lit colour reaches the sheet's CSS.
describe('neonVars', () => {
  it('is the colour, and the colour at 33% (glow) and 13% (inner glow) for the selected tab, as hex alphas', () => {
    expect(neonVars('#4FDDE8')).toEqual({
      '--sl-gear': '#4FDDE8',
      '--sl-gear-glow': '#4FDDE855',
      '--sl-gear-inner': '#4FDDE822',
    });
    // 0x55 = 85/255, 0x22 = 34/255.
    expect([0x55, 0x22].map((alpha) => Math.round((alpha / 255) * 100))).toEqual([33, 13]);
  });

  it('has no colour for a border: a strip\'s and the Era panel\'s is the rail\'s grey in every state, not the gear\'s at 27% (QWW-57, R5)', () => {
    expect(Object.keys(neonVars('#FFC24A'))).not.toContain('--sl-gear-line');
    expect(Object.values(neonVars('#FFC24A')).some((value) => value === '#FFC24A44')).toBe(false);
  });
});

// QWW-57, R11: the order the sheet draws the gears in is its own constant; the contract's order, which the server and the engine
// read, is left alone.
describe('the sheet\'s order of gears', () => {
  it('is Difficulty, Popularity, Tempo, then Listening History, and the tabs add Era', () => {
    expect(SHEET_GEARS).toEqual(['difficulty', 'popularity', 'tempo', 'history']);
    expect(SHEET_PARTS).toEqual(['difficulty', 'popularity', 'tempo', 'history', 'era']);
  });

  it('holds the same four gears as the contract, once each, so no gear can drop off the sheet', () => {
    expect(new Set(SHEET_GEARS).size).toBe(SHEET_GEARS.length);
    expect([...SHEET_GEARS].sort()).toEqual([...GEAR_IDS].sort());
    expect(new Set(SHEET_PARTS).size).toBe(SHEET_PARTS.length);
    expect([...SHEET_PARTS].sort()).toEqual([...TUNER_PARTS].sort());
  });

  it('leaves the contract\'s order alone, and mini still opens on the sheet\'s first gear, Difficulty', () => {
    expect([...GEAR_IDS]).toEqual(['difficulty', 'history', 'popularity', 'tempo']);
    expect([...TUNER_PARTS]).toEqual(['difficulty', 'history', 'popularity', 'tempo', 'era']);
    expect(DEFAULTS.open).toBe('difficulty');
    expect(SHEET_GEARS[0]).toBe(DEFAULTS.open);
    expect(SHEET_GEARS.at(-1)).toBe('history');
  });
});

// The sheet's stylesheet, read as text: vitest does not apply CSS Modules, so what a browser draws is tests/e2e/setlist-sheet.spec.ts's and
// setlist-sheet-fit.spec.ts's. These keep the decisions of the review of the 6A preview (QWW-57, 11 Nov), and the fits that the adversarial
// review of #38 asked for, from being undone quietly.
describe('sheet.module.css (QWW-57: R5, R6, R8, R10; the review of #38: findings 4, 7 and 8)', () => {
  const css = readFileSync(join(__dirname, '../../src/components/setlist/sheet.module.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** The declarations of the rule with exactly this selector, at the top level or inside an at-rule. */
  const rule = (selector: string) => new RegExp(`(?:^|[{}]) ?${escape(selector)} ?\\{([^{}]*)\\}`).exec(css)?.[1] ?? '';
  /** What is inside each `@media (hover: hover)` block, joined, and the stylesheet without them. */
  const hoverBlocks = [...css.matchAll(/@media \(hover: hover\) \{((?:[^{}]|\{[^{}]*\})*)\}/g)];
  const inHover = hoverBlocks.map((m) => m[1]).join(' ');
  const outsideHover = css.replace(/@media \(hover: hover\) \{(?:[^{}]|\{[^{}]*\})*\}/g, '');

  it('has no pink in the top border or the shadow of the sheet, and keeps the dark shadow (R8)', () => {
    const sheet = rule('.sheet');
    expect(sheet).toContain('border-top: 1px solid rgba(255, 255, 255, 0.06);');
    expect(sheet).toContain('box-shadow: 0 -10px 30px rgba(0, 0, 0, 0.55);');
    expect(sheet).not.toMatch(/255, ?79, ?160|ff4fa0/i);
  });

  it('draws a strip\'s and the Era panel\'s border in the rail\'s grey in every state, never in the gear\'s colour (R5)', () => {
    expect(rule('.strip')).toContain('border: 1px solid var(--sl-rail);');
    expect(rule('.eraPanel')).toContain('border: 1px solid var(--sl-rail);');
    expect(css).not.toContain('--sl-gear-line');
    // No state overrides it.
    expect(css).not.toMatch(/\.(strip|eraPanel)\[data-off\] ?\{[^}]*border/);
    // A tab's border is the rail's grey too, and only the selected one takes the gear's colour.
    expect(rule('.tab')).toContain('border: 1px solid var(--sl-rail);');
    expect(rule(".tab[aria-pressed='true']")).toContain('border-color: var(--sl-gear);');
  });

  it('gives an idle tab and an unpicked era button a hover border on pointer devices only, and no glow (R10)', () => {
    expect(hoverBlocks).toHaveLength(2);
    expect(inHover).toContain(".tab[aria-pressed='false']:hover { border-color: var(--sl-gear); }");
    expect(inHover).toContain(".eraButton[aria-pressed='false']:hover { border-color: var(--sl-pink); }");
    expect(inHover).not.toMatch(/shadow/);
    // Nothing outside (hover: hover) sets a border on hover, so a tap on a phone leaves nothing behind.
    expect(outsideHover).not.toMatch(/:hover ?\{[^}]*border/);
  });

  it('sets the four labels\' type by the strip body\'s width, from 6A\'s 11 px and 0.12em down to 9 px (R6)', () => {
    expect(rule('.stripBody')).toContain('container-type: inline-size;');
    // 6A's look is the base, and what a browser without container units keeps.
    expect(rule('.eyebrow')).toContain('font-size: 11px;');
    expect(rule('.eyebrow')).toContain('letter-spacing: 0.12em;');
    const labels = rule('.stripBody .eyebrow');
    expect(labels).toMatch(/font-size: clamp\(9px, [^;]*100cqw[^;]*, clamp\(9\.5px, [^;]*100cqw[^;]*, 11px\)\);/);
    expect(labels).toMatch(/letter-spacing: clamp\(0px, [^;]*100cqw[^;]*, 0\.12em\);/);
    // A body too narrow for any of it wraps the label instead of cutting it off.
    expect(labels).toContain('white-space: normal;');
  });

  // vitest has no layout, so the formulas are evaluated here, with the widths of the labels measured in Chromium in the Inter files the app ships
  // (700 for a strip's label, 600 for a tab's and an era button's). tests/e2e/setlist-sheet.spec.ts and setlist-sheet-fit.spec.ts check the real
  // thing, in a browser, at 360, 375, 390 and 412 px and in the desktop frame.
  /** The last value a rule gives a property: a second declaration is the one for a browser with container units. */
  const declared = (selector: string, property: string) => [...rule(selector).matchAll(new RegExp(`(?:^| )${property}: ([^;]+);`, 'g'))].map((m) => m[1]!).at(-1)!;
  /** A length made of clamp(), calc(), px and 100cqw (and em, of `em` px), with 100cqw as `cqw` px. */
  const length = (expr: string, cqw: number, em = 0) =>
    new Function('clamp', `return ${expr.replace(/100cqw/g, `${cqw}`).replace(/([\d.]+)em/g, `($1 * ${em})`).replace(/calc\(/g, '(').replace(/px/g, '')};`)(
      (min: number, value: number, max: number) => Math.min(Math.max(value, min), max),
    ) as number;

  it('keeps "LISTENING HISTORY" on one line from a strip body of 129 px (a mini strip at 360 px) up, 3 px to spare at the tightest, and 6A\'s look from 180 px (R6)', () => {
    const size = declared('.stripBody .eyebrow', 'font-size');
    const tracking = declared('.stripBody .eyebrow', 'letter-spacing');
    // The room the label has beside the reset button: its 44 px box, 8 px of it past the row's edge, and no gap before it.
    expect(rule('.resetButton')).toContain('width: 44px;');
    expect(rule('.resetButton')).toContain('margin: -8px -8px -4px 0;');
    expect(rule('.stripBody .gearHead')).toContain('gap: 0;');
    expect(rule('.gearHead')).toContain('gap: 8px;'); // the Era panel's header
    const BUTTON = 36;
    // Inter 700: "LISTENING HISTORY" is 10.0017 px per px of font size and 17 characters, " · OFF" after it 12.7535 and 23.
    let tightest = Infinity;
    for (let body = 129; body <= 260; body++) {
      const s = length(size, body);
      const t = length(tracking, body, s);
      expect(s, `a body of ${body} px`).toBeGreaterThanOrEqual(9);
      expect(s, `a body of ${body} px`).toBeLessThanOrEqual(11);
      tightest = Math.min(tightest, body - BUTTON - (10.0017 * s + 17 * t));
      // History off or disabled has no reset button, and the whole body.
      expect(body - (12.7535 * s + 23 * t), `"LISTENING HISTORY · OFF" in a body of ${body} px`).toBeGreaterThan(0);
    }
    expect(tightest).toBeGreaterThanOrEqual(2.9);
    expect(length(size, 129)).toBe(9);
    // 6A's own 11 px and 0.12em on an expanded strip at 390 px (a body of 180) and wider; nothing changed from a body of 134 px up.
    expect(length(size, 180)).toBe(11);
    expect(length(tracking, 180, 11)).toBeCloseTo(1.32, 5);
    for (let body = 134; body <= 260; body++) expect(length(size, body), `a body of ${body} px`).toBeCloseTo(Math.min(Math.max((body - 47) / 12.04, 9.5), 11), 5);
  });

  it('keeps every pair of end labels on one line from a strip body of 129 px up: Tempo\'s tighten 5.5 px apart below a body of 144 px, the others fit at 6A\'s 12 px', () => {
    // 6A's pairs, word for word. Their widths were measured for these words: change one and they must be measured again.
    const PAIRS: Record<GearId, [string, string]> = {
      difficulty: ['Light work', 'Locked in'],
      popularity: ['Deep cuts', 'Pop hits'],
      tempo: ['Slow jams', 'Upbeat tracks'],
      history: ['Rediscover', 'On repeat'],
    };
    for (const g of GEAR_IDS) expect([GEAR_META[g].left, GEAR_META[g].right], g).toEqual(PAIRS[g]);
    // Inter 500 at 12 px: each pair's width, in px. The three without a rule fit in the narrowest body, 129 px, with 8.5 px or more between the labels.
    const AT_12 = { difficulty: 115.594, popularity: 104.141, history: 120.438 };
    expect(rule('.ends')).toContain('font-size: 12px;');
    for (const g of ['difficulty', 'popularity', 'history'] as const) expect(129 - AT_12[g], g).toBeGreaterThanOrEqual(8.5);
    // Tempo's: 138.516 px at 12 px, which is 11.5416 px per px of font size over 22 characters (22 px of tracking per px of it).
    const tempo = ".strip[data-gear='tempo'] .ends";
    const size = declared(tempo, 'font-size');
    const tracking = declared(tempo, 'letter-spacing');
    expect(size).toMatch(/^clamp\(9px, [^;]*100cqw[^;]*, 12px\)$/);
    expect(tracking).toMatch(/^clamp\(-0\.03em, [^;]*100cqw[^;]*, 0px\)$/);
    for (let body = 129; body <= 260; body++) {
      const s = length(size, body);
      const t = length(tracking, body, s);
      expect(s, `a body of ${body} px`).toBeGreaterThanOrEqual(9);
      expect(s, `a body of ${body} px`).toBeLessThanOrEqual(12);
      expect(t, `a body of ${body} px`).toBeGreaterThanOrEqual(-0.03 * s - 1e-9);
      expect(t, `a body of ${body} px`).toBeLessThanOrEqual(0);
      // At 375 px in the mini sheet (a body of 144 px) the pair fits as it is, 5.5 px apart: the labels are never nearer than that.
      expect(body - (11.5416 * s + 22 * t), `Tempo's pair in a body of ${body} px`).toBeGreaterThanOrEqual(5.4);
    }
    // 6A's look from that body up, and the tracking before the size.
    for (let body = 144; body <= 260; body++) {
      expect(length(size, body), `a body of ${body} px`).toBe(12);
      expect(length(tracking, body, 12), `a body of ${body} px`).toBeCloseTo(0, 9);
    }
    expect(length(size, 137)).toBe(12);
    expect(length(tracking, 137, 12)).toBeLessThan(0);
    expect(length(size, 129)).toBeCloseTo(11.35, 2);
  });

  it('sets the tab labels\' type by the tab bar\'s width: 3 px clear each side of "Popularity" with 4% to spare, from 360 px, 11 px where that fits (finding 7)', () => {
    expect(rule('.tabs')).toContain('container-type: inline-size;');
    expect(rule('.tab')).toContain('font-size: 11px;'); // what a browser without container units keeps
    const size = declared('.tab', 'font-size');
    expect(size).toMatch(/^clamp\(9px, [^;]*100cqw[^;]*, 11px\)$/);
    // Inter 600 on a Mac: "Popularity" is 4.9474 px per px of font size. Linux (CI) sets it about 2.3% wider (49.00 px against 47.89 px at 9.68 px), which a fit with
    // nothing to spare failed, so the label is 4% wider here. A tab is a fifth of the bar less four gaps of 4 px, and clientWidth is the box inside its borders, rounded.
    for (let bar = 298; bar <= 400; bar += 0.5) {
      const s = length(size, bar);
      const client = Math.round((bar - 16) / 5 - 2);
      expect(s, `a bar of ${bar} px`).toBeGreaterThanOrEqual(9);
      expect(client - 4.9474 * 1.04 * s, `"Popularity" 4% wider than on a Mac, at ${s}px, in a tab of ${client} px (a bar of ${bar} px)`).toBeGreaterThanOrEqual(6);
    }
    expect(length(size, 350)).toBe(11); // a 412 px phone
    expect(length(size, 348)).toBe(11); // the desktop frame
  });

  it('sets the era labels\' type by the Era panel\'s width, not the window\'s, and on a phone it is what the window\'s formula gave (finding 8)', () => {
    expect(rule('.eraPanel')).toContain('container-type: inline-size;');
    expect(rule('.eraButton')).toContain('font-size: 9px;'); // what a browser without container units keeps
    const size = declared('.eraButton', 'font-size');
    expect(size).toMatch(/^clamp\(9px, [^;]*100cqw[^;]*, 10\.5px\)$/);
    // Nothing in the sheet follows the window, and the old custom property is gone.
    expect(css).not.toContain('100vw');
    expect(css).not.toContain('--sl-era-label-size');
    // A phone of width w has a panel whose content box is w - 78 px: its sizes were (w - 116) / 27.5 from 9 px to 10.5 px.
    for (let w = 340; w <= 460; w++) expect(length(size, w - 78), `a ${w} px phone`).toBeCloseTo(Math.min(Math.max((w - 116) / 27.5, 9), 10.5), 5);
    // Inter 600 with -0.03em: "Pre-’70s" is 3.8378 px per px of font size. A button is (content - 24 px of gaps) / 7 less its 1 px borders.
    for (let content = 282; content <= 332; content++) {
      const room = (content - 24) / 7 - 2;
      expect(room - 3.8378 * length(size, content), `a panel of ${content} px`).toBeGreaterThanOrEqual(0);
    }
    expect(length(size, 332)).toBe(10.5); // the desktop frame
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
