// Props for rendering <SetlistScreen> on its own in screen tests, the selectors of its DOM contract (spec §9 and the
// QWW-46 screen), and builders for songs: a Match as the server sends it (what the ranking engine takes in) and a
// SetlistSong as the engine sends it back (what the screen draws).
import type { Label, Match, OctaveShift, ScoreParts, VocalRange } from '../../src/lib/contracts';
import type { SetlistScreenProps } from '../../src/components/setlist/SetlistScreen';
import { SHOW_STEP } from '../../src/lib/client/flow';
import { eraOf } from '../../src/lib/setlist/eras';
import { initialTuner } from '../../src/lib/setlist/tuner';
import type { EraId, GearId, SetlistResponse, SetlistSong, TunerPart } from '../../src/lib/setlist/types';

const noop = () => {};

/** A range that most fixture songs fit inside: A2 to C5. */
export const RANGE: VocalRange = { low: 45, high: 72, source: 'test' };

/**
 * Every prop of the screen, with no-op callbacks. Catalogue mode by default (nobody signed in), with the tuner every
 * singer starts from; a test for a signed-in singer passes `mode: 'library'`. `songs` are what the ranking engine
 * returned, best first (`null` until it has answered).
 */
export function setlistProps(range: VocalRange, songs: SetlistSong[] | null, overrides: Partial<SetlistScreenProps> = {}): SetlistScreenProps {
  return {
    range,
    mode: 'catalogue',
    tuner: initialTuner(),
    songs,
    shown: SHOW_STEP,
    loading: false,
    error: false,
    displayName: 'Test Singer',
    onTuner: noop,
    onGearDone: noop,
    onSelect: noop,
    onMore: noop,
    onRetry: noop,
    onRedo: noop,
    onRedoEnd: noop,
    onConnect: noop,
    onLogout: async () => {},
    ...overrides,
  };
}

// ---- the DOM contract ----

export const SEL = {
  app: '#app',
  sheet: '#sheet',
  handle: '#handle',
  rack: '#rack',
  strips: '#strips',
  eraPanel: '#era-panel',
  tabs: '#tabs',
  /** The ranked list. */
  list: 'ol[aria-label="Ranked songs"]',
  /** One row of it; `data-id` is the track id and `data-rank` the 1-based place. */
  row: '[data-row]',
  /** The slot at the end of a row that holds the play button, outside the button that opens the song. */
  playSlot: '[data-play-slot]',
  /** "Pick an era to see songs." */
  empty: '#empty',
  strip: (gear: GearId) => `[data-strip][data-gear="${gear}"]`,
  slider: (gear: GearId) => `#slider-${gear}`,
  reset: (gear: TunerPart) => `[data-reset="${gear}"]`,
  era: (era: EraId) => `[data-era="${era}"]`,
  tab: (gear: TunerPart) => `#tabs [data-tab][data-gear="${gear}"]`,
} as const;

/** The first element that matches, or a thrown error that names the selector, so a test fails on the line that asked. */
export function el<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Nothing matches ${selector}`);
  return found;
}

export const all = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T[] =>
  Array.from(root.querySelectorAll<T>(selector));

/** The track ids of the rows on screen, top to bottom. The DOM is in rank order, so this is the ranking. */
export const rowIds = (): string[] => all(SEL.row).map((li) => li.dataset.id ?? '');

// ---- songs with scores a test controls ----

export interface SongOptions {
  title?: string;
  artist?: string;
  /** Release year, or null for a song with no known year (so no era). Default 1995. */
  year?: number | null;
  /** The label the song shows. Default 'easy'. */
  difficulty?: Label;
  /**
   * 0 to 3: how hard the song is inside its label. For easy, medium and hard it orders the songs of one label on the
   * Difficulty gear (the engine places each label's songs in its own third of the track by strain). Default 0.
   */
  strain?: number;
  /** 0 to 1, or null when nothing is known about how well known the song is. Default 0.5. */
  popularity?: number | null;
  /** 0 to 1: how much the singer plays it, or null for a song with no listening data. Default 0.5. */
  history?: number | null;
  /** Beats per minute, or null when no tempo is known. Default 120. */
  tempo?: number | null;
  /** The song's lowest and highest note. Default 50 to 64, inside `RANGE`. */
  range?: { low: number; high: number };
  /** The play rank, lower = played more. It breaks ties between songs that score the same on a gear. Default 0. */
  playRank?: number;
  /** 'up' or 'down': the song fits only if sung an octave higher or lower than the artist (R13). Default 'none', as written. */
  octave?: OctaveShift;
}

/** A match whose year, difficulty, popularity, listening history and tempo are exactly what the options say. */
export function song(id: string, o: SongOptions = {}): Match {
  const low = o.range?.low ?? 50;
  const high = o.range?.high ?? 64;
  const year = o.year === undefined ? 1995 : o.year;
  const popularity = o.popularity === undefined ? 0.5 : o.popularity;
  const history = o.history === undefined ? 0.5 : o.history;
  const tempo = o.tempo === undefined ? 120 : o.tempo;
  // `familiarity` is typed as always there; the engine reads it defensively, so a song with no listening data leaves it out.
  const parts = {
    comfort: 1,
    ...(history === null ? {} : { familiarity: history }),
    popularity: popularity ?? 0.5,
    popularityKnown: popularity !== null,
    penalty: 0,
  } as ScoreParts;
  return {
    track: {
      id,
      title: o.title ?? `Song ${id}`,
      artist: o.artist ?? `Artist ${id}`,
      artistId: `a-${id}`,
      spotifyUrl: `https://open.spotify.com/track/${id}`,
      playRank: o.playRank ?? 0,
    },
    range: { low, high, tessitura: Math.round((low + high) / 2), source: 'note-file', confidence: 'high', fastLyrics: false },
    difficulty: o.difficulty ?? 'easy',
    octave: o.octave ?? 'none',
    strain: o.strain ?? 0,
    parts,
    ...(year === null ? {} : { year }),
    ...(tempo === null ? {} : { tempo }),
  };
}

/** Where a gear puts a song: 0 to 100, or null when it is not known. */
export type Places = Partial<Record<GearId, number | null>>;

/** The place a lone song of each label gets on Difficulty: the middle of the label's third of the track. */
const LABEL_PLACE: Record<Label, number> = { easy: 16.7, medium: 50, hard: 83.3, maybe: 50 };

/**
 * A song as the ranking engine returns it: the match, its era, and its place on each gear. Difficulty sits in the middle
 * of the match's label's third unless `places` says otherwise; every other gear is unknown unless `places` gives it.
 */
export function ranked(match: Match, places: Places = {}): SetlistSong {
  return {
    match,
    era: eraOf(match.year),
    gears: { difficulty: LABEL_PLACE[match.difficulty], history: null, popularity: null, tempo: null, ...places },
  };
}

/** `ranked(song(id, options), places)`: a returned song built from options in one go. */
export const rankedSong = (id: string, options: SongOptions = {}, places: Places = {}): SetlistSong => ranked(song(id, options), places);

/**
 * A whole answer from the ranking engine, for a fake one: the songs as given, `total` their count, one page, and the
 * parts that count by default (Difficulty and Popularity). `extra` overrides any field, e.g. `{ empty: 'no-era-picked' }`.
 */
export function response(songs: SetlistSong[], extra: Partial<SetlistResponse> = {}): SetlistResponse {
  return { songs, total: songs.length, nextOffset: null, sources: {}, applied: ['difficulty', 'popularity'], ...extra };
}
