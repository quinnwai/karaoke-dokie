// The words on the sheet (spec §4a, §6 and the reference markup), by gear.

import type { GearId, TunerPart } from './types';

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

// Round 6A (§5) shortened History's label on the strip to "HISTORY"; Quinn-Wai's review (QWW-57, R6, 11 Nov) put "LISTENING
// HISTORY" back on the strip. Its tab is still "History", and its ✕ button says "Turn off listening history" to a screen reader.
export const GEAR_META: Record<GearId, GearMeta> = {
  difficulty: { eyebrow: 'DIFFICULTY', tab: 'Difficulty', left: 'Light work', right: 'Locked in', resetLabel: 'Turn off difficulty' },
  history: { eyebrow: 'LISTENING HISTORY', tab: 'History', left: 'Rediscover', right: 'On repeat', resetLabel: 'Turn off listening history' },
  popularity: { eyebrow: 'POPULARITY', tab: 'Popularity', left: 'Deep cuts', right: 'Pop hits', resetLabel: 'Turn off popularity' },
  tempo: { eyebrow: 'TEMPO', tab: 'Tempo', left: 'Slow jams', right: 'Upbeat tracks', resetLabel: 'Turn off tempo' },
};

/**
 * The order the sheet draws the gears in: the strips top to bottom and the tabs left to right (QWW-57, R11). Listening
 * History is last of the four because it has to be unlocked. `GEAR_IDS` (src/lib/contracts.ts) is the server's and the
 * engine's order and stays as it is; this is only what the sheet shows, and a test checks that it holds the same four gears.
 * Mini still opens on `DEFAULTS.open`, Difficulty, which is first in both.
 */
export const SHEET_GEARS: readonly GearId[] = ['difficulty', 'popularity', 'tempo', 'history'];
/** The tabs: the gears in sheet order, then Era. */
export const SHEET_PARTS: readonly TunerPart[] = [...SHEET_GEARS, 'era'];

// The Era panel's header is "ERA", and "OFF · all eras" while Era is off (§8, `ERA_OFF_NOTE` in eras.ts), which replaces "ERA: PICK ANY".
export const ERA_META = { eyebrow: 'ERA', tab: 'Era', resetLabel: 'Turn off era' } as const;

/** The ✕ button's tooltip (R21: it turns the gear off, so it is no longer a reset arrow). */
export const RESET_TITLE = "Turn off: don't factor in";

/** Why History cannot be used, in the place of its track (the gear is off and disabled, spec: logged-out). */
export const HISTORY_HINT_LOGGED_OUT = 'Connect Spotify to use your listening history';
/** Signed in, but the server could not read the Spotify library, so the catalogue's songs are shown (QWW-55). */
export const HISTORY_HINT_UNREACHABLE = 'Spotify could not be reached, so listening history is off';
