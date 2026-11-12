// A gear's fader (QWW-57, R33): where a pointer is over the track, as a value, and what a finger that is moving is doing. A native range
// input takes a touch only on its own 14 by 20 px thumb (iOS WebKit above all), so the strip takes the pointer itself, on a hit area
// that reaches past the track, and this is the arithmetic the input would have done.

/** The drawn knob's width. Its centre travels the track's length, so the hit area reaches half of this past each end of the track. */
export const KNOB_PX = 14;

/** How far a finger moves before it is no longer a tap. A finger that lifts inside it presses the fader where it is. */
export const TOUCH_SLOP_PX = 8;

/**
 * How far a finger must have gone before a clearly sideways move is called a drag. A swipe up or down can start with a wobble to one side, and a drag
 * can start with a dip, so the first few px say little: Chromium sends the first 15 px or so of a vertical swipe as moves before it cancels the press,
 * and a finger that has been left to settle for this long has shown which way it is going.
 */
export const TOUCH_DECIDE_PX = 16;

/** How far a finger that is not clearly sideways must have gone for the stretch to be judged, by which way it went more (QWW-57, R33, the gate on 828aaca). */
export const TOUCH_VERDICT_PX = 32;

/**
 * How far a finger must have gone, still more sideways than up or down, for the drag that was called early to stand for good. Before that the call is provisional:
 * a swipe that began with a kick to one side and then went up or down is taken back (`dragStanding`), so no swipe that ends mostly vertical has turned a gear on
 * or moved it (the gate on 1ee41b4).
 */
export const TOUCH_FINAL_PX = 40;

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
 * What a finger that has moved (`dx`, `dy`) px from where it landed is doing: nothing yet, dragging the fader, or scrolling (up or down). It is judged
 * over a stretch, not at its first few px, so that a swipe that wobbles sideways at the start is not taken for a drag and a drag that dips at the start
 * is not taken for a scroll:
 *   - under TOUCH_DECIDE_PX: wait (a tap that wobbles is still a tap)
 *   - from there, at least twice as far sideways as up or down: a drag
 *   - otherwise wait until TOUCH_VERDICT_PX, then whichever way it went more (level counts as sideways)
 * The strip lets a vertical swipe go to the browser (`touch-action: pan-y`), which then cancels the press, normally well before the verdict.
 */
export function touchIntent(dx: number, dy: number): TouchIntent {
  const sideways = Math.abs(dx);
  const upDown = Math.abs(dy);
  const far = Math.hypot(dx, dy);
  if (far < TOUCH_DECIDE_PX) return 'wait';
  if (sideways >= 2 * upDown) return 'drag';
  if (far < TOUCH_VERDICT_PX) return 'wait';
  return upDown > sideways ? 'scroll' : 'drag';
}

/**
 * Whether a finger that lifts (`dx`, `dy`) px from where it landed, before `touchIntent` had called it, pressed the fader: a tap (inside the slop) does,
 * and so does a short drag; a short swipe that went mostly up or down does not, so no swipe that ends mostly vertical turns a gear on.
 */
export function liftsOnTheFader(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) < TOUCH_SLOP_PX || Math.abs(dx) >= Math.abs(dy);
}

export type DragStanding = 'keep' | 'final' | 'revoke';

/**
 * What becomes of a drag that `touchIntent` called as a finger moved (`dx`, `dy`) px from where it landed, and that has put the gear on or moved it: it is
 * taken back ('revoke') if the finger is then more up or down than sideways before it has gone TOUCH_FINAL_PX, it stands for good ('final') once it has
 * gone that far still more sideways than up or down, and until then it is kept ('keep'). A drag that stands follows the finger wherever it goes after.
 */
export function dragStanding(dx: number, dy: number): DragStanding {
  if (Math.abs(dy) > Math.abs(dx)) return 'revoke';
  return Math.hypot(dx, dy) >= TOUCH_FINAL_PX ? 'final' : 'keep';
}
