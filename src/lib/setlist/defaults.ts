// The tuner's defaults, in one place (spec §11): first load and every Reset read from here, so they cannot disagree.
//
// The values are the ranking decision of QWW-47 (model A, Quinn-Wai, 10 Nov), and they live in src/lib/songs/setlistConfig.ts,
// the file the server's engine reads too: the screen imports them from there instead of repeating them, so the two cannot
// drift apart (QWW-57; that file holds no ranking code, so the screen may import it). In short: the default view is "most
// popular first, then easiest" (Difficulty 0 and Popularity 100 on; History, Tempo and Era off), and the engine's weights
// (Popularity counts double) turn those values into exactly that. Era off shows every era, and the first tap on an era
// button picks just that era (spec §4: with Era off a tap applies to the default picks, which are none).
//
// What this file adds is the screen's own: which part the mini sheet shows, and the sheet's mode.
//
// - `open` is Difficulty: the first gear that is on (the reference opens on History, which now starts off).
// - `mini` is false: the sheet starts expanded (the L2 expanded board). A phone that would be left with fewer than three
//   whole rows opens it in mini instead (QWW-57, decision 1; src/lib/setlist/fit.ts), and `?mini=1` starts it in mini
//   mode, as the reference does.

import { DEFAULT_OFF, DEFAULTS as TUNER_DEFAULTS } from '../songs/setlistConfig';
import type { TunerPart } from './types';

export const DEFAULTS = Object.freeze({
  ...TUNER_DEFAULTS,
  /** Parts that start off (reset, not factored in). */
  off: DEFAULT_OFF,
  open: 'difficulty' as TunerPart,
  mini: false,
});
