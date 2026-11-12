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
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  const view = render(
    <GearStrip gear="tempo" value={DEFAULTS.tempo} off hidden={false} onInput={onInput} onTouch={onTouch} onReset={vi.fn()} onDone={onDone} {...over} />,
  );
  return { ...view, onInput, onTouch, onDone, hit: fader('tempo') };
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
  it('a mouse or a pen leaves it on the gear\'s slider, so the arrow keys carry on from the press as they did with the native one; a finger does not take it', () => {
    const { hit } = strip({ value: 30, off: false });
    const slider = document.getElementById('slider-tempo');
    faderPointer('pointerDown', hit, { x: faderX(60) });
    expect(document.activeElement).toBe(slider);
    faderPointer('pointerUp', hit, { x: faderX(60) });
    (document.activeElement as HTMLElement).blur();
    faderPointer('pointerDown', hit, { kind: 'pen', x: faderX(40) });
    expect(document.activeElement).toBe(slider);
    faderPointer('pointerUp', hit, { kind: 'pen', x: faderX(40) });
    (document.activeElement as HTMLElement).blur();
    faderPointer('pointerDown', hit, { kind: 'touch', x: faderX(80) });
    faderPointer('pointerUp', hit, { kind: 'touch', x: faderX(80) });
    expect(document.activeElement).not.toBe(slider);
  });
});

describe('the mousedown the browser follows a press with', () => {
  it('is cancelled on the fader, so the browser\'s own step for it does not take the focus off the slider the press has just given it (a real browser does that; jsdom only shows the cancel)', () => {
    const { hit } = strip({ value: 30, off: false });
    expect(fireEvent.mouseDown(hit), 'fireEvent returns false when the event was cancelled').toBe(false);
  });

  it('is not cancelled on the ✕, which a mouse press takes focus on as a button does', () => {
    const reset = vi.fn();
    strip({ value: 30, off: false, onReset: reset });
    expect(fireEvent.mouseDown(document.querySelector('button[data-reset]')!)).toBe(true);
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

  it('a finger that began sideways keeps following when it drifts up or down', () => {
    const { hit, onInput, onDone } = strip({ value: 10, off: false });
    faderPointer('pointerDown', hit, finger(faderX(20), 0));
    faderPointer('pointerMove', hit, finger(faderX(45), 2));
    faderPointer('pointerMove', hit, finger(faderX(60), 90));
    faderPointer('pointerMove', hit, finger(faderX(70), 200));
    faderPointer('pointerUp', hit, finger(faderX(70), 200));
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
      <GearStrip gear="history" value={100} off hidden={false} unavailable="Connect Spotify to use your listening history" onInput={none} onTouch={none} onReset={none} onDone={none} />,
    );
    expect(container.querySelector('[data-fader]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[type="range"]')!.disabled).toBe(true);
  });
});
