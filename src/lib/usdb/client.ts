// Client for USDB (https://usdb.animux.de), the fan-run UltraStar note file database.
// USDB has no API, so this logs in like a browser and reads its pages.
// Request sequence (login form fields, the list search, the gettxt page with the notes in a
// <textarea>) was learned from the open-source USDB Syncer project
// (https://github.com/bohning/usdb_syncer); this is an independent implementation.
// Requests are spaced out (minIntervalMs) so we never hammer a small hobby site.

import { songKey } from '../songs/resolve';

export const USDB_BASE_URL = 'https://usdb.animux.de/index.php';

export interface UsdbSongRow {
  id: number;
  artist: string;
  title: string;
}

export interface UsdbClientOptions {
  username: string;
  password: string;
  fetch?: typeof globalThis.fetch;
  /** Minimum time between requests. Default 2500 ms. */
  minIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface UsdbClient {
  /** Searches by artist and title and returns the note file text, or null when USDB has no match. */
  findNoteFile(artist: string, title: string): Promise<string | null>;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, '')).trim();

/** Song rows from a search result page (rows carry data-songid; artist and title are cells 3 and 4). */
export function parseSongList(html: string): UsdbSongRow[] {
  const rows: UsdbSongRow[] = [];
  const rowRe = /<tr[^>]*data-songid="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
  for (const m of html.matchAll(rowRe)) {
    const cells = [...m[2]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]!);
    if (cells.length < 4) continue;
    rows.push({ id: Number(m[1]), artist: stripTags(cells[2]!), title: stripTags(cells[3]!) });
  }
  return rows;
}

/** The note file text from a gettxt page, or null when the page has none (e.g. logged out). */
export function parseNoteText(html: string): string | null {
  const m = /<textarea[^>]*>([\s\S]*?)<\/textarea>/i.exec(html);
  return m ? decodeEntities(m[1]!) : null;
}

/** Title without "(feat. X)", "[Live]" or " - Remastered 2011" parts, for the USDB search box. */
function searchTitle(title: string): string {
  return title.replace(/\s+-\s+.*$/, '').replace(/\s*[([].*?[)\]]/g, '').trim();
}

export function createUsdbClient(opts: UsdbClientOptions): UsdbClient {
  const fetch = opts.fetch ?? globalThis.fetch;
  const minInterval = opts.minIntervalMs ?? 2500;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let cookie: string | null = null;
  let lastRequest = -Infinity;
  let loggedIn = false;

  async function request(params: Record<string, string>, form: Record<string, string>): Promise<string> {
    const wait = lastRequest + minInterval - now();
    if (wait > 0) await sleep(wait);
    lastRequest = now();
    const url = `${USDB_BASE_URL}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie ? { cookie } : {}),
      },
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie');
    const session = setCookie && /PHPSESSID=[^;]+/.exec(setCookie);
    if (session) cookie = session[0];
    if (res.status >= 400) throw new Error(`USDB request failed with HTTP ${res.status}`);
    return res.text();
  }

  async function login() {
    if (loggedIn) return;
    const page = await request({}, { user: opts.username, pass: opts.password, login: 'Login' });
    // A logged-in page links to the user's profile and a logout.
    if (!/link=logout/i.test(page) || !cookie) throw new Error('USDB login failed: check USDB_USERNAME and USDB_PASSWORD');
    loggedIn = true;
  }

  return {
    async findNoteFile(artist, title) {
      await login();
      const cleanTitle = searchTitle(title);
      const list = await request({ link: 'list' }, { interpret: artist, title: cleanTitle, details: '1', limit: '30', start: '0' });
      const want = songKey(artist, cleanTitle);
      const hit = parseSongList(list).find((row) => songKey(row.artist, row.title) === want);
      if (!hit) return null;
      const page = await request({ link: 'gettxt', id: String(hit.id) }, { wd: '1' });
      return parseNoteText(page);
    },
  };
}
