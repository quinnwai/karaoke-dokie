// Where a finger really pressed (QWW-57, R33, the gate on 1ee41b4). A touch browser does not give a tap to the element under the finger: Chromium hands the
// pointer events and the click of a touch with a radius to a button or label near it (the nearest one that answers clicks, within a few px more than the radius),
// and the click's own position is the one it moved to. But the position of the `pointerdown` stays the finger's, so that is what a control asks, and the element the
// event names says nothing: a ✕ that is sent a click can ask whether the press began on it, and a fader whose area the finger is in can take the press whoever the
// browser named.

/** The position of the last press, in the page's px; null before the first. */
let last: { x: number; y: number } | null = null;
let installed = false;

/** Starts noting the position of every press in the document (the first press is noted too, so call it when a control mounts). It can be called any number of times. */
export function trackPresses(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener(
    'pointerdown',
    (e) => {
      // (A press with no position, as a test's synthetic one may be, says nothing.)
      if (Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) last = { x: e.clientX, y: e.clientY };
    },
    true,
  );
}

/**
 * Whether the last press began on `el`, `slop` px more on every side counted: yes when there has been none (a click that nothing pressed, a script's) or when the
 * element has no box here (jsdom lays nothing out), so that only a press that is known to be elsewhere says no.
 */
export function pressWasOn(el: Element, slop = 0): boolean {
  if (!last) return true;
  const box = el.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return true;
  return last.x >= box.left - slop && last.x < box.right + slop && last.y >= box.top - slop && last.y < box.bottom + slop;
}

/**
 * Whether a pointer event at (`x`, `y`) is on `el`'s box: yes where the element has no box (jsdom lays nothing out). For a control that must be pressed where it is,
 * and not where the browser named it: the event's own position is the finger's, whichever element the event names.
 */
export function pointIsOn(el: Element, x: number, y: number): boolean {
  const box = el.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return true;
  return x >= box.left && x < box.right && y >= box.top && y < box.bottom;
}

/** Forgets the last press (a test's). */
export function forgetPresses(): void {
  last = null;
}
