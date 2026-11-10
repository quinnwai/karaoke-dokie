// The bottom sheet's geometry and the handle's drag rules (spec §3 and §4). Pure, so the numbers are tested without
// a browser; the sheet component only reads and applies them.

/** Rack heights, px: every gear (expanded), and one gear plus the tab bar (mini). */
export const RACK_FULL = 416;
export const RACK_MINI = 164;
/** Pointer travel before a press counts as a drag, not a tap. */
export const DRAG_START_PX = 6;
/** Drag distance that switches the mode on release. */
export const SNAP_PX = 50;
/** Dragging up this far from mini switches to the full layout while the sheet grows. */
export const UNCOMPACT_PX = 8;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface SheetLayout {
  dragging: boolean;
  /** Rack height, px. */
  rackHeight: number;
  /**
   * Which layout is drawn. It is `compact` (one gear plus tabs) in mini mode, but not once an upward drag has
   * started growing the sheet: then the full layout shows at once.
   */
  compact: boolean;
}

/** `dragY` is the handle's offset in px while dragging (negative = up), or null when idle. */
export function sheetLayout(mini: boolean, dragY: number | null): SheetLayout {
  const dragging = dragY !== null;
  const base = mini ? RACK_MINI : RACK_FULL;
  return {
    dragging,
    rackHeight: Math.round(dragging ? clamp(base - dragY, RACK_MINI, RACK_FULL) : base),
    compact: mini && !(dragging && dragY < -UNCOMPACT_PX),
  };
}

/** The mode after a drag of `dy` px (negative = up) from `mini`. Short drags change nothing. */
export function modeAfterDrag(mini: boolean, dy: number): boolean {
  if (mini && dy < -SNAP_PX) return false;
  if (!mini && dy > SNAP_PX) return true;
  return mini;
}
