// Reads a signed-in person's Spotify library for the identity audit (scripts/identity-audit.ts), the way
// the app reads it when it opens, but built to be gentle with Spotify's rate limit: one request at a time
// with a pause between them, and a stop at the first HTTP 429 (no further requests). Any other failed
// read is counted and reported, because the client skips a playlist whose read fails and would
// otherwise hand back a library that is missing it.

import type { Track } from '../contracts';
import type { Store } from '../server/store';
import { createSpotifyClient, ensureFreshTokens, getUserListening, SpotifyError, type FetchFn, type Listening, type SpotifyConfig } from '../server/spotify';

/** A run that stopped on purpose; the message says what to do next. */
export class AuditStop extends Error {}

export interface LibraryRead {
  who: string;
  listening: Listening;
  /** Requests sent to Spotify, the token refresh included. */
  requests: number;
  /** Reads that failed other than with a 429, e.g. "3 x HTTP 500 on /v1/playlists/:id/items". Empty: the library is complete. */
  problems: string[];
}

/** Pause between Spotify requests: the audit is a one-off read, not worth risking the app's rate limit. */
export const PACE_MS = 250;

export async function readLibraryStrictly(opts: {
  store: Store;
  config: SpotifyConfig;
  /** Spotify user id; needed when more than one user has signed in. */
  userId?: string;
  fetchFn?: FetchFn;
  /** Pause between requests, in ms. Default PACE_MS. */
  paceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called before the first Spotify request. */
  announce?: (who: string) => void;
}): Promise<LibraryRead> {
  const { store, config } = opts;
  if (!config.clientId || !config.clientSecret) throw new AuditStop('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set');
  const ids = opts.userId ? [opts.userId] : await store.listUserIds();
  if (!ids.length) throw new AuditStop('No signed-in users yet');
  if (ids.length > 1) {
    const names = await Promise.all(ids.map(async (id) => `${id} (${(await store.getUser(id))?.displayName ?? '?'})`));
    throw new AuditStop(`More than one user is signed in: ${names.join(', ')}. Pass one Spotify user id.`);
  }
  const user = await store.getUser(ids[0]!);
  if (!user) throw new AuditStop(`No user ${ids[0]}`);
  opts.announce?.(user.displayName);

  const send = opts.fetchFn ?? ((input, init) => fetch(input, init));
  const pace = opts.paceMs ?? PACE_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const state = { requests: 0, stopped: false, retryAfter: null as string | null, failures: new Map<string, number>() };
  const fail = (what: string) => state.failures.set(what, (state.failures.get(what) ?? 0) + 1);
  // One request at a time: the client asks for several saved-song pages at once, and Spotify's limit is small.
  let queue: Promise<unknown> = Promise.resolve();
  const strictFetch: FetchFn = (input, init) => {
    const run = queue.then(async () => {
      if (state.stopped) throw new SpotifyError('Stopped after Spotify answered 429', 429);
      if (state.requests > 0 && pace > 0) await sleep(pace);
      state.requests++;
      const endpoint = new URL(input).pathname.replace(/\/playlists\/[^/]+/, '/playlists/:id');
      let res: Response;
      try {
        res = await send(input, init);
      } catch (err) {
        fail(`network error on ${endpoint}`);
        throw err;
      }
      if (res.status === 429) {
        state.stopped = true;
        state.retryAfter = res.headers.get('retry-after');
      } else if (!res.ok && !(endpoint.endsWith('/items') && (res.status === 404 || res.status === 410))) {
        fail(`HTTP ${res.status} on ${endpoint}`); // a 404 on /items is the expected fallback to /tracks
      }
      return res;
    });
    queue = run.catch(() => undefined);
    return run;
  };

  let listening: Listening | undefined;
  try {
    const spotify = createSpotifyClient(config, strictFetch);
    const fresh = await ensureFreshTokens(user, spotify, store);
    listening = await getUserListening(spotify, fresh.spotify.accessToken);
  } catch (err) {
    if (!state.stopped) {
      if (err instanceof SpotifyError && [400, 401, 403].includes(err.status)) {
        throw new AuditStop(`Spotify refused the saved sign-in or the app keys (HTTP ${err.status}). Check the Spotify keys, or sign in to the app again, then run this again.`);
      }
      throw err;
    }
  }
  // The client skips a playlist whose read fails, a 429 included, so the run can finish with a partial library.
  if (state.stopped || !listening) {
    const wait = state.retryAfter ? `Retry-After ${state.retryAfter} s` : 'no Retry-After given';
    throw new AuditStop(
      `Spotify answered HTTP 429 (${wait}) after ${state.requests} requests and the run stopped there. ` +
        'The saved sign-in may have been refreshed in the database; nothing else was written. Wait it out, then run again.',
    );
  }
  return { who: user.displayName, listening, requests: state.requests, problems: [...state.failures].map(([what, n]) => `${n} x ${what}`) };
}

// ---- the command line ----

export class UsageError extends Error {}

const VALUE_FLAGS = new Set(['--env', '--out', '--library']);
const BOOLEAN_FLAGS = new Set(['--no-database', '--refresh', '--help']);

export function parseArgs(args: string[]): { flags: Map<string, string | true>; userId: string | undefined } {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) positional.push(a);
    else if (VALUE_FLAGS.has(a)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new UsageError(`${a} needs a value`);
      flags.set(a, value);
    } else if (BOOLEAN_FLAGS.has(a)) flags.set(a, true);
    else throw new UsageError(`Unknown option ${a}`);
  }
  if (positional.length > 1) throw new UsageError('Give at most one Spotify user id');
  return { flags, userId: positional[0] };
}

/** What the audit needs from a track, so the saved copy holds no more of the library than that. */
function slim(t: Track): Track {
  const s: Track = { id: t.id, title: t.title, artist: t.artist, artistId: t.artistId, spotifyUrl: '', playRank: t.playRank };
  if (t.popularity !== undefined) s.popularity = t.popularity;
  if (t.isrc !== undefined) s.isrc = t.isrc;
  if (t.durationMs !== undefined) s.durationMs = t.durationMs;
  if (t.artists !== undefined) s.artists = t.artists;
  return s;
}

export const slimListening = (l: Listening): Listening => ({
  top: Object.fromEntries(Object.entries(l.top).map(([range, tracks]) => [range, (tracks ?? []).map(slim)])),
  recent: l.recent.map(slim),
  saved: l.saved.map(slim),
  playlists: (l.playlists ?? []).map(slim),
});

/** The library's lists, named for the audit's per-list coverage. */
export function sourcesOf(l: Listening): { name: string; tracks: Track[] }[] {
  return [
    { name: 'top tracks, 4 weeks', tracks: l.top.short_term ?? [] },
    { name: 'top tracks, 6 months', tracks: l.top.medium_term ?? [] },
    { name: 'top tracks, all time', tracks: l.top.long_term ?? [] },
    { name: 'recently played', tracks: l.recent },
    { name: 'saved songs', tracks: l.saved },
    { name: 'playlists', tracks: l.playlists ?? [] },
  ];
}
