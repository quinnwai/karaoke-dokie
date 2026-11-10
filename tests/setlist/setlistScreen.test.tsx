// @vitest-environment jsdom
// The Setlist screen's DOM contract (QWW-46; spec §3, §4, §4a, §8 and §9): what the sheet draws in each mode, the handle
// and its drag, the gear strips and their reset buttons, the Era panel, the ranked list, the loading and empty states,
// and the `window.setlist` test hook. The screen holds no ranking, so each test hands it the songs a ranking engine
// returned and checks what it draws and which callbacks it makes. jsdom applies no CSS, so layout, drag feel and
// animation are tests/e2e's, not these.
import { cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { useReducer, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetlistScreen, type SetlistScreenProps } from '../../src/components/setlist/SetlistScreen';
import type { Match, ResultsMode } from '../../src/lib/contracts';
import { EASY, HARD, MID, rowLane } from '../../src/lib/setlist/art';
import { DEFAULTS } from '../../src/lib/setlist/defaults';
import { initialTuner, tunerReducer, type TunerAction } from '../../src/lib/setlist/tuner';
import { GEAR_IDS, TUNER_PARTS, type EmptyReason, type EraId, type GearId, type SetlistSong, type TunerState } from '../../src/lib/setlist/types';
import { all, el, RANGE, rankedSong, rowIds, SEL, setlistProps } from '../helpers/setlist';

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

/** Lets the zero-delay timer a slider uses to look at a finished press run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

const hidden = (selector: string) => el(selector).hasAttribute('hidden');

// ---- the screen ----

describe('the screen', () => {
  it('is the main region, headed "Tune your setlist", with no TV frame around it', () => {
    draw();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Tune your setlist']);
    expect(el(SEL.app).tagName).toBe('MAIN');
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

  it('has a tab for each gear and for Era, in sheet order', () => {
    mini();
    expect(all(`${SEL.tabs} [data-tab]`).map((t) => t.dataset.gear)).toEqual(['difficulty', 'history', 'popularity', 'tempo', 'era']);
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

// ---- the gears ----

describe('gear strips', () => {
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
});

describe('History', () => {
  const HINT = 'Connect Spotify to use your listening history';
  const strip = () => el(SEL.strip('history'));

  it('is off and disabled while signed out, and says why in place of its track', () => {
    draw();
    const input = el<HTMLInputElement>(SEL.slider('history'));
    expect(input.disabled).toBe(true);
    const hint = within(strip()).getByText(HINT);
    expect(input.getAttribute('aria-describedby')).toBe(hint.id);
    expect(hint.id).not.toBe('');
    // The track (the strip's one aria-hidden div; the art is an svg and the OFF tag a span) and its end labels are not drawn.
    expect(strip().querySelector('div[aria-hidden="true"]')).toBeNull();
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
    fireEvent.pointerDown(el(SEL.slider('history')));
    expect(calls(onTuner)).toEqual([{ type: 'touch', gear: 'history' }]);
  });
});

describe('reset buttons', () => {
  const LABEL: Record<(typeof TUNER_PARTS)[number], string> = {
    difficulty: 'Reset difficulty (stop factoring it in)',
    history: 'Reset listening history (stop factoring it in)',
    popularity: 'Reset popularity (stop factoring it in)',
    tempo: 'Reset tempo (stop factoring it in)',
    era: 'Reset era (stop factoring it in)',
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
    expect(button.getAttribute('title')).toBe("Reset: don't factor in");
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

  it('a tap on an off gear that moves nothing turns it on, and is one adjustment', async () => {
    // Tempo starts off. A tap exactly on the default fires no input and no change, so the press itself has to say so.
    const { onTuner, onGearDone } = draw();
    const slider = el(SEL.slider('tempo'));
    fireEvent.pointerDown(slider);
    expect(calls(onTuner)).toEqual([{ type: 'touch', gear: 'tempo' }]);
    expect(onGearDone).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    await settle();
    expect(calls(onGearDone)).toEqual(['tempo']);
    expect(onTuner).toHaveBeenCalledTimes(1);
  });

  it('a tap on an off gear that does move ends once, not twice', async () => {
    const { onTuner, onGearDone } = draw();
    const slider = el(SEL.slider('tempo'));
    fireEvent.pointerDown(slider);
    fireEvent.input(slider, { target: { value: '60' } });
    fireEvent.pointerUp(slider);
    // The browser's change follows the pointer-up in the same task, when the value moved.
    fireEvent.change(slider);
    await settle();
    expect(calls(onTuner)).toEqual([
      { type: 'touch', gear: 'tempo' },
      { type: 'input', gear: 'tempo', value: 60 },
    ]);
    expect(calls(onGearDone)).toEqual(['tempo']);
  });

  it('a press on a gear that is on changes nothing and ends nothing', async () => {
    const { onTuner, onGearDone } = draw();
    const slider = el(SEL.slider('difficulty'));
    fireEvent.pointerDown(slider);
    fireEvent.pointerUp(slider);
    await settle();
    expect(onTuner).not.toHaveBeenCalled();
    expect(onGearDone).not.toHaveBeenCalled();
  });

  it('a press of the primary button (button 0) turns an off gear on, as a plain press does', async () => {
    const { onTuner, onGearDone } = draw();
    const slider = el(SEL.slider('tempo'));
    pointer('pointerDown', slider, undefined, 0);
    pointer('pointerUp', slider, undefined, 0);
    await settle();
    expect(calls(onTuner)).toEqual([{ type: 'touch', gear: 'tempo' }]);
    expect(calls(onGearDone)).toEqual(['tempo']);
  });

  // A right or middle click is not a tap: it must not switch a gear on, or end an adjustment that never began.
  it.each([
    ['middle', 1],
    ['right', 2],
  ] as const)('a %s-button press on an off gear turns nothing on and ends nothing, and the next plain tap still counts once', async (_name, button) => {
    const { onTuner, onGearDone } = draw();
    const slider = el(SEL.slider('tempo'));
    pointer('pointerDown', slider, undefined, button);
    pointer('pointerUp', slider, undefined, button);
    await settle();
    expect(onTuner).not.toHaveBeenCalled();
    expect(onGearDone).not.toHaveBeenCalled();

    fireEvent.pointerDown(slider);
    fireEvent.pointerUp(slider);
    await settle();
    expect(calls(onTuner)).toEqual([{ type: 'touch', gear: 'tempo' }]);
    expect(calls(onGearDone)).toEqual(['tempo']);
  });

  it('a cancelled press on an off gear (the browser took it for a scroll) turns it on and ends that adjustment once', async () => {
    // No pointer-up and no change follow a cancelled press, so the cancel is what ends it.
    const { onTuner, onGearDone } = draw();
    const slider = el(SEL.slider('tempo'));
    fireEvent.pointerDown(slider);
    fireEvent.pointerCancel(slider);
    expect(calls(onTuner)).toEqual([{ type: 'touch', gear: 'tempo' }]);
    await settle();
    expect(calls(onGearDone)).toEqual(['tempo']);
  });

  it('a press the browser cancelled for a scroll does not make the next plain tap look like an adjustment', async () => {
    const onGearDone = vi.fn<(gear: GearId) => void>();
    render(<Tuned initial={tunerOf({ off: ['tempo'] })} onGearDone={onGearDone} />);
    const slider = el(SEL.slider('tempo'));
    fireEvent.pointerDown(slider);
    fireEvent.pointerCancel(slider);
    await settle();
    // The cancelled press turned Tempo on, and that was the one adjustment.
    expect(calls(onGearDone)).toEqual(['tempo']);
    // Tempo is on now. A later tap on it that moves nothing is not another one.
    fireEvent.pointerDown(slider);
    fireEvent.pointerUp(slider);
    await settle();
    expect(calls(onGearDone)).toEqual(['tempo']);
  });
});

// ---- Era ----

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

  it('is a group labelled "ERA: PICK ANY"', () => {
    draw();
    const group = screen.getByRole('group', { name: 'ERA: PICK ANY' });
    expect(group).toBe(el(SEL.eraPanel));
    const labelledBy = group.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy ?? '')?.firstChild?.textContent).toBe('ERA: PICK ANY');
  });

  it('Era off, as every singer starts: no era is pressed or outlined (the defaults have no picks), the panel says OFF and has nothing to reset', () => {
    // QWW-47's defaults have no picks, so with Era off nothing is outlined at all.
    expect(DEFAULTS.eras).toEqual([]);
    draw();
    expect(buttons().map((b) => b.getAttribute('aria-pressed'))).toEqual(Array(7).fill('false'));
    expect(parked()).toEqual([...DEFAULTS.eras]);
    expect(el(SEL.eraPanel).hasAttribute('data-off')).toBe(true);
    expect(el('#era-label [aria-hidden="true"]').textContent).toBe(' · OFF');
    expect(hidden(SEL.reset('era'))).toBe(true);
  });

  it('Era off with picks held: no era is pressed, the picks it holds are outlined (parked), and none counts', () => {
    draw([rankedSong('a')], signedIn({ off: ['era'], eras: ['s90', 's00', 's10'] }));
    expect(buttons().map((b) => b.getAttribute('aria-pressed'))).toEqual(Array(7).fill('false'));
    expect(parked()).toEqual(['s90', 's00', 's10']);
    expect(el(SEL.eraPanel).hasAttribute('data-off')).toBe(true);
    expect(el('#era-label [aria-hidden="true"]').textContent).toBe(' · OFF');
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

  it('Era on with nothing picked is not Era off: nothing pressed or parked, and the reset stays', () => {
    draw([], signedIn({ off: [], eras: [] }));
    expect(pressed()).toEqual([]);
    expect(parked()).toEqual([]);
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
  const openButton = (row: HTMLElement): HTMLButtonElement => {
    const button = row.querySelector('button');
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

  it('numbers the rows from 1 in that order', () => {
    draw(songs);
    expect(rows().map((li) => li.dataset.rank)).toEqual(['1', '2', '3']);
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

describe('the lane at the end of a row (spec §5)', () => {
  /** jsdom writes an inline colour back as rgb(...), whatever it was given. */
  const rgb = (hex: string) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
  };
  const rowOf = (id: string) => el(`[data-id="${id}"]`);
  const openButton = (row: HTMLElement) => el('button', row);
  /** The elements of a row whose CSS-module class is `name` (vitest renames `lane` to something like `_lane_ab12cd`). */
  const named = (row: HTMLElement, name: string) => all(`[class*="_${name}_"]`, row);

  it.each([
    [10, EASY],
    [50, MID],
    [90, HARD],
  ])('a song at place %i on Difficulty draws a band and three dashes in %s', (place, color) => {
    draw([rankedSong('x', {}, { difficulty: place })]);
    const row = rowOf('x');
    const [lane] = named(row, 'lane');
    expect(named(row, 'lane')).toHaveLength(1);
    expect(lane!.getAttribute('aria-hidden')).toBe('true');
    const [band] = named(row, 'laneBand');
    const dashes = named(row, 'laneDash');
    expect(named(row, 'laneBand')).toHaveLength(1);
    expect(dashes).toHaveLength(3);
    expect(named(row, 'laneNone')).toHaveLength(0);

    // The numbers come from rowLane (tests/setlist/art.test.ts has the spec's arithmetic for it).
    const expected = rowLane(place);
    expect(expected.color).toBe(color);
    expect([band!.style.top, band!.style.height]).toEqual([`${expected.bandTop}px`, `${expected.bandHeight}px`]);
    expect(dashes.map((d) => d.style.top)).toEqual(expected.dashTop.map((top) => `${top}px`));
    expect(dashes.map((d) => [d.style.left, d.style.width])).toEqual([
      ['3px', '10px'],
      ['16px', '12px'],
      ['31px', '10px'],
    ]);
    for (const part of [band!, ...dashes]) expect(part.style.background).toBe(rgb(color));
  });

  it('is drawn from the song\'s place, not from its label: a Hard song placed low is green', () => {
    draw([rankedSong('h', { difficulty: 'hard' }, { difficulty: 10 })]);
    const [band] = named(rowOf('h'), 'laneBand');
    expect(band!.style.background).toBe(rgb(EASY));
  });

  it('a song with no place on Difficulty draws no lane, only a spacer where it would be, so the rows stay aligned', () => {
    draw([rankedSong('a', {}, { difficulty: 40 }), rankedSong('n', {}, { difficulty: null })]);
    const [withLane, without] = [rowOf('a'), rowOf('n')] as [HTMLElement, HTMLElement];

    expect(named(without, 'lane')).toHaveLength(0);
    expect(named(without, 'laneBand')).toHaveLength(0);
    expect(named(without, 'laneDash')).toHaveLength(0);
    const spacer = named(without, 'laneNone');
    expect(spacer).toHaveLength(1);
    expect(spacer[0]!.getAttribute('aria-hidden')).toBe('true');
    expect(spacer[0]!.children).toHaveLength(0);
    // It stands where the lane stands: last in the button that opens the song.
    expect(openButton(without).lastElementChild).toBe(spacer[0]);
    expect(openButton(withLane).lastElementChild).toBe(named(withLane, 'lane')[0]);
    expect(named(withLane, 'laneNone')).toHaveLength(0);
    // The rest of the row is as for any song: its words, its place in the list and its play slot.
    expect(openButton(without).getAttribute('aria-label')).toBe('Song n by Artist n, ’90s, Easy');
    expect(without.dataset.rank).toBe('2');
    expect(without.querySelector(SEL.playSlot)).not.toBeNull();
  });
});

describe('the lane of a Maybe song', () => {
  const rowOf = (id: string) => el(`[data-id="${id}"]`);
  const named = (row: HTMLElement, name: string) => all(`[class*="_${name}_"]`, row);

  it('is not drawn, whatever place the engine gave the song on Difficulty: only the spacer stands where it would', () => {
    // Its range is only an estimate, so no difficulty is shown anywhere. The sure song has the same place, and its lane.
    draw([rankedSong('m', { difficulty: 'maybe' }, { difficulty: 60 }), rankedSong('s', { difficulty: 'hard' }, { difficulty: 60 })]);
    const [maybe, sure] = [rowOf('m'), rowOf('s')] as [HTMLElement, HTMLElement];

    expect(named(maybe, 'lane')).toHaveLength(0);
    expect(named(maybe, 'laneBand')).toHaveLength(0);
    expect(named(maybe, 'laneDash')).toHaveLength(0);
    const spacer = named(maybe, 'laneNone');
    expect(spacer).toHaveLength(1);
    expect(spacer[0]!.getAttribute('aria-hidden')).toBe('true');
    expect(spacer[0]!.children).toHaveLength(0);
    expect(el('button', maybe).lastElementChild).toBe(spacer[0]);

    expect(named(sure, 'lane')).toHaveLength(1);
    expect(named(sure, 'laneBand')).toHaveLength(1);
    expect(named(sure, 'laneNone')).toHaveLength(0);
  });

  it('keeps its words: the row still says Maybe, and a Maybe row lines up with the rows around it', () => {
    draw([rankedSong('a', {}, { difficulty: 20 }), rankedSong('m', { difficulty: 'maybe' }, { difficulty: 20 }), rankedSong('b', {}, { difficulty: 20 })]);
    expect(el('button', rowOf('m')).getAttribute('aria-label')).toBe('Song m by Artist m, ’90s, Maybe');
    // Every row ends its button with exactly one lane-sized element, a lane or a spacer, so the rows stay aligned.
    for (const id of ['a', 'm', 'b']) {
      expect(named(rowOf(id), 'lane').length + named(rowOf(id), 'laneNone').length, `row ${id}`).toBe(1);
    }
    expect(all(SEL.row).map((li) => li.dataset.rank)).toEqual(['1', '2', '3']);
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
      const open = el('button', row);
      expect(open.contains(slot)).toBe(false);
      expect(slot.closest('button')).toBeNull();
      expect(slot.parentElement).toBe(row);
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
    fireEvent.click(el('button', all(SEL.row)[1]!));
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
    // Era on with nothing picked: the tuner and the engine agree, and the engine's word is what the screen reads.
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
