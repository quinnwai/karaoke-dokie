// A gear's fader in jsdom (QWW-57, R33). jsdom has no PointerEvent and lays nothing out, so a pointer event is a plain one given its fields by
// hand, and the hit area is given a box: a 200 px track whose area starts at x = 100 and is 214 px wide (7 px more at each end), so the knob's
// centre is at x = 107 for 0 and x = 307 for 100, and a step is 2 px.

import { createEvent, fireEvent } from '@testing-library/react';
import type { GearId } from '../../src/lib/setlist/types';
import { SEL } from './setlist';

const LEFT = 100;
const WIDTH = 214;

/** A gear's hit area, in the box `faderX` aims at. */
export function fader(gear: GearId): HTMLElement {
  const hit = document.querySelector<HTMLElement>(`${SEL.strip(gear)} [data-fader]`);
  if (!hit) throw new Error(`The ${gear} strip has no fader hit area`);
  hit.getBoundingClientRect = () => new DOMRect(LEFT, 0, WIDTH, 44);
  return hit;
}

/** Where a pointer is when it is on the knob at `value`. */
export const faderX = (value: number) => LEFT + 7 + (value / 100) * (WIDTH - 14);

export interface FaderPointer {
  x?: number;
  y?: number;
  kind?: 'mouse' | 'touch' | 'pen';
  /** Which pointer: a mouse is 1 and so is the first finger. */
  id?: number;
  button?: number;
}

export function faderPointer(type: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel', target: Element, init: FaderPointer = {}): void {
  const event = createEvent[type](target);
  const fields = { clientX: init.x ?? 0, clientY: init.y ?? 0, pointerId: init.id ?? 1, pointerType: init.kind ?? 'mouse', button: init.button ?? 0 };
  for (const [name, value] of Object.entries(fields)) Object.defineProperty(event, name, { value });
  fireEvent(target, event);
}
