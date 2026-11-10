// The ranking engine port, and the INTERIM engine behind it.
//
// QWW-47 owns the real engine: server side (POST /api/setlist), with the hard range filter, "easy leans low", "never
// empty" and the tempo from QWW-54. The tuner talks to it through `SetlistEngine`: a SetlistRequest in, a
// SetlistResponse out (types in ./types, mirroring QWW-47's contract). Until that merges, `createLocalEngine` ranks the
// matches the screen already loaded, with the same model, so the tuner works on real data. When QWW-47 lands, only the
// engine passed to the screen changes (a `fetch` of /api/setlist instead of this): nothing on the screen ranks.
//
// The model is spec §5 as QWW-47 decided it (option A):
//   place    = a song's rank among the songs that fit, 0 to 100, per gear (browse.ts sliderPlaces: each tenth of a
//              track holds about a tenth of the songs; Difficulty gives Easy, Medium and Hard a third each)
//   distance = sum over the gears that count of weight × |place - target|
//   order    = songs in the picked eras (every era when Era is off), nearest first, ties in the server's order
// Popularity weighs double: it leads, and Difficulty orders within it. A song we know nothing about on a gear that
// counts sorts after the rest on it. History counts only once the singer's library was read. Songs with only an
// estimated range (Maybe) come after the rest, each group laid out on the gears on its own. A song whose range spans
// fewer than 5 semitones is not a real melody (QWW-43's "Jump"): its difficulty is unknown, so it cannot win on "easy".
//
// The list is every song at once: the local engine does not page (`offset` and `limit` are ignored, `nextOffset` is null).

import type { DataSourceLogEntry, Match, SliderId, VocalRange } from '../contracts';
import { sliderPlaces } from '../songs/browse';
import { eraOf } from './eras';
import type { EmptyReason, GearId, SetlistInput, SetlistRequest, SetlistResponse, SetlistSong, TunerPart } from './types';
import { GEAR_IDS, TUNER_PARTS } from './types';

export interface SetlistEngine {
  /** The songs for this request, best first. */
  rank(request: SetlistRequest): Promise<SetlistResponse>;
}

export const GEAR_WEIGHT: Record<GearId, number> = { difficulty: 1, history: 1, popularity: 2, tempo: 1 };

/** Farther than the 100 a known song can be from a target, so an unknown place always sorts after a known one. */
export const UNKNOWN_DISTANCE = 150;

/** A song's lowest to highest note must span at least this many semitones to say anything about its difficulty. */
export const MIN_PLAUSIBLE_SPAN = 5;

/** The gear id's name in the older slider code (browse.ts) that places songs. */
const SLIDER_OF: Record<GearId, SliderId> = { difficulty: 'difficulty', history: 'familiarity', popularity: 'popularity', tempo: 'tempo' };

const percent = (place: number | null): number | null => (place === null ? null : Math.round(place * 1000) / 10);

/** Where each of `songs` sits on one gear, 0 to 100, or null when unknown. */
function placesOn(gear: GearId, songs: Match[], user: VocalRange): (number | null)[] {
  if (gear !== 'difficulty') return sliderPlaces(songs, SLIDER_OF[gear], user).map(percent);
  // Songs with an implausibly narrow range take no part in placing the others, and have no place themselves.
  const real = songs.flatMap((m, i) => (m.range.high - m.range.low >= MIN_PLAUSIBLE_SPAN ? [i] : []));
  const placed = sliderPlaces(
    real.map((i) => songs[i]!),
    'difficulty',
    user,
  );
  const out = songs.map((): number | null => null);
  real.forEach((i, k) => (out[i] = percent(placed[k] ?? null)));
  return out;
}

export function rankSetlist(candidates: Match[], input: SetlistInput): { songs: SetlistSong[]; applied: TunerPart[]; empty?: EmptyReason } {
  const off = new Set(input.off);
  const user: VocalRange = { low: input.range.low, high: input.range.high, source: 'test' };
  const counting = GEAR_IDS.filter((g) => !off.has(g) && (g !== 'history' || input.loggedIn));
  const eraOn = !off.has('era');
  const applied = TUNER_PARTS.filter((p) => (p === 'era' ? eraOn : (counting as readonly TunerPart[]).includes(p)));

  // Every song's place on every gear, the Maybe songs laid out on their own.
  const maybe = (m: Match) => (m.difficulty === 'maybe' ? 1 : 0);
  const places = candidates.map((): SetlistSong['gears'] => ({ difficulty: null, history: null, popularity: null, tempo: null }));
  for (const group of [0, 1]) {
    const at = candidates.flatMap((m, i) => (maybe(m) === group ? [i] : []));
    if (!at.length) continue;
    const songs = at.map((i) => candidates[i]!);
    for (const gear of GEAR_IDS) {
      // History is the singer's own library: for anyone else it has no places.
      if (gear === 'history' && !input.loggedIn) continue;
      placesOn(gear, songs, user).forEach((place, k) => (places[at[k]!]![gear] = place));
    }
  }

  const rows = candidates.map((match, i) => ({ match, i, era: eraOf(match.year), gears: places[i]! }));
  const inEra = eraOn ? rows.filter((r) => r.era !== null && input.eras.includes(r.era)) : rows;

  let empty: EmptyReason | undefined;
  if (inEra.length === 0) empty = eraOn && input.eras.length === 0 ? 'no-era-picked' : candidates.length === 0 ? 'no-songs-in-range' : 'no-songs-in-era';

  const ranked = inEra
    .map((r) => {
      let distance = 0;
      for (const g of counting) {
        const place = r.gears[g];
        distance += GEAR_WEIGHT[g] * (place === null ? UNKNOWN_DISTANCE : Math.abs(place - input.gears[g]));
      }
      return { r, distance, group: maybe(r.match) };
    })
    .sort((a, b) => a.group - b.group || a.distance - b.distance || a.r.i - b.r.i);

  return { songs: ranked.map(({ r }) => ({ match: r.match, era: r.era, gears: r.gears })), applied, ...(empty ? { empty } : {}) };
}

/**
 * The interim engine: ranks `candidates` (every match the server sent for the range) in the browser.
 * `loggedIn` says whether they are the singer's library (History counts) or the catalogue.
 */
export function createLocalEngine(
  candidates: Match[],
  opts: { loggedIn: boolean; sources?: Record<string, DataSourceLogEntry>; libraryUnavailable?: boolean },
): SetlistEngine {
  return {
    rank: (request) => {
      const { songs, applied, empty } = rankSetlist(candidates, { ...request, loggedIn: opts.loggedIn });
      return Promise.resolve({
        songs,
        total: songs.length,
        nextOffset: null,
        sources: opts.sources ?? {},
        applied,
        ...(empty ? { empty } : {}),
        ...(opts.libraryUnavailable ? { libraryUnavailable: true } : {}),
      });
    },
  };
}
