// Deezer track rank (QWW-37): one more popularity number, for songs with no USDB views, karaoke
// views or Year-End chart entry (mostly artist estimates from a library). Deezer's public search
// API needs no key or login and gives every track a `rank` (a whole number, higher is more
// popular). `npm run popularity:deezer` looks songs up in a batch and stores the rank per song key
// (song_deezer); `npm run popularity:calibrate` matches it to the shared scale. Deezer is never
// called while a page loads.
//
// The search is plain text ("artist title"): the quoted form artist:"..." track:"..." returned
// nothing when tried in November 2026. A result counts only when its artist and title match the
// song's key; among the results that match (the original, remasters, live takes), the best rank.

import { hasLittleSinging, songKey } from '../songs/resolve';

/** One Deezer search result, the fields we read. */
export interface DeezerTrack {
  id: number;
  title: string;
  title_short?: string;
  rank: number;
  artist: { name: string };
}

/** What a lookup found: the best-ranked matching track. */
export interface DeezerHit {
  rank: number;
  deezerId: number;
  artist: string;
  title: string;
}

/** Results per search: enough for the original plus its live and remastered takes. */
export const SEARCH_LIMIT = 10;

/**
 * Deezer's API limit is 50 requests per 5 seconds, but its CDN refused us (HTTP 403) after about
 * 45 minutes at 8 a second (Nov 2026), so this stays well under it.
 */
export const REQUESTS_PER_SECOND = 5;

/** The search text for a song: its artist and title, without version tags or featured artists. */
export function deezerQuery(artist: string, title: string): string {
  const [a, t] = songKey(artist, title).split('|');
  return `${a} ${t}`;
}

/**
 * A key part with punctuation dropped and "&" read as "and": "paint it, black" is "paint it black",
 * "kc & the sunshine band" is "kc and the sunshine band".
 */
const loose = (part: string) =>
  part.replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** True when one artist name is the other with words added ("ms lauryn hill", "lauryn hill"). */
function sameArtist(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 3 && ` ${long} `.includes(` ${short} `);
}

/** True when a Deezer track is the song with key `key`. */
export function matchesKey(key: string, track: Pick<DeezerTrack, 'title' | 'title_short' | 'artist'>): boolean {
  if (hasLittleSinging(track.title)) return false; // karaoke and instrumental versions share the title
  const [artist = '', title = ''] = key.split('|').map(loose);
  const [dArtist = ''] = songKey(track.artist.name, '').split('|').map(loose);
  if (!sameArtist(artist, dArtist)) return false;
  // A medley title counts by its first song: "Hard to Say I'm Sorry / Get Away".
  const titles = [track.title, track.title_short ?? ''].flatMap((t) => [t, t.split(' / ')[0]!]);
  return titles.some((t) => loose(songKey('', t).split('|')[1] ?? '') === title);
}

/** The best-ranked result that matches `key`, or null when none does. */
export function pickDeezerHit(key: string, results: DeezerTrack[]): DeezerHit | null {
  let best: DeezerTrack | undefined;
  for (const t of results) {
    if (typeof t.rank !== 'number' || !matchesKey(key, t)) continue;
    if (!best || t.rank > best.rank) best = t;
  }
  return best ? { rank: best.rank, deezerId: best.id, artist: best.artist.name, title: best.title } : null;
}

export class DeezerError extends Error {}

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface DeezerClientOptions {
  fetch?: Fetch;
  perSecond?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Tries per search before giving up, on a quota error or a server error. */
  tries?: number;
}

/**
 * Searches Deezer, spacing requests to stay under its limit and waiting out a quota error
 * (Deezer answers 200 with `{"error":{"code":4}}` when over it).
 */
export function createDeezerClient(opts: DeezerClientOptions = {}) {
  const doFetch: Fetch = opts.fetch ?? ((url) => fetch(url));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gap = 1000 / (opts.perSecond ?? REQUESTS_PER_SECOND);
  const tries = opts.tries ?? 5;
  let next = 0;
  /** Waits for this request's turn; turns are handed out one gap apart. */
  const turn = async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gap;
    if (at > now) await sleep(at - now);
  };
  return {
    async search(q: string): Promise<DeezerTrack[]> {
      const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}`;
      for (let i = 1; ; i++) {
        await turn();
        const res = await doFetch(url);
        const body = res.ok ? ((await res.json()) as { data?: DeezerTrack[]; error?: { code?: number; message?: string } }) : undefined;
        if (body && !body.error) return body.data ?? [];
        const why = body?.error ? `error ${body.error.code}: ${body.error.message}` : `HTTP ${res.status}`;
        // A 403 is the CDN refusing us, not a quota: retrying only prolongs it.
        if (i >= tries || res.status === 403) throw new DeezerError(`Deezer search failed (${why}): ${q}`);
        await sleep(5000 * i); // the quota counts 5 seconds back
      }
    },
  };
}
