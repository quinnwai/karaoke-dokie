// Which mode a phone opens the sheet in, and whether the expanded sheet fits at all (QWW-57, Quinn-Wai's decision 1, 11 Nov).
//
// The expanded sheet is 451 px tall (416 of rack) and the rest of the screen is fixed, so on a short phone it leaves the
// song list almost nothing: 3 rows on a 390x844, 0 on the 390x664 that iPhone Safari shows, and on a 375x553 (an iPhone SE
// with Safari's bars) it does not fit inside the screen at all. So:
//
// - A screen that would be left with fewer than 3 whole rows opens in MINI. Expanded stays one drag up.
// - A screen that cannot hold the expanded sheet at all keeps it in mini: the handle does not expand it.
//
// The numbers are measured in the browser (the layout is the browser's, and safe areas and fonts are in it), then
// reduced to the answers here, which are pure and tested.

import { RACK_FULL } from './sheet';

/** A song row is 66 px tall (Round 6A §4). */
export const ROW_HEIGHT = 66;
/** A phone opens expanded only if that leaves at least this many whole rows. */
export const MIN_OPENING_ROWS = 3;

export interface ExpandedFit {
  /** How tall the song list would be with the sheet expanded, px. Negative: the expanded sheet is taller than the room for it. */
  listHeight: number;
  /** Whole rows that list shows. */
  rows: number;
  /** The expanded sheet fits inside the screen. */
  canExpand: boolean;
  /** The sheet should open in mini: expanded would leave fewer than MIN_OPENING_ROWS whole rows. */
  opensMini: boolean;
}

/**
 * What the expanded sheet would leave, from what is on screen now. `list` is the song list's height, `rack` the sheet's
 * rack height (416 expanded, 164 mini, anything in between mid-drag), and `overflow` how far the screen's content runs past
 * its bottom edge (0 when everything fits; an expanded sheet that is too tall squeezes the list to nothing and spills
 * over). The list and the rack always add up to the same room, so the answer does not depend on the mode it is read in.
 */
export function expandedFit({ list, rack, overflow = 0 }: { list: number; rack: number; overflow?: number }): ExpandedFit {
  const listHeight = list + (rack - RACK_FULL) - overflow;
  const rows = Math.max(0, Math.floor(listHeight / ROW_HEIGHT));
  return { listHeight, rows, canExpand: listHeight >= 0, opensMini: rows < MIN_OPENING_ROWS };
}

/** How close the centred カラオケ sign must stay to redo and to the Spotify button (QWW-57, R1). */
export const SIGN_GAP = 8;
/** The sign is 16 px where there is room. Short of room it shrinks to 13 px, the size of the range and redo beside it, before it goes. */
export const SIGN_MAX_SIZE = 16;
export const SIGN_MIN_SIZE = 13;

/**
 * The type size of the sign (QWW-57, R1): the largest, from SIGN_MAX_SIZE down to SIGN_MIN_SIZE px, at which it keeps `gap` px clear
 * of redo's right edge and of the Spotify button's left edge; null when even SIGN_MIN_SIZE does not (then it goes). It is centred on
 * the header's own `middle`, not in the room between its neighbours, so the room it has is twice the nearer neighbour's distance
 * from the middle, less a gap each side. `sign` is its box at SIGN_MAX_SIZE; its width is proportional to its type size (the
 * letter-spacing is in em). All of it is page coordinates of the same row.
 */
export function signSize(sign: { left: number; right: number }, middle: number, redoRight: number, spotifyLeft: number, gap: number = SIGN_GAP): number | null {
  const room = 2 * Math.min(middle - redoRight, spotifyLeft - middle) - 2 * gap;
  const size = (room * SIGN_MAX_SIZE) / (sign.right - sign.left);
  return size >= SIGN_MIN_SIZE ? Math.min(size, SIGN_MAX_SIZE) : null;
}
