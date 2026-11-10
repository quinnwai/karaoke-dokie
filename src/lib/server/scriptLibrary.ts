// The Spotify library for scripts (QWW-55 PR 2). Real Spotify only with --live; otherwise a saved snapshot
// (--snapshot <file>, or SPOTIFY_SNAPSHOT) or the offline mock, so a run by hand, in CI or by an agent makes no
// real request and takes nothing from the quota that testers share.
import { readFile, writeFile } from 'node:fs/promises';
import type { Track } from '../contracts';
import { readConfig } from './config';
import { loadLibrary } from './library';
import { createMockSpotifyClient } from './mockSpotify';
import { createSpotifyClient, getUserTracks, type FetchFn } from './spotify';
import { countingFetch, withCaller } from './spotifyCalls';
import type { Store, UserRecord } from './store';

export type LibrarySource = 'live' | 'snapshot' | 'mock';

export interface ScriptLibraryOptions {
  /** The script's name without .ts, e.g. "usdb-sync": the caller its requests are counted for. */
  script: string;
  argv: string[];
  env: Record<string, string | undefined>;
  store: Store;
  /** The fetch for --live (tests pass a fake). */
  fetch?: FetchFn;
}

const argOf = (argv: string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
};

/** Whether the script was started with --live. */
export const isLive = (argv: string[]): boolean => argv.includes('--live');

/** A snapshot file: a JSON list of songs as `--live --save-snapshot <file>` writes them. */
export async function readSnapshot(file: string): Promise<Track[]> {
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(parsed) || parsed.some((t) => typeof t?.id !== 'string' || typeof t?.title !== 'string' || typeof t?.artist !== 'string')) {
    throw new Error(`${file} is not a list of songs (each needs id, title and artist)`);
  }
  return parsed as Track[];
}

/**
 * The user's library for a script and where it came from. With --live it is the stored library brought up to date
 * from real Spotify (and, with --save-snapshot <file>, written out as a snapshot for later runs); without, never a request.
 */
export async function readScriptLibrary(user: UserRecord, o: ScriptLibraryOptions): Promise<{ tracks: Track[]; source: LibrarySource }> {
  if (isLive(o.argv)) {
    const spotify = createSpotifyClient(readConfig({ ...o.env, SPOTIFY_LIVE: '1' }).spotify, countingFetch(o.fetch ?? ((i, init) => fetch(i, init)), o.store));
    const tracks = await withCaller(`script:${o.script}`, () => loadLibrary(user, { store: o.store, spotify }));
    const out = argOf(o.argv, '--save-snapshot');
    if (out) await writeFile(out, JSON.stringify(tracks));
    return { tracks, source: 'live' };
  }
  if (argOf(o.argv, '--save-snapshot')) throw new Error('--save-snapshot needs --live: a snapshot is written from a real read');
  const snapshot = argOf(o.argv, '--snapshot') ?? o.env.SPOTIFY_SNAPSHOT;
  if (snapshot) return { tracks: await readSnapshot(snapshot), source: 'snapshot' };
  return { tracks: await getUserTracks(createMockSpotifyClient(), 'mock'), source: 'mock' };
}
