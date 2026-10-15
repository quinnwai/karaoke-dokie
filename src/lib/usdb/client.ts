// Client for USDB (https://usdb.animux.de), the fan-run UltraStar note file database.
// USDB has no API, so this logs in like a browser and reads its pages.
// Request sequence (login form fields, the list search, the gettxt page with the notes in a
// <textarea>) was learned from the open-source USDB Syncer project
// (https://github.com/bohning/usdb_syncer); this is an independent implementation.
// Requests are spaced out (minIntervalMs) so we never hammer a small hobby site.
// Downloads follow the site's own countdown: GET ?link=gettxt shows a wait (about 24 s, in its
// script as `time = N`), and only after it do we POST wd=1 for the note text, like a browser does.

import { songKey } from '../songs/resolve';

export const USDB_BASE_URL = 'https://usdb.animux.de/index.php';

export interface UsdbSongRow {
  id: number;
  artist: string;
  title: string;
  /** Page views (last cell) and star rating 0-5 (cell before it), when the row has them. */
  views?: number;
  rating?: number;
  /** USDB's last-changed time (epoch seconds), from the row's data-lastchange. */
  lastChange?: number;
}

export interface UsdbSong {
  /** USDB song id, for linking to its page. */
  id?: number;
  /** The note file text, or null when only the search was done. */
  noteText: string | null;
  views?: number;
  rating?: number;
}

export interface UsdbClientOptions {
  username: string;
  password: string;
  fetch?: typeof globalThis.fetch;
  /** Minimum time between requests. Default 2500 ms. */
  minIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Ask for the note text straight away instead of waiting out the countdown, as USDB Syncer does.
   * Only for the catalogue fill, which the USDB folks OK'd. Falls back to waiting if USDB refuses.
   */
  skipCountdown?: boolean;
}

export interface UsdbClient {
  /** Logs in (once). Throws a clear error when USDB rejects the username or password. */
  login(): Promise<void>;
  /** Searches by artist and title and returns the note file text, or null when USDB has no match. */
  findNoteFile(artist: string, title: string): Promise<string | null>;
  /** Like findNoteFile, plus the song's views and rating. `download: false` only searches (fast). */
  findSong(artist: string, title: string, opts?: { download?: boolean }): Promise<UsdbSong | null>;
  /** One page (100 rows) of USDB's song list, by id or by last change. Empty past the end. */
  listSongs(opts: { order: 'id' | 'lastchange'; descending?: boolean; start: number }): Promise<UsdbSongRow[]>;
  /** The note file for a known USDB id (waits out the countdown), or null. */
  downloadById(id: number): Promise<string | null>;
}

export const USDB_LIST_PAGE_SIZE = 100;

/** Link to a song's page on USDB. */
export const usdbSongUrl = (id: number) => `${USDB_BASE_URL}?link=detail&id=${id}`;

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
  const rowRe = /<tr([^>]*data-songid="(\d+)"[^>]*)>([\s\S]*?)<\/tr>/g;
  for (const m of html.matchAll(rowRe)) {
    const cells = [...m[3]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]!);
    if (cells.length < 4) continue;
    const row: UsdbSongRow = { id: Number(m[2]), artist: stripTags(cells[2]!), title: stripTags(cells[3]!) };
    const changed = /data-lastchange="(\d+)"/.exec(m[1]!);
    if (changed) row.lastChange = Number(changed[1]);
    if (cells.length >= 6) {
      const views = parseCount(cells[cells.length - 1]!);
      const rating = parseRating(cells[cells.length - 2]!);
      if (views !== undefined) row.views = views;
      if (rating !== undefined) row.rating = rating;
    }
    rows.push(row);
  }
  return rows;
}

/** A whole number like "1000" or "1.234" (thousands separator); undefined when the cell is not one. */
function parseCount(cell: string): number | undefined {
  const text = stripTags(cell).replace(/[.,\s]/g, '');
  return /^\d+$/.test(text) ? Number(text) : undefined;
}

/** A rating cell: a number 0-5, or star images (full and half). Undefined when it is neither. */
function parseRating(cell: string): number | undefined {
  const stars = (cell.match(/<img[^>]*star[^>]*>/gi) ?? []).filter((t) => !/empty|off|grey|gray/i.test(t));
  const half = stars.filter((t) => /half/i.test(t)).length;
  const full = stars.length - half;
  if (full || half) return Math.min(5, full + half / 2);
  const text = stripTags(cell).replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(text)) return undefined;
  const n = Number(text);
  return n >= 0 && n <= 5 ? n : undefined;
}

/** The note file text from a gettxt page, or null when the page has none (e.g. logged out). */
export function parseNoteText(html: string): string | null {
  const m = /<textarea[^>]*>([\s\S]*?)<\/textarea>/i.exec(html);
  return m ? decodeEntities(m[1]!) : null;
}

/** Seconds the gettxt page asks the browser to wait before it may fetch the notes (0 when there is no countdown). */
export function parseDownloadWait(html: string): number {
  const m = /\btime\s*=\s*(\d+)/.exec(html);
  return m ? Number(m[1]) : 0;
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

  async function request(params: Record<string, string>, form: Record<string, string> | null): Promise<string> {
    const wait = lastRequest + minInterval - now();
    if (wait > 0) await sleep(wait);
    lastRequest = now();
    const url = `${USDB_BASE_URL}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`;
    const res = await fetch(url, {
      method: form ? 'POST' : 'GET',
      headers: {
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie');
    const session = setCookie && /PHPSESSID=[^;]+/.exec(setCookie);
    if (session) cookie = session[0];
    if (res.status >= 400) throw new Error(`USDB request failed with HTTP ${res.status}`);
    return res.text();
  }

  // A logged-in page links to a logout.
  const isLoggedIn = (page: string) => /link=logout/i.test(page);

  async function login() {
    if (loggedIn) return;
    // Open the site first so the login form is posted with a session cookie, like a browser.
    if (!cookie) await request({}, null);
    let page = await request({}, { user: opts.username, pass: opts.password, login: 'Login' });
    // The login answer can be a redirect with an empty body; the next page shows the result.
    if (!isLoggedIn(page)) page = await request({}, null);
    if (!isLoggedIn(page) || !cookie) throw new Error('USDB login failed: check USDB_USERNAME and USDB_PASSWORD');
    loggedIn = true;
  }

  async function download(id: number): Promise<string | null> {
    const params = { link: 'gettxt', id: String(id) };
    if (opts.skipCountdown) {
      const direct = parseNoteText(await request(params, { wd: '1' }));
      if (direct !== null) return direct;
    }
    const countdown = await request(params, null);
    const ready = parseNoteText(countdown);
    if (ready !== null) return ready;
    const wait = parseDownloadWait(countdown);
    if (wait > 0) await sleep((wait + 1) * 1000);
    return parseNoteText(await request(params, { wd: '1' }));
  }

  async function findSong(artist: string, title: string, { download: fetchNotes = true } = {}): Promise<UsdbSong | null> {
    await login();
    const cleanTitle = searchTitle(title);
    const list = await request({ link: 'list' }, { interpret: artist, title: cleanTitle, details: '1', limit: '30', start: '0' });
    const want = songKey(artist, cleanTitle);
    const hit = parseSongList(list).find((row) => songKey(row.artist, row.title) === want);
    if (!hit) return null;
    const song: UsdbSong = { id: hit.id, noteText: fetchNotes ? await download(hit.id) : null };
    if (hit.views !== undefined) song.views = hit.views;
    if (hit.rating !== undefined) song.rating = hit.rating;
    return song;
  }

  async function listSongs({ order, descending = false, start }: { order: 'id' | 'lastchange'; descending?: boolean; start: number }) {
    await login();
    // Same form fields as USDB Syncer's song list fetch: 100 rows per page, sorted by id or last change.
    const page = await request(
      { link: 'list' },
      { order, ud: descending ? 'desc' : 'asc', limit: String(USDB_LIST_PAGE_SIZE), details: '1', start: String(start) },
    );
    return parseSongList(page);
  }

  return {
    login,
    findSong,
    listSongs,
    async downloadById(id) {
      await login();
      return download(id);
    },
    async findNoteFile(artist, title) {
      return (await findSong(artist, title))?.noteText ?? null;
    },
  };
}
