import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { songRangeFromUltrastar } from '../../src/lib/songs/range';
import { createUsdbClient } from '../../src/lib/usdb/client';
import { fillCatalogue } from '../../src/lib/usdb/fillCatalogue';
import { fixture } from '../songs/fixture';

const noteFile = (pitches: number[]) =>
  `#TITLE:x\n#ARTIST:y\n#BPM:120\n#GAP:0\n${pitches.map((p, i) => `: ${i * 4} 4 ${p} la`).join('\n')}\nE\n`;
const log = { trackId: '', title: 't', artist: 'a', outcome: 'note-file' as const, reason: 'r', at: 'x' };

describe('fillCatalogue', () => {
  it('downloads songs without a note-file range, most-viewed first, once per song key', async () => {
    const store = createMemoryStore();
    await store.putUsdbSongs([
      { id: 1, key: 'a|one', artist: 'A', title: 'One', views: 10 },
      { id: 2, key: 'a|two', artist: 'A', title: 'Two', views: 500, rating: 4 },
      { id: 3, key: 'a|two', artist: 'A', title: 'Two (dupe)', views: 5 },
      { id: 4, key: 'a|known', artist: 'A', title: 'Known', views: 900 },
      { id: 5, key: 'a|bad', artist: 'A', title: 'Bad', views: 1 },
    ]);
    const known = { low: 50, high: 60, tessitura: 55, source: 'note-file' as const, confidence: 'high' as const, fastLyrics: false };
    await store.putSongRange('a|known', { range: known, log });
    const downloads: number[] = [];
    const usdb = { downloadById: async (id: number) => (downloads.push(id), id === 5 ? null : noteFile([0, 4, 7])) };

    const summary = await fillCatalogue({ store, usdb });
    expect(downloads).toEqual([2, 1, 5]);
    expect(summary).toEqual({ candidates: 3, stored: 2, failed: 1 });
    expect((await store.getSongRange('a|two'))!.range).toMatchObject({ usdbId: 2, usdbViews: 500, usdbRating: 4, source: 'note-file' });
    expect((await store.getSongRange('a|known'))!.range).toEqual(known);
    expect(await store.getSongRange('a|bad')).toBeNull();
  });

  it('replaces measured recordings and estimates with the note file', async () => {
    const store = createMemoryStore();
    await store.putUsdbSongs([
      { id: 1, key: 'a|recorded', artist: 'A', title: 'Recorded', views: 10 },
      { id: 2, key: 'a|guessed', artist: 'A', title: 'Guessed', views: 5 },
    ]);
    const base = { low: 50, high: 60, tessitura: 55, fastLyrics: false };
    await store.putSongRange('a|recorded', { range: { ...base, source: 'audio-full', confidence: 'high', method: 'm' }, log: { ...log, outcome: 'audio-full' } });
    await store.putSongRange('a|guessed', { range: { ...base, source: 'artist-typical', confidence: 'low' }, log: { ...log, outcome: 'artist-typical' } });
    const usdb = { downloadById: async () => noteFile([0, 4, 7]) };
    expect(await fillCatalogue({ store, usdb })).toEqual({ candidates: 2, stored: 2, failed: 0 });
    for (const key of ['a|recorded', 'a|guessed']) {
      expect((await store.getSongRange(key))!).toMatchObject({ range: { source: 'note-file', low: 60, high: 67 }, log: { outcome: 'note-file' } });
    }
  });

  it('stops after the limit, and a rerun picks up where it left off', async () => {
    const store = createMemoryStore();
    await store.putUsdbSongs([1, 2, 3].map((id) => ({ id, key: `a|${id}`, artist: 'A', title: String(id), views: 10 - id })));
    const downloads: number[] = [];
    const usdb = { downloadById: async (id: number) => (downloads.push(id), noteFile([0, 4])) };
    await fillCatalogue({ store, usdb, limit: 2 });
    await fillCatalogue({ store, usdb });
    expect(downloads).toEqual([1, 2, 3]);
  });

  it('with recheckFast, re-reads only flagged USDB songs and clears flags the rule no longer gives', async () => {
    const store = createMemoryStore();
    await store.putUsdbSongs([1, 2, 3].map((id) => ({ id, key: `a|${id}`, artist: 'A', title: String(id), views: 10 - id })));
    const base = { low: 50, high: 60, tessitura: 55, source: 'note-file' as const, confidence: 'high' as const };
    await store.putSongRange('a|1', { range: { ...base, fastLyrics: true, usdbId: 1 }, log });
    await store.putSongRange('a|2', { range: { ...base, fastLyrics: false, usdbId: 2 }, log });
    await store.putSongRange('a|3', { range: { ...base, fastLyrics: true, collection: 'singmania' }, log });
    const downloads: number[] = [];
    const usdb = { downloadById: async (id: number) => (downloads.push(id), noteFile([0, 4, 7])) };
    const summary = await fillCatalogue({ store, usdb, recheckFast: true });
    expect(downloads).toEqual([1]);
    expect(summary).toEqual({ candidates: 1, stored: 1, failed: 0 });
    expect((await store.getSongRange('a|1'))!.range).toEqual({ ...base, fastLyrics: false, usdbId: 1 });
  });

  it('with rescanDuets, re-reads the duet upload of songs stored without parts, keeping the catalogue names', async () => {
    const store = createMemoryStore();
    await store.putUsdbSongs([
      { id: 1, key: 'duo|islands', artist: 'Duo', title: 'Islands', views: 900, rating: 4 },
      { id: 2, key: 'duo|islands', artist: 'Duo', title: 'Islands [DUET]', views: 100, rating: 5 },
      { id: 3, key: 'duo|islands', artist: 'Duo', title: 'Islands (Duet)', views: 50 },
      { id: 4, key: 'duo|has parts', artist: 'Duo', title: 'Has Parts [DUET]', views: 80 },
      { id: 5, key: 'duo|guessed', artist: 'Duo', title: 'Guessed [DUET]', views: 70 },
      { id: 6, key: 'duo|one part', artist: 'Duo', title: 'One Part [DUET]', views: 60 },
      { id: 7, key: 'duo|broken', artist: 'Duo', title: 'Broken [DUET]', views: 40 },
      { id: 8, key: 'duo|solo', artist: 'Duo', title: 'Solo', views: 999 },
    ]);
    const old = { low: 60, high: 62, tessitura: 61, source: 'note-file' as const, confidence: 'high' as const, fastLyrics: false };
    const named = (title: string) => ({ ...log, artist: 'Duo', title });
    // Stored from the solo upload before duets had parts.
    await store.putSongRange('duo|islands', { range: { ...old, usdbId: 1, usdbViews: 900, usdbRating: 4 }, log: named('Islands') });
    for (const [key, title] of Object.entries({ 'duo|one part': 'One Part', 'duo|broken': 'Broken', 'duo|solo': 'Solo' })) {
      await store.putSongRange(key, { range: old, log: named(title) });
    }
    await store.putSongRange('duo|has parts', { range: songRangeFromUltrastar(fixture('duet.txt')), log: named('Has Parts') });
    await store.putSongRange('duo|guessed', { range: { ...old, source: 'artist-typical', confidence: 'low' }, log: { ...named('Guessed'), outcome: 'artist-typical' } });
    const downloads: number[] = [];
    // id 6 is listed as a duet but has one sung part; id 7 sends no notes.
    const usdb = { downloadById: async (id: number) => (downloads.push(id), id === 7 ? null : id === 6 ? noteFile([0, 4, 7]) : fixture('duet.txt')) };

    const summary = await fillCatalogue({ store, usdb, rescanDuets: true, now: () => new Date(0) });
    // Uploads titled as a duet, most-viewed first: Islands' duet upload, not its more-viewed solo one.
    expect(downloads).toEqual([2, 6, 7]);
    expect(summary).toEqual({ candidates: 3, stored: 1, failed: 1 });
    const islands = (await store.getSongRange('duo|islands'))!;
    expect(islands.range).toEqual({ ...songRangeFromUltrastar(fixture('duet.txt')), usdbId: 2, usdbViews: 100, usdbRating: 5 });
    expect(islands.log).toEqual({ ...named('Islands'), reason: 'Used the UltraStar note file for this song (from USDB).', at: '1970-01-01T00:00:00.000Z' });
    expect((await store.getSongRange('duo|one part'))!.range).toEqual(old);
    expect((await store.getSongRange('duo|guessed'))!.range!.source).toBe('artist-typical');

    // A rerun only re-reads the duets still without parts.
    downloads.length = 0;
    await fillCatalogue({ store, usdb, rescanDuets: true });
    expect(downloads).toEqual([6, 7]);
  });

  it('with rescanDuets, downloads through the client, so request spacing and the countdown still apply', async () => {
    const store = createMemoryStore();
    await store.putUsdbSongs([
      { id: 21, key: 'duo|a', artist: 'Duo', title: 'A [DUET]', views: 20 },
      { id: 22, key: 'duo|b', artist: 'Duo', title: 'B (Duet)', views: 10 },
    ]);
    const old = { low: 60, high: 62, tessitura: 61, source: 'note-file' as const, confidence: 'high' as const, fastLyrics: false };
    for (const key of ['duo|a', 'duo|b']) await store.putSongRange(key, { range: old, log });
    // Fake USDB pages: logged in everywhere; gettxt shows the countdown, then the notes once posted.
    const page = (name: string) => readFileSync(join(__dirname, '../fixtures/usdb', name), 'utf8');
    const gettxt: string[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      let body = '<a href="?link=logout">Logout</a>';
      if (url.includes('link=gettxt')) {
        gettxt.push(`${method} ${new URL(url).searchParams.get('id')}`);
        body = method === 'GET' ? page('gettxt-countdown.html') : `<textarea>${fixture('duet.txt')}</textarea>`;
      }
      return new Response(body, { status: 200, headers: { 'set-cookie': 'PHPSESSID=abc; path=/' } });
    }) as typeof globalThis.fetch;
    const waits: number[] = [];
    let clock = 0;
    const usdb = createUsdbClient({
      username: 'u', password: 'p', fetch, minIntervalMs: 2500,
      now: () => clock,
      sleep: async (ms) => { waits.push(ms); clock += ms; },
    });

    expect(await fillCatalogue({ store, usdb, rescanDuets: true })).toEqual({ candidates: 2, stored: 2, failed: 0 });
    expect(gettxt).toEqual(['GET 21', 'POST 21', 'GET 22', 'POST 22']);
    expect(waits.filter((w) => w === 25_000)).toHaveLength(2); // each file waits out the 24 s countdown plus a second
    expect(waits.filter((w) => w !== 25_000).every((w) => w > 0 && w <= 2500)).toBe(true);
    expect((await store.getSongRange('duo|b'))!.range).toMatchObject({ duet: true, usdbId: 22 });
  });

  it('runs a fast-lyrics recheck and a duet rescan separately', async () => {
    const usdb = { downloadById: async () => null };
    await expect(fillCatalogue({ store: createMemoryStore(), usdb, recheckFast: true, rescanDuets: true })).rejects.toThrow(/separate runs/);
  });
});
