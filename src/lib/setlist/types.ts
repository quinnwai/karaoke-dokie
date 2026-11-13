// The Setlist tuner's vocabulary (round 5 design, QWW-46). Plain data only: no React and no ranking.
// The spec is docs/setlist-round5/setlist-round5-spec.md; section numbers below point into it.
//
// The request, song and response types are QWW-47's contract (POST /api/setlist): they live in src/lib/contracts.ts and are
// re-exported here so the screen has one place to import the tuner's vocabulary from.

import { GEAR_IDS, type GearId, type TunerPart } from '../contracts';

export { ERA_IDS, GEAR_IDS } from '../contracts';
export type { EraId, GearId, GearValues, SetlistInput, SetlistRequest, SetlistResponse, SetlistSong, SetlistState, TunerPart } from '../contracts';
import type { EraId, SetlistResponse } from '../contracts';

/** Everything the sheet can show one of, the tabs can open, and a reset can switch off: the four gears and Era. */
export const TUNER_PARTS: readonly TunerPart[] = [...GEAR_IDS, 'era'];

/**
 * What the singer has set on the sheet (spec §2). Everything on screen derives from it. The drag offset of the
 * handle is not here: it changes sixty times a second and only the sheet cares, so the sheet keeps it.
 */
export interface TunerState {
  /** Slider targets, whole numbers 0 to 100. A gear that is off holds its default value here. */
  difficulty: number;
  history: number;
  popularity: number;
  tempo: number;
  /** The picked eras. While Era is off this holds the default picks (none), which are not applied. */
  eras: EraId[];
  /** Parts that were reset and are not factored in. */
  off: TunerPart[];
  /** Which part the mini sheet shows. */
  open: TunerPart;
  /** True when the sheet is in its mini mode. */
  mini: boolean;
}

export type EmptyReason = NonNullable<SetlistResponse['empty']>;
