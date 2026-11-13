// @vitest-environment jsdom
// The Setlist screen's DOM contract (QWW-46; spec §3, §4, §4a, §8 and §9): what the sheet draws in each mode, the handle
// and its drag, the gear strips and their reset buttons, the Era panel, the ranked list, the loading and empty states,
// and the `window.setlist` test hook. The screen holds no ranking, so each test hands it the songs a ranking engine
// returned and checks what it draws and which callbacks it makes. jsdom applies no CSS, so layout, drag feel and
// animation are tests/e2e's, not these.
import { cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { useReducer, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetlistScreen, type SetlistScreenProps } from '../../src/components/setlist/SetlistScreen';
import { Sheet } from '../../src/components/setlist/Sheet';
import type { Match, ResultsMode } from '../../src/lib/contracts';
import { resetFlickerSession } from '../../src/lib/setlist/art';
import { DEFAULTS } from '../../src/lib/setlist/defaults';
import { SHEET_GEARS, SHEET_PARTS } from '../../src/lib/setlist/gears';
import { initialTuner, tunerReducer, type TunerAction } from '../../src/lib/setlist/tuner';
import { GEAR_IDS, TUNER_PARTS, type EmptyReason, type EraId, type GearId, type SetlistSong, type TunerState } from '../../src/lib/setlist/types';
import { fader, faderPointer, faderX } from '../helpers/fader';
import { all, el, RANGE, rankedSong, rowIds, SEL, setlistProps } from '../helpers/setlist';

// Every test is a page's first load as far as the strips' turn-on flicker goes (it plays once per page).
beforeEach(resetFlickerSession);
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  delete (window as unknown as { setlist?: unknown }).setlist;
});

// ---- helpers ----

type Overrides = Partial<Omit<SetlistScreenProps, 'onTuner' | 'onGearDone' | 'onSelect' | 'onMore' | 'onRetry'>>;

/** The tuner every singer starts from (QWW-47's defaults: History, Tempo and Era off, no era picked), with some of it changed. */
const tunerOf = (over: Partial<TunerState> = {}): TunerState => ({ ...initialTuner(), ...over });

/** A signed-in singer: the library's songs, so History can be used (it still starts off, as it does for everyone). */
const signedIn = (over: Partial<TunerState> = {}): Overrides => ({ mode: 'library', tuner: tunerOf(over) });

/** The first argument of each call a mock got. */
const calls = (fn: { mock: { calls: unknown[][] } }): unknown[] => fn.mock.calls.map(([first]) => first);

/**
 * The screen with the callbacks that matter recorded. With no overrides it is a signed-out singer's screen: catalogue
 * mode, the tuner every singer starts from (History, Tempo and Era off), the sheet expanded.
 */
function draw(songs: SetlistSong[] | null = [rankedSong('a')], overrides: Overrides = {}) {
  const onTuner = vi.fn<(action: TunerAction) => void>();
  const onGearDone = vi.fn<(gear: GearId) => void>();
  const onSelect = vi.fn<(trackId: string, position: number) => void>();
  const onMore = vi.fn<() => void>();
  const onRetry = vi.fn<() => void>();
  const props = setlistProps(RANGE, songs, { ...overrides, onTuner, onGearDone, onSelect, onMore, onRetry });
  const view = render(<SetlistScreen {...props} />);
  /** Draws it again with some props changed. */
  const update = (next: Overrides & { songs?: SetlistSong[] | null }) => view.rerender(<SetlistScreen {...props} {...next} />);
  return { ...view, onTuner, onGearDone, onSelect, onMore, onRetry, update };
}

/**
 * The screen with the real tuner reducer behind it, for what depends on the props changing as a result: a reset
 * button that hides itself, the focus that moves, a gear that turns on.
 */
function Tuned(props: { initial: TunerState; mode?: ResultsMode; onTuner?(action: TunerAction): void; onGearDone?(gear: GearId): void }) {
  const [tuner, dispatch] = useReducer(tunerReducer, props.initial);
  return (
    <SetlistScreen
      {...setlistProps(RANGE, [rankedSong('a')], {
        mode: props.mode ?? 'library',
        tuner,
        onTuner: (action) => {
          props.onTuner?.(action);
          dispatch(action);
        },
        onGearDone: (gear) => props.onGearDone?.(gear),
      })}
    />
  );
}

/**
 * jsdom has no PointerEvent, so each one is a plain Event that carries by hand the pointer's clientY and the mouse button.
 * A plain event has no button at all, which the strip counts as the primary one.
 */
function pointer(type: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel', target: Element, clientY?: number, button?: number): void {
  const event = createEvent[type](target);
  if (clientY !== undefined) Object.defineProperty(event, 'clientY', { value: clientY });
  if (button !== undefined) Object.defineProperty(event, 'button', { value: button });
  fireEvent(target, event);
}

const hidden = (selector: string) => el(selector).hasAttribute('hidden');

// ---- the screen ----

describe('the screen', () => {
  it('is headed "Tune your setlist", and draws no TV frame of its own (the TV is KaraokeApp\'s, around every step)', () => {
    draw();
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings.map((h) => h.textContent)).toEqual(['Tune your setlist']);
    expect(el(SEL.app).contains(headings[0]!)).toBe(true);
    expect(screen.queryByRole('region', { name: 'Karaoke screen' })).toBeNull();
  });

  it.each([
    { mini: false, mode: 'expanded' },
    { mini: true, mode: 'mini' },
  ])('data-mode follows the sheet mode (mini is $mini)', ({ mini, mode }) => {
    draw([rankedSong('a')], { tuner: tunerOf({ mini }) });
    expect(el(SEL.app).dataset.mode).toBe(mode);
  });

  it.each(TUNER_PARTS)('data-open names the open gear (%s)', (open) => {
    draw([rankedSong('a')], { tuner: tunerOf({ open }) });
    expect(el(SEL.app).dataset.open).toBe(open);
  });

  it('starts expanded with Difficulty open, for a singer who has set nothing', () => {
    draw();
    expect(el(SEL.app).dataset.mode).toBe('expanded');
    expect(el(SEL.app).dataset.open).toBe('difficulty');
  });

  it('asks for nothing on its own', () => {
    const { onTuner, onGearDone, onSelect, onMore, onRetry } = draw();
    for (const fn of [onTuner, onGearDone, onSelect, onMore, onRetry]) expect(fn).not.toHaveBeenCalled();
  });
});

// ---- the sheet ----

describe('what the sheet draws', () => {
  const gearsDrawn = () => GEAR_IDS.filter((g) => !hidden(SEL.strip(g)));
  const compact = () => el(SEL.sheet).hasAttribute('data-compact');

  it('expanded: every gear and Era, no tab bar, and not the compact layout', () => {
    draw([rankedSong('a')], { tuner: tunerOf({ mini: false }) });
    expect(hidden(SEL.strips)).toBe(false);
    expect(gearsDrawn()).toEqual([...GEAR_IDS]);
    expect(hidden(SEL.eraPanel)).toBe(false);
    expect(hidden(SEL.tabs)).toBe(true);
    expect(compact()).toBe(false);
  });

  it.each(TUNER_PARTS)('expanded ignores which gear is open (%s)', (open) => {
    draw([rankedSong('a')], { tuner: tunerOf({ mini: false, open }) });
    expect(gearsDrawn()).toEqual([...GEAR_IDS]);
    expect(hidden(SEL.eraPanel)).toBe(false);
    expect(hidden(SEL.tabs)).toBe(true);
  });

  it.each(GEAR_IDS)('mini with %s open: only that gear, the tab bar, no Era panel', (open) => {
    draw([rankedSong('a')], { tuner: tunerOf({ mini: true, open }) });
    expect(compact()).toBe(true);
    expect(hidden(SEL.strips)).toBe(false);
    expect(gearsDrawn()).toEqual([open]);
    expect(hidden(SEL.eraPanel)).toBe(true);
    expect(hidden(SEL.tabs)).toBe(false);
  });

  it('mini with Era open: the Era panel and the tab bar, no gear strips', () => {
    draw([rankedSong('a')], { tuner: tunerOf({ mini: true, open: 'era' }) });
    expect(compact()).toBe(true);
    expect(hidden(SEL.strips)).toBe(true);
    expect(gearsDrawn()).toEqual([]);
    expect(hidden(SEL.eraPanel)).toBe(false);
    expect(hidden(SEL.tabs)).toBe(false);
  });

  it.each([
    ['signed out', {}],
    ['signed in', { mode: 'library' }],
  ] as const)('mini with the tuner every singer starts from opens on Difficulty, %s', (_who, over) => {
    draw([rankedSong('a')], { ...over, tuner: initialTuner({ mini: true }) });
    expect(el(SEL.app).dataset.open).toBe('difficulty');
    expect(gearsDrawn()).toEqual(['difficulty']);
    expect(hidden(SEL.eraPanel)).toBe(true);
    expect(hidden(SEL.tabs)).toBe(false);
  });

  // QWW-57, R11: Listening History needs unlocking, so it goes last of the four; the contract's order is the server's, not the sheet's.
  it('draws the strips as Difficulty, Popularity, Tempo, then Listening History, and the tabs as those four and then Era', () => {
    draw();
    expect(all('[data-strip]').map((strip) => strip.dataset.gear)).toEqual(['difficulty', 'popularity', 'tempo', 'history']);
    expect(all(`${SEL.tabs} [data-tab]`).map((tab) => tab.dataset.gear)).toEqual(['difficulty', 'popularity', 'tempo', 'history', 'era']);
    expect(all('[data-strip]').map((strip) => strip.dataset.gear)).toEqual([...SHEET_GEARS]);
    expect(all(`${SEL.tabs} [data-tab]`).map((tab) => tab.dataset.gear)).toEqual([...SHEET_PARTS]);
    // The strips are in the strips' box, the Era panel after it, then the tab bar: the order a screen reader and the Tab key follow.
    const order = all('#strips, #era-panel, #tabs').map((part) => part.id);
    expect(order).toEqual(['strips', 'era-panel', 'tabs']);
  });

  it('keeps the sheet\'s order in mini too, and mini still opens on Difficulty, the first strip and the first tab', () => {
    draw([rankedSong('a')], { tuner: initialTuner({ mini: true }) });
    expect(all(`${SEL.tabs} [data-tab]`).map((tab) => tab.dataset.gear)).toEqual([...SHEET_PARTS]);
    expect(all('[data-strip]').map((strip) => strip.dataset.gear)).toEqual([...SHEET_GEARS]);
    expect(el(SEL.app).dataset.open).toBe('difficulty');
    expect(SHEET_GEARS[0]).toBe('difficulty');
    expect(all(`${SEL.tabs} [data-tab]`)[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(gearsDrawn()).toEqual(['difficulty']);
  });

  it('is a region of its own that holds the handle, the rack and the tab bar', () => {
    draw();
    const sheet = screen.getByRole('region', { name: 'Setlist controls' });
    expect(sheet).toBe(el(SEL.sheet));
    for (const part of [SEL.handle, SEL.rack, SEL.tabs, SEL.eraPanel]) expect(sheet.contains(el(part))).toBe(true);
    expect(el(SEL.rack).contains(el(SEL.strips))).toBe(true);
  });
});

describe('the tab bar', () => {
  const mini = (over: Partial<TunerState> = {}, overrides: Overrides = {}) =>
    draw([rankedSong('a')], { tuner: tunerOf({ mini: true, ...over }), ...overrides });
  const offTabs = () => TUNER_PARTS.filter((g) => el(SEL.tab(g)).hasAttribute('data-off'));

  it('has a tab for each gear and for Era, in sheet order (History after Tempo, R11)', () => {
    mini();
    expect(all(`${SEL.tabs} [data-tab]`).map((t) => t.dataset.gear)).toEqual(['difficulty', 'popularity', 'tempo', 'history', 'era']);
    expect(el(SEL.tabs).getAttribute('role')).toBe('group');
  });

  it.each(TUNER_PARTS)('presses only the tab of the open gear (%s)', (open) => {
    mini({ open });
    expect(TUNER_PARTS.filter((g) => el(SEL.tab(g)).getAttribute('aria-pressed') === 'true')).toEqual([open]);
    expect(TUNER_PARTS.filter((g) => el(SEL.tab(g)).getAttribute('aria-pressed') === 'false')).toHaveLength(TUNER_PARTS.length - 1);
  });

  it('marks the gears that are off, which for a singer who has set nothing are the ones the defaults start off', () => {
    mini({}, { mode: 'library' });
    expect(offTabs()).toEqual(TUNER_PARTS.filter((part) => DEFAULTS.off.includes(part)));
    // With QWW-47's defaults that is History, Tempo and Era, for a signed-in singer too.
    expect(offTabs()).toEqual(['history', 'tempo', 'era']);
  });

  it('does not mark a gear that has been switched on', () => {
    mini({ off: ['tempo'] }, { mode: 'library' });
    expect(offTabs()).toEqual(['tempo']);
  });

  it('marks History as off before Spotify is connected, whatever the tuner says', () => {
    // A tuner with History switched on, on the catalogue's songs.
    mini({ off: ['tempo', 'era'] }, { mode: 'catalogue' });
    expect(offTabs()).toEqual(['history', 'tempo', 'era']);
  });

  it.each(TUNER_PARTS)('a tap on the %s tab opens that gear', (gear) => {
    const { onTuner } = mini();
    fireEvent.click(el(SEL.tab(gear)));
    expect(calls(onTuner)).toEqual([{ type: 'open', gear }]);
  });

  // Round 6A §9 and test 32: an English label under each icon, never Japanese.
  it('labels each tab in English only', () => {
    mini();
    const labels = all(`${SEL.tabs} [data-tab]`).map((t) => t.textContent ?? '');
    expect(labels).toEqual(['Difficulty', 'Popularity', 'Tempo', 'History', 'Era']);
    for (const label of labels) expect(label).not.toMatch(/[぀-ヿ㐀-鿿]/);
  });

  // jsdom applies no CSS, so the selected tab's look (border, glow, label colour) is checked where it is decided: the
  // colour each tab hands its stylesheet, and the alphas the design draws it at (§9: glow 33%, inner glow 13%).
  const lit = (part: (typeof TUNER_PARTS)[number], name = '--sl-gear') => el(SEL.tab(part)).style.getPropertyValue(name);

  it('hands each tab its gear\'s lit colour: Difficulty by its tier, the others fixed (§3.1)', () => {
    mini({ difficulty: 50 });
    expect(TUNER_PARTS.map((part) => lit(part))).toEqual(['#FFC24A', '#4FDDE8', '#FFC24A', '#B583FF', '#FF4FA0']);
  });

  it.each([
    [0, '#4DE89A'],
    [33, '#4DE89A'],
    [34, '#FFC24A'],
    [66, '#FFC24A'],
    [67, '#FF5A8A'],
    [100, '#FF5A8A'],
  ])('Difficulty at %i lights its tab in %s, with the same 34 and 67 cut-offs as the strip', (difficulty, colour) => {
    mini({ difficulty });
    expect(lit('difficulty')).toBe(colour);
    expect(lit('difficulty', '--sl-gear-glow')).toBe(`${colour}55`);
    expect(lit('difficulty', '--sl-gear-inner')).toBe(`${colour}22`);
  });

  // README §7: a lit tab's icon glows (drop-shadow 0 0 3px, its colour); an off tab's is unlit, with no glow. The tab tells
  // its art whether its gear is off, History before Spotify is connected and the Era tab included.
  it('tells each tab\'s art whether its gear is off: an off tab\'s icon has no glow', () => {
    mini({ off: ['tempo', 'era'] }, { mode: 'catalogue' });
    // A lit tab glows: a 3 px drop-shadow on its svg (Difficulty, Tempo, Era), or a filter on a group inside it (History and Popularity,
    // which glow only what is lit, QWW-57 R7). An off tab has neither.
    const svg = (part: (typeof TUNER_PARTS)[number]) => el('svg', el(SEL.tab(part)));
    const glows = (part: (typeof TUNER_PARTS)[number]) =>
      /^drop-shadow\(0 0 3px #[0-9A-F]{6}\)$/.test(svg(part).style.filter) || svg(part).querySelector('g[filter]') !== null;
    expect(offTabs()).toEqual(['history', 'tempo', 'era']);
    expect(TUNER_PARTS.filter((part) => !glows(part))).toEqual(offTabs());
  });

  it('keeps an off tab\'s colour too: a selected tab shows its gear\'s colour on or off, and only the icon goes unlit (§7)', () => {
    mini({ open: 'tempo', off: ['tempo', 'era'] });
    expect(offTabs()).toContain('tempo');
    expect(lit('tempo')).toBe('#B583FF');
    expect(el(SEL.tab('tempo')).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('the handle', () => {
  it('is a real button, so Enter and Space work on it without code of ours', () => {
    // jsdom does not turn a keydown into a click, so the keys themselves are for the browser tests.
    draw();
    const handle = el(SEL.handle);
    expect(handle.tagName).toBe('BUTTON');
    expect(handle.getAttribute('type')).toBe('button');
    expect(screen.getByRole('button', { name: 'Show one gear' })).toBe(handle);
  });

  it.each([
    [false, 'true', 'Show one gear'],
    [true, 'false', 'Show all gears'],
  ] as const)('with mini %s: aria-expanded %s, named %s, and it controls the rack', (mini, expanded, label) => {
    draw([rankedSong('a')], { tuner: tunerOf({ mini }) });
    const handle = el(SEL.handle);
    expect(handle.getAttribute('aria-expanded')).toBe(expanded);
    expect(handle.getAttribute('aria-label')).toBe(label);
    expect(handle.getAttribute('aria-controls')).toBe('rack');
    expect(document.getElementById('rack')).toBe(el(SEL.rack));
  });

  it.each([false, true])('a click asks for the other mode (mini is %s)', (mini) => {
    const { onTuner } = draw([rankedSong('a')], { tuner: tunerOf({ mini }) });
    fireEvent.click(el(SEL.handle));
    expect(calls(onTuner)).toEqual([{ type: 'mini', mini: !mini }]);
  });

  // The gate on 1ee41b4: the handle's box reaches 11 px into the first strip, and Chromium hands a touch near it (a big finger's, in the blank part of the strip's title
  // row) to it. By where the finger is, only a press on the handle's own box is the handle's. jsdom lays nothing out, so the handle is given a box.
  describe('a press that was not on its box', () => {
    const boxed = () => {
      const handle = el(SEL.handle);
      handle.getBoundingClientRect = () => new DOMRect(100, 0, 140, 44);
      return handle;
    };
    /** A press, then the click a touch browser ends it in, as a finger makes it (`detail` 1). */
    const tap = (target: Element, at: { x: number; y: number }) => {
      for (const type of ['pointerDown', 'pointerUp'] as const) {
        const event = createEvent[type](target);
        Object.defineProperty(event, 'clientX', { value: at.x });
        Object.defineProperty(event, 'clientY', { value: at.y });
        fireEvent(target, event);
      }
      fireEvent.click(target, { detail: 1 });
    };

    it('does not fold or open the sheet: the browser named the handle, the finger was in the strip below it', () => {
      const { onTuner } = draw();
      tap(boxed(), { x: 260, y: 60 });
      expect(onTuner).not.toHaveBeenCalled();
    });

    it('does not start a drag either', () => {
      const { onTuner } = draw();
      const handle = boxed();
      for (const [type, y] of [['pointerDown', 60], ['pointerMove', 160], ['pointerUp', 160]] as const) {
        const event = createEvent[type](handle);
        Object.defineProperty(event, 'clientX', { value: 260 });
        Object.defineProperty(event, 'clientY', { value: y });
        fireEvent(handle, event);
      }
      expect(onTuner).not.toHaveBeenCalled();
    });

    it('is a press on its box all the same: a tap there folds the sheet, and a key or a screen reader\'s click (detail 0) always does', () => {
      const { onTuner } = draw();
      tap(boxed(), { x: 170, y: 20 });
      expect(calls(onTuner)).toEqual([{ type: 'mini', mini: true }]);
      fireEvent.click(el(SEL.handle));
      expect(calls(onTuner)).toEqual([
        { type: 'mini', mini: true },
        { type: 'mini', mini: true },
      ]);
    });
  });

  it('is not disabled while the sheet can expand', () => {
    draw();
    expect(el(SEL.handle).hasAttribute('aria-disabled')).toBe(false);
  });
});

describe('dragging the handle', () => {
  const rackHeight = () => el(SEL.rack).style.height;
  const compact = () => el(SEL.sheet).hasAttribute('data-compact');
  const dragging = () => el(SEL.rack).hasAttribute('data-dragging');
  /** The sheet mode the gesture ended up asking for: its last `mini` action, or the mode it began in when it asked for none. */
  const modeAsked = (onTuner: { mock: { calls: unknown[][] } }, began: boolean): boolean => {
    const asked = calls(onTuner).filter((a): a is { type: 'mini'; mini: boolean } => (a as TunerAction).type === 'mini');
    return asked.length > 0 ? asked[asked.length - 1]!.mini : began;
  };

  it('from mini, an upward drag grows the rack at once and draws the full layout while it goes', () => {
    const { onTuner } = draw([rankedSong('a')], { tuner: tunerOf({ mini: true }) });
    const handle = el(SEL.handle);
    expect(rackHeight()).toBe('164px');
    expect(compact()).toBe(true);

    pointer('pointerDown', handle, 300);
    pointer('pointerMove', handle, 220);
    expect(rackHeight()).toBe('244px');
    expect(dragging()).toBe(true);
    expect(compact()).toBe(false);
    expect(GEAR_IDS.every((g) => !hidden(SEL.strip(g)))).toBe(true);
    expect(hidden(SEL.eraPanel)).toBe(false);
    expect(hidden(SEL.tabs)).toBe(true);
    // Nothing is decided until the pointer is let go.
    expect(onTuner).not.toHaveBeenCalled();

    pointer('pointerUp', handle, 220);
    expect(calls(onTuner)).toEqual([{ type: 'mini', mini: false }]);
    expect(dragging()).toBe(false);
    // The mode is the tuner's: with the prop unchanged the rack goes back to where it was.
    expect(rackHeight()).toBe('164px');
  });

  it('swallows the click a drag ends in, and only that one: the first Enter or screen reader\'s activation after a touch drag, which has no click of its own, toggles (the gate on 4e324f5)', async () => {
    const { onTuner } = draw([rankedSong('a')], { tuner: tunerOf({ mini: true }) });
    const handle = el(SEL.handle);
    pointer('pointerDown', handle, 300);
    pointer('pointerMove', handle, 220);
    pointer('pointerUp', handle, 220);
    expect(onTuner).toHaveBeenCalledTimes(1); // the drag's own
    // No click came (a finger's drag has none), a moment later the key does:
    await new Promise((resolve) => setTimeout(resolve, 5));
    fireEvent.click(handle, { detail: 0 });
    expect(onTuner).toHaveBeenCalledTimes(2);
  });

  it('swallows the click that follows a drag, once', () => {
    const { onTuner } = draw([rankedSong('a')], { tuner: tunerOf({ mini: true }) });
    const handle = el(SEL.handle);
    pointer('pointerDown', handle, 300);
    pointer('pointerMove', handle, 220);
    pointer('pointerUp', handle, 220);
    fireEvent.click(handle);
    expect(onTuner).toHaveBeenCalledTimes(1);
    // The next real tap toggles as usual.
    fireEvent.click(handle);
    expect(onTuner).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['expanded', false, 30, false],
    ['expanded', false, 80, true],
    ['mini', true, -30, true],
    ['mini', true, -80, false],
  ] as const)('from %s, a drag of %i px leaves mini at %s', (_from, mini, dy, becomes) => {
    const { onTuner } = draw([rankedSong('a')], { tuner: tunerOf({ mini }) });
    const handle = el(SEL.handle);
    pointer('pointerDown', handle, 300);
    pointer('pointerMove', handle, 300 + dy);
    pointer('pointerUp', handle, 300 + dy);
    expect(modeAsked(onTuner, mini)).toBe(becomes);
  });

  it('a plain press and release asks for nothing, and the click toggles once', () => {
    const { onTuner } = draw();
    const handle = el(SEL.handle);
    pointer('pointerDown', handle, 300);
    pointer('pointerUp', handle, 300);
    expect(onTuner).not.toHaveBeenCalled();
    fireEvent.click(handle);
    expect(calls(onTuner)).toEqual([{ type: 'mini', mini: true }]);
  });

  // Past 6 px a press is a drag: too short to change the mode, but its click must not toggle it either.
  it.each([
    [6, 'a tap, so the click toggles the mode', true],
    [7, 'a drag too short to change the mode, so its click is swallowed and the mode stays', false],
  ] as const)('a press that travels %i px is %s', (dy, _what, becomes) => {
    const { onTuner } = draw();
    const handle = el(SEL.handle);
    pointer('pointerDown', handle, 300);
    pointer('pointerMove', handle, 300 + dy);
    pointer('pointerUp', handle, 300 + dy);
    fireEvent.click(handle);
    expect(modeAsked(onTuner, false)).toBe(becomes);
    expect(calls(onTuner).filter((a) => (a as TunerAction).type === 'mini' && (a as { mini: boolean }).mini)).toHaveLength(becomes ? 1 : 0);
  });

  it('a cancelled pointer finishes the drag from where it last was', () => {
    const { onTuner } = draw();
    const handle = el(SEL.handle);
    pointer('pointerDown', handle, 300);
    pointer('pointerMove', handle, 380);
    // A cancelled pointer can report zeroed coordinates, so it carries none here.
    pointer('pointerCancel', handle);
    expect(calls(onTuner)).toEqual([{ type: 'mini', mini: true }]);
    expect(dragging()).toBe(false);
  });

  it('ignores movement when nothing is pressed', () => {
    const { onTuner } = draw();
    pointer('pointerMove', el(SEL.handle), 100);
    expect(dragging()).toBe(false);
    expect(rackHeight()).toBe('416px');
    expect(onTuner).not.toHaveBeenCalled();
  });
});

// ---- a screen too short for the expanded sheet ----

describe('the handle when the sheet cannot expand (QWW-57, decision 1)', () => {
  /** The sheet on its own: whether the expanded sheet fits is the screen's measurement, and jsdom has no layout to measure. */
  function drawSheet(over: Partial<Parameters<typeof Sheet>[0]> = {}) {
    const onTuner = vi.fn<(action: TunerAction) => void>();
    const props: Parameters<typeof Sheet>[0] = {
      tuner: tunerOf(),
      historyAvailable: true,
      historyHint: 'Connect Spotify to use your listening history',
      canExpand: false,
      onTuner,
      onGearDone: () => {},
      ...over,
    };
    const view = render(<Sheet {...props} />);
    return { onTuner, update: (next: Partial<typeof props>) => view.rerender(<Sheet {...props} {...next} />) };
  }
  const rackHeight = () => el(SEL.rack).style.height;
  const compact = () => el(SEL.sheet).hasAttribute('data-compact');
  const gearsDrawn = () => GEAR_IDS.filter((g) => !hidden(SEL.strip(g)));

  it.each([true, false])('draws the mini sheet whatever the tuner remembers (its mini is %s), and the handle says it is disabled', (mini) => {
    drawSheet({ tuner: tunerOf({ mini }) });
    expect(rackHeight()).toBe('164px');
    expect(compact()).toBe(true);
    expect(gearsDrawn()).toEqual(['difficulty']);
    expect(hidden(SEL.eraPanel)).toBe(true);
    expect(hidden(SEL.tabs)).toBe(false);
    const handle = el(SEL.handle);
    expect(handle.getAttribute('aria-disabled')).toBe('true');
    expect(handle.getAttribute('aria-expanded')).toBe('false');
    // Its name stays what it is in mini; it is still a button, so a keyboard user finds it.
    expect(handle.getAttribute('aria-label')).toBe('Show all gears');
    expect(handle.tagName).toBe('BUTTON');
  });

  // A click is what a tap, Enter and Space all send to a button.
  it.each([true, false])('a click does nothing, again and again (the tuner\'s mini is %s)', (mini) => {
    const { onTuner } = drawSheet({ tuner: tunerOf({ mini }) });
    fireEvent.click(el(SEL.handle));
    fireEvent.click(el(SEL.handle));
    expect(onTuner).not.toHaveBeenCalled();
    expect(rackHeight()).toBe('164px');
    expect(compact()).toBe(true);
  });

  it('an upward drag does not grow the rack or draw the full layout, and asks for no mode', () => {
    const { onTuner } = drawSheet({ tuner: tunerOf({ mini: true }) });
    const handle = el(SEL.handle);
    pointer('pointerDown', handle, 300);
    pointer('pointerMove', handle, 220);
    expect(rackHeight()).toBe('164px');
    expect(compact()).toBe(true);
    expect(gearsDrawn()).toEqual(['difficulty']);
    expect(hidden(SEL.eraPanel)).toBe(true);
    expect(hidden(SEL.tabs)).toBe(false);
    pointer('pointerUp', handle, 220);
    // The click that follows a drag does nothing either.
    fireEvent.click(handle);
    expect(onTuner).not.toHaveBeenCalled();
    expect(rackHeight()).toBe('164px');
  });

  it('leaves the tuner\'s mode alone, so when the screen grows the sheet opens as the singer left it', () => {
    const { onTuner, update } = drawSheet({ tuner: tunerOf({ mini: false }) });
    const handle = el(SEL.handle);
    // A drag down from what looks like mini must not write "mini" into the tuner.
    pointer('pointerDown', handle, 300);
    pointer('pointerMove', handle, 380);
    pointer('pointerUp', handle, 380);
    expect(onTuner).not.toHaveBeenCalled();
    expect(rackHeight()).toBe('164px');

    // A phone turned upright: the expanded sheet fits again.
    update({ canExpand: true });
    expect(rackHeight()).toBe('416px');
    expect(compact()).toBe(false);
    expect(gearsDrawn()).toEqual([...GEAR_IDS]);
    expect(hidden(SEL.eraPanel)).toBe(false);
    expect(hidden(SEL.tabs)).toBe(true);
    expect(el(SEL.handle).hasAttribute('aria-disabled')).toBe(false);
    expect(el(SEL.handle).getAttribute('aria-expanded')).toBe('true');
    expect(el(SEL.handle).getAttribute('aria-label')).toBe('Show one gear');
  });

  // The control: the same sheet, able to expand, does what the handle always did.
  it('when it can expand, the same handle works as usual', () => {
    const { onTuner } = drawSheet({ canExpand: true, tuner: tunerOf({ mini: true }) });
    expect(rackHeight()).toBe('164px');
    fireEvent.click(el(SEL.handle));
    expect(calls(onTuner)).toEqual([{ type: 'mini', mini: false }]);
  });
});

// ---- the gears ----

describe('gear strips', () => {
  // Round 6A §5 shortened History's label to "HISTORY"; QWW-57's review (R6) put "LISTENING HISTORY" back (its tab is still "History").
  const NAME: Record<GearId, string> = { difficulty: 'DIFFICULTY', history: 'LISTENING HISTORY', popularity: 'POPULARITY', tempo: 'TEMPO' };
  const VALUE: Record<GearId, number> = { difficulty: 11, history: 22, popularity: 33, tempo: 44 };
  const label = (gear: GearId) => el<HTMLLabelElement>(`label[for="slider-${gear}"]`);

  it.each(GEAR_IDS)('%s is a real range input, named by its label, at the tuner value', (gear) => {
    draw([rankedSong('a')], signedIn({ off: [], ...VALUE }));
    const input = screen.getByRole('slider', { name: NAME[gear] }) as HTMLInputElement;
    expect(input).toBe(el(SEL.slider(gear)));
    expect(input.type).toBe('range');
    expect([input.min, input.max, input.step]).toEqual(['0', '100', '1']);
    expect(input.value).toBe(String(VALUE[gear]));
    expect(label(gear).textContent).toBe(NAME[gear]);
    expect(el(SEL.strip(gear)).contains(input)).toBe(true);
  });

  it.each(GEAR_IDS)('%s off: Off for assistive tech, the strip marked, the visual OFF tag hidden from them', (gear) => {
    draw([rankedSong('a')], signedIn({ off: [gear] }));
    const input = el(SEL.slider(gear));
    expect(input.getAttribute('aria-valuetext')).toBe('Off');
    expect(el(SEL.strip(gear)).hasAttribute('data-off')).toBe(true);
    const tag = el('[aria-hidden="true"]', label(gear));
    expect(tag.textContent).toBe(' · OFF');
    // The tag is aria-hidden, so the input's name is still just the label's words.
    expect(screen.getByRole('slider', { name: NAME[gear] })).toBe(input);
    // The other three gears are on and say nothing of the sort.
    for (const other of GEAR_IDS.filter((g) => g !== gear)) {
      expect(el(SEL.slider(other)).hasAttribute('aria-valuetext')).toBe(false);
      expect(el(SEL.strip(other)).hasAttribute('data-off')).toBe(false);
      expect(label(other).querySelector('[aria-hidden]')).toBeNull();
    }
  });

  it('an off gear keeps its value, so the thumb stays at the default it was reset to', () => {
    draw([rankedSong('a')], signedIn({ off: ['tempo'], tempo: 50 }));
    expect((el(SEL.slider('tempo')) as HTMLInputElement).value).toBe('50');
  });

  it('a singer who has set nothing sees the defaults: each gear at its default value, those the defaults start off marked off', () => {
    draw([rankedSong('a')], signedIn());
    const off = GEAR_IDS.filter((g) => el(SEL.strip(g)).hasAttribute('data-off'));
    expect(off).toEqual(GEAR_IDS.filter((g) => DEFAULTS.off.includes(g)));
    const values = Object.fromEntries(GEAR_IDS.map((g) => [g, Number((el(SEL.slider(g)) as HTMLInputElement).value)]));
    expect(values).toEqual({ difficulty: DEFAULTS.difficulty, history: DEFAULTS.history, popularity: DEFAULTS.popularity, tempo: DEFAULTS.tempo });
    // With QWW-47's defaults Difficulty and Popularity are the gears that count.
    expect(GEAR_IDS.filter((g) => !off.includes(g))).toEqual(['difficulty', 'popularity']);
  });

  it.each([
    ['difficulty', 'Light work', 'Locked in'],
    ['history', 'Rediscover', 'On repeat'],
    ['popularity', 'Deep cuts', 'Pop hits'],
    ['tempo', 'Slow jams', 'Fast tracks'],
  ] as const)('%s draws its end labels, %s and %s, under the track', (gear, left, right) => {
    draw([rankedSong('a')], signedIn({ off: [] }));
    const ends = within(el(SEL.strip(gear)));
    expect(ends.getByText(left).nextElementSibling).toBe(ends.getByText(right));
  });

  // jsdom applies no CSS, so a strip's neon look is checked where it is decided: the colour the strip hands its stylesheet
  // for its label, fill and glow (Round 6A §3.1, §5). Its border is not one of them: it is the rail's grey whatever the state (R5).
  const litOf = (gear: GearId, name = '--sl-gear') => el(SEL.strip(gear)).style.getPropertyValue(name);

  it('hands each strip its gear\'s lit colour', () => {
    draw([rankedSong('a')], signedIn({ off: [], difficulty: 50, history: 90, popularity: 5, tempo: 95 }));
    expect(GEAR_IDS.map((g) => litOf(g))).toEqual(['#FFC24A', '#4FDDE8', '#FFC24A', '#B583FF']);
  });

  it('hands no strip, and not the Era panel, the gear\'s colour for a border: no --sl-gear-line, lit or off (R5)', () => {
    const { update } = draw([rankedSong('a')], signedIn({ off: [], eras: ['s90'] }));
    for (const off of [[], [...TUNER_PARTS]]) {
      update({ tuner: tunerOf({ off, eras: ['s90'] }) });
      for (const part of [...all('[data-strip]'), el(SEL.eraPanel)]) expect(part.style.getPropertyValue('--sl-gear-line'), part.id || part.dataset.gear).toBe('');
    }
    // The strip's colour is for its label and fill and the panel's for its header: those are still handed over.
    expect(litOf('history')).toBe('#4FDDE8');
    expect(el(SEL.eraPanel).style.getPropertyValue('--sl-gear')).toBe('#FF4FA0');
  });

  it.each([
    [10, '#4DE89A'],
    [33, '#4DE89A'],
    [34, '#FFC24A'],
    [66, '#FFC24A'],
    [67, '#FF5A8A'],
    [95, '#FF5A8A'],
  ])('Difficulty at %i is lit in its tier\'s colour, %s, whatever the other gears say', (difficulty, colour) => {
    draw([rankedSong('a')], signedIn({ off: [], difficulty, history: 0, popularity: 100, tempo: 50 }));
    expect(litOf('difficulty')).toBe(colour);
  });

  // Stable names for the browser tests, which read computed styles and cannot name a CSS-module class.
  it.each(GEAR_IDS)('%s has one data-knob, data-fill and data-ends in its track and under it, and a data-offtag only while it is off', (gear) => {
    const { update } = draw([rankedSong('a')], signedIn({ off: [] }));
    const strip = () => el(SEL.strip(gear));
    for (const hook of ['[data-knob]', '[data-fill]', '[data-ends]']) expect(all(hook, strip()), hook).toHaveLength(1);
    expect(el('[data-ends]', strip()).getAttribute('data-ends')).toBe('');
    expect(strip().querySelector('[data-offtag]')).toBeNull();
    // The fill and the knob are the track's two children, the end labels follow it.
    const track = el('div[aria-hidden="true"]', strip());
    expect(track.children[0]).toBe(el('[data-fill]', strip()));
    expect(track.children[1]).toBe(el('[data-knob]', strip()));
    expect(track.nextElementSibling).toBe(el('[data-ends]', strip()));

    update({ tuner: tunerOf({ off: [gear] }) });
    expect(all('[data-offtag]', strip())).toHaveLength(1);
    expect(el('[data-offtag]', strip()).textContent).toBe(' · OFF');
    // The label holds the tag, so the tag is not one the strip repeats elsewhere.
    expect(el<HTMLLabelElement>(`label[for="slider-${gear}"]`).contains(el('[data-offtag]', strip()))).toBe(true);
  });

  it('puts the fill and the knob at the value, on or off: the strip body carries it in percent', () => {
    draw([rankedSong('a')], signedIn({ off: ['tempo'], difficulty: 11, tempo: 50 }));
    const pct = (gear: GearId) => el('div[aria-hidden="true"]', el(SEL.strip(gear))).parentElement?.style.getPropertyValue('--pct');
    expect([pct('difficulty'), pct('tempo')]).toEqual(['11%', '50%']);
  });

  // Round 6A §7: an off gear is a switched-off sign, not a faded one. The art draws itself unlit, so the sheet puts no
  // opacity and no grayscale on it, on or off.
  // The art draws itself unlit when told its gear is off (tests/setlist/gearArt.test.tsx has how); this is the wiring. The
  // turn-on flicker is the visible mark: README test 29 is `neonOn 0.7s` on a lit gear, and an off gear has none.
  it('tells each strip\'s art whether its gear is off, History before Spotify is connected included', () => {
    // History is on in the tuner here, but a signed-out singer cannot use it, so it is off all the same.
    draw([rankedSong('a')], { mode: 'catalogue', tuner: tunerOf({ off: ['tempo', 'era'] }) });
    const animation = (gear: GearId) => el('svg', el(SEL.strip(gear))).style.animation;
    expect(GEAR_IDS.map((gear) => animation(gear))).toEqual(['neonOn 0.7s linear 1', 'none', 'neonOn 0.7s linear 1', 'none']);
    expect(GEAR_IDS.filter((gear) => el(SEL.strip(gear)).hasAttribute('data-off'))).toEqual(['history', 'tempo']);
  });

  // QWW-57, R7: the notes, bolts and rays a value does not reach are drawn unlit, not hidden; an off gear lights none of them.
  // tests/setlist/gearArt.test.tsx has the art itself; this is the wiring, through the strip and the tab.
  it('lights the notes and bolts a gear\'s value reaches, on the strip and as rays on the tab, and none of an off gear\'s, History before Spotify is connected included', () => {
    const litIn = (selector: string) => all(`${selector} [data-lit]`).filter((part) => part.dataset.lit === 'true').length;
    const drawnIn = (selector: string) => all(`${selector} [data-lit]`).length;
    // Signed in: History is on at 65 and Popularity at 30.
    const { update } = draw([rankedSong('a')], signedIn({ off: ['tempo', 'era'], history: 65, popularity: 30 }));
    expect([litIn(SEL.strip('history')), litIn(SEL.tab('history')), litIn(SEL.strip('popularity')), litIn(SEL.tab('popularity'))]).toEqual([5, 5, 2, 2]);
    // Every one is drawn all the same: seven notes or bolts on the strip, seven rays on the tab.
    expect([drawnIn(SEL.strip('history')), drawnIn(SEL.tab('history')), drawnIn(SEL.strip('popularity')), drawnIn(SEL.tab('popularity'))]).toEqual([7, 7, 7, 7]);
    // Signed out, History is off whatever the tuner says, so none of its notes or rays is lit; Popularity is untouched.
    update({ mode: 'catalogue' });
    expect([litIn(SEL.strip('history')), litIn(SEL.tab('history')), litIn(SEL.strip('popularity')), litIn(SEL.tab('popularity'))]).toEqual([0, 0, 2, 2]);
    expect(drawnIn(SEL.strip('history'))).toBe(7);
    // Popularity reset: all seven bolts and rays are drawn, none lit.
    update({ tuner: tunerOf({ off: ['popularity', 'tempo', 'era'], popularity: 30 }) });
    expect([litIn(SEL.strip('popularity')), litIn(SEL.tab('popularity')), drawnIn(SEL.strip('popularity'))]).toEqual([0, 0, 7]);
  });

  it('does not dim an off gear\'s art: no opacity and no filter on it', () => {
    draw([rankedSong('a')], signedIn({ off: ['tempo', 'era'] }));
    const offGears = GEAR_IDS.filter((g) => el(SEL.strip(g)).hasAttribute('data-off'));
    expect(offGears).toEqual(['tempo']);
    for (const gear of offGears) {
      const art = el('svg', el(SEL.strip(gear)));
      expect(art.style.opacity, gear).toBe('');
      expect(art.style.filter, gear).toBe('');
    }
  });
});

describe('History', () => {
  const HINT = 'Connect Spotify to use your listening history';
  const strip = () => el(SEL.strip('history'));

  // QWW-57, R6: the strip says "LISTENING HISTORY" (the tab and the reset button's name are as they were). A History that cannot be
  // used at all says why under its track, so it does not also say " · OFF"; one that is off but usable (signed in) does.
  const label = () => el<HTMLLabelElement>('label[for="slider-history"]');

  it('is labelled LISTENING HISTORY, and the slider is named by it', () => {
    draw();
    expect(label().textContent).toBe('LISTENING HISTORY');
    expect(screen.getByRole('slider', { name: 'LISTENING HISTORY' })).toBe(el(SEL.slider('history')));
    // The reset button keeps its name (it is hidden while History is off, so it is read from its attribute).
    expect(el(SEL.reset('history')).getAttribute('aria-label')).toBe('Turn off listening history');
  });

  it('has the OFF tag after its label while it is off but usable (signed in), and no tag once it is on', () => {
    const { update } = draw([rankedSong('a')], signedIn());
    expect(label().textContent).toBe('LISTENING HISTORY · OFF');
    expect(el('[data-offtag]', label()).textContent).toBe(' · OFF');
    // The tag is aria-hidden, so the slider's name is the words alone.
    expect(screen.getByRole('slider', { name: 'LISTENING HISTORY' })).toBe(el(SEL.slider('history')));
    update({ tuner: tunerOf({ off: ['tempo', 'era'] }) });
    expect(label().textContent).toBe('LISTENING HISTORY');
    expect(label().querySelector('[data-offtag]')).toBeNull();
  });

  it.each([
    ['signed out', {}, HINT],
    ['signed in, with Spotify unreachable', { mode: 'library', libraryUnavailable: true }, 'Spotify could not be reached, so listening history is off'],
  ] as const)('has no OFF tag while it is disabled, %s: the hint under the track says why', (_who, over, hint) => {
    draw([rankedSong('a')], { ...over, tuner: tunerOf({ off: [...DEFAULTS.off] }) });
    expect(el<HTMLInputElement>(SEL.slider('history')).disabled).toBe(true);
    expect(strip().hasAttribute('data-off')).toBe(true);
    expect(label().textContent).toBe('LISTENING HISTORY');
    expect(strip().querySelector('[data-offtag]')).toBeNull();
    expect(within(strip()).getByText(hint)).toBeTruthy();
    // The other gears are untouched: Tempo is off and usable, so it says so.
    expect(el<HTMLLabelElement>('label[for="slider-tempo"]').textContent).toBe('TEMPO · OFF');
  });

  it('has no OFF tag while it is disabled even with History on in the tuner (a signed-out singer\'s tuner can have it on)', () => {
    draw([rankedSong('a')], { tuner: tunerOf({ off: ['tempo', 'era'] }) });
    expect(el<HTMLInputElement>(SEL.slider('history')).disabled).toBe(true);
    expect(label().textContent).toBe('LISTENING HISTORY');
    expect(strip().querySelector('[data-offtag]')).toBeNull();
  });

  it('is off and disabled while signed out, and says why in place of its end labels, under a track that is still drawn', () => {
    draw();
    const input = el<HTMLInputElement>(SEL.slider('history'));
    expect(input.disabled).toBe(true);
    const hint = within(strip()).getByText(HINT);
    expect(input.getAttribute('aria-describedby')).toBe(hint.id);
    expect(hint.id).not.toBe('');
    // The track (the strip's one aria-hidden div; the art is an svg) is drawn, and the hint stands
    // right under it, where the end labels would. The end labels are not drawn.
    expect(strip().querySelectorAll('div[aria-hidden="true"]')).toHaveLength(1);
    expect(el('div[aria-hidden="true"]', strip()).nextElementSibling).toBe(hint);
    // The browser tests' hook for "the end labels' row" is on the hint here, and says so.
    expect(all('[data-ends]', strip())).toEqual([hint]);
    expect(hint.getAttribute('data-ends')).toBe('hint');
    expect(within(strip()).queryByText('Rediscover')).toBeNull();
    expect(within(strip()).queryByText('On repeat')).toBeNull();
    expect(strip().hasAttribute('data-off')).toBe(true);
    expect(input.getAttribute('aria-valuetext')).toBe('Off');
    // There is nothing to reset on a gear that cannot be used.
    expect(hidden(SEL.reset('history'))).toBe(true);
  });

  it('says it only for History: the other gears show their tracks', () => {
    draw();
    expect(screen.getAllByText(HINT)).toHaveLength(1);
    for (const gear of ['difficulty', 'popularity', 'tempo'] as const) expect(el<HTMLInputElement>(SEL.slider(gear)).disabled).toBe(false);
  });

  it('is usable once signed in: enabled, with its track and no hint, though it starts off like everyone\'s', () => {
    draw([rankedSong('a')], signedIn());
    const input = el<HTMLInputElement>(SEL.slider('history'));
    expect(input.disabled).toBe(false);
    expect(input.hasAttribute('aria-describedby')).toBe(false);
    expect(within(strip()).queryByText(HINT)).toBeNull();
    expect(strip().querySelector('div[aria-hidden="true"]')).not.toBeNull();
    expect(within(strip()).getByText('Rediscover')).toBeTruthy();
    expect(within(strip()).getByText('On repeat')).toBeTruthy();
    // Off until it is touched: it says so, and has nothing to reset yet.
    expect(strip().hasAttribute('data-off')).toBe(true);
    expect(input.getAttribute('aria-valuetext')).toBe('Off');
    expect(hidden(SEL.reset('history'))).toBe(true);
  });

  it('once switched on it counts: no OFF mark, a reset to press', () => {
    draw([rankedSong('a')], signedIn({ off: ['tempo', 'era'] }));
    expect(strip().hasAttribute('data-off')).toBe(false);
    expect(el(SEL.slider('history')).hasAttribute('aria-valuetext')).toBe(false);
    expect(hidden(SEL.reset('history'))).toBe(false);
  });

  it('a press on it, signed in, asks for it to be switched on', () => {
    const { onTuner } = draw([rankedSong('a')], signedIn());
    faderPointer('pointerDown', fader('history'), { x: faderX(DEFAULTS.history) });
    expect(calls(onTuner)).toEqual([{ type: 'touch', gear: 'history' }]);
  });
});

describe('reset buttons', () => {
  const LABEL: Record<(typeof TUNER_PARTS)[number], string> = {
    difficulty: 'Turn off difficulty',
    history: 'Turn off listening history',
    popularity: 'Turn off popularity',
    tempo: 'Turn off tempo',
    era: 'Turn off era',
  };

  it.each(TUNER_PARTS)('%s: hidden while it is off, shown while it is on', (gear) => {
    const { update } = draw([rankedSong('a')], signedIn({ off: [] }));
    expect(hidden(SEL.reset(gear))).toBe(false);
    update({ tuner: tunerOf({ off: [gear] }) });
    expect(hidden(SEL.reset(gear))).toBe(true);
    update({ tuner: tunerOf({ off: TUNER_PARTS.filter((g) => g !== gear) }) });
    expect(hidden(SEL.reset(gear))).toBe(false);
  });

  it.each(TUNER_PARTS)('%s: named for a screen reader and with a tooltip, and its icon is decorative', (gear) => {
    draw([rankedSong('a')], signedIn({ off: [] }));
    const button = el(SEL.reset(gear));
    expect(button.getAttribute('aria-label')).toBe(LABEL[gear]);
    expect(screen.getByRole('button', { name: LABEL[gear] })).toBe(button);
    expect(button.getAttribute('title')).toBe("Turn off: don't factor in");
    expect(button.textContent).toBe('');
    expect(el('svg', button).getAttribute('aria-hidden')).toBe('true');
  });

  it.each(TUNER_PARTS)('%s: a click asks for a reset of that gear', (gear) => {
    const { onTuner } = draw([rankedSong('a')], signedIn({ off: [] }));
    fireEvent.click(el(SEL.reset(gear)));
    expect(calls(onTuner)).toEqual([{ type: 'reset', gear }]);
  });

  it.each(GEAR_IDS)('%s: the button hides itself after use, and focus lands on that gear\'s slider instead of being lost', (gear) => {
    const onTuner = vi.fn<(action: TunerAction) => void>();
    render(<Tuned initial={tunerOf({ off: [] })} onTuner={onTuner} />);
    const button = el(SEL.reset(gear));
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(calls(onTuner)).toEqual([{ type: 'reset', gear }]);
    expect(button.hasAttribute('hidden')).toBe(true);
    expect(document.activeElement).toBe(el(SEL.slider(gear)));
  });

  it('era: the button hides itself after use, and focus lands on the first Era button', () => {
    const onTuner = vi.fn<(action: TunerAction) => void>();
    render(<Tuned initial={tunerOf({ off: [], eras: ['s80'] })} onTuner={onTuner} />);
    const button = el(SEL.reset('era'));
    button.focus();
    fireEvent.click(button);
    expect(calls(onTuner)).toEqual([{ type: 'reset', gear: 'era' }]);
    expect(button.hasAttribute('hidden')).toBe(true);
    expect(document.activeElement).toBe(el(SEL.era('pre')));
  });
});

describe('moving a gear', () => {
  it('a drag steps the value through input events and ends nothing', () => {
    const { onTuner, onGearDone } = draw();
    const slider = el(SEL.slider('difficulty'));
    fireEvent.input(slider, { target: { value: '35' } });
    fireEvent.input(slider, { target: { value: '36' } });
    expect(calls(onTuner)).toEqual([
      { type: 'input', gear: 'difficulty', value: 35 },
      { type: 'input', gear: 'difficulty', value: 36 },
    ]);
    expect(onGearDone).not.toHaveBeenCalled();
  });

  it('letting go ends the adjustment once: the browser sends one change event', () => {
    const { onTuner, onGearDone } = draw();
    const slider = el(SEL.slider('difficulty'));
    fireEvent.input(slider, { target: { value: '35' } });
    fireEvent.pointerUp(slider);
    fireEvent.change(slider);
    expect(onTuner).toHaveBeenCalledTimes(1);
    expect(calls(onGearDone)).toEqual(['difficulty']);
  });

  it('a keyboard step is one input and one end', () => {
    const { onTuner, onGearDone } = draw();
    fireEvent.change(el(SEL.slider('difficulty')), { target: { value: '21' } });
    expect(calls(onTuner)).toEqual([{ type: 'input', gear: 'difficulty', value: 21 }]);
    expect(calls(onGearDone)).toEqual(['difficulty']);
  });

  // The pointer goes to the fader's hit area, not to the input (R33): `fader`, `faderX` and `faderPointer` aim at it (tests/helpers/fader.ts).
  it('a press on an off gear exactly on its default turns it on, and is one adjustment', () => {
    // Tempo starts off. A press that lands on the default sets no new value, so the press itself has to say so.
    const { onTuner, onGearDone } = draw();
    const hit = fader('tempo');
    faderPointer('pointerDown', hit, { x: faderX(DEFAULTS.tempo) });
    expect(calls(onTuner)).toEqual([{ type: 'touch', gear: 'tempo' }]);
    expect(onGearDone).not.toHaveBeenCalled();
    faderPointer('pointerUp', hit, { x: faderX(DEFAULTS.tempo) });
    expect(calls(onGearDone)).toEqual(['tempo']);
    expect(onTuner).toHaveBeenCalledTimes(1);
  });

  it('a press on an off gear away from its default turns it on and sets the value there, and ends once', () => {
    const { onTuner, onGearDone } = draw();
    const hit = fader('tempo');
    faderPointer('pointerDown', hit, { x: faderX(60) });
    faderPointer('pointerUp', hit, { x: faderX(60) });
    expect(calls(onTuner)).toEqual([
      { type: 'touch', gear: 'tempo' },
      { type: 'input', gear: 'tempo', value: 60 },
    ]);
    expect(calls(onGearDone)).toEqual(['tempo']);
  });

  it('a press on a gear that is on, on its knob, changes nothing and ends nothing', () => {
    const { onTuner, onGearDone } = draw();
    const hit = fader('difficulty');
    faderPointer('pointerDown', hit, { x: faderX(DEFAULTS.difficulty) });
    faderPointer('pointerUp', hit, { x: faderX(DEFAULTS.difficulty) });
    expect(onTuner).not.toHaveBeenCalled();
    expect(onGearDone).not.toHaveBeenCalled();
  });

  // A right or middle click is not a press: it must not switch a gear on, or end an adjustment that never began.
  it.each([
    ['middle', 1],
    ['right', 2],
  ] as const)('a %s-button press on an off gear turns nothing on and ends nothing, and the next plain press still counts once', (_name, button) => {
    const { onTuner, onGearDone } = draw();
    const hit = fader('tempo');
    faderPointer('pointerDown', hit, { x: faderX(DEFAULTS.tempo), button });
    faderPointer('pointerUp', hit, { x: faderX(DEFAULTS.tempo), button });
    expect(onTuner).not.toHaveBeenCalled();
    expect(onGearDone).not.toHaveBeenCalled();

    faderPointer('pointerDown', hit, { x: faderX(DEFAULTS.tempo) });
    faderPointer('pointerUp', hit, { x: faderX(DEFAULTS.tempo) });
    expect(calls(onTuner)).toEqual([{ type: 'touch', gear: 'tempo' }]);
    expect(calls(onGearDone)).toEqual(['tempo']);
  });

  it('a finger that lands on an off gear and is then taken by the browser for a scroll turns nothing on and records nothing', () => {
    // The thumb must not jump on the first pointerdown of a touch that then turns vertical (R33): a finger waits to see which way it goes.
    const { onTuner, onGearDone } = draw();
    const hit = fader('tempo');
    faderPointer('pointerDown', hit, { kind: 'touch', x: faderX(80), y: 0 });
    expect(onTuner).not.toHaveBeenCalled();
    faderPointer('pointerMove', hit, { kind: 'touch', x: faderX(80) + 1, y: 12 });
    faderPointer('pointerCancel', hit, { kind: 'touch' });
    expect(onTuner).not.toHaveBeenCalled();
    expect(onGearDone).not.toHaveBeenCalled();
  });

  // The gate on 1ee41b4: no swipe that ends mostly up or down turns a gear on or moves it. A finger that kicked sideways first was called a drag, so the gear was put
  // on or moved; the sheet puts it back as it was (value, on or off, the open part), through the tuner's own state, and records nothing.
  it.each<[string, GearId, Partial<TunerState>, number]>([
    ['an off gear (Tempo)', 'tempo', { off: ['tempo'] }, DEFAULTS.tempo],
    ['a gear that is on (Difficulty, at 40)', 'difficulty', { difficulty: 40, off: [] }, 40],
  ])('a swipe that kicked 15 px sideways in its first 6 and then went 120 px down puts %s back as it was, with nothing recorded', (_name, gear, over, before) => {
    const onTuner = vi.fn<(action: TunerAction) => void>();
    const onGearDone = vi.fn<(gear: GearId) => void>();
    render(<Tuned initial={tunerOf({ ...over, open: 'popularity' })} onTuner={onTuner} onGearDone={onGearDone} />);
    const hit = fader(gear);
    const wasOff = el(SEL.strip(gear)).hasAttribute('data-off');
    const x0 = faderX(before);
    faderPointer('pointerDown', hit, { kind: 'touch', x: x0, y: 0 });
    faderPointer('pointerMove', hit, { kind: 'touch', x: x0 + 15, y: 6 });
    // It was called a drag: the gear is on and the value is under the finger.
    expect(el(SEL.strip(gear)).hasAttribute('data-off')).toBe(false);
    for (let y = 12; y <= 120; y += 6) faderPointer('pointerMove', hit, { kind: 'touch', x: x0 + 15, y });
    faderPointer('pointerUp', hit, { kind: 'touch', x: x0 + 15, y: 120 });
    expect(el(SEL.strip(gear)).hasAttribute('data-off')).toBe(wasOff);
    expect(Number(el(SEL.slider(gear)).getAttribute('value') ?? (el(SEL.slider(gear)) as HTMLInputElement).value)).toBe(before);
    expect(onGearDone, 'no adjustment is recorded').not.toHaveBeenCalled();
    const actions = calls(onTuner) as TunerAction[];
    expect(actions.at(-1)).toMatchObject({ type: 'patch', patch: { [gear]: before, open: 'popularity' } });
    expect(actions.filter((a) => a.type === 'reset')).toEqual([]);
  });

  it('a press that turned a gear on and was then cancelled ends that adjustment once, and the next plain tap does not look like another', () => {
    const onGearDone = vi.fn<(gear: GearId) => void>();
    render(<Tuned initial={tunerOf({ off: ['tempo'] })} onGearDone={onGearDone} />);
    const hit = fader('tempo');
    faderPointer('pointerDown', hit, { x: faderX(DEFAULTS.tempo) });
    faderPointer('pointerCancel', hit);
    // The press turned Tempo on, and that was the one adjustment.
    expect(calls(onGearDone)).toEqual(['tempo']);
    // Tempo is on now. A later tap on its knob that moves nothing is not another one.
    faderPointer('pointerDown', hit, { x: faderX(DEFAULTS.tempo) });
    faderPointer('pointerUp', hit, { x: faderX(DEFAULTS.tempo) });
    expect(calls(onGearDone)).toEqual(['tempo']);
  });
});

// ---- Era ----

describe('the Era panel after a finger\'s tap on its ✕ (the gates on 4e324f5 and 5ab0be7)', () => {
  const eraButton = (era: EraId) => el(`${SEL.eraPanel} [data-era="${era}"]`);
  /** A finger's tap: a press at the box's middle, then the click (`detail` 1). */
  const tap = (target: Element, kind: 'touch' | 'mouse' = 'touch') => {
    target.getBoundingClientRect = () => new DOMRect(100, 100, 44, 52);
    const event = createEvent.pointerDown(target);
    Object.defineProperty(event, 'clientX', { value: 120 });
    Object.defineProperty(event, 'clientY', { value: 120 });
    Object.defineProperty(event, 'pointerType', { value: kind });
    fireEvent(target, event);
    fireEvent.click(target, { detail: 1 });
  };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(2_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the era buttons for 400 ms: the second tap of a double tap on the ✕ lands on the \'20s, which turned Era back on with only the \'20s picked', () => {
    const onTuner = vi.fn<(action: TunerAction) => void>();
    render(<Tuned initial={tunerOf({ off: [], eras: ['s80'] })} onTuner={onTuner} />);
    tap(el('button[data-reset="era"]'));
    expect(calls(onTuner)).toEqual([{ type: 'reset', gear: 'era' }]);
    vi.setSystemTime(2_000_000 + 150);
    tap(eraButton('s20'));
    vi.setSystemTime(2_000_000 + 399);
    tap(eraButton('s20'));
    expect(calls(onTuner)).toEqual([{ type: 'reset', gear: 'era' }]);
    // The moment is 400 ms from the ✕ and no more: the taps it held did not put it off, so a tap 2 ms later is a choice.
    vi.setSystemTime(2_000_000 + 401);
    tap(eraButton('s20'));
    expect(calls(onTuner)).toEqual([{ type: 'reset', gear: 'era' }, { type: 'era', era: 's20' }]);
  });

  it('is 400 ms from the tap on the ✕ whatever it holds: after a run of taps in it, a tap 450 ms after the ✕ turns the era on (the gate on 5ab0be7)', () => {
    const onTuner = vi.fn<(action: TunerAction) => void>();
    render(<Tuned initial={tunerOf({ off: [], eras: ['s80'] })} onTuner={onTuner} />);
    tap(el('button[data-reset="era"]'));
    for (const at of [60, 160, 260, 360, 399]) {
      vi.setSystemTime(2_000_000 + at);
      tap(eraButton('s20'));
    }
    expect(calls(onTuner)).toEqual([{ type: 'reset', gear: 'era' }]);
    vi.setSystemTime(2_000_000 + 450);
    tap(eraButton('s20'));
    expect(calls(onTuner)).toEqual([{ type: 'reset', gear: 'era' }, { type: 'era', era: 's20' }]);
  });

  it('is a finger\'s: a mouse click on the ✕ and one on an era right after are two choices', () => {
    const onTuner = vi.fn<(action: TunerAction) => void>();
    render(<Tuned initial={tunerOf({ off: [], eras: ['s80'] })} onTuner={onTuner} />);
    tap(el('button[data-reset="era"]'), 'mouse');
    vi.setSystemTime(2_000_000 + 100);
    tap(eraButton('s20'), 'mouse');
    expect(calls(onTuner)).toHaveLength(2);
  });

  it('is not started by a key on the ✕ (a click with detail 0), and does not hold a key on an era: a tap or a key right after is a choice', () => {
    const onTuner = vi.fn<(action: TunerAction) => void>();
    render(<Tuned initial={tunerOf({ off: [], eras: ['s80'] })} onTuner={onTuner} />);
    // A finger went down on the ✕ with no click after it, so the last press is a finger's, not a mouse's left from an earlier test: the key's click is judged on its detail.
    const resetEra = el('button[data-reset="era"]');
    resetEra.getBoundingClientRect = () => new DOMRect(100, 100, 44, 52);
    const down = createEvent.pointerDown(resetEra);
    Object.defineProperty(down, 'clientX', { value: 120 });
    Object.defineProperty(down, 'clientY', { value: 120 });
    Object.defineProperty(down, 'pointerType', { value: 'touch' });
    fireEvent(resetEra, down);
    fireEvent.click(resetEra, { detail: 0 });
    vi.setSystemTime(2_000_000 + 100);
    tap(eraButton('s20'));
    expect(calls(onTuner)).toEqual([{ type: 'reset', gear: 'era' }, { type: 'era', era: 's20' }]);
    // And after a finger's tap on the ✕ (a hold), a key on an era is still not held: it has no press, so nobody pressed it by mistake.
    tap(el('button[data-reset="era"]'));
    vi.setSystemTime(2_000_000 + 150);
    fireEvent.click(eraButton('s70'), { detail: 0 });
    expect(calls(onTuner).at(-1)).toEqual({ type: 'era', era: 's70' });
  });
});

describe('the Era panel', () => {
  const buttons = () => all(`${SEL.eraPanel} [data-era]`);
  const pressed = () => buttons().filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.era);
  const parked = () => buttons().filter((b) => b.hasAttribute('data-parked')).map((b) => b.dataset.era);

  it('has the seven eras in order, labelled with a typographic apostrophe (U+2019)', () => {
    draw();
    expect(buttons().map((b) => b.dataset.era)).toEqual(['pre', 's70', 's80', 's90', 's00', 's10', 's20']);
    expect(buttons().map((b) => b.textContent)).toEqual(['Pre-’70s', '’70s', '’80s', '’90s', '’00s', '’10s', '’20s']);
    expect(buttons().every((b) => b.tagName === 'BUTTON')).toBe(true);
  });

  // Round 6A §8: the header is "ERA", and "· OFF · all eras" while Era is off; it replaces "ERA: PICK ANY". The count that came after
  // "ERA" is the screen header's now (R19).
  it('is a group named by its header: "ERA", and "ERA · OFF · all eras" while Era is off', () => {
    draw();
    const group = screen.getByRole('group', { name: 'ERA · OFF · all eras' });
    expect(group).toBe(el(SEL.eraPanel));
    const labelledBy = group.getAttribute('aria-labelledby');
    expect(labelledBy).toBe('era-label');
    expect(document.getElementById(labelledBy ?? '')?.firstChild?.textContent).toBe('ERA');
  });

  it.each([1204, 10, 1, 0, null])('with Era on the header reads just "ERA", with no count in the panel, whatever the engine counted (%s)', (total) => {
    draw([rankedSong('a')], { ...signedIn({ off: [], eras: ['s90'] }), total });
    expect(el('#era-label').textContent).toBe('ERA');
    expect(el('#era-label').children).toHaveLength(0);
    expect(screen.getByRole('group', { name: 'ERA' })).toBe(el(SEL.eraPanel));
    expect(el(SEL.eraPanel).textContent).not.toContain('song');
  });

  it('with Era off the header says so, in a span of its own for the CSS to set apart, and carries no count either', () => {
    draw([rankedSong('a')], { ...signedIn({ off: ['era'] }), total: 1204 });
    expect(el('#era-label').textContent).toBe('ERA · OFF · all eras');
    const note = el('#era-label > span');
    expect(note.textContent).toBe('· OFF · all eras');
    expect(note.hasAttribute('data-off-note')).toBe(true);
    // It is part of the group's name, so a screen reader says what Era is doing.
    expect(note.hasAttribute('aria-hidden')).toBe(false);
    expect(el(SEL.eraPanel).textContent).not.toContain('song');
  });

  it('hands its stylesheet the pink, for its header (§8); its border is the rail\'s grey in every state, so it gets no colour for one (R5)', () => {
    draw();
    expect(el(SEL.eraPanel).style.getPropertyValue('--sl-gear')).toBe('#FF4FA0');
    expect(el(SEL.eraPanel).style.getPropertyValue('--sl-gear-line')).toBe('');
  });

  it('Era off, as every singer starts: no era is pressed or outlined (the defaults have no picks), the panel says OFF and has nothing to reset', () => {
    // QWW-47's defaults have no picks, so with Era off nothing is outlined at all.
    expect(DEFAULTS.eras).toEqual([]);
    draw();
    expect(buttons().map((b) => b.getAttribute('aria-pressed'))).toEqual(Array(7).fill('false'));
    expect(parked()).toEqual([...DEFAULTS.eras]);
    expect(el(SEL.eraPanel).hasAttribute('data-off')).toBe(true);
    expect(el('#era-label').textContent).toBe('ERA · OFF · all eras');
    expect(hidden(SEL.reset('era'))).toBe(true);
  });

  it('Era off with picks held: no era is pressed, the picks it holds are outlined (parked), and none counts', () => {
    draw([rankedSong('a')], signedIn({ off: ['era'], eras: ['s90', 's00', 's10'] }));
    expect(buttons().map((b) => b.getAttribute('aria-pressed'))).toEqual(Array(7).fill('false'));
    expect(parked()).toEqual(['s90', 's00', 's10']);
    expect(el(SEL.eraPanel).hasAttribute('data-off')).toBe(true);
    expect(el('#era-label').textContent).toBe('ERA · OFF · all eras');
    expect(hidden(SEL.reset('era'))).toBe(true);
  });

  it('Era on: exactly the picked eras are pressed, none is parked, and there is something to reset', () => {
    draw([rankedSong('a')], signedIn({ off: [], eras: ['s70', 's20'] }));
    expect(pressed()).toEqual(['s70', 's20']);
    expect(parked()).toEqual([]);
    expect(el(SEL.eraPanel).hasAttribute('data-off')).toBe(false);
    expect(el('#era-label').querySelector('[aria-hidden]')).toBeNull();
    expect(hidden(SEL.reset('era'))).toBe(false);
  });

  it('Era on with nothing picked, a state only the test hook or an old state reaches (R23), is not Era off: nothing pressed or parked, and the reset stays', () => {
    draw([], signedIn({ off: [], eras: [] }));
    expect(pressed()).toEqual([]);
    expect(parked()).toEqual([]);
    expect(el(SEL.eraPanel).hasAttribute('data-off')).toBe(false);
    expect(hidden(SEL.reset('era'))).toBe(false);
  });

  it('R23: tapping the one picked era turns Era off, so the panel is the Era-off one: nothing pressed or outlined, "OFF · all eras", no ✕', () => {
    const onTuner = vi.fn<(action: TunerAction) => void>();
    render(<Tuned initial={tunerOf({ off: [], eras: ['s80'] })} onTuner={onTuner} />);
    const lights = () => all(`${SEL.tab('era')} [data-jukebox="button"]`).map((button) => button.getAttribute('fill'));
    expect(pressed()).toEqual(['s80']);
    expect(hidden(SEL.reset('era'))).toBe(false);
    expect(lights()).toEqual(['#FFC24A', '#34313D', '#34313D']); // the '80s is before the '90s: the left button, lit amber
    fireEvent.click(el(SEL.era('s80')));
    expect(calls(onTuner)).toEqual([{ type: 'era', era: 's80' }]);
    expect(pressed()).toEqual([]);
    expect(parked()).toEqual([]);
    expect(el(SEL.eraPanel).hasAttribute('data-off')).toBe(true);
    expect(el('#era-label').textContent).toBe('ERA · OFF · all eras');
    expect(hidden(SEL.reset('era'))).toBe(true);
    // The Era tab goes unlit with it, and the jukebox's three buttons (R24) are the unlit grey.
    expect(el(SEL.tab('era')).hasAttribute('data-off')).toBe(true);
    expect(lights()).toEqual(['#34313D', '#34313D', '#34313D']);
  });

  it('R23: with two eras picked, tapping one leaves Era on with the other', () => {
    render(<Tuned initial={tunerOf({ off: [], eras: ['s80', 's90'] })} />);
    fireEvent.click(el(SEL.era('s80')));
    expect(pressed()).toEqual(['s90']);
    expect(el(SEL.eraPanel).hasAttribute('data-off')).toBe(false);
    expect(hidden(SEL.reset('era'))).toBe(false);
  });

  it.each(['pre', 's70', 's80', 's90', 's00', 's10', 's20'] as EraId[])('a click on %s asks for that era', (era) => {
    const { onTuner } = draw();
    fireEvent.click(el(SEL.era(era)));
    expect(calls(onTuner)).toEqual([{ type: 'era', era }]);
  });
});

// ---- the list ----

describe('the ranked list', () => {
  // Not in id order and not in any ranking order: the screen draws the list it is given, in the order it is given.
  const songs = [
    rankedSong('c', { title: 'Cello', artist: 'Cara', year: 2004, difficulty: 'hard' }),
    rankedSong('a', { title: 'Alpha', artist: 'Ada', year: 1969 }),
    rankedSong('b', { title: 'Bravo', artist: 'Bo', year: null, difficulty: 'maybe' }),
  ];
  const rows = () => all(SEL.row);
  /** The button that opens the song: a direct child of the row, as the ▶ in the slot beside it is not. */
  const openButton = (row: HTMLElement): HTMLButtonElement => {
    const button = Array.from(row.children).find((c): c is HTMLButtonElement => c.tagName === 'BUTTON');
    if (!button) throw new Error('A row has no button');
    return button;
  };

  it('is an ordered list named "Ranked songs", with a row per song in the order given', () => {
    draw(songs);
    const list = screen.getByRole('list', { name: 'Ranked songs' });
    expect(list).toBe(el(SEL.list));
    expect(list.tagName).toBe('OL');
    expect(within(list).getAllByRole('listitem')).toEqual(rows());
    expect(rows().every((row) => row.tagName === 'LI')).toBe(true);
    expect(rowIds()).toEqual(['c', 'a', 'b']);
  });

  it('numbers the rows from 1 in that order, in data-rank and in the number the slot shows (R3), which a screen reader skips', () => {
    draw(songs);
    expect(rows().map((li) => li.dataset.rank)).toEqual(['1', '2', '3']);
    const numbers = rows().map((li) => el('[data-rank-number]', li));
    expect(numbers.map((n) => n.textContent)).toEqual(['1', '2', '3']);
    expect(numbers.every((n) => n.getAttribute('aria-hidden') === 'true' && n.closest(SEL.playSlot) !== null)).toBe(true);
  });

  it('gives each row\'s title its own text once, with the copy the fill draws held in data-fill-text and not as a second node (R12)', () => {
    draw(songs);
    expect(all('[data-row-title]').map((t) => t.textContent)).toEqual(['Cello', 'Alpha', 'Bravo']);
    expect(rows().map((li) => el('[data-fill-text]', li).getAttribute('data-fill-text'))).toEqual(['Cello', 'Alpha', 'Bravo']);
    expect(screen.getAllByText('Cello')).toHaveLength(1);
    // The #1 title's looping wipe is gone: nothing marks a row by its place.
    expect(all('[data-wipe]')).toHaveLength(0);
  });

  it('names each row\'s button "title by artist, era, difficulty", with no era part for a song with no year', () => {
    draw(songs);
    expect(rows().map((li) => openButton(li).getAttribute('aria-label'))).toEqual([
      'Cello by Cara, ’00s, Hard',
      'Alpha by Ada, Pre-’70s, Easy',
      'Bravo by Bo, Maybe',
    ]);
  });

  it.each([
    ['easy', 'Easy'],
    ['medium', 'Medium'],
    ['hard', 'Hard'],
    ['maybe', 'Maybe'],
  ] as const)('a %s song reads %s', (difficulty, word) => {
    draw([rankedSong('x', { title: 'Xylo', artist: 'Xi', year: 1995, difficulty })]);
    expect(openButton(el(SEL.row)).getAttribute('aria-label')).toBe(`Xylo by Xi, ’90s, ${word}`);
  });

  it('shows "Artist · Era" under the title, and just the artist for a song with no year', () => {
    draw(songs);
    const [cello, alpha, bravo] = rows();
    expect(within(cello!).getByText('Cello')).toBeTruthy();
    expect(within(cello!).getByText('Cara · ’00s')).toBeTruthy();
    expect(within(alpha!).getByText('Ada · Pre-’70s')).toBeTruthy();
    expect(within(bravo!).getByText('Bo')).toBeTruthy();
    expect(within(bravo!).queryByText(/·/)).toBeNull();
  });

  it('takes the era from the song the engine returned: it writes it down, and does not work it out from the year', () => {
    const base = rankedSong('x', { title: 'Xylo', artist: 'Xi', year: 1995 });
    draw([{ ...base, era: 's80' }]);
    expect(openButton(el(SEL.row)).getAttribute('aria-label')).toBe('Xylo by Xi, ’80s, Easy');
    expect(within(el(SEL.row)).getByText('Xi · ’80s')).toBeTruthy();
    cleanup();

    draw([{ ...base, era: null }]);
    expect(openButton(el(SEL.row)).getAttribute('aria-label')).toBe('Xylo by Xi, Easy');
    expect(within(el(SEL.row)).getByText('Xi')).toBeTruthy();
  });

  it('opens a song from its button, with its 1-based place in the list', () => {
    const { onSelect } = draw(songs);
    const [, alpha, bravo] = rows();
    fireEvent.click(openButton(alpha!));
    fireEvent.click(openButton(bravo!));
    expect(onSelect.mock.calls).toEqual([
      ['a', 2],
      ['b', 3],
    ]);
  });
});

describe('the play slot', () => {
  const songs = [rankedSong('a'), rankedSong('b'), rankedSong('c')];
  const slots = () => all(SEL.playSlot);

  it('is beside the button that opens the song, never inside it', () => {
    draw(songs);
    expect(slots()).toHaveLength(3);
    for (const row of all(SEL.row)) {
      const slot = el(SEL.playSlot, row);
      const open = Array.from(row.children).find((c) => c.tagName === 'BUTTON')!;
      expect(open.contains(slot)).toBe(false);
      expect(slot.closest('button')).toBeNull();
      expect(slot.parentElement).toBe(row);
    }
  });

  it('holds the row\'s rank number first and the ▶ after it, one over the other in the slot (R3), and the ▶ is the glyph with no ring', () => {
    draw(songs);
    for (const slot of slots()) {
      expect(Array.from(slot.children).map((c) => (c.hasAttribute('data-rank-number') ? 'number' : c.tagName))).toEqual(['number', 'BUTTON']);
      expect(slot.querySelectorAll('svg')).toHaveLength(1);
      expect(slot.querySelectorAll('circle')).toHaveLength(0);
    }
  });

  it('holds a disabled "Play preview (not available yet)" button until playback is mounted', () => {
    draw(songs);
    for (const slot of slots()) {
      const play = within(slot).getByRole('button', { name: 'Play preview (not available yet)' }) as HTMLButtonElement;
      expect(play.disabled).toBe(true);
    }
  });

  it('holds what renderPlay returns for that row\'s song, which it is given as the match', () => {
    const renderPlay = vi.fn((m: Match): ReactNode => <button type="button" data-testid={`play-${m.track.id}`}>Play</button>);
    draw(songs, { renderPlay });
    for (const [i, row] of all(SEL.row).entries()) {
      const id = songs[i]?.match.track.id;
      expect(within(el(SEL.playSlot, row)).getByTestId(`play-${id}`)).toBeTruthy();
    }
    const given = renderPlay.mock.calls.map(([m]) => m);
    for (const s of songs) expect(given).toContain(s.match);
    expect(screen.queryByRole('button', { name: 'Play preview (not available yet)' })).toBeNull();
  });

  it('does not open the song when it is tapped: the slot, the placeholder or a mounted button', () => {
    const { onSelect, unmount } = draw(songs);
    fireEvent.click(slots()[0]!);
    fireEvent.click(within(slots()[1]!).getByRole('button'));
    expect(onSelect).not.toHaveBeenCalled();
    unmount();

    const mounted = draw(songs, { renderPlay: (m) => <button type="button" data-testid={`play-${m.track.id}`}>Play</button> });
    fireEvent.click(screen.getByTestId('play-b'));
    fireEvent.click(slots()[2]!);
    expect(mounted.onSelect).not.toHaveBeenCalled();
    // The row's own button still opens it.
    fireEvent.click(Array.from(all(SEL.row)[1]!.children).find((c) => c.tagName === 'BUTTON')!);
    expect(mounted.onSelect.mock.calls).toEqual([['b', 2]]);
  });
});

// ---- paging, loading and failing ----

describe('paging, loading and failing', () => {
  const many = ['a', 'b', 'c', 'd', 'e'].map((id) => rankedSong(id));

  it('draws only the songs shown and offers "Load more songs" while more are ranked', () => {
    const { onMore } = draw(many, { shown: 2 });
    expect(rowIds()).toEqual(['a', 'b']);
    fireEvent.click(screen.getByRole('button', { name: 'Load more songs' }));
    expect(onMore).toHaveBeenCalledTimes(1);
  });

  it.each([5, 40])('offers no "Load more songs" once every ranked song is shown (shown is %i)', (shown) => {
    draw(many, { shown });
    expect(rowIds()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(screen.queryByRole('button', { name: 'Load more songs' })).toBeNull();
  });

  it('says "Loading…" while the songs are loading, or before the engine has answered once', () => {
    draw(null);
    expect(screen.getByText('Loading…')).toBeTruthy();
    cleanup();
    draw(many, { loading: true });
    expect(screen.getByText('Loading…')).toBeTruthy();
    cleanup();
    draw(many);
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('a failed load says so and offers "Try again", with no "Load more songs" and no "Loading…"', () => {
    const { onRetry } = draw(null, { error: true });
    expect(screen.getByText('Couldn’t load songs.')).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
    const retry = screen.getByRole('button', { name: 'Try loading songs again' });
    expect(retry.textContent).toBe('Try again');
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    cleanup();

    // Even with songs left over from before, and more of them than are shown.
    draw(many, { error: true, shown: 2 });
    expect(screen.queryByRole('button', { name: 'Load more songs' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Try loading songs again' })).toBeTruthy();
  });
});

describe('when the engine sent no songs', () => {
  const PICK = 'Pick an era to see songs.';
  const NONE_IN_ERA = 'No songs from those eras fit your range. Try another era, or reset Era.';
  const NONE_CATALOGUE = 'None of our catalogue songs fit this range yet.';
  const NONE_LIBRARY = 'None of your songs have range data yet, or none fit your range.';
  const REASONS: EmptyReason[] = ['no-era-picked', 'no-songs-in-era', 'no-songs-in-range'];
  /** Which of the four empty-list notes are on screen. */
  const notes = () => [PICK, NONE_IN_ERA, NONE_CATALOGUE, NONE_LIBRARY].filter((text) => screen.queryByText(text) !== null);

  it.each(['catalogue', 'library'] as const)('asks for an era when the engine says none is picked, in %s mode', (mode) => {
    // Era on with nothing picked, which only the test hook or an old state reaches now (R23: unpicking the last era turns Era off): the
    // tuner and the engine agree, and the engine's word is what the screen reads.
    draw([], { mode, empty: 'no-era-picked', tuner: tunerOf({ off: [], eras: [] }) });
    const empty = el(SEL.empty);
    expect(empty.textContent).toBe(PICK);
    expect(empty.getAttribute('role')).toBe('status');
    expect(screen.getByText(PICK)).toBe(empty);
    expect(notes()).toEqual([PICK]);
  });

  it('says no song of the picked eras fits, and neither blames the range nor asks for an era', () => {
    draw([], { empty: 'no-songs-in-era', tuner: tunerOf({ off: [], eras: ['s20'] }) });
    expect(notes()).toEqual([NONE_IN_ERA]);
    expect(document.querySelector(SEL.empty)).toBeNull();
  });

  it.each([
    ['catalogue', NONE_CATALOGUE],
    ['library', NONE_LIBRARY],
  ] as const)('says nothing fits the range, in %s mode, for no-songs-in-range and for no reason at all', (mode, text) => {
    for (const empty of ['no-songs-in-range', undefined] as const) {
      draw([], { mode, empty });
      expect(notes()).toEqual([text]);
      expect(document.querySelector(SEL.empty)).toBeNull();
      cleanup();
    }
  });

  it('does not work it out from the tuner: Era on with nothing picked, and no reason from the engine, is only the range message', () => {
    draw([], { tuner: tunerOf({ off: [], eras: [] }) });
    expect(document.querySelector(SEL.empty)).toBeNull();
    expect(notes()).toEqual([NONE_CATALOGUE]);
  });

  it.each<[string, SetlistSong[] | null, Overrides]>([
    ['the songs are still loading', [], { loading: true }],
    ['the engine has not answered yet', null, {}],
    ['the load failed', [], { error: true }],
    ['songs are listed', [rankedSong('a')], {}],
  ])('shows none of them when %s, whatever the reason', (_why, songs, overrides) => {
    for (const empty of REASONS) {
      draw(songs, { ...overrides, empty });
      expect(notes()).toEqual([]);
      expect(document.querySelector(SEL.empty)).toBeNull();
      cleanup();
    }
  });
});

// ---- the test hook ----

describe('window.setlist, the test hook (spec §9)', () => {
  interface TestHook {
    getState(): TunerState;
    setState(patch: Partial<TunerState>): void;
    ranking(): string[];
    songs(): { id: string; title: string; artist: string; era: EraId | null }[];
  }
  const hook = () => (window as unknown as { setlist?: TestHook }).setlist;
  const need = (): TestHook => {
    const found = hook();
    if (!found) throw new Error('window.setlist is not there');
    return found;
  };
  const songs = [
    rankedSong('c', { title: 'Cello', artist: 'Cara', year: 2004, difficulty: 'hard' }, { difficulty: 90 }),
    rankedSong('a', { title: 'Alpha', artist: 'Ada', year: 1969 }),
    rankedSong('b', { title: 'Bravo', artist: 'Bo', year: null, difficulty: 'medium' }),
  ];

  it('exists only when NEXT_PUBLIC_SETLIST_TEST_HOOK is "1"', () => {
    vi.stubEnv('NEXT_PUBLIC_SETLIST_TEST_HOOK', '1');
    draw(songs);
    expect(hook()).toBeDefined();
  });

  it.each([undefined, '0', '', 'true'])('is not there when the variable is %j', (value) => {
    vi.stubEnv('NEXT_PUBLIC_SETLIST_TEST_HOOK', value);
    draw(songs);
    expect(hook()).toBeUndefined();
  });

  it('is removed when the screen goes', () => {
    vi.stubEnv('NEXT_PUBLIC_SETLIST_TEST_HOOK', '1');
    const { unmount } = draw(songs);
    expect(hook()).toBeDefined();
    unmount();
    expect(hook()).toBeUndefined();
  });

  it('getState gives a copy of the tuner', () => {
    vi.stubEnv('NEXT_PUBLIC_SETLIST_TEST_HOOK', '1');
    const tuner = tunerOf({ tempo: 77, eras: ['s80'] });
    draw(songs, { tuner });
    const state = need().getState();
    expect(state).toEqual(tuner);
    expect(state).not.toBe(tuner);
    state.off.push('difficulty');
    state.eras.push('s20');
    expect(tuner.off).not.toContain('difficulty');
    expect(tuner.eras).toEqual(['s80']);
  });

  it('ranking gives the titles in rank order, and songs the id, title, artist and era of each row (no difficulty)', () => {
    vi.stubEnv('NEXT_PUBLIC_SETLIST_TEST_HOOK', '1');
    draw(songs);
    expect(need().ranking()).toEqual(['Cello', 'Alpha', 'Bravo']);
    expect(need().songs()).toEqual([
      { id: 'c', title: 'Cello', artist: 'Cara', era: 's00' },
      { id: 'a', title: 'Alpha', artist: 'Ada', era: 'pre' },
      { id: 'b', title: 'Bravo', artist: 'Bo', era: null },
    ]);
  });

  it('setState asks for a patch of the tuner', () => {
    vi.stubEnv('NEXT_PUBLIC_SETLIST_TEST_HOOK', '1');
    const { onTuner } = draw(songs);
    need().setState({ tempo: 90, mini: true });
    expect(calls(onTuner)).toEqual([{ type: 'patch', patch: { tempo: 90, mini: true } }]);
  });

  it('follows the latest props, and is the same object across renders', () => {
    vi.stubEnv('NEXT_PUBLIC_SETLIST_TEST_HOOK', '1');
    const { update, onTuner } = draw(songs);
    const first = need();
    update({ songs: [...songs].reverse(), tuner: tunerOf({ tempo: 12 }) });
    expect(hook()).toBe(first);
    expect(first.ranking()).toEqual(['Bravo', 'Alpha', 'Cello']);
    expect(first.getState().tempo).toBe(12);
    first.setState({ tempo: 13 });
    expect(calls(onTuner)).toEqual([{ type: 'patch', patch: { tempo: 13 } }]);
  });
});
