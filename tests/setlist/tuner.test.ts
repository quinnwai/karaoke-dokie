// The tuner reducer against spec §4 and §4a, the sheet geometry against §3, and the request the tuner sends.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../src/lib/setlist/defaults';
import { eraOf, ERA_LABEL } from '../../src/lib/setlist/eras';
import { SHEET_GEARS, SHEET_PARTS } from '../../src/lib/setlist/gears';
import { modeAfterDrag, neonVars, RACK_FULL, RACK_MINI, sheetLayout } from '../../src/lib/setlist/sheet';
import { initialTuner, isOn, toRequest, tunerReducer } from '../../src/lib/setlist/tuner';
import type { TunerAction } from '../../src/lib/setlist/tuner';
import { GEAR_IDS, TUNER_PARTS, type EraId, type TunerState } from '../../src/lib/setlist/types';

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

// The sheet's stylesheet, read as text: vitest does not apply CSS Modules, so what a browser draws is tests/e2e/setlist-sheet.spec.ts's.
// These keep the decisions of the review of the 6A preview (QWW-57, 11 Nov) from being undone quietly.
describe('sheet.module.css (QWW-57: R5, R6, R8, R10)', () => {
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

  it('sets the four labels\' type by the strip body\'s width, from 6A\'s 11 px and 0.12em down to 9.5 px (R6)', () => {
    expect(rule('.stripBody')).toContain('container-type: inline-size;');
    // 6A's look is the base, and what a browser without container units keeps.
    expect(rule('.eyebrow')).toContain('font-size: 11px;');
    expect(rule('.eyebrow')).toContain('letter-spacing: 0.12em;');
    const labels = rule('.stripBody .eyebrow');
    expect(labels).toMatch(/font-size: clamp\(9\.5px, [^;]*100cqw[^;]*, 11px\);/);
    expect(labels).toMatch(/letter-spacing: clamp\(0px, [^;]*100cqw[^;]*, 0\.12em\);/);
    // The one case that cannot fit on a line wraps instead of being cut off.
    expect(labels).toContain('white-space: normal;');
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
