// The network engine: it asks POST /api/setlist and gives back what the server ranked. Ranking itself is the server's
// (tests/songs/setlist.test.ts); here is only what travels.

import { describe, expect, it, vi } from 'vitest';
import { createNetworkEngine, NETWORK_LIMIT } from '../../src/lib/setlist/engine';
import { SETLIST_PAGE } from '../../src/lib/songs/setlistConfig';
import type { SetlistRequest, SetlistResponse } from '../../src/lib/setlist/types';

const REQUEST: SetlistRequest = {
  gears: { difficulty: 0, history: 100, popularity: 100, tempo: 50 },
  off: ['history', 'tempo', 'era'],
  eras: [],
  range: { low: 45, high: 72 },
};
const ANSWER: SetlistResponse = { songs: [], total: 0, nextOffset: null, sources: {}, applied: ['difficulty', 'popularity'], empty: 'no-songs-in-range' };

describe('NETWORK_LIMIT', () => {
  it('is the server\'s page maximum itself, imported and not repeated (QWW-57)', () => {
    expect(NETWORK_LIMIT).toBe(SETLIST_PAGE.max);
    // Pinned as well, so a change to the page size is read before it ships: the screen slices these 40 at a time.
    expect(NETWORK_LIMIT).toBe(200);
  });
});

describe('createNetworkEngine', () => {
  it('posts the request as JSON, asking for the most songs one request may, and returns the answer', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(ANSWER), { status: 200 }));
    const signal = new AbortController().signal;
    await expect(createNetworkEngine(fetchFn as unknown as typeof fetch).rank(REQUEST, signal)).resolves.toEqual(ANSWER);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/setlist');
    expect(init.method).toBe('POST');
    expect(init.signal).toBe(signal);
    expect(JSON.parse(init.body as string)).toEqual({ ...REQUEST, limit: NETWORK_LIMIT });
  });

  it('keeps a limit the request names', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(ANSWER)));
    await createNetworkEngine(fetchFn as unknown as typeof fetch).rank({ ...REQUEST, limit: 20, offset: 40 });
    expect(JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ limit: 20, offset: 40 });
  });

  it('fails when the server does not answer with success', async () => {
    const fetchFn = vi.fn(async () => new Response('{"error":"bad"}', { status: 400 }));
    await expect(createNetworkEngine(fetchFn as unknown as typeof fetch).rank(REQUEST)).rejects.toThrow('400');
  });
});
