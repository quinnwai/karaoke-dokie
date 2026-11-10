// Results without Spotify (QWW-2 Track B). Someone who has not connected Spotify gets songs from
// the public catalogue: every song with a measured range (store.listCatalogue). It is stateless:
// the visitor's range comes with each request, and nothing about them is kept here.
//
// Catalogue songs are shown as tracks nobody has played. Familiarity is 1, so comfort alone
// decides the fit part of the score, and known is false, so no reason says the user listens to
// them (score.ts). Popularity comes from the song's USDB views and stars and from our karaoke
// popularity (KaraFun views, Billboard Year-End rank), whatever measured its range.

import type { DataSourceLogEntry, Match, RecommendationsResponse, SongRange, Track, VocalRange } from '../contracts';
import { applyCanonical, type SongCanonical } from '../songs/canonical';
import { partRange } from '../songs/match';
import { hasLittleSinging } from '../songs/resolve';
import { withKaraokePopularity } from '../songs/score';
import { tempoOf } from '../tempo/tempo';
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
  /** Tempo in beats per minute (QWW-40), when any source has one. */
  tempo?: number;
}

/** A catalogue song and the track it is shown as. Its log line carries the track id. */
export interface CatalogueTrack extends CatalogueEntry {
  track: Track;
}

/** A load that could not read the mapping it was asked to apply: the songs are right but not tidy, so the cache keeps it only briefly. */
export type LoadedCatalogue = CatalogueEntry[] & { degraded?: true };
/** How long a degraded load is served before the next request reads again. */
export const DEGRADED_TTL_MS = 60_000;

export interface LoadOptions {
  /**
   * Apply the stored one-song-one-row mapping (QWW-49: songs/canonical.ts applyCanonical): one row per song,
   * with its clean title and artist line. The app and the live-data smoke test ask for it. Off, the catalogue is
   * as stored, which is what reports that look songs up by key want (report:library, tempo:report).
   */
  canonical?: boolean;
}

/**
 * The stored mapping for these keys, read twice at most. Empty when the build has not run, and also when it
 * cannot be read: the list then shows the titles as stored, as it did before the build existed, instead of
 * failing, and `failed` says so, so the cache does not keep that for long.
 */
async function readCanonical(
  store: Partial<Pick<Store, 'getSongCanonical'>>,
  keys: string[],
): Promise<{ mapping: Map<string, SongCanonical>; failed: boolean }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { mapping: (await store.getSongCanonical?.(keys)) ?? new Map(), failed: false };
    } catch (err) {
      if (attempt < 2) continue;
      console.warn(`[catalogue] could not read song_canonical; showing the titles as stored for a minute: ${err instanceof Error ? err.message : err}`);
      return { mapping: new Map(), failed: true };
    }
  }
}

/**
 * Reads the catalogue, most popular first, and its songs' karaoke popularity in one batched read.
 * The cache keeps both, so requests read neither. With `canonical`, one row per song with its clean title
 * and artist line, from the stored mapping when there is one.
 */
export async function loadCatalogue(
  store: Pick<Store, 'listCatalogue' | 'getSongPopularity' | 'getSongTempos'> & Partial<Pick<Store, 'getSongCanonical'>>,
  size: number = CATALOGUE_SIZE,
  opts: LoadOptions = {},
): Promise<LoadedCatalogue> {
  const listed = await store.listCatalogue(size);
  const read = opts.canonical ? await readCanonical(store, listed.map((s) => s.key)) : { mapping: new Map<string, SongCanonical>(), failed: false };
  const songs = applyCanonical(listed, read.mapping);
  const keys = songs.map((s) => s.key);
  const [popularity, tempos] = await Promise.all([store.getSongPopularity(keys), store.getSongTempos(keys)]);
  const entries: LoadedCatalogue = songs.map((s) => {
    const p = popularity.get(s.key);
    const tempo = tempoOf(tempos.get(s.key), s.key);
    return { ...s, ...(p ? { popularity: p } : {}), ...(tempo !== undefined ? { tempo } : {}) };
  });
  if (read.failed) entries.degraded = true;
  return entries;
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

/** Matches the whole catalogue against the visitor's range, ranks it, then returns all of it or one page. */
export function recommendCatalogue(
  songs: CatalogueTrack[],
  userRange: VocalRange,
  deps: CatalogueDeps,
  page: CataloguePage,
): RecommendationsResponse {
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

export interface Catalogue {
  /** The catalogue as tracks: read from the store on first use, and again once the TTL has passed. */
  get(): Promise<CatalogueTrack[]>;
  recommend(userRange: VocalRange, page: CataloguePage): Promise<RecommendationsResponse>;
}

/** The catalogue cached per process. `load` reads it from the store (loadCatalogue); a degraded load is kept for DEGRADED_TTL_MS only. */
export function createCatalogue(
  load: () => Promise<LoadedCatalogue>,
  deps: CatalogueDeps,
  opts: { ttlMs?: number; now?: () => number } = {},
): Catalogue {
  const ttlMs = opts.ttlMs ?? CATALOGUE_TTL_MS;
  const now = opts.now ?? Date.now;
  // Requests that arrive during a read share it. A failed read is dropped, so the next request retries.
  let cached: { tracks: Promise<CatalogueTrack[]>; expires: number } | null = null;
  const get = (): Promise<CatalogueTrack[]> => {
    if (cached && cached.expires > now()) return cached.tracks;
    const entry = {
      tracks: load().then((entries) => {
        if (entries.degraded) entry.expires = Math.min(entry.expires, now() + DEGRADED_TTL_MS);
        return catalogueTracks(entries);
      }),
      expires: now() + ttlMs,
    };
    entry.tracks.catch(() => {
      if (cached === entry) cached = null;
    });
    cached = entry;
    return entry.tracks;
  };
  return {
    get,
    async recommend(userRange, page) {
      return recommendCatalogue(await get(), userRange, deps, page);
    },
  };
}
