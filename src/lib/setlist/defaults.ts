// The tuner's defaults, in one place (spec §11): first load and every Reset read from here, so they cannot disagree.
//
// They are the ranking decision of QWW-47 (model A, Quinn-Wai, 10 Nov), which this screen takes as it is: the default view
// is "most popular first, then easiest", and the engine's weights (Popularity counts double) turn these values into
// exactly that. Why each value:
//
// - Difficulty 0, on. The "Light work" end: among equally popular songs the easiest comes first. Zero rather than a
//   low-ish 15, because a song easier than the target would otherwise lose to one sitting on it.
// - History 100, off. The "On repeat" end. Off because a singer without Spotify has no history and the default view does
//   not use it. Switched on, it starts where it brings their own top and liked songs to the front, so touching it visibly
//   does something. Before Spotify is connected the gear cannot be switched on at all.
// - Popularity 100, on. The "Pop hits" end: the most popular songs first.
// - Tempo 50, off. The neutral middle: tempo is a taste, not a default.
// - Era off, with no default picks. Era off shows every era, and the first tap on an era button picks just that era
//   (spec §4: with Era off a tap applies to the default picks, which are none).
//
// The sheet starts expanded (the L2 expanded board). The QWW-42 cut order drops mini mode first if time runs out;
// `?mini=1` starts the sheet in mini mode, as the reference does. The mini sheet first shows Difficulty: the first
// gear that is on.

import type { EraId, TunerPart } from './types';

export const DEFAULTS = Object.freeze({
  difficulty: 0,
  history: 100,
  popularity: 100,
  tempo: 50,
  eras: Object.freeze<EraId[]>([]) as readonly EraId[],
  /** Parts that start off (reset, not factored in). */
  off: Object.freeze<TunerPart[]>(['history', 'tempo', 'era']) as readonly TunerPart[],
  open: 'difficulty' as TunerPart,
  mini: false,
});
