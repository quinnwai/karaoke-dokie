// @vitest-environment jsdom
// QWW-57, R33, the gate on 1ee41b4: where a press really began (src/lib/setlist/rawPress.ts). A touch browser hands the pointer events and the click of a touch with
// a radius to a control near the finger, and the position of the event stays the finger's, so a control asks where the last press began and not which element
// the event names. jsdom lays nothing out, so each element is given a box.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetPresses, pointIsOn, pressWasOn, trackPresses } from '../../src/lib/setlist/rawPress';

const boxed = (x: number, y: number, w: number, h: number) => {
  const el = document.createElement('button');
  el.getBoundingClientRect = () => new DOMRect(x, y, w, h);
  document.body.append(el);
  return el;
};

/** A pointerdown with a position, on whichever element the browser names, as a finger's is. */
const press = (named: Element, x: number, y: number) => {
  const event = new Event('pointerdown', { bubbles: true });
  Object.defineProperty(event, 'clientX', { value: x });
  Object.defineProperty(event, 'clientY', { value: y });
  named.dispatchEvent(event);
};

beforeEach(() => {
  forgetPresses();
  trackPresses();
});
afterEach(() => {
  document.body.replaceChildren();
});

describe('pressWasOn', () => {
  it('says yes before any press: a click that nothing pressed (a script\'s, a screen reader\'s) is not one to turn away', () => {
    expect(pressWasOn(boxed(100, 100, 44, 20))).toBe(true);
  });

  it('is by where the press began, whichever element the event named: a press on the thumb named for the ✕ is not the ✕\'s', () => {
    const reset = boxed(100, 0, 44, 20);
    const thumb = boxed(100, 28, 44, 44);
    press(reset, 120, 30); // the finger is on the thumb, the browser named the ✕
    expect(pressWasOn(reset)).toBe(false);
    expect(pressWasOn(thumb)).toBe(true);
    press(thumb, 120, 10); // the finger is on the ✕, the browser named the thumb
    expect(pressWasOn(reset)).toBe(true);
    expect(pressWasOn(thumb)).toBe(false);
  });

  it('counts a box as half open, as the browser\'s hit test does: its left and top edges are in, its right and bottom edges are not', () => {
    const el = boxed(100, 100, 44, 20);
    const at = (x: number, y: number) => {
      press(el, x, y);
      return pressWasOn(el);
    };
    expect([at(100, 100), at(143.9, 119.9), at(144, 110), at(120, 120), at(99.9, 110), at(120, 99.9)]).toEqual([true, true, false, false, false, false]);
  });

  it('gives a slop on every side when one is asked for (the era buttons: half the gap between two)', () => {
    const el = boxed(100, 100, 44, 20);
    press(el, 98, 98);
    expect(pressWasOn(el)).toBe(false);
    expect(pressWasOn(el, 2)).toBe(true);
    press(el, 96, 110);
    expect(pressWasOn(el, 2)).toBe(false);
  });

  it('says yes for an element with no box (jsdom lays nothing out, and a hidden element is nobody\'s to turn away)', () => {
    const el = document.createElement('button');
    document.body.append(el);
    press(el, 5, 5);
    expect(pressWasOn(el)).toBe(true);
  });

  it('is not moved by a press with no position, as a test\'s synthetic one may be', () => {
    const el = boxed(100, 100, 44, 20);
    press(el, 120, 110);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(pressWasOn(el)).toBe(true);
  });
});

describe('pointIsOn', () => {
  it('is by the point, with the same half-open box; an element with no box has every point', () => {
    const el = boxed(100, 100, 140, 44);
    expect([pointIsOn(el, 100, 100), pointIsOn(el, 239, 143), pointIsOn(el, 240, 120), pointIsOn(el, 170, 144), pointIsOn(el, 260, 60)]).toEqual([true, true, false, false, false]);
    expect(pointIsOn(document.createElement('div'), 1, 1)).toBe(true);
  });
});
