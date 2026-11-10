// Results without Spotify (QWW-2 Track B). Someone who has not connected Spotify gets songs from
// the public catalogue: every song with a measured range (store.listCatalogue). It is stateless:
// the visitor's range comes with each request, and nothing about them is kept here.
//
// Catalogue songs are shown as tracks nobody has played. Familiarity is 1, so comfort alone
// decides the fit part of the score, and known is false, so no reason says the user listens to
// them (score.ts). Popularity comes from the song's USDB views and stars and from our karaoke
// popularity (KaraFun views, Billboard Year-End rank), whatever measured its range.

import type { DataSourceLogEntry, Match, RecommendationsResponse, SetlistInput, SongRange, Track, VocalRange } from '../contracts';
import { partRange } from '../songs/match';
import { hasLittleSinging } from '../songs/resolve';
import { withKaraokePopularity } from '../songs/score';
import { prepareSetlist, rankPrepared, type PreparedSetlist, type RankedSetlist } from '../songs/setlist';
import { effectiveTempo, type EffectiveSource } from '../tempo/feel';
import { readSongFeels } from './songFeel';
import { MAX_ALL_MATCHES, type SongDeps } from './songService';
import type { CatalogueSong, SongPopularityRecord, Store, UsdbIndexEntry } from './store';

/** How many songs are read from the store, most popular first; every Year-End song is read as well. */
export const CATALOGUE_SIZE = 6000;
/** One read of the catalogue serves every request in the process for this long. */
export const CATALOGUE_TTL_MS = 60 * 60_000;

const ID_PREFIX = 'cat:';

/** A catalogue song as the cache keeps it: with its karaoke popularity row (QWW-6), when it has one. */
export interface CatalogueEntry extends CatalogueSong {
  popularity?: SongPopularityRecord;
  /** The one tempo the ranking uses, in beats per minute, when the song has one (QWW-40; with its feel label, QWW-54). */
  tempo?: number;
  /** Where `tempo` came from: a measurement, a checked tempo, or the song's feel label. */
  tempoSource?: EffectiveSource;
}

/** A catalogue song and the track it is shown as. Its log line carries the track id. */
export interface CatalogueTrack extends CatalogueEntry {
  track: Track;
}

/**
 * Reads the catalogue, most popular first, and its songs' karaoke popularity, measured tempo and feel
 * labels in batched reads. The cache keeps all of it, so requests read none of it, and the one tempo of
 * each song is worked out here, once per cache fill (effectiveTempo), never per request. A store with no
 * feel labels, or one that cannot give them, leaves every song on its measured tempo.
 */
export async function loadCatalogue(
  store: Pick<Store, 'listCatalogue' | 'getSongPopularity' | 'getSongTempos'> & Partial<Pick<Store, 'getSongFeels'>>,
  size: number = CATALOGUE_SIZE,
): Promise<CatalogueEntry[]> {
  const songs = await store.listCatalogue(size);
  const keys = songs.map((s) => s.key);
  const [popularity, tempos, feels] = await Promise.all([store.getSongPopularity(keys), store.getSongTempos(keys), readSongFeels(store, keys)]);
  return songs.map((s) => {
    const p = popularity.get(s.key);
    const t = effectiveTempo({ key: s.key, record: tempos.get(s.key), feel: feels.get(s.key)?.feel });
    return { ...s, ...(p ? { popularity: p } : {}), ...(t ? { tempo: t.tempo, tempoSource: t.source } : {}) };
  });
}

/** The song key in a catalogue track id ("cat:<songKey>"), or null for any other id. */
export function catalogueKey(trackId: string): string | null {
  return trackId.startsWith(ID_PREFIX) && trackId.length > ID_PREFIX.length ? trackId.slice(ID_PREFIX.length) : null;
}

/**
 * Catalogue songs as tracks, in catalogue order (playRank). The stored log line keeps whatever
 * track id wrote it, which can be a tester's Spotify track, so it is replaced with the catalogue id.
 */
export function catalogueTracks(songs: CatalogueEntry[]): CatalogueTrack[] {
  return songs.map((song, i) => {
    const id = ID_PREFIX + song.key;
    const track: Track = {
      id,
      title: song.title,
      artist: song.artist,
      artistId: '',
      spotifyUrl: `https://open.spotify.com/search/${encodeURIComponent(`${song.artist} ${song.title}`)}`,
      playRank: i,
      familiarity: 1,
      known: false,
    };
    return { ...song, log: { ...song.log, trackId: id }, track };
  });
}

/** The song logic the catalogue uses, from the same SongDeps as the Spotify library. */
export type CatalogueDeps = Pick<SongDeps, 'matchSong' | 'rankMatches' | 'paginate'>;

/** Every match at once (`complete`), or one page of them. */
export type CataloguePage = { all: true } | { offset: number; limit: number };

/**
 * The range a song is scored with: USDB views and stars from its USDB row when the range has
 * none (bulk-imported note files, measured recordings), so popularity is not the flat default.
 * Only for scoring: the match keeps the stored range.
 */
function scoringRange(range: SongRange, usdb: UsdbIndexEntry | undefined): SongRange {
  if (!usdb) return range;
  const out = { ...range };
  if (out.usdbViews === undefined && usdb.views !== undefined) out.usdbViews = usdb.views;
  if (out.usdbRating === undefined && usdb.rating !== undefined) out.usdbRating = usdb.rating;
  return out;
}

/** A range without pitch histograms: the client does not use them, and all=1 sends every match. */
function withoutPitchShare(range: SongRange): SongRange {
  const { pitchShare: _, ...rest } = range;
  if (rest.parts) rest.parts = rest.parts.map(({ pitchShare: _p, ...part }) => part);
  return rest;
}

/**
 * The catalogue songs that fit `userRange` (the hard range filter: `deps.matchSong` is null for a song that does
 * not), as matches carrying their year, genre and tempo, and the log line of each by track id. Neither ranked nor
 * cut, and the stored range, pitch histogram included, is kept.
 */
export function catalogueMatches(
  songs: CatalogueTrack[],
  userRange: VocalRange,
  deps: Pick<CatalogueDeps, 'matchSong'>,
): { matches: Match[]; logs: Map<string, DataSourceLogEntry> } {
  const matches: Match[] = [];
  const logs = new Map<string, DataSourceLogEntry>();
  for (const song of songs) {
    if (hasLittleSinging(song.title)) continue; // a dub or karaoke version shares the original's key
    const scored = withKaraokePopularity(scoringRange(song.range, song.usdb), song.popularity);
    const fit = deps.matchSong(song.track, scored, userRange);
    if (!fit) continue;
    // The stored range, not the scored copy. A duet is shown as the part it matched (toMatch), so its
    // range is that part's: the whole song's is part 1's, and the bar would draw the other singer's notes.
    const m: Match = { ...fit, range: fit.part === undefined ? song.range : partRange(song.range, fit.part) };
    if (song.usdb?.year !== undefined) {
      m.year = song.usdb.year;
      m.yearSource = 'usdb';
    } else if (song.popularity?.chartYear !== undefined) {
      // A Year-End chart year can be a year after release, so only when USDB has no year.
      m.year = song.popularity.chartYear;
      m.yearSource = 'chart';
    }
    if (song.usdb?.genre) m.genre = song.usdb.genre;
    if (song.tempo !== undefined) m.tempo = song.tempo;
    matches.push(m);
    logs.set(song.track.id, song.log);
  }
  return { matches, logs };
}

/** Matches the whole catalogue against the visitor's range, ranks it, then returns all of it or one page. */
export function recommendCatalogue(
  songs: CatalogueTrack[],
  userRange: VocalRange,
  deps: CatalogueDeps,
  page: CataloguePage,
): RecommendationsResponse {
  const { matches, logs } = catalogueMatches(songs, userRange, deps);

  // Ranked as a whole, then paged. The order is the same on every request while the cached
  // catalogue lasts, so pages never repeat or skip a song.
  const ranked = deps.rankMatches(matches);
  const sources = (items: Match[]) => Object.fromEntries(items.map((m) => [m.track.id, logs.get(m.track.id)!]));
  if ('all' in page) {
    // A wide range can match thousands of catalogue songs; the phone gets the best ones by Top
    // picks, which is plenty for every sort and chip and keeps the response small on a phone.
    const best = ranked.slice(0, MAX_ALL_MATCHES);
    const all = best.map((m) => ({ ...m, range: withoutPitchShare(m.range) }));
    // Same contract as the library's all=1: a trimmed list says so, with no offset to ask again from.
    return { matches: all, nextOffset: null, sources: sources(best), complete: best.length === ranked.length };
  }
  const { items, nextOffset } = deps.paginate(ranked, page.offset, page.limit);
  return { matches: items, nextOffset, sources: sources(items) };
}

// ---------- the Setlist tuner (QWW-47) ----------

/** One singer's catalogue songs, matched and with their place on every gear: made once per range, reused while a slider moves. */
export interface CatalogueSetlist {
  /** Every catalogue song that fits the range. */
  matches: Match[];
  logs: Map<string, DataSourceLogEntry>;
  prepared: PreparedSetlist;
}

/** The hard range filter, then every song's place on every gear (songs/setlist.ts). */
export function prepareCatalogue(
  songs: CatalogueTrack[],
  range: Pick<VocalRange, 'low' | 'high'>,
  deps: Pick<CatalogueDeps, 'matchSong'>,
): CatalogueSetlist {
  const { matches, logs } = catalogueMatches(songs, { low: range.low, high: range.high, source: 'test' }, deps);
  return { matches, logs, prepared: prepareSetlist(matches.map((match) => ({ match })), range) };
}

/**
 * The engine over the catalogue, in one call: the songs of `songs` that fit `input.range`, ranked for the tuner's state.
 * For a script or a test that holds the tracks; the server asks Catalogue.setlist, which keeps the first part.
 */
export function rankCatalogue(songs: CatalogueTrack[], input: SetlistInput, deps: Pick<CatalogueDeps, 'matchSong'>): RankedSetlist {
  return rankPrepared(prepareCatalogue(songs, input.range, deps).prepared, input);
}

/** Ranges whose prepared songs a process keeps. Each is a few thousand matches, so only the ranges testers are using. */
export const SETLIST_RANGES_KEPT = 6;

export interface Catalogue {
  /** The catalogue as tracks: read from the store on first use, and again once the TTL has passed. */
  get(): Promise<CatalogueTrack[]>;
  recommend(userRange: VocalRange, page: CataloguePage): Promise<RecommendationsResponse>;
  /** The tuner's songs for a range, kept for the next requests (the last SETLIST_RANGES_KEPT ranges), and dropped when the catalogue reloads. */
  setlist(range: Pick<VocalRange, 'low' | 'high'>): Promise<CatalogueSetlist>;
}

/** The catalogue cached per process. `load` reads it from the store (loadCatalogue). */
export function createCatalogue(
  load: () => Promise<CatalogueEntry[]>,
  deps: CatalogueDeps,
  opts: { ttlMs?: number; now?: () => number } = {},
): Catalogue {
  const ttlMs = opts.ttlMs ?? CATALOGUE_TTL_MS;
  const now = opts.now ?? Date.now;
  // Requests that arrive during a read share it. A failed read is dropped, so the next request retries.
  let cached: { tracks: Promise<CatalogueTrack[]>; expires: number } | null = null;
  const get = (): Promise<CatalogueTrack[]> => {
    if (cached && cached.expires > now()) return cached.tracks;
    const entry = { tracks: load().then(catalogueTracks), expires: now() + ttlMs };
    entry.tracks.catch(() => {
      if (cached === entry) cached = null;
    });
    cached = entry;
    return entry.tracks;
  };
  // Most recently used last. Made from one read of the catalogue: a reload (a new array) starts them again.
  const lists = new Map<string, CatalogueSetlist>();
  let listsFrom: CatalogueTrack[] | null = null;
  return {
    get,
    async recommend(userRange, page) {
      return recommendCatalogue(await get(), userRange, deps, page);
    },
    async setlist(range) {
      const tracks = await get();
      if (listsFrom !== tracks) {
        lists.clear();
        listsFrom = tracks;
      }
      const key = `${range.low}:${range.high}`;
      const hit = lists.get(key);
      const list = hit ?? prepareCatalogue(tracks, range, deps);
      lists.delete(key);
      lists.set(key, list);
      if (lists.size > SETLIST_RANGES_KEPT) lists.delete(lists.keys().next().value!);
      return list;
    },
  };
}
