// Spotify Web API requests counted per UTC day and caller (QWW-55 PR 2), in the spotify_calls table: the quota is one
// pool for the whole app, so a day's total says who is using it. A caller is "site:/api/recommendations" for a site
// route and "script:usdb-sync" for a script; anything that did not say who it is counts as "unknown".
import { AsyncLocalStorage } from 'node:async_hooks';
import { describeError, type FetchFn } from './spotify';
import type { Store } from './store';

const callers = new AsyncLocalStorage<string>();
let defaultCaller = 'unknown';

/** Runs `fn`; every Spotify request it makes (even after an await) is counted for `caller`. */
export function withCaller<T>(caller: string, fn: () => Promise<T>): Promise<T> {
  return callers.run(caller, fn);
}

/** The caller for requests made outside any withCaller: a script sets its name once, at the start. */
export function setDefaultCaller(caller: string): void {
  defaultCaller = caller;
}

export const currentCaller = (): string => callers.getStore() ?? defaultCaller;

/** "2026-11-10": the day a request counts for. */
export const utcDay = (ms: number = Date.now()): string => new Date(ms).toISOString().slice(0, 10);

/**
 * `inner`, counting each request to the Web API (api.spotify.com; the token endpoint is not counted) before it is sent,
 * since a request that fails still used the quota. A count that cannot be written is logged, not thrown.
 */
export function countingFetch(inner: FetchFn, store: Pick<Store, 'addSpotifyCalls'>, now: () => number = Date.now): FetchFn {
  return async (input, init) => {
    if (input.startsWith('https://api.spotify.com/')) {
      await store.addSpotifyCalls(utcDay(now()), currentCaller(), 1).catch((err) => {
        console.error(`[spotify] could not count a request: ${describeError(err)}`);
      });
    }
    return inner(input, init);
  };
}
