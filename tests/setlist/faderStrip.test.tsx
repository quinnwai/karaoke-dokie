// @vitest-environment jsdom
// QWW-57, R33: what a press on a gear's fader does to the gear (the hit area in src/components/setlist/GearStrip.tsx). jsdom lays nothing
// out, so the hit area is given a box and a pointer is aimed with `faderX` (tests/helpers/fader.ts). What the browser does with the
// touch itself (touch-action, the cancel a swipe gets, where the box is on a phone) is tests/e2e/setlist-fader.spec.ts.
//
// The rules: a mouse or a pen is on the fader at once (the value jumps to it, and a drag follows); a finger that lands waits, and moves
// nothing until it is a tap (the thumb jumps to where it lifted) or a drag past the slop that is mostly sideways. A swipe that is mostly
// up or down leaves the gear alone. An adjustment is a press that did something, and it ends when its pointer goes.

import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GearStrip } from '../../src/components/setlist/GearStrip';
import { DEFAULTS } from '../../src/lib/setlist/defaults';
import { TOUCH_SLOP_PX } from '../../src/lib/setlist/fader';
import { fader, faderPointer, faderX } from '../helpers/fader';

afterEach(cleanup);

/** Tempo, which starts off at its default, unless the test says otherwise. */
function strip(over: Partial<ComponentProps<typeof GearStrip>> = {}) {
  const onInput = vi.fn<(value: number) => void>();
  const onTouch = vi.fn<() => void>();
  const onDone = vi.fn<() => void>();
  const onRevert = vi.fn<() => void>();
  const view = render(
    <GearStrip gear="tempo" value={DEFAULTS.tempo} off hidden={false} onInput={onInput} onTouch={onTouch} onReset={vi.fn()} onDone={onDone} onRevert={onRevert} {...over} />,
  );
  return { ...view, onInput, onTouch, onDone, onRevert, hit: fader('tempo') };
}

const values = (fn: { mock: { calls: number[][] } }) => fn.mock.calls.map(([value]) => value);

describe('a mouse press on the fader', () => {
  it('jumps the value to the pointer and a drag follows it, each step once, and lets go as one adjustment', () => {
    const { hit, onInput, onTouch, onDone } = strip({ value: 30, off: false });
    faderPointer('pointerDown', hit, { x: faderX(60) });
    expect(values(onInput)).toEqual([60]);
    faderPointer('pointerMove', hit, { x: faderX(60) + 0.4 }); // the same step
    faderPointer('pointerMove', hit, { x: faderX(75) });
    faderPointer('pointerMove', hit, { x: faderX(90) });
    expect(values(onInput)).toEqual([60, 75, 90]);
    expect(onDone).not.toHaveBeenCalled();
    faderPointer('pointerUp', hit, { x: faderX(90) });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onTouch).not.toHaveBeenCalled();
  });

  it('turns an off gear on first, and then sets the value, as one adjustment', () => {
    const { hit, onInput, onTouch, onDone } = strip();
    faderPointer('pointerDown', hit, { x: faderX(70) });
    expect(onTouch).toHaveBeenCalledTimes(1);
    expect(values(onInput)).toEqual([70]);
    expect(onTouch.mock.invocationCallOrder[0]).toBeLessThan(onInput.mock.invocationCallOrder[0]!);
    faderPointer('pointerUp', hit, { x: faderX(70) });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('on the knob of an off gear turns it on at its default and sets nothing, which is one adjustment', () => {
    const { hit, onInput, onTouch, onDone } = strip();
    faderPointer('pointerDown', hit, { x: faderX(DEFAULTS.tempo) });
    expect(onTouch).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    faderPointer('pointerUp', hit, { x: faderX(DEFAULTS.tempo) });
    expect(onInput).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('on the knob of a gear that is on changes nothing and is not an adjustment', () => {
    const { hit, onInput, onTouch, onDone } = strip({ value: 30, off: false });
    faderPointer('pointerDown', hit, { x: faderX(30) });
    faderPointer('pointerUp', hit, { x: faderX(30) });
    expect(onInput).not.toHaveBeenCalled();
    expect(onTouch).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('follows a pointer that has left the area, up to each end of the track and no further', () => {
    const { hit, onInput } = strip({ value: 30, off: false });
    faderPointer('pointerDown', hit, { x: faderX(50) });
    faderPointer('pointerMove', hit, { x: faderX(100) + 300, y: -200 });
    faderPointer('pointerMove', hit, { x: faderX(0) - 300, y: 500 });
    expect(values(onInput)).toEqual([50, 100, 0]);
  });

  it('is the same for a pen', () => {
    const { hit, onInput, onTouch, onDone } = strip();
    faderPointer('pointerDown', hit, { kind: 'pen', x: faderX(40) });
    faderPointer('pointerMove', hit, { kind: 'pen', x: faderX(45) });
    faderPointer('pointerUp', hit, { kind: 'pen', x: faderX(45) });
    expect(onTouch).toHaveBeenCalledTimes(1);
    expect(values(onInput)).toEqual([40, 45]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('is not moved by a pointer that is only passing over it', () => {
    const { hit, onInput, onTouch, onDone } = strip({ value: 30, off: false });
    faderPointer('pointerMove', hit, { x: faderX(40) });
    faderPointer('pointerUp', hit, { x: faderX(40) });
    expect([onInput, onTouch, onDone].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
  });

  // A right or middle click is not a press: it must not switch a gear on, or move it, or end an adjustment that never began.
  it.each([
    ['middle', 1],
    ['right', 2],
  ] as const)('is not a press with the %s button: nothing is turned on, moved or recorded, and the next plain press still counts once', (_name, button) => {
    const { hit, onInput, onTouch, onDone } = strip();
    faderPointer('pointerDown', hit, { x: faderX(70), button });
    faderPointer('pointerMove', hit, { x: faderX(80), button });
    faderPointer('pointerUp', hit, { x: faderX(80), button });
    expect([onInput, onTouch, onDone].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);

    faderPointer('pointerDown', hit, { x: faderX(DEFAULTS.tempo) });
    faderPointer('pointerUp', hit, { x: faderX(DEFAULTS.tempo) });
    expect(onTouch).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('is ended where it is by a cancel, once, and the pointer is not followed after it', () => {
    const { hit, onInput, onDone } = strip({ value: 30, off: false });
    faderPointer('pointerDown', hit, { x: faderX(50) });
    faderPointer('pointerCancel', hit, { x: faderX(50) });
    expect(onDone).toHaveBeenCalledTimes(1);
    faderPointer('pointerMove', hit, { x: faderX(80) });
    faderPointer('pointerUp', hit, { x: faderX(80) });
    expect(values(onInput)).toEqual([50]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('the focus after a press', () => {
  it('is the browser\'s, as a mouse\'s: the strip does not script it at the press, and the area is a plain element (a second label in the strip would be one more for the browser tests and the readers to meet)', () => {
    const { hit } = strip({ value: 30, off: false });
    expect(hit.tagName).toBe('DIV');
    expect(document.querySelectorAll('label')).toHaveLength(1);
    for (const kind of ['mouse', 'pen', 'touch'] as const) {
      faderPointer('pointerDown', hit, { kind, x: faderX(60) });
      faderPointer('pointerUp', hit, { kind, x: faderX(60) });
    }
    expect(document.activeElement).not.toBe(document.getElementById('slider-tempo'));
  });

  it('is given by the click a mouse press ends in: the title is clicked, which the browser answers with a label\'s focus (a mouse\'s: no keyboard ring until a key), and where that leaves the slider unfocused it is focused with focusVisible false', () => {
    const { hit } = strip({ value: 30, off: false });
    const title = document.querySelector('label')!;
    const clicked = vi.fn();
    title.addEventListener('click', clicked);
    const slider = document.getElementById('slider-tempo') as HTMLInputElement;
    const focus = vi.spyOn(slider, 'focus');
    faderPointer('pointerDown', hit, { x: faderX(60) });
    faderPointer('pointerUp', hit, { x: faderX(60) });
    fireEvent.click(hit, { detail: 1 });
    expect(clicked, 'the title is clicked once').toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true, focusVisible: false });
    // A finger's press does neither: it has no keys.
    clicked.mockClear();
    focus.mockClear();
    faderPointer('pointerDown', hit, { kind: 'touch', x: faderX(40) });
    faderPointer('pointerUp', hit, { kind: 'touch', x: faderX(40) });
    fireEvent.click(hit, { detail: 1 });
    expect(clicked).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it('is not taken at the press: the mousedown after it is the browser\'s and is not cancelled', () => {
    const { hit } = strip({ value: 30, off: false });
    faderPointer('pointerDown', hit, { x: faderX(60) });
    expect(fireEvent.mouseDown(hit), 'the mousedown is the browser\'s, not cancelled').toBe(true);
  });
});

describe('where a press is: the finger\'s position, not the element the browser names', () => {
  /** A press as Chromium gives it for a touch with a radius: the event names an element near the finger (the title, the ✕), and its position is the finger's. */
  const named = (el: Element, init: { x: number; y: number }) => faderPointer('pointerDown', el, { kind: 'touch', ...init });
  const title = () => document.querySelector('label')!;
  const reset = () => document.querySelector('button[data-reset]')!;

  it('a press in the fader\'s area is the fader\'s though the event names the ✕ or the title (a finger 16 px above the thumb, from a radius of 12)', () => {
    const { onInput, onTouch, onDone } = strip({ value: 30, off: false });
    for (const el of [reset(), title()]) {
      named(el, { x: faderX(70), y: 1 });
      faderPointer('pointerUp', el, { kind: 'touch', x: faderX(70), y: 1 });
    }
    expect(values(onInput)).toEqual([70, 70]);
    expect(onTouch).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(2);
  });

  it('a press outside the fader\'s area is not, though the event names the fader: a second tap on a ✕ that has gone, or a tap between the title and the ✕', () => {
    const { hit, onInput, onTouch, onDone } = strip({ value: 30, off: false });
    for (const y of [-3, -12, 44, 60]) {
      named(hit, { x: faderX(70), y });
      faderPointer('pointerUp', hit, { kind: 'touch', x: faderX(70), y });
    }
    for (const x of [faderX(0) - 12, faderX(100) + 12]) {
      named(hit, { x, y: 20 });
      faderPointer('pointerUp', hit, { kind: 'touch', x, y: 20 });
    }
    expect([onInput, onTouch, onDone].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it('a mouse press outside the area does nothing either, and the pointer that began in the area is followed outside it', () => {
    const { hit, onInput } = strip({ value: 30, off: false });
    faderPointer('pointerDown', hit, { x: faderX(60), y: -5 });
    expect(onInput).not.toHaveBeenCalled();
    faderPointer('pointerDown', hit, { x: faderX(60), y: 10 });
    faderPointer('pointerMove', hit, { x: faderX(90), y: 500 });
    expect(values(onInput)).toEqual([60, 90]);
  });
});

describe('the ✕\'s click', () => {
  const reset = () => document.querySelector<HTMLElement>('button[data-reset]')!;
  /** A click as a finger makes it (`detail` 1), after a press where `pressAt` says, with the ✕'s box where `box` says (jsdom lays nothing out). */
  const tapWith = (pressAt: { x: number; y: number }, box: { x: number; y: number; w: number; h: number }) => {
    reset().getBoundingClientRect = () => new DOMRect(box.x, box.y, box.w, box.h);
    faderPointer('pointerDown', reset(), { kind: 'touch', ...pressAt });
    fireEvent.click(reset(), { detail: 1 });
  };

  it('counts when the finger pressed on the ✕\'s box, and a key press or a screen reader\'s click (detail 0) always counts', () => {
    const onReset = vi.fn();
    strip({ value: 30, off: false, onReset });
    tapWith({ x: 330, y: 8 }, { x: 300, y: 0, w: 44, h: 20 });
    expect(onReset).toHaveBeenCalledTimes(1);
    tapWith({ x: 100, y: 500 }, { x: 300, y: 0, w: 44, h: 20 });
    fireEvent.click(reset(), { detail: 0 });
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it('does not count when the press was somewhere else: the browser gave the ✕ the click of a tap on the fader, or beside the ✕', () => {
    const onReset = vi.fn();
    strip({ value: 30, off: false, onReset });
    tapWith({ x: 300, y: 30 }, { x: 300, y: 0, w: 44, h: 20 }); // the thumb under the ✕
    tapWith({ x: 250, y: 8 }, { x: 300, y: 0, w: 44, h: 20 }); // beside it
    expect(onReset).not.toHaveBeenCalled();
  });
});

describe('the fader after a finger\'s tap on the ✕ (the gates on 4e324f5 and 5ab0be7)', () => {
  const reset = () => document.querySelector<HTMLElement>('button[data-reset]')!;
  /** A finger's tap on the ✕ (a press on its box, then the click), or a mouse's. */
  const tapReset = (kind: 'touch' | 'mouse') => {
    reset().getBoundingClientRect = () => new DOMRect(300, 0, 44, 20);
    faderPointer('pointerDown', reset(), { kind, x: 330, y: 8 });
    fireEvent.click(reset(), { detail: 1 });
  };
  /** A tap on the fader a little below where the ✕ was, in its area (the strip's area starts at y 0 in jsdom). */
  const tapFader = (hit: HTMLElement, value: number, kind: 'touch' | 'mouse' = 'touch') => {
    faderPointer('pointerDown', hit, { kind, x: faderX(value), y: 12 });
    faderPointer('pointerUp', hit, { kind, x: faderX(value), y: 12 });
  };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds a finger\'s presses on the fader for 400 ms, so the second tap of a double tap, a little lower than the first, in the fader\'s area, does not turn the gear back on', () => {
    const onReset = vi.fn();
    const { hit, onInput, onTouch, onDone } = strip({ value: 30, off: false, onReset });
    tapReset('touch');
    expect(onReset).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_000_000 + 150);
    tapFader(hit, 96);
    vi.setSystemTime(1_000_000 + 399);
    tapFader(hit, 96);
    expect([onInput, onTouch, onDone].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it('is a moment: a tap after it is a choice, and works', () => {
    const { hit, onInput, onDone } = strip({ value: 30, off: false, onReset: vi.fn() });
    tapReset('touch');
    vi.setSystemTime(1_000_000 + 401);
    tapFader(hit, 70);
    expect(values(onInput)).toEqual([70]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('is 400 ms from the tap on the ✕ and no more: a run of taps it holds does not put it off, and a tap 450 ms after the ✕ works, whatever was held before it (the gate on 5ab0be7)', () => {
    const { hit, onInput, onDone } = strip({ value: 30, off: false, onReset: vi.fn() });
    tapReset('touch');
    for (const at of [60, 160, 260, 360, 399]) {
      vi.setSystemTime(1_000_000 + at);
      tapFader(hit, 90);
    }
    expect(onInput).not.toHaveBeenCalled();
    vi.setSystemTime(1_000_000 + 450);
    tapFader(hit, 90);
    expect(values(onInput)).toEqual([90]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('is no longer for a drag: one that starts 450 ms after the ✕ follows the finger, after taps it held (the gate on 5ab0be7)', () => {
    const { hit, onInput, onDone } = strip({ value: 30, off: false, onReset: vi.fn() });
    tapReset('touch');
    for (const at of [100, 250, 399]) {
      vi.setSystemTime(1_000_000 + at);
      tapFader(hit, 90);
    }
    expect(onInput).not.toHaveBeenCalled();
    vi.setSystemTime(1_000_000 + 450);
    const finger = { kind: 'touch' as const, y: 12, id: 7 };
    faderPointer('pointerDown', hit, { ...finger, x: faderX(20) });
    faderPointer('pointerMove', hit, { ...finger, x: faderX(40) });
    faderPointer('pointerMove', hit, { ...finger, x: faderX(60) });
    faderPointer('pointerUp', hit, { ...finger, x: faderX(60) });
    expect(values(onInput)).toEqual([40, 60]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('is counted from the tap on the ✕ alone: a tap held at 399 ms has not moved the end of it, so a tap at 401 ms works', () => {
    const { hit, onInput } = strip({ value: 30, off: false, onReset: vi.fn() });
    tapReset('touch');
    vi.setSystemTime(1_000_000 + 399);
    tapFader(hit, 90);
    expect(onInput).not.toHaveBeenCalled();
    vi.setSystemTime(1_000_000 + 401);
    tapFader(hit, 70);
    expect(values(onInput)).toEqual([70]);
  });

  it('is not a mouse\'s: a click on the ✕ with a mouse and a click on the track right after are two choices', () => {
    const { hit, onInput } = strip({ value: 30, off: false, onReset: vi.fn() });
    tapReset('mouse');
    vi.setSystemTime(1_000_000 + 100);
    tapFader(hit, 90, 'mouse');
    expect(values(onInput)).toEqual([90]);
  });

  it('is not started by a key or a screen reader\'s click on the ✕ either (detail 0)', () => {
    const { hit, onInput } = strip({ value: 30, off: false, onReset: vi.fn() });
    // A finger went down on the ✕ (and lifted off it somewhere else, with no click), so the last press is a finger's, not a mouse's left from an earlier test: the key's
    // click is then judged on its detail alone.
    reset().getBoundingClientRect = () => new DOMRect(300, 0, 44, 20);
    faderPointer('pointerDown', reset(), { kind: 'touch', x: 330, y: 8 });
    fireEvent.click(reset(), { detail: 0 });
    vi.setSystemTime(1_000_000 + 100);
    tapFader(hit, 90);
    expect(values(onInput)).toEqual([90]);
  });
});

describe('a finger on the fader', () => {
  const finger = (x: number, y = 0, id = 1) => ({ kind: 'touch' as const, x, y, id });

  it('landing changes nothing: the thumb does not jump and an off gear stays off, in case the finger is about to scroll', () => {
    const { hit, onInput, onTouch, onDone } = strip();
    faderPointer('pointerDown', hit, finger(faderX(80)));
    expect([onInput, onTouch, onDone].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it('a tap turns an off gear on and jumps the thumb to where the finger lifted, as one adjustment', () => {
    const { hit, onInput, onTouch, onDone } = strip();
    faderPointer('pointerDown', hit, finger(faderX(80)));
    faderPointer('pointerUp', hit, finger(faderX(80)));
    expect(onTouch).toHaveBeenCalledTimes(1);
    expect(values(onInput)).toEqual([80]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a tap on a gear that is on jumps the thumb there, and a tap on its knob is nothing', () => {
    const { hit, onInput, onTouch, onDone } = strip({ value: 30, off: false });
    faderPointer('pointerDown', hit, finger(faderX(30)));
    faderPointer('pointerUp', hit, finger(faderX(30)));
    expect(onDone).not.toHaveBeenCalled();
    faderPointer('pointerDown', hit, finger(faderX(90)));
    faderPointer('pointerUp', hit, finger(faderX(90)));
    expect(values(onInput)).toEqual([90]);
    expect(onTouch).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a tap that wobbles inside the slop is still a tap, and jumps to where the finger lifted', () => {
    const { hit, onInput, onDone } = strip({ value: 30, off: false });
    const wobble = TOUCH_SLOP_PX - 2;
    faderPointer('pointerDown', hit, finger(faderX(50), 0));
    faderPointer('pointerMove', hit, finger(faderX(50) + wobble, 1));
    expect(onInput).not.toHaveBeenCalled();
    faderPointer('pointerUp', hit, finger(faderX(50) + wobble, 1));
    expect(values(onInput)).toEqual([53]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a sideways drag takes the thumb to the finger once it is past the slop, follows it, and ends once when it lifts', () => {
    const { hit, onInput, onTouch, onDone } = strip();
    faderPointer('pointerDown', hit, finger(faderX(20), 0));
    faderPointer('pointerMove', hit, finger(faderX(20) + 4, 1));
    expect(onInput).not.toHaveBeenCalled();
    expect(onTouch).not.toHaveBeenCalled();
    faderPointer('pointerMove', hit, finger(faderX(40), 2));
    expect(onTouch).toHaveBeenCalledTimes(1);
    faderPointer('pointerMove', hit, finger(faderX(60), 3));
    faderPointer('pointerMove', hit, finger(faderX(80), 3));
    expect(values(onInput)).toEqual([40, 60, 80]);
    expect(onDone).not.toHaveBeenCalled();
    faderPointer('pointerUp', hit, finger(faderX(80), 3));
    expect(values(onInput)).toEqual([40, 60, 80]);
    expect(onTouch).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a drag to the left follows it too', () => {
    const { hit, onInput } = strip({ value: 80, off: false });
    faderPointer('pointerDown', hit, finger(faderX(80), 0));
    faderPointer('pointerMove', hit, finger(faderX(60), 4));
    faderPointer('pointerMove', hit, finger(faderX(30), 6));
    expect(values(onInput)).toEqual([60, 30]);
  });

  it('a swipe mostly up or down leaves the gear alone: no value, not turned on, nothing recorded', () => {
    const { hit, onInput, onTouch, onDone } = strip();
    faderPointer('pointerDown', hit, finger(faderX(50), 0));
    faderPointer('pointerMove', hit, finger(faderX(50) + 1, 12));
    faderPointer('pointerMove', hit, finger(faderX(50) + 3, 40));
    faderPointer('pointerMove', hit, finger(faderX(50) + 4, 90));
    faderPointer('pointerUp', hit, finger(faderX(50) + 4, 90));
    expect([onInput, onTouch, onDone].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it('a 120 px swipe down that drifted 15 px sideways in its first 9 px, and that nothing cancels, changes nothing: it is judged over a stretch, not at its first move (review of 828aaca)', () => {
    const { hit, onInput, onTouch, onDone } = strip();
    faderPointer('pointerDown', hit, finger(faderX(50), 0));
    faderPointer('pointerMove', hit, finger(faderX(50) + 7, 4));
    faderPointer('pointerMove', hit, finger(faderX(50) + 15, 9));
    expect([onInput, onTouch, onDone].map((fn) => fn.mock.calls.length), 'nothing yet: it has not shown which way it goes').toEqual([0, 0, 0]);
    for (let y = 20; y <= 120; y += 20) faderPointer('pointerMove', hit, finger(faderX(50) + 15, y));
    faderPointer('pointerUp', hit, finger(faderX(50) + 15, 120));
    expect([onInput, onTouch, onDone].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it('a swipe that wobbled sideways and lifts before it has gone far turns nothing on either', () => {
    const { hit, onInput, onTouch, onDone } = strip();
    faderPointer('pointerDown', hit, finger(faderX(50), 0));
    faderPointer('pointerMove', hit, finger(faderX(50) + 4, 22));
    faderPointer('pointerUp', hit, finger(faderX(50) + 4, 22));
    expect([onInput, onTouch, onDone].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it('a short drag that lifts before the finger has gone TOUCH_DECIDE_PX still presses the fader where it lifted', () => {
    const { hit, onInput, onTouch, onDone } = strip();
    faderPointer('pointerDown', hit, finger(faderX(50), 0));
    faderPointer('pointerMove', hit, finger(faderX(50) + 12, 3));
    expect(onInput).not.toHaveBeenCalled();
    faderPointer('pointerUp', hit, finger(faderX(50) + 12, 3));
    expect(onTouch).toHaveBeenCalledTimes(1);
    expect(values(onInput)).toEqual([56]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  /** A swipe that starts with a kick to the side and then goes straight up or down, as a finger reports it: every 6 px. */
  const kickThenSwipe = (kickX: number, kickY: number, toY: number, startAt = 20) => {
    const x0 = faderX(startAt);
    const path = [{ x: x0 + kickX, y: kickY }];
    for (let y = kickY + 6; Math.abs(y) <= Math.abs(toY); y += Math.sign(toY) * 6) path.push({ x: x0 + kickX, y });
    return { x0, path };
  };

  it.each([
    ['15 px across in the first 6 px, then 120 px down', 15, 6, 120],
    ['15 px across in the first 7 px, then 120 px up', 15, -7, -120],
    ['15 px across in the first 8 px, then 120 px down', 15, 8, 120],
    ['18 px across in the first 6 px, then 120 px down', 18, 6, 120],
    ['30 px across in the first 4 px, then 120 px up', 30, -4, -120],
    ['40 px across in the first 4 px, then 120 px down', 40, 4, 120],
    ['50 px across in the first 6 px, then 120 px up', 50, -6, -120],
  ])('a swipe that kicks sideways, %s, and nothing cancels, changes nothing in the end: the gear that it turned on or moved is put back, and no adjustment is recorded (the gates on 1ee41b4 and 4e324f5)', (_name, kx, ky, toY) => {
    const { hit, onInput, onTouch, onDone, onRevert } = strip();
    const { x0, path } = kickThenSwipe(kx, ky, toY);
    faderPointer('pointerDown', hit, finger(x0, 0));
    for (const p of path) faderPointer('pointerMove', hit, finger(p.x, p.y));
    faderPointer('pointerUp', hit, finger(path.at(-1)!.x, path.at(-1)!.y));
    expect(onDone, 'no adjustment is recorded').not.toHaveBeenCalled();
    // What it did before it was taken back is what onRevert undoes: at most the gear on and the value at the finger, and nothing after the call. A kick
    // that was not called a drag at all (8 px up or down in the first 15 across is not twice as far sideways) did nothing to take back.
    expect(onTouch.mock.calls.length).toBeLessThanOrEqual(1);
    expect(onInput.mock.calls.length).toBeLessThanOrEqual(1);
    const didSomething = onTouch.mock.calls.length + onInput.mock.calls.length > 0;
    expect(onRevert, 'the gear is put back once if it was changed').toHaveBeenCalledTimes(didSomething ? 1 : 0);
  });

  it('a 30 degree diagonal for 40 px and then 100 px up, and a wide thumb\'s arc, 35 px right and 150 px up, change nothing either (the gate on 4e324f5)', () => {
    for (const path of [
      // 30 degrees up and to the right for 40 px, then straight up.
      [...Array.from({ length: 8 }, (_, i) => [5 * 0.866 * (i + 1), -5 * 0.5 * (i + 1)]), ...Array.from({ length: 17 }, (_, i) => [34.64, -20 - 6 * (i + 1)])],
      // an arc: out 35 px to the right while going up 10, then up to 150.
      [...Array.from({ length: 7 }, (_, i) => [5 * (i + 1), -1.5 * (i + 1)]), ...Array.from({ length: 24 }, (_, i) => [35, -10 - 6 * (i + 1)])],
    ]) {
      const { hit, onDone, onRevert, onInput, onTouch } = strip();
      const x0 = faderX(20);
      faderPointer('pointerDown', hit, finger(x0, 0));
      for (const [dx, dy] of path) faderPointer('pointerMove', hit, finger(x0 + dx!, dy!));
      faderPointer('pointerUp', hit, finger(x0 + path.at(-1)![0]!, path.at(-1)![1]!));
      expect(onDone).not.toHaveBeenCalled();
      const changed = onTouch.mock.calls.length + onInput.mock.calls.length > 0;
      expect(onRevert).toHaveBeenCalledTimes(changed ? 1 : 0);
      cleanup();
    }
  });

  it('a swipe that kicks and then goes up or down on a gear that is on, and that puts it back the same way, never calls it done', () => {
    const { hit, onInput, onDone, onRevert } = strip({ value: 40, off: false });
    const { x0, path } = kickThenSwipe(15, 6, 120);
    faderPointer('pointerDown', hit, finger(x0, 0));
    for (const p of path) faderPointer('pointerMove', hit, finger(p.x, p.y));
    faderPointer('pointerUp', hit, finger(path.at(-1)!.x, path.at(-1)!.y));
    expect(onRevert).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    expect(onInput.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('a drag is taken back for how far up or down the finger has been compared with how far to the side, not for where it is: it follows a moderate drift, and is taken back once the drift is more than 1.5 times the reach', () => {
    const { hit, onInput, onDone, onRevert } = strip({ value: 10, off: false });
    faderPointer('pointerDown', hit, finger(faderX(20), 0));
    faderPointer('pointerMove', hit, finger(faderX(20) + 18, 6));
    faderPointer('pointerMove', hit, finger(faderX(20) + 44, 8));
    faderPointer('pointerMove', hit, finger(faderX(20) + 50, 70)); // 70 up or down against a reach of 50: 1.4 times, so far kept
    expect(onRevert).not.toHaveBeenCalled();
    faderPointer('pointerMove', hit, finger(faderX(20) + 50, 80)); // 80 against 50: more than 1.5 times, taken back
    expect(onRevert).toHaveBeenCalledTimes(1);
    faderPointer('pointerMove', hit, finger(faderX(20) + 90, 4)); // a taken-back finger is a scroll for good
    faderPointer('pointerUp', hit, finger(faderX(20) + 90, 4));
    expect(values(onInput)).toEqual([29, 42, 45]);
    expect(onDone).not.toHaveBeenCalled();
  });

  /** A finger that goes out `out` px, comes back to `back` px (negative: the other side of where it landed), with `drift` px of wander up or down, reported every 2 px. */
  const nudge = (hit: HTMLElement, start: number, out: number, back: number, drift: number) => {
    const x0 = faderX(start);
    faderPointer('pointerDown', hit, finger(x0, 0));
    const steps = (from: number, to: number, y: (i: number) => number) => {
      for (let i = 1; i <= Math.ceil(Math.abs(to - from) / 2); i++) faderPointer('pointerMove', hit, finger(x0 + from + Math.sign(to - from) * Math.min(2 * i, Math.abs(to - from)), y(i)));
    };
    steps(0, out, (i) => (i % 2 ? drift : 0));
    steps(out, back, (i) => (i % 2 ? drift : 1));
    faderPointer('pointerUp', hit, finger(x0 + back, drift));
    return x0 + back;
  };

  it.each([16, 20, 24, 30])('fine-tuning that goes out %s px and comes back to within 8 px of where it landed, with up to 4 px of drift, ends where the finger is, as one adjustment (the gate on 4e324f5)', (out) => {
    for (const back of [-8, -4, 0, 4, 8]) {
      for (const drift of [0, 2, 4]) {
        const { hit, onInput, onDone, onRevert } = strip({ value: 50, off: false });
        const endX = nudge(hit, 50, out, back, drift);
        expect(onRevert, `out ${out}, back ${back}, drift ${drift}: never taken back`).not.toHaveBeenCalled();
        expect(onDone, `out ${out}, back ${back}, drift ${drift}: one adjustment`).toHaveBeenCalledTimes(1);
        expect(values(onInput).at(-1), `out ${out}, back ${back}, drift ${drift}: ends at the finger`).toBe(Math.round(((endX - faderX(0)) / (faderX(100) - faderX(0))) * 100));
        cleanup();
      }
    }
  });

  it('the same on an off gear: Tempo turns on, stays on through the correction, and ends at the finger as one adjustment', () => {
    const { hit, onInput, onTouch, onDone, onRevert } = strip();
    nudge(hit, 50, 24, -16, 2);
    expect(onTouch).toHaveBeenCalledTimes(1);
    expect(onRevert).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(values(onInput).at(-1)).toBe(42);
  });

  it('deliberate drags are not taken back: sideways with a little up and down along the way, in either direction', () => {
    const { hit, onInput, onRevert, onDone } = strip({ value: 50, off: false });
    faderPointer('pointerDown', hit, finger(faderX(50), 0));
    for (let i = 1; i <= 15; i++) faderPointer('pointerMove', hit, finger(faderX(50) - 4 * i, (i % 2 ? 5 : -5)));
    faderPointer('pointerUp', hit, finger(faderX(50) - 60, 5));
    expect(onRevert).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(values(onInput).at(-1)).toBe(20);
  });

  it('a drag that dips 7 px down first and then goes 80 px sideways, reported every 2 px as a finger does, takes the thumb to the finger and follows it (review of 828aaca)', () => {
    const { hit, onInput, onTouch, onDone } = strip();
    faderPointer('pointerDown', hit, finger(faderX(20), 0));
    faderPointer('pointerMove', hit, finger(faderX(20), 7));
    for (let dx = 2; dx <= 14; dx += 2) faderPointer('pointerMove', hit, finger(faderX(20) + dx, 7));
    expect([onInput, onTouch].map((fn) => fn.mock.calls.length), 'not yet: it has not shown which way it goes').toEqual([0, 0]);
    for (let dx = 16; dx <= 80; dx += 2) faderPointer('pointerMove', hit, finger(faderX(20) + dx, 8));
    expect(onTouch).toHaveBeenCalledTimes(1);
    // The first step past the stretch it was judged over takes the thumb to the finger, and each step after that follows it.
    expect(values(onInput)).toEqual(Array.from({ length: 33 }, (_, i) => 28 + i));
    faderPointer('pointerUp', hit, finger(faderX(20) + 80, 8));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a swipe 8 px across and 60 px down, which the browser then cancels, changes nothing either', () => {
    const { hit, onInput, onTouch, onDone } = strip();
    faderPointer('pointerDown', hit, finger(faderX(50), 0));
    for (let i = 1; i <= 3; i++) faderPointer('pointerMove', hit, finger(faderX(50) + (8 * i) / 10, (60 * i) / 10));
    faderPointer('pointerCancel', hit, finger(0, 0));
    expect([onInput, onTouch, onDone].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it('a touch the browser cancels before the finger has gone anywhere changes nothing, and the next tap still counts once', () => {
    const { hit, onInput, onTouch, onDone } = strip();
    faderPointer('pointerDown', hit, finger(faderX(50)));
    faderPointer('pointerMove', hit, finger(faderX(50) + 1, 3));
    faderPointer('pointerCancel', hit, finger(0, 0));
    expect([onInput, onTouch, onDone].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);

    faderPointer('pointerDown', hit, finger(faderX(DEFAULTS.tempo)));
    faderPointer('pointerUp', hit, finger(faderX(DEFAULTS.tempo)));
    expect(onTouch).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a finger that began sideways keeps following when it drifts up or down, as far as 1.5 times its sideways reach', () => {
    const { hit, onInput, onDone } = strip({ value: 10, off: false });
    faderPointer('pointerDown', hit, finger(faderX(20), 0));
    faderPointer('pointerMove', hit, finger(faderX(45), 2));
    faderPointer('pointerMove', hit, finger(faderX(60), 90));
    faderPointer('pointerMove', hit, finger(faderX(70), 120));
    faderPointer('pointerUp', hit, finger(faderX(70), 120));
    expect(values(onInput)).toEqual([45, 60, 70]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a drag the browser cancels ends the adjustment where it is, once', () => {
    const { hit, onInput, onDone } = strip({ value: 10, off: false });
    faderPointer('pointerDown', hit, finger(faderX(20), 0));
    faderPointer('pointerMove', hit, finger(faderX(45), 2));
    faderPointer('pointerCancel', hit, finger(0, 0));
    expect(values(onInput)).toEqual([45]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a second finger is ignored while the first is down, and the first goes on', () => {
    const { hit, onInput, onDone } = strip({ value: 10, off: false });
    faderPointer('pointerDown', hit, finger(faderX(20), 0, 1));
    faderPointer('pointerMove', hit, finger(faderX(40), 1, 1));
    faderPointer('pointerDown', hit, finger(faderX(90), 0, 2));
    faderPointer('pointerMove', hit, finger(faderX(95), 0, 2));
    faderPointer('pointerUp', hit, finger(faderX(95), 0, 2));
    expect(onDone).not.toHaveBeenCalled();
    faderPointer('pointerMove', hit, finger(faderX(60), 1, 1));
    faderPointer('pointerUp', hit, finger(faderX(60), 1, 1));
    expect(values(onInput)).toEqual([40, 60]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('the strip that cannot be used', () => {
  it('has no hit area at all, so it takes no pointer, and its input is disabled', () => {
    const none = vi.fn();
    const { container } = render(
      <GearStrip gear="history" value={100} off hidden={false} unavailable="Connect Spotify to use your listening history" onInput={none} onTouch={none} onReset={none} onDone={none} onRevert={none} />,
    );
    expect(container.querySelector('[data-fader]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[type="range"]')!.disabled).toBe(true);
  });
});
