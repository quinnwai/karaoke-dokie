// A gear's fader (QWW-57, R33): where a pointer is over the track, as a value, and what a finger that is moving is doing. A native range
// input takes a touch only on its own 14 by 20 px thumb (iOS WebKit above all), so the strip takes the pointer itself, on a hit area
// that reaches past the track, and this is the arithmetic the input would have done.

/** The drawn knob's width. Its centre travels the track's length, so the hit area reaches half of this past each end of the track. */
export const KNOB_PX = 14;

/** How far a finger moves before it is called a drag or a scroll. Chromium sends the first 15 px or so of a vertical swipe as moves before it cancels the press; deciding at 8 keeps the thumb still for them. */
export const TOUCH_SLOP_PX = 8;

/**
 * The value, 0 to 100 in the whole steps the range input has, for a pointer at `x` over a hit area that starts at `left` and is `width`
 * wide. The area is the track with half a knob more at each end, so the knob's centre is at `left + 7` for 0 and `left + width - 7` for
 * 100, and a pointer past either end is that end's value. An area with no track to move along (14 px or less) is 0.
 */
export function faderValue(x: number, left: number, width: number): number {
  const travel = width - KNOB_PX;
  if (!(travel > 0)) return 0;
  const along = (x - left - KNOB_PX / 2) / travel;
  return Math.round(Math.min(1, Math.max(0, along)) * 100);
}

export type TouchIntent = 'wait' | 'drag' | 'scroll';

/**
 * What a finger that has moved (`dx`, `dy`) px from where it landed is doing: nothing yet (inside the slop, so a tap that wobbles is still a
 * tap), dragging the fader (mostly sideways), or scrolling (mostly up or down, level counts as sideways). The strip lets a vertical swipe go to
 * the browser (`touch-action: pan-y`), which then cancels the press; this keeps the thumb still on the way to that cancel.
 */
export function touchIntent(dx: number, dy: number): TouchIntent {
  if (Math.hypot(dx, dy) < TOUCH_SLOP_PX) return 'wait';
  return Math.abs(dy) > Math.abs(dx) ? 'scroll' : 'drag';
}
