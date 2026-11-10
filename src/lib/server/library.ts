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
  RequestBudgetError,
  requestMeter,
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
/** Pages of the check for un-liked songs read per visit (the likes check and the rest of the budget share the 5). */
export const VERIFY_PAGES_PER_VISIT = 3;

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
  const budget = state.savedComplete ? INCREMENTAL_BUDGET : Infinity;
  // Every Web API request of this visit is counted by the client (retries and playlist pages included), and refused
  // once the budget is used up. The likes themselves are read whatever the budget (below).
  const meter = { count: 0, limit: budget };
  await requestMeter.run(meter, () => syncWithin(user, state, { store, spotify, sleep }, now, meter, budget));
}

async function syncWithin(
  user: UserRecord,
  state: LibrarySyncState,
  { store, spotify, sleep = defaultSleep }: LibraryDeps,
  now: number,
  meter: { count: number; limit: number },
  budget: number,
): Promise<void> {
  const token = user.spotify.accessToken;
  const open = () => meter.count < meter.limit;

  /** Reads liked-song pages from `offset` to the end, a few at a time; `onBatch` gets each group with its absolute indices. */
  async function readLikes(offset: number, onBatch: (items: { track: Track; index: number }[], total: number) => Promise<void>): Promise<number> {
    const first = await spotify.getSavedPage(token, offset);
    const total = first.total;
    await onBatch(first.items.flatMap((track, i) => (track ? [{ track, index: offset + i }] : [])), total);
    state.savedNextOffset = Math.min(total, offset + 50);
    const offsets: number[] = [];
    for (let o = offset + 50; o < total; o += 50) offsets.push(o);
    for (let i = 0; i < offsets.length; i += PAGE_CONCURRENCY) {
      const started = Date.now();
      const group = offsets.slice(i, i + PAGE_CONCURRENCY);
      const pages = await Promise.all(group.map((o) => spotify.getSavedPage(token, o)));
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
    await syncLikes();
  }
  await store.putLibraryState(user.id, state, now);

  /**
   * A visit to a complete library: the newest likes first (always read, however many; counted but not limited by the
   * budget), then, only when Spotify's count says something was un-liked, a few pages of a check pass that finds out
   * what. The pass is spread over visits so that none goes over the budget.
   */
  async function syncLikes(): Promise<void> {
    meter.limit = Infinity;
    const known = new Set((await store.listSavedTracks(user.id)).map((t) => t.id));
    const fresh: Track[] = [];
    let raw = 0; // new items in Spotify's count, the unreadable ones included
    let total = state.savedTotal;
    let firstPage: (Track | null)[] = [];
    for (let offset = 0; ; offset += 50) {
      const page = await spotify.getSavedPage(token, offset);
      if (offset === 0) firstPage = page.items;
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
    meter.limit = budget;

    const mismatch = total !== state.savedTotal + raw;
    if (mismatch && !state.verify) {
      // Something was un-liked (or the count changed some other way): start a check pass.
      const gen = Math.max(Math.floor(now / 1000), (state.lastGen ?? 0) + 1);
      state.lastGen = gen;
      state.verify = { gen, offset: 0, unreadable: 0, attempt: 1 };
    }
    const base = Math.floor(now / 1000) * 10_000;
    await store.putSavedTracks(user.id, fresh.map((track, i) => ({ track, pos: base + raw - i, gen: state.verify?.gen ?? 0 })));
    for (const t of fresh) known.add(t.id);
    state.savedTotal = total;
    if (state.verify) await verifyStep(state.verify, known, firstPage, total);
  }

  async function verifyStep(v: NonNullable<LibrarySyncState['verify']>, known: Set<string>, firstPage: (Track | null)[], total: number): Promise<void> {
    /** Marks the songs of a page as seen by this pass, storing the ones we did not have. */
    const mark = async (items: (Track | null)[], pageOffset: number, pageTotal: number) => {
      v.unreadable += items.filter((t) => !t).length;
      const seen: string[] = [];
      const added: { track: Track; pos: number; gen: number }[] = [];
      items.forEach((track, i) => {
        if (!track) return;
        if (known.has(track.id)) seen.push(track.id);
        else {
          added.push({ track, pos: posOf(pageOffset + i, pageTotal), gen: v.gen });
          known.add(track.id);
        }
      });
      await store.markSavedSeen(user.id, seen, v.gen);
      await store.putSavedTracks(user.id, added);
    };
    if (v.offset === 0) {
      await mark(firstPage, 0, total);
      v.offset = 50;
    }
    for (let n = 0; n < VERIFY_PAGES_PER_VISIT && open() && v.offset < total; n++) {
      const page = await spotify.getSavedPage(token, v.offset);
      total = page.total;
      await mark(page.items, v.offset, page.total);
      v.offset += 50;
    }
    if (v.offset < total) return; // the pass goes on at the next visit
    // The pass is over. Nothing is removed unless it accounts for every item Spotify counts: the library can change while
    // it is read (a song moves across a page boundary and is missed), and a song dropped by mistake is lost until it is
    // liked again, while one kept by mistake only waits for the next pass.
    const seen = await store.countSavedFromGen(user.id, v.gen);
    if (seen + v.unreadable >= total) {
      await store.removeSavedBeforeGen(user.id, v.gen);
      state.verify = null;
    } else if (v.attempt < 2) {
      const gen = (state.lastGen ?? v.gen) + 1;
      state.lastGen = gen;
      state.verify = { gen, offset: 0, unreadable: 0, attempt: v.attempt + 1 };
    } else {
      state.verify = null;
    }
    state.savedTotal = total;
  }

  // ---- the rest, in order of importance, while the budget lasts ----
  const due = (at: number | undefined) => at === undefined || now - at >= TOP_REFRESH_MS;
  for (const range of TIME_RANGES) {
    if (open() && due(state.top[range]?.at)) state.top[range] = { at: now, tracks: await spotify.getTopTracks(token, range) };
  }
  if (open() && due(state.recent?.at)) {
    // Recent plays need a permission that users who signed in before it was added have not granted.
    state.recent = await spotify.getRecentlyPlayed(token).then(
      (tracks) => ({ at: now, tracks }),
      (err) => {
        if (!isScopeError(err)) throw err;
        return { at: now, tracks: [] };
      },
    );
  }
  if (open() && now >= state.playlistsRetryAt) {
    try {
      const own = await spotify.getOwnPlaylists(token, user.id);
      const ids = new Set(own.map((p) => p.id));
      for (const id of Object.keys(state.playlists)) if (!ids.has(id)) delete state.playlists[id];
      for (const p of own) {
        const stored = state.playlists[p.id];
        // A playlist with no snapshot_id cannot be told apart from itself, so it is read once.
        if (stored && (stored.snapshotId === p.snapshotId || p.snapshotId === '')) continue;
        if (!open()) break;
        const tracks = await spotify.getPlaylistSongs(token, p.id).catch((err) => {
          if (err instanceof SpotifyError && [403, 404, 410].includes(err.status)) return [] as Track[];
          throw err;
        });
        state.playlists[p.id] = { snapshotId: p.snapshotId, tracks };
      }
    } catch (err) {
      // Out of requests for this visit: the rest of the playlists wait for the next one.
      if (err instanceof RequestBudgetError) {
        // nothing to do
      } else if (isScopeError(err)) state.playlistsRetryAt = now + PLAYLIST_RETRY_MS;
      else throw err;
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
