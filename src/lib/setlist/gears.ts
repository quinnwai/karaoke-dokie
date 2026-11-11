// The words on the sheet (spec §4a, §6 and the reference markup), by gear.

import type { GearId } from './types';

export interface GearMeta {
  /** The label on the gear's strip. */
  eyebrow: string;
  /** The label on its tab. */
  tab: string;
  /** The words at the two ends of its track. */
  left: string;
  right: string;
  /** The reset button's name for a screen reader. */
  resetLabel: string;
}

// Round 6A (§5): History's label on the strip is "HISTORY" (it was "LISTENING HISTORY"); its reset button still says
// "listening history" to a screen reader.
export const GEAR_META: Record<GearId, GearMeta> = {
  difficulty: { eyebrow: 'DIFFICULTY', tab: 'Difficulty', left: 'Light work', right: 'Locked in', resetLabel: 'Reset difficulty (stop factoring it in)' },
  history: { eyebrow: 'HISTORY', tab: 'History', left: 'Rediscover', right: 'On repeat', resetLabel: 'Reset listening history (stop factoring it in)' },
  popularity: { eyebrow: 'POPULARITY', tab: 'Popularity', left: 'Deep cuts', right: 'Pop hits', resetLabel: 'Reset popularity (stop factoring it in)' },
  tempo: { eyebrow: 'TEMPO', tab: 'Tempo', left: 'Slow jams', right: 'Upbeat tracks', resetLabel: 'Reset tempo (stop factoring it in)' },
};

// The Era panel's header is "ERA" and then a count (§8, `eraCountText` in eras.ts), which replaces "ERA: PICK ANY".
export const ERA_META = { eyebrow: 'ERA', tab: 'Era', resetLabel: 'Reset era (stop factoring it in)' } as const;

/** The reset button's tooltip. */
export const RESET_TITLE = "Reset: don't factor in";

/** Why History cannot be used, in the place of its track (the gear is off and disabled, spec: logged-out). */
export const HISTORY_HINT_LOGGED_OUT = 'Connect Spotify to use your listening history';
/** Signed in, but the server could not read the Spotify library, so the catalogue's songs are shown (QWW-55). */
export const HISTORY_HINT_UNREACHABLE = 'Spotify could not be reached, so listening history is off';
