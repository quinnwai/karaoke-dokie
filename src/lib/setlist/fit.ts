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
/** How far, in px of type, the sign steps down when the size it was given does not keep the gap once it is laid out. */
export const SIGN_STEP = 0.2;

/**
 * A first guess at the type size of the sign (QWW-57, R1): the largest, from SIGN_MAX_SIZE down to SIGN_MIN_SIZE px, at which it
 * would keep `gap` px clear of redo's right edge and of the Spotify button's left edge; null when not even SIGN_MIN_SIZE would. It is
 * centred on the header's own `middle`, not in the room between its neighbours, so the room it has is twice the nearer neighbour's
 * distance from the middle, less a gap each side. `sign` is its box at SIGN_MAX_SIZE. It takes the width to be proportional to the
 * type size (the letter-spacing is in em), which a font with hinted advances, as on Linux, is not exactly: `settleSignSize` checks the
 * guess against the sign as laid out. All of it is page coordinates of the same row.
 */
export function signSize(sign: { left: number; right: number }, middle: number, redoRight: number, spotifyLeft: number, gap: number = SIGN_GAP): number | null {
  const room = 2 * Math.min(middle - redoRight, spotifyLeft - middle) - 2 * gap;
  const size = (room * SIGN_MAX_SIZE) / (sign.right - sign.left);
  return size >= SIGN_MIN_SIZE ? Math.min(size, SIGN_MAX_SIZE) : null;
}

/** Whether the sign, as it is laid out, keeps `gap` px clear of redo's right edge and of the Spotify button's left edge. */
export function signFits(sign: { left: number; right: number }, redoRight: number, spotifyLeft: number, gap: number = SIGN_GAP): boolean {
  return sign.left - redoRight >= gap && spotifyLeft - sign.right >= gap;
}

/**
 * The size the sign settles at: the `guess` (from `signSize`) floored to a tenth of a px, then down SIGN_STEP px at a time until
 * `fits(size)` says it keeps the gap. `fits` is the real measurement: it lays the sign out at that size and checks it (`signFits`).
 * Null when not even SIGN_MIN_SIZE passes, and the sign goes. A null guess is still tried at SIGN_MIN_SIZE, since the guess is only a
 * guess. It tries at most 16 sizes, each a multiple of a tenth, from the guess to SIGN_MIN_SIZE, so it always ends.
 */
export function settleSignSize(guess: number | null, fits: (size: number) => boolean): number | null {
  const min = Math.round(SIGN_MIN_SIZE * 10);
  const step = Math.round(SIGN_STEP * 10);
  let tenths = guess === null ? min : Math.floor(guess * 10);
  for (;;) {
    if (fits(tenths / 10)) return tenths / 10;
    if (tenths <= min) return null;
    tenths = Math.max(min, tenths - step);
  }
}
