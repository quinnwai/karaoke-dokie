// The one place that decides which implementations the running app uses.
// Swap points:
//  - song logic: songLogicFallback.ts -> src/lib/songs (songKey, matchSong, rankMatches, paginate,
//    resolveSongRange(track, deps)) once that module is merged;
//  - note files: noteFileSource -> the USDB fetcher once it exists.
import type { SongRange, Track } from '../contracts';
import seedFile from '../../../data/seed-song-ranges.json';
import { configProblems, readConfig, type ServerConfig } from './config';
import { getStore, resetStoreForTests } from './getStore';
import { createMockSpotifyClient } from './mockSpotify';
import { matchSong, paginate, rankMatches, songKey } from './songLogicFallback';
import { createSongService, type ResolveResult, type SongDeps, type SongService } from './songService';
import { createSpotifyClient, type SpotifyClient } from './spotify';
import type { Store } from './store';
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
}

export const SEED_SONGS: SeedSong[] = (seedFile as { songs: SeedSong[] }).songs;

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

export function productionSongDeps(): SongDeps {
  return {
    songKey,
    resolveSongRange: createPlaceholderResolver(SEED_SONGS, songKey, noteFileSource),
    matchSong,
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
  /** Non-empty when env is missing something sign-in needs. */
  problems: string[];
}

const g = globalThis as unknown as { __karaokeApp?: AppContext };

export function getAppContext(): AppContext {
  const store = getStore();
  if (!g.__karaokeApp || g.__karaokeApp.store !== store) {
    const config = readConfig();
    g.__karaokeApp = {
      config,
      store,
      spotify: config.spotifyMock ? createMockSpotifyClient() : createSpotifyClient(config.spotify),
      songs: createSongService(store, productionSongDeps()),
      tracks: createTrackCache(),
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
