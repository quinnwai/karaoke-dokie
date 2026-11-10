// The one place that decides which implementations the running app uses.
// Song logic comes from src/lib/songs. Note files come from noteFileSource (the USDB fetcher).
// Seed ranges are used only with SPOTIFY_MOCK=1, so the offline demo and e2e tests have data.
import type { DataSourceLogEntry, Mood, SongRange, Track } from '../contracts';
import seedFile from '../../../data/seed-song-ranges.json';
import { createCatalogue, loadCatalogue, type Catalogue } from './catalogue';
import { configProblems, readConfig, type ServerConfig } from './config';
import { getStore, pickStoreKind, resetStoreForTests } from './getStore';
import { createMockSpotifyClient } from './mockSpotify';
import { matchSong as fitSong, toMatch } from '../songs/match';
import { paginate, rankMatches } from '../songs/rank';
import { scoreMatch } from '../songs/score';
import { resolveSongRange, songKey } from '../songs/resolve';
import { createSongService, type ResolveResult, type SongDeps, type SongService } from './songService';
import { createSpotifyClient, type SpotifyClient } from './spotify';
import { countingFetch } from './spotifyCalls';
import type { SongMoodsRecord, Store, UsdbIndexEntry } from './store';
import { createTrackCache, type TrackCache } from './trackCache';

/** Where UltraStar note files come from. */
export interface NoteFileSource {
  /** The note file text, or null when none is available. */
  getNoteFile(artist: string, title: string): Promise<string | null>;
}

/**
 * For now no note files are fetched: ranges come from the store's cache (checked by the song
 * service before any lookup) and the placeholder seeds below. The USDB fetcher plugs in here.
 */
export const noteFileSource: NoteFileSource = {
  async getNoteFile() {
    return null;
  },
};

export interface SeedSong {
  artist: string;
  title: string;
  range: SongRange;
  provenance: string;
  /** The song's USDB index row (placeholder numbers), for the catalogue's popularity, year and genre. */
  usdb?: { id: number; views?: number; rating?: number; year?: number; genre?: string; language?: string };
  /** Placeholder mood labels, for the mood chips in the offline demo. */
  moods?: Mood[];
  /** Not in the mock Spotify library: only the no-Spotify catalogue shows it. */
  catalogueOnly?: boolean;
}

export const SEED_SONGS: SeedSong[] = (seedFile as { songs: SeedSong[] }).songs;

/**
 * Stores the seed ranges, each with a log line naming its provenance, and their USDB rows. Only for
 * mock mode's empty memory store, so the catalogue has songs in the offline demo and e2e. The log
 * lines also go in the source log, as the library lookup used to write them for the seeds.
 */
export async function seedStore(store: Store, seeds: SeedSong[], now: () => Date = () => new Date()): Promise<void> {
  // Every write starts before the first await. The memory store finishes a write as it starts,
  // so it is fully seeded before any request reads it, including feedback, which never waits.
  const writes: Promise<void>[] = [];
  const usdb: UsdbIndexEntry[] = [];
  const moods: SongMoodsRecord[] = [];
  for (const s of seeds) {
    const key = songKey(s.artist, s.title);
    const log: DataSourceLogEntry = { trackId: '', title: s.title, artist: s.artist, outcome: s.range.source, reason: s.provenance, at: now().toISOString() };
    writes.push(store.putSongRange(key, { range: s.range, log }), store.appendLog(log));
    if (s.usdb) usdb.push({ ...s.usdb, key, artist: s.artist, title: s.title });
    if (s.moods?.length) moods.push({ key, moods: s.moods, method: 'placeholder-seed', source: 'seed' });
  }
  writes.push(store.putUsdbSongs(usdb), store.putSongMoods(moods));
  await Promise.all(writes);
}

/**
 * Placeholder resolveSongRange: seed ranges first, then a note file (none yet), else skipped.
 * Replace with src/lib/songs resolveSongRange(track, { noteFiles: noteFileSource, ... }).
 */
export function createPlaceholderResolver(
  seeds: SeedSong[],
  key: (artist: string, title: string) => string,
  noteFiles: NoteFileSource,
  now: () => Date = () => new Date(),
): (track: Track) => Promise<ResolveResult> {
  const byKey = new Map(seeds.map((s) => [key(s.artist, s.title), s]));
  return async (track) => {
    const base = { trackId: track.id, title: track.title, artist: track.artist, at: now().toISOString() };
    const seed = byKey.get(key(track.artist, track.title));
    if (seed) {
      return { range: seed.range, log: { ...base, outcome: seed.range.source, reason: seed.provenance } };
    }
    const file = await noteFiles.getNoteFile(track.artist, track.title);
    const reason = file
      ? 'Note file found but no parser is wired yet'
      : 'No note file found for this song (USDB lookup not connected yet)';
    return { range: null, log: { ...base, outcome: 'skipped', reason } };
  };
}

/** The artist part of a songKey ("artist|title"), used to find other songs by the same artist. */
export function artistKey(artist: string): string {
  return songKey(artist, '').split('|')[0]!;
}

/** How long an artist's measured ranges are reused: a library has many songs by one artist, looked up together. */
const ARTIST_RANGES_TTL_MS = 60_000;

export function realResolver(store: Store, noteFiles: NoteFileSource, now: () => number = Date.now): (track: Track) => Promise<ResolveResult> {
  const byArtist = new Map<string, { at: number; ranges: Promise<SongRange[]> }>();
  const artistRanges = (artist: string) => {
    const key = artistKey(artist);
    const hit = byArtist.get(key);
    if (hit && now() - hit.at < ARTIST_RANGES_TTL_MS) return hit.ranges;
    const ranges = store.listMeasuredRangesByArtist(key);
    // A failed lookup is not kept, so it is retried.
    ranges.catch(() => byArtist.delete(key));
    byArtist.set(key, { at: now(), ranges });
    return ranges;
  };
  return (track) =>
    resolveSongRange(track, {
      getNoteFile: (artist, title) => noteFiles.getNoteFile(artist, title),
      getArtistSongRanges: (artist) => artistRanges(artist),
      // No outside artist-range source is connected in v1.
      getExternalArtistRange: async () => null,
    });
}

export function productionSongDeps(store: Store, mock: boolean): SongDeps {
  return {
    songKey,
    resolveSongRange: mock
      ? createPlaceholderResolver(SEED_SONGS, songKey, noteFileSource)
      : realResolver(store, noteFileSource),
    matchSong: (track, range, userRange) => {
      const fit = fitSong(userRange, range);
      // A duet is scored and shown on the part the user sings: toMatch swaps in that part's range.
      return fit ? scoreMatch(userRange, toMatch(track, range, fit)) : null;
    },
    rankMatches,
    paginate,
  };
}

export interface AppContext {
  config: ServerConfig;
  store: Store;
  spotify: SpotifyClient;
  songs: SongService;
  tracks: TrackCache;
  /** The public catalogue, for visitors without Spotify (QWW-2 Track B). */
  catalogue: Catalogue;
  /** Non-empty when env is missing something sign-in needs. */
  problems: string[];
}

const g = globalThis as unknown as { __karaokeApp?: AppContext };

export function getAppContext(): AppContext {
  const store = getStore();
  if (!g.__karaokeApp || g.__karaokeApp.store !== store) {
    const config = readConfig();
    const deps = productionSongDeps(store, config.spotifyMock);
    // Mock mode's memory store starts empty, so the catalogue would be too. Never into Postgres,
    // where the placeholder seeds would overwrite real ranges.
    const seeded = config.spotifyMock && pickStoreKind() === 'memory' ? seedStore(store, SEED_SONGS) : Promise.resolve();
    g.__karaokeApp = {
      config,
      store,
      spotify: config.spotifyMock ? createMockSpotifyClient() : createSpotifyClient(config.spotify, countingFetch((i, init) => fetch(i, init), store)),
      songs: createSongService(store, deps),
      tracks: createTrackCache(),
      catalogue: createCatalogue(async () => {
        await seeded;
        return loadCatalogue(store);
      }, deps),
      problems: configProblems(config),
    };
  }
  return g.__karaokeApp;
}

/** Tests only: rebuild everything (fresh memory store, re-read env) on next use. */
export function resetAppContextForTests(): void {
  delete g.__karaokeApp;
  resetStoreForTests();
}
