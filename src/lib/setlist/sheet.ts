// The bottom sheet's geometry and the handle's drag rules (spec §3 and §4), and the one place that says how a lit colour
// reaches the sheet's CSS (Round 6A §5, §8, §9). Pure, so the numbers are tested without a browser; the sheet component
// only reads and applies them.

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

/**
 * `dragY` is the handle's offset in px while dragging (negative = up), or null when idle.
 *
 * `canExpand` is false where the expanded sheet does not fit inside the screen at all (QWW-57, Quinn-Wai, 11 Nov): the
 * sheet then stays in mini whatever `mini` says, so the rack never grows past RACK_MINI, not even while it is dragged, and
 * the full layout is never drawn.
 */
export function sheetLayout(mini: boolean, dragY: number | null, canExpand = true): SheetLayout {
  const dragging = dragY !== null;
  const stayMini = mini || !canExpand;
  const base = stayMini ? RACK_MINI : RACK_FULL;
  const tallest = canExpand ? RACK_FULL : RACK_MINI;
  return {
    dragging,
    rackHeight: Math.round(dragging ? clamp(base - dragY, RACK_MINI, tallest) : base),
    compact: stayMini && !(canExpand && dragging && dragY < -UNCOMPACT_PX),
  };
}

/** The mode after a drag of `dy` px (negative = up) from `mini`. Short drags change nothing. */
export function modeAfterDrag(mini: boolean, dy: number): boolean {
  if (mini && dy < -SNAP_PX) return false;
  if (!mini && dy > SNAP_PX) return true;
  return mini;
}

/** The custom properties `neonVars` sets. The sheet's CSS reads them, and nothing else carries a lit colour to it. */
export type NeonVars = Record<'--sl-gear' | '--sl-gear-glow' | '--sl-gear-inner', string>;

/**
 * A part's lit colour, and that colour at the alphas the design draws it at, as custom properties for the strip, the Era
 * panel or the tab to carry. They are decided here, once: `-glow` (`55`, 33%) and `-inner` (`22`, 13%) are the outer and
 * inner glow of the selected tab. `color` is a `#rrggbb` (the palette in art.ts), so a hex alpha can be appended to it. The
 * CSS decides when they apply: an off part ignores them (§7). A strip's and the panel's border is not drawn in the gear's
 * colour in any state (R5, QWW-57; 6A drew it at 27%): it is the rail's grey, so there is no `-line` any more.
 */
export function neonVars(color: string): NeonVars {
  return {
    '--sl-gear': color,
    '--sl-gear-glow': `${color}55`,
    '--sl-gear-inner': `${color}22`,
  };
}
