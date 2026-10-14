import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createUsdbClient, parseSongList, parseNoteText } from '../../src/lib/usdb/client';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures/usdb', name), 'utf8');

interface Call { url: string; method: string; body: string; cookie: string | null }

function fakeFetch(pages: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? ''), cookie: headers.get('cookie') });
    const key = Object.keys(pages).find((k) => url.includes(k));
    if (!key) return new Response('not found', { status: 404 });
    return pages[key]!();
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const html = (body: string, cookie?: string) =>
  new Response(body, { status: 200, headers: cookie ? { 'set-cookie': cookie } : {} });

describe('USDB page parsing', () => {
  it('reads song rows from a search result page', () => {
    expect(parseSongList(fixture('list.html'))).toEqual([
      { id: 1234, artist: 'Queen', title: 'Bohemian Rhapsody' },
      { id: 5678, artist: 'Queen & David Bowie', title: 'Under Pressure' },
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

  it('returns null when the page has no notes', () => {
    expect(parseNoteText('<html>please log in</html>')).toBeNull();
  });
});

describe('USDB client', () => {
  const pages = () =>
    fakeFetch({
      'link=list': () => html(fixture('list.html')),
      'link=gettxt': () => html(fixture('gettxt.html')),
      'index.php': () => html('<a href="?link=profil">profile</a> <a href="?link=logout">Logout</a>', 'PHPSESSID=abc123; path=/'),
    });

  it('logs in once, keeps the session cookie, searches and downloads notes', async () => {
    const { fetch, calls } = pages();
    const client = createUsdbClient({ username: 'u', password: 'p', fetch, minIntervalMs: 0 });
    const notes = await client.findNoteFile('Queen', 'Bohemian Rhapsody - Remastered 2011');
    expect(notes).toContain('#TITLE:Bohemian Rhapsody');

    const login = calls[0]!;
    expect(login.method).toBe('POST');
    expect(new URLSearchParams(login.body).get('user')).toBe('u');
    expect(new URLSearchParams(login.body).get('login')).toBe('Login');

    const search = calls.find((c) => c.url.includes('link=list'))!;
    expect(search.cookie).toContain('PHPSESSID=abc123');
    expect(new URLSearchParams(search.body).get('interpret')).toBe('Queen');
    expect(new URLSearchParams(search.body).get('title')).toBe('Bohemian Rhapsody');

    const get = calls.find((c) => c.url.includes('link=gettxt'))!;
    expect(get.url).toContain('id=1234');
    expect(get.cookie).toContain('PHPSESSID=abc123');

    await client.findNoteFile('Queen', 'Bohemian Rhapsody');
    expect(calls.filter((c) => c.body.includes('login=Login'))).toHaveLength(1);
  });

  it('returns null when no result matches the artist and title', async () => {
    const { fetch } = pages();
    const client = createUsdbClient({ username: 'u', password: 'p', fetch, minIntervalMs: 0 });
    expect(await client.findNoteFile('Omar Apollo', 'Evergreen')).toBeNull();
  });

  it('fails clearly when login is rejected', async () => {
    const { fetch } = fakeFetch({ 'index.php': () => html('Login failed. Wrong user or password') });
    const client = createUsdbClient({ username: 'u', password: 'bad', fetch, minIntervalMs: 0 });
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
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(waits.every((w) => w <= 2500 && w > 0)).toBe(true);
  });
});
