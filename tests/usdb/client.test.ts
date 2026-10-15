import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createUsdbClient, parseDownloadWait, parseSongList, parseNoteText } from '../../src/lib/usdb/client';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures/usdb', name), 'utf8');

interface Call { url: string; method: string; body: string; cookie: string | null }

function fakeFetch(pages: Record<string, (method: string) => Response>) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? ''), cookie: headers.get('cookie') });
    const key = Object.keys(pages).find((k) => url.includes(k));
    if (!key) return new Response('not found', { status: 404 });
    return pages[key]!(init?.method ?? 'GET');
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const html = (body: string, cookie?: string) =>
  new Response(body, { status: 200, headers: cookie ? { 'set-cookie': cookie } : {} });

describe('USDB page parsing', () => {
  it('reads song rows from a search result page', () => {
    expect(parseSongList(fixture('list.html'))).toEqual([
      { id: 1234, artist: 'Queen', title: 'Bohemian Rhapsody', rating: 5, views: 1000, lastChange: 1700000000 },
      { id: 5678, artist: 'Queen & David Bowie', title: 'Under Pressure', rating: 4, views: 500, lastChange: 1700000001 },
    ]);
  });

  it('returns no rows for an empty result page', () => {
    expect(parseSongList('<html><body>No songs found</body></html>')).toEqual([]);
  });

  it('reads the note text out of the gettxt page, decoding entities', () => {
    const text = parseNoteText(fixture('gettxt.html').replace('#TITLE:Bohemian', '#TITLE:Bohemian &amp;'));
    expect(text).toContain('#ARTIST:Queen');
    expect(text).toContain('#TITLE:Bohemian & Rhapsody');
    expect(text?.trim().endsWith('E')).toBe(true);
  });

  it('reads star-image ratings and views with thousands separators', () => {
    const row = (rating: string, views: string) =>
      `<tr data-songid="9"><td></td><td></td><td>A</td><td>B</td><td>x</td><td>${rating}</td><td>${views}</td></tr>`;
    const stars = '<img src="images/star.png"><img src="images/star.png"><img src="images/star.png"><img src="images/half_star.png"><img src="images/star_empty.png">';
    expect(parseSongList(row(stars, '12.345'))[0]).toMatchObject({ rating: 3.5, views: 12345 });
    expect(parseSongList(row('', 'n/a'))[0]).not.toHaveProperty('views');
    expect(parseSongList('<tr data-songid="9"><td></td><td></td><td>A</td><td>B</td></tr>')[0]).toEqual({ id: 9, artist: 'A', title: 'B' });
  });

  it('returns null when the page has no notes', () => {
    expect(parseNoteText('<html>please log in</html>')).toBeNull();
  });
});

describe('USDB client', () => {
  const pages = () =>
    fakeFetch({
      'link=list': () => html(fixture('list.html')),
      'link=gettxt': (method) => html(method === 'GET' ? fixture('gettxt-countdown.html') : fixture('gettxt.html')),
      'index.php': () => html('<a href="?link=profil">profile</a> <a href="?link=logout">Logout</a>', 'PHPSESSID=abc123; path=/'),
    });

  it('logs in once, keeps the session cookie, searches and downloads notes', async () => {
    const { fetch, calls } = pages();
    const client = createUsdbClient({ username: 'u', password: 'p', fetch, minIntervalMs: 0, sleep: async () => {} });
    const notes = await client.findNoteFile('Queen', 'Bohemian Rhapsody - Remastered 2011');
    expect(notes).toContain('#TITLE:Bohemian Rhapsody');

    expect(calls[0]!.method).toBe('GET'); // opens the site first for a session cookie
    const login = calls[1]!;
    expect(login.method).toBe('POST');
    expect(login.cookie).toContain('PHPSESSID=abc123');
    expect(new URLSearchParams(login.body).get('user')).toBe('u');
    expect(new URLSearchParams(login.body).get('login')).toBe('Login');

    const search = calls.find((c) => c.url.includes('link=list'))!;
    expect(search.cookie).toContain('PHPSESSID=abc123');
    expect(new URLSearchParams(search.body).get('interpret')).toBe('Queen');
    expect(new URLSearchParams(search.body).get('title')).toBe('Bohemian Rhapsody');

    const [get, post] = calls.filter((c) => c.url.includes('link=gettxt'));
    expect(get!.method).toBe('GET');
    expect(get!.url).toContain('id=1234');
    expect(get!.cookie).toContain('PHPSESSID=abc123');
    expect(post!.method).toBe('POST');
    expect(new URLSearchParams(post!.body).get('wd')).toBe('1');

    await client.findNoteFile('Queen', 'Bohemian Rhapsody');
    expect(calls.filter((c) => c.body.includes('login=Login'))).toHaveLength(1);
  });

  it('pages through the song list 100 rows at a time, sorted as asked', async () => {
    const { fetch, calls } = pages();
    const client = createUsdbClient({ username: 'u', password: 'p', fetch, minIntervalMs: 0, sleep: async () => {} });
    const rows = await client.listSongs({ order: 'lastchange', descending: true, start: 200 });
    expect(rows.map((r) => r.id)).toEqual([1234, 5678]);
    const form = new URLSearchParams(calls.find((c) => c.url.includes('link=list'))!.body);
    expect(Object.fromEntries(form)).toEqual({ order: 'lastchange', ud: 'desc', limit: '100', details: '1', start: '200' });
  });

  it('downloads a note file by id, waiting out the countdown', async () => {
    const { fetch, calls } = pages();
    const slept: number[] = [];
    const client = createUsdbClient({ username: 'u', password: 'p', fetch, minIntervalMs: 0, sleep: async (ms) => { slept.push(ms); } });
    expect(await client.downloadById(1234)).toContain('#ARTIST:Queen');
    expect(calls.filter((c) => c.url.includes('link=gettxt')).map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(calls.some((c) => c.url.includes('link=list'))).toBe(false);
    expect(slept).toContain(25_000);
  });

  it('returns null when no result matches the artist and title', async () => {
    const { fetch } = pages();
    const client = createUsdbClient({ username: 'u', password: 'p', fetch, minIntervalMs: 0, sleep: async () => {} });
    expect(await client.findNoteFile('Omar Apollo', 'Evergreen')).toBeNull();
  });

  it('follows a login answer that is an empty redirect', async () => {
    let loggedIn = false;
    const { fetch } = fakeFetch({
      'link=list': () => html(fixture('list.html')),
      'link=gettxt': () => html(fixture('gettxt.html')),
      'index.php': (method) => {
        if (method === 'POST') {
          loggedIn = true;
          return new Response('', { status: 302, headers: { 'set-cookie': 'PHPSESSID=new1; path=/', location: 'index.php' } });
        }
        return html(loggedIn ? '<a href="?link=logout">Logout</a>' : 'Please login', 'PHPSESSID=first; path=/');
      },
    });
    const client = createUsdbClient({ username: 'u', password: 'p', fetch, minIntervalMs: 0, sleep: async () => {} });
    expect(await client.findNoteFile('Queen', 'Bohemian Rhapsody')).toContain('#ARTIST:Queen');
  });

  it('only logs in when the session cookie is sent with the form, like USDB', async () => {
    let sessions = 0;
    const loggedIn = new Set<string>();
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const cookie = new Headers(init?.headers).get('cookie');
      if (url.includes('link=list')) return html(fixture('list.html'));
      if (url.includes('link=gettxt')) return html(fixture('gettxt.html'));
      if (!cookie) return html('Please login', `PHPSESSID=s${++sessions}; path=/`);
      if (init?.method === 'POST') loggedIn.add(cookie);
      return html(loggedIn.has(cookie) ? '<a href="?link=logout">Logout</a>' : 'Please login');
    }) as typeof globalThis.fetch;
    const client = createUsdbClient({ username: 'u', password: 'p', fetch, minIntervalMs: 0, sleep: async () => {} });
    await expect(client.login()).resolves.toBeUndefined();
    expect(await client.findNoteFile('Queen', 'Bohemian Rhapsody')).toContain('#ARTIST:Queen');
  });

  it('fails clearly when login is rejected', async () => {
    const { fetch } = fakeFetch({ 'index.php': () => html('Login failed. Wrong user or password') });
    const client = createUsdbClient({ username: 'u', password: 'bad', fetch, minIntervalMs: 0, sleep: async () => {} });
    await expect(client.findNoteFile('Queen', 'Bohemian Rhapsody')).rejects.toThrow(/login/i);
  });

  it('waits between requests to stay polite', async () => {
    const { fetch } = pages();
    const waits: number[] = [];
    let clock = 0;
    const client = createUsdbClient({
      username: 'u', password: 'p', fetch, minIntervalMs: 2500,
      now: () => clock,
      sleep: async (ms) => { waits.push(ms); clock += ms; },
    });
    await client.findNoteFile('Queen', 'Bohemian Rhapsody');
    expect(waits).toContain(25_000); // the page's 24 s countdown plus a second
    expect(waits.filter((w) => w !== 25_000).every((w) => w <= 2500 && w > 0)).toBe(true);
  });

  it('can search without downloading, for views and rating only', async () => {
    const { fetch, calls } = pages();
    const client = createUsdbClient({ username: 'u', password: 'p', fetch, minIntervalMs: 0, sleep: async () => {} });
    expect(await client.findSong('Queen', 'Bohemian Rhapsody', { download: false })).toEqual({ id: 1234, noteText: null, rating: 5, views: 1000 });
    expect(calls.some((c) => c.url.includes('link=gettxt'))).toBe(false);
  });

  it('reads the countdown from the gettxt page', () => {
    expect(parseDownloadWait(fixture('gettxt-countdown.html'))).toBe(24);
    expect(parseDownloadWait('<html>no timer</html>')).toBe(0);
  });

  it('skips the wait when the notes are already on the first page', async () => {
    const { fetch, calls } = fakeFetch({
      'link=list': () => html(fixture('list.html')),
      'link=gettxt': () => html(fixture('gettxt.html')),
      'index.php': () => html('<a href="?link=logout">Logout</a>', 'PHPSESSID=abc123; path=/'),
    });
    const waits: number[] = [];
    const client = createUsdbClient({ username: 'u', password: 'p', fetch, minIntervalMs: 0, sleep: async (ms) => { waits.push(ms); } });
    expect(await client.findNoteFile('Queen', 'Bohemian Rhapsody')).toContain('#ARTIST:Queen');
    expect(calls.filter((c) => c.url.includes('link=gettxt'))).toHaveLength(1);
    expect(waits).toEqual([]);
  });
});
