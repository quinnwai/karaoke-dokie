// A signed-in user's Spotify library for the song list: stored per user, then kept up to date by reading only what
// changed (QWW-55 PR 2).
//
// Spotify's Development Mode quota is one pool for the whole app, and on 10 Nov 2026 a few sign-ins used it all:
// each one read the user's entire library again, and Spotify then answered 429 to every call for 3.4 hours.
//
// Now the library is read in full once and kept in the store (user_library, user_saved):
//   - liked songs: newest first, stopping at the first song already stored. Spotify's count of liked songs says whether
//     anything was un-liked in between; if it does not add up, the likes are read again in full and the missing songs
//     are dropped. There is no cap. A first read that is cut off (an error, a 429, the request deadline) keeps what it
//     got and resumes from there on the next visit.
//   - top tracks and recent plays: at most once a day each.
//   - playlists: the list of own playlists is checked on a visit (one request); a playlist's songs are read only when
//     its snapshot_id changed.
// A visit to a complete library makes at most INCREMENTAL_BUDGET requests: the likes check comes first, the rest wait
// for the next visit when the budget is used up. While Spotify says wait, or when a read fails, the stored library is
// served as it is.
//
// Spotify's terms (QWW-55): songs un-liked on Spotify are dropped on each sync, a user's stored library is deleted when
// they disconnect (disconnectUser) and after IDLE_DELETE_MS without a visit (purgeIdleLibraries), and it is only ever
// returned to that user.

import type { TimeRange, Track } from '../contracts';
import {
  assertSpotifyOpen,
  buildLibrary,
  describeError,
  ensureFreshTokens,
  noteSpotifyLimit,
  SpotifyError,
  TIME_RANGES,
  type SleepFn,
  type SpotifyClient,
} from './spotify';
import type { LibrarySyncState, Store, UserRecord } from './store';

/** Requests a visit to a complete library may make (the first read and a resumed one are not limited). */
export const INCREMENTAL_BUDGET = 5;
/** Top tracks and recent plays are read again after this long. */
export const TOP_REFRESH_MS = 24 * 60 * 60_000;
/** A user who has not granted playlist access is not asked again for this long. */
const PLAYLIST_RETRY_MS = 24 * 60 * 60_000;
/** A stored library is deleted when its user has not visited for this long. */
export const IDLE_DELETE_MS = 30 * 24 * 60 * 60_000;
const PURGE_EVERY_MS = 60 * 60_000;
/** Liked-song pages (50 songs each) read at once, at least this long per group: about 8 requests a second. */
const PAGE_CONCURRENCY = 5;
const BATCH_MIN_MS = 600;

export interface LibraryDeps {
  store: Store;
  spotify: SpotifyClient;
  /** Waits between page groups; tests pass a no-op. */
  sleep?: SleepFn;
}

export const emptySyncState = (): LibrarySyncState => ({
  savedTotal: 0,
  savedComplete: false,
  savedNextOffset: 0,
  top: {},
  recent: null,
  playlists: {},
  playlistsRetryAt: 0,
});

const isScopeError = (err: unknown) => err instanceof SpotifyError && (err.status === 401 || err.status === 403);

/**
 * The user's library: what is stored, brought up to date from Spotify as far as the rules above allow. Throws only
 * when nothing is stored and the sync failed (Spotify said wait, failed, or refused the token), so the route can answer
 * with the catalogue's songs; a user with a stored library always gets it.
 */
export async function loadLibrary(user: UserRecord, deps: LibraryDeps, now: number = Date.now()): Promise<Track[]> {
  const { store } = deps;
  // A stored state that cannot be read is an error, not an empty library: writing an empty state back would start a
  // full first read of a library that is already stored, which is the cost this exists to avoid. The route answers
  // with the catalogue's songs.
  const state = (await store.getLibraryState(user.id))?.state ?? emptySyncState();

  let failure: unknown = null;
  try {
    await assertSpotifyOpen(store, now);
    const fresh = await ensureFreshTokens(user, deps.spotify, store, now);
    await syncLibrary(fresh, state, deps, now);
  } catch (err) {
    failure = err;
    await noteSpotifyLimit(store, err, now);
  }
  // The visit is recorded (it keeps the library from the 30 day deletion) and the progress made is kept even when the sync failed.
  await store.putLibraryState(user.id, state, now).catch(logStore('keep the library state'));
  // After the visit is recorded, so the user who is here is never the idle one that is deleted.
  await purgeIdleLibraries(store, now);

  const saved = await store.listSavedTracks(user.id);
  const playlists = dedupe(Object.values(state.playlists).flatMap((p) => p.tracks));
  const top = Object.fromEntries(TIME_RANGES.map((r) => [r, state.top[r]?.tracks ?? []])) as Record<TimeRange, Track[]>;
  const library = buildLibrary({ top, recent: state.recent?.tracks ?? [], saved, playlists });
  if (failure) {
    if (library.length === 0) throw failure;
    console.error(`[library] could not bring ${user.id}'s stored library up to date, serving it as it is: ${describeError(failure)}`);
  }
  return library;
}

const logStore = (what: string) => (err: unknown) => {
  console.error(`[library] could not ${what}: ${describeError(err)}`);
  return null;
};

const dedupe = (tracks: Track[]): Track[] => [...new Map(tracks.map((t) => [t.id, t])).values()];

async function syncLibrary(user: UserRecord, state: LibrarySyncState, { store, spotify, sleep = defaultSleep }: LibraryDeps, now: number): Promise<void> {
  const token = user.spotify.accessToken;
  const budget = state.savedComplete ? INCREMENTAL_BUDGET : Infinity;
  let used = 0;
  const call = <T>(f: () => Promise<T>): Promise<T> => {
    used++;
    return f();
  };
  const open = () => used < budget;

  /** Liked items a read could not map (local files, no title); Spotify's count includes them. */
  let unreadable = 0;
  /** Reads liked-song pages from `offset` to the end, a few at a time; `onBatch` gets each group with its absolute indices. */
  async function readLikes(offset: number, onBatch: (items: { track: Track; index: number }[], total: number) => Promise<void>): Promise<number> {
    const first = await call(() => spotify.getSavedPage(token, offset));
    const total = first.total;
    unreadable += first.items.filter((t) => !t).length;
    await onBatch(first.items.flatMap((track, i) => (track ? [{ track, index: offset + i }] : [])), total);
    state.savedNextOffset = Math.min(total, offset + 50);
    const offsets: number[] = [];
    for (let o = offset + 50; o < total; o += 50) offsets.push(o);
    for (let i = 0; i < offsets.length; i += PAGE_CONCURRENCY) {
      const started = Date.now();
      const group = offsets.slice(i, i + PAGE_CONCURRENCY);
      const pages = await Promise.all(group.map((o) => call(() => spotify.getSavedPage(token, o))));
      unreadable += pages.reduce((n, p) => n + p.items.filter((t) => !t).length, 0);
      await onBatch(pages.flatMap((p, k) => p.items.flatMap((track, j) => (track ? [{ track, index: group[k]! + j }] : []))), total);
      state.savedNextOffset = Math.min(total, group[group.length - 1]! + 50);
      if (i + PAGE_CONCURRENCY < offsets.length) {
        const pause = BATCH_MIN_MS - (Date.now() - started);
        if (pause > 0) await sleep(pause);
      }
    }
    return total;
  }

  /** Newest-first position in the stored order for the song at `index` of a full read. */
  const posOf = (index: number, total: number) => total - index;

  if (!state.savedComplete) {
    // The first read, or one resumed after it was cut off: every group of pages is kept as it arrives.
    state.savedNextOffset = Math.max(0, state.savedNextOffset);
    // From the start, drop anything left by an earlier library that was only partly deleted.
    if (state.savedNextOffset === 0) await store.removeSavedTracks(user.id, (await store.listSavedTracks(user.id)).map((t) => t.id));
    const total = await readLikes(state.savedNextOffset, async (items, total) => {
      await store.putSavedTracks(user.id, items.map(({ track, index }) => ({ track, pos: posOf(index, total) })));
      await store.putLibraryState(user.id, { ...state, savedTotal: total }, now);
    });
    state.savedTotal = total;
    state.savedNextOffset = total;
    state.savedComplete = true;
  } else {
    await syncNewLikes();
  }
  await store.putLibraryState(user.id, state, now);

  async function syncNewLikes(): Promise<void> {
    const known = new Set((await store.listSavedTracks(user.id)).map((t) => t.id));
    const fresh: Track[] = [];
    let raw = 0; // new items in Spotify's count, the unreadable ones included
    let total = state.savedTotal;
    for (let offset = 0; ; offset += 50) {
      const page = await call(() => spotify.getSavedPage(token, offset));
      total = page.total;
      let reachedKnown = false;
      for (const item of page.items) {
        if (item && known.has(item.id)) {
          reachedKnown = true;
          break;
        }
        raw++;
        if (item) fresh.push(item);
      }
      if (reachedKnown || page.items.length === 0 || offset + 50 >= total) break;
    }
    if (total === state.savedTotal + raw) {
      const base = Math.floor(now / 1000) * 10_000;
      await store.putSavedTracks(user.id, fresh.map((track, i) => ({ track, pos: base + raw - i })));
      state.savedTotal = total;
      return;
    }
    // Something was un-liked (or the count changed some other way): read the likes in full and drop what is gone.
    const all = new Map<string, { track: Track; pos: number }>();
    const readTotal = await readLikes(0, async (items, t) => {
      for (const { track, index } of items) all.set(track.id, { track, pos: posOf(index, t) });
    });
    await store.putSavedTracks(user.id, [...all.values()]);
    // The library can change while it is read (a song moves across a page boundary and is missed), so nothing is
    // dropped unless the read accounts for every item Spotify counted; a song kept by mistake is gone at the next
    // count mismatch, one dropped by mistake would be lost until it is liked again.
    if (all.size + unreadable >= readTotal) {
      await store.removeSavedTracks(user.id, [...known].filter((id) => !all.has(id)));
    }
    state.savedTotal = readTotal;
  }

  // ---- the rest, in order of importance, while the budget lasts ----
  const due = (at: number | undefined) => at === undefined || now - at >= TOP_REFRESH_MS;
  for (const range of TIME_RANGES) {
    if (open() && due(state.top[range]?.at)) state.top[range] = { at: now, tracks: await call(() => spotify.getTopTracks(token, range)) };
  }
  if (open() && due(state.recent?.at)) {
    // Recent plays need a permission that users who signed in before it was added have not granted.
    state.recent = await call(() => spotify.getRecentlyPlayed(token)).then(
      (tracks) => ({ at: now, tracks }),
      (err) => {
        if (!isScopeError(err)) throw err;
        return { at: now, tracks: [] };
      },
    );
  }
  if (open() && now >= state.playlistsRetryAt) {
    try {
      const own = await call(() => spotify.getOwnPlaylists(token, user.id));
      const ids = new Set(own.map((p) => p.id));
      for (const id of Object.keys(state.playlists)) if (!ids.has(id)) delete state.playlists[id];
      for (const p of own) {
        const stored = state.playlists[p.id];
        // A playlist with no snapshot_id cannot be told apart from itself, so it is read once.
        if (stored && (stored.snapshotId === p.snapshotId || p.snapshotId === '')) continue;
        if (!open()) break;
        const tracks = await call(() => spotify.getPlaylistSongs(token, p.id)).catch((err) => {
          if (err instanceof SpotifyError && [403, 404, 410].includes(err.status)) return [] as Track[];
          throw err;
        });
        state.playlists[p.id] = { snapshotId: p.snapshotId, tracks };
      }
    } catch (err) {
      if (!isScopeError(err)) throw err;
      state.playlistsRetryAt = now + PLAYLIST_RETRY_MS;
    }
  }
  await store.putLibraryState(user.id, state, now);
}

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Deletes a user's stored library (they disconnected). */
export async function disconnectUser(store: Store, userId: string): Promise<void> {
  await store.deleteUserLibrary(userId);
}

let lastPurge = 0;
/** Deletes the stored library of every user not seen for IDLE_DELETE_MS; at most once an hour per process. Never throws. */
export async function purgeIdleLibraries(store: Store, now: number = Date.now()): Promise<number> {
  if (now - lastPurge < PURGE_EVERY_MS) return 0;
  lastPurge = now;
  try {
    return await store.deleteIdleLibraries(now - IDLE_DELETE_MS);
  } catch (err) {
    console.error(`[library] could not delete idle libraries: ${describeError(err)}`);
    return 0;
  }
}

/** Tests only: forget when the last purge ran. */
export function resetPurgeForTests(): void {
  lastPurge = 0;
}
