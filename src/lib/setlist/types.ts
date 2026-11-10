// The Setlist tuner's vocabulary (round 5 design, QWW-46). Plain data only: no React and no ranking.
// The spec is docs/setlist-round5/setlist-round5-spec.md; section numbers below point into it.
//
// The request, song and response types mirror the ranking contract QWW-47 posted (POST /api/setlist, comment of 10 Nov,
// 13:58 UTC), name for name. QWW-47 puts them in src/lib/contracts.ts; whichever of the two changes merges second
// deletes the copy here and imports that one.

import type { DataSourceLogEntry, Match, Midi } from '../contracts';

/** The four slider gears, in the order the expanded sheet shows them. */
export const GEAR_IDS = ['difficulty', 'history', 'popularity', 'tempo'] as const;
export type GearId = (typeof GEAR_IDS)[number];

/** Everything the sheet can show one of, the tabs can open, and a reset can switch off: the four gears and Era. */
export const TUNER_PARTS = ['difficulty', 'history', 'popularity', 'tempo', 'era'] as const;
export type TunerPart = (typeof TUNER_PARTS)[number];

/** Eras, oldest first. `pre` is "Pre-’70s". */
export const ERA_IDS = ['pre', 's70', 's80', 's90', 's00', 's10', 's20'] as const;
export type EraId = (typeof ERA_IDS)[number];

/** A gear's target, or a song's place on it: 0 to 100. */
export type GearValues = Record<GearId, number>;

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

/** What the tuner is set to, as the ranking engine reads it. `off` lists the parts that are reset and not factored in. */
export interface SetlistState {
  gears: GearValues;
  off: TunerPart[];
  /** Used only while 'era' is not in `off`; picked and empty then means no songs (spec §4a). */
  eras: EraId[];
}

/** What the engine's ranking function takes: the state, the singer's range, and whether a listening history exists. */
export interface SetlistInput extends SetlistState {
  range: { low: Midi; high: Midi };
  /** True when the singer is signed in and their library was read: only then does the History gear count. */
  loggedIn: boolean;
}

/** One ranked song: the song as the song page reads it, its era, and its place on each gear. */
export interface SetlistSong {
  match: Match;
  /** From `match.year`; null when the song has no year (it is then left out while Era is on). */
  era: EraId | null;
  /**
   * The song's place on each gear, 0 to 100, by its rank among the songs that fit the singer (so every tenth of a
   * track holds about a tenth of the songs). `difficulty` also draws the row's mini lane: Easy songs are 0 to 33,
   * Medium 33 to 67, Hard 67 to 100. null when we do not know: the song then sorts after the rest on that gear.
   */
  gears: Record<GearId, number | null>;
}

/** What the tuner sends to the ranking engine: the state, the singer's range, and the page wanted. */
export interface SetlistRequest extends SetlistState {
  range: { low: Midi; high: Midi };
  /** Default 0. */
  offset?: number;
  /** 1 to 200, default 100. */
  limit?: number;
}

export interface SetlistResponse {
  /** The page asked for, best first. Row `i` is rank `offset + i + 1`. */
  songs: SetlistSong[];
  /** How many songs pass the range and the Era filter: what `songs` is a page of. */
  total: number;
  /** Offset of the next page, or null at the end. */
  nextOffset: number | null;
  /** Data-source lines for the songs on this page, keyed by track id (the song page's info button). */
  sources: Record<string, DataSourceLogEntry>;
  /** The parts that counted: not the ones in `off`, and not History unless the singer's library was read. */
  applied: TunerPart[];
  /**
   * Why there are no songs: Era is on with no era picked ('no-era-picked', the design's "Pick an era to see songs."),
   * no song of the picked eras fits the range, or nothing fits the range at all. Unset when there are songs.
   */
  empty?: 'no-era-picked' | 'no-songs-in-era' | 'no-songs-in-range';
  /** True when the singer is signed in but their Spotify library could not be read: the list is the catalogue's. */
  libraryUnavailable?: boolean;
}

export type EmptyReason = NonNullable<SetlistResponse['empty']>
