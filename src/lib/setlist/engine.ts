// The ranking engine port, and the network engine behind it.
//
// QWW-47 owns the engine: it runs on the server (POST /api/setlist, src/lib/songs/setlist.ts) with the hard range filter,
// "easy leans low", "never empty" and the tempo from QWW-54. The tuner talks to it through `SetlistEngine`: a
// SetlistRequest in, a SetlistResponse out. Nothing on the screen ranks.

import { SETLIST_PAGE } from '../songs/setlistConfig';
import type { SetlistRequest, SetlistResponse } from './types';

export interface SetlistEngine {
  /** The songs for this request, best first. `signal` aborts a request that a newer one has replaced. */
  rank(request: SetlistRequest, signal?: AbortSignal): Promise<SetlistResponse>;
}

/** The most songs one request may ask for (the server's own SETLIST_PAGE.max, imported, not repeated): the screen slices these, 40 at a time. */
export const NETWORK_LIMIT = SETLIST_PAGE.max;

/** The engine that asks the server. A request that does not say how many songs it wants gets the most one request may. */
export function createNetworkEngine(fetchFn: typeof fetch = (...args) => fetch(...args)): SetlistEngine {
  return {
    async rank(request, signal) {
      const res = await fetchFn('/api/setlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limit: NETWORK_LIMIT, ...request }),
        signal,
      });
      if (!res.ok) throw new Error(`POST /api/setlist answered ${res.status}`);
      return (await res.json()) as SetlistResponse;
    },
  };
}
