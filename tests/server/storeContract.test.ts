import { describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DataSourceLogEntry, FeedbackEntry, SongRange } from '../../src/lib/contracts';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { createPostgresStore, migrate, schemaStatements, type QueryFn } from '../../src/lib/server/postgresStore';
import { SCHEMA_SQL } from '../../src/lib/server/schema';
import { pickStoreKind } from '../../src/lib/server/getStore';
import type { Store } from '../../src/lib/server/store';
import type { SongMoodsRecord, SongPopularityRecord } from '../../src/lib/server/store';

function pgMemQuery(opts: Parameters<typeof newDb>[0] = {}): QueryFn {
  const db = newDb(opts);
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  return async (text, params) => (await pool.query(text, params)).rows;
}

const factories: [string, () => Store][] = [
  ['memory', () => createMemoryStore()],
  ['postgres (pg-mem)', () => createPostgresStore(pgMemQuery())],
];

const songRange: SongRange = { low: 50, high: 69, tessitura: 60, source: 'note-file', confidence: 'high', fastLyrics: false };
const logEntry = (n: number, outcome: DataSourceLogEntry['outcome'] = 'note-file'): DataSourceLogEntry => ({
  trackId: `t${n}`,
  title: `Song ${n}`,
  artist: `Artist ${n}`,
  outcome,
  reason: `reason ${n}`,
  at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
});
const feedback = (userId: string, n: number): FeedbackEntry => ({
  userId,
  trackId: `t${n}`,
  thumbs: n % 2 ? 'up' : 'down',
  userRange: { low: 48, high: 72, source: 'test' },
  difficulty: 'medium',
  octave: 'down',
  at: new Date(Date.UTC(2026, 0, 2, 0, 0, n)).toISOString(),
});

describe.each(factories)('Store contract: %s', (_name, make) => {
  it('reads back users and updates them on upsert', async () => {
    const s = make();
    expect(await s.getUser('u1')).toBeNull();
    const u = { id: 'u1', displayName: 'Ann', spotify: { accessToken: 'a', refreshToken: 'r', expiresAt: 1_800_000_000_000 } };
    await s.upsertUser(u);
    expect(await s.getUser('u1')).toEqual(u);
    const u2 = { ...u, displayName: 'Ann B', spotify: { ...u.spotify, accessToken: 'a2' } };
    await s.upsertUser(u2);
    expect(await s.getUser('u1')).toEqual(u2);
  });

  it('lists user ids', async () => {
    const s = make();
    expect(await s.listUserIds()).toEqual([]);
    const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: 1 };
    await s.upsertUser({ id: 'u2', displayName: 'B', spotify: tokens });
    await s.upsertUser({ id: 'u1', displayName: 'A', spotify: tokens });
    expect((await s.listUserIds()).sort()).toEqual(['u1', 'u2']);
  });

  it('reads back vocal ranges per user', async () => {
    const s = make();
    expect(await s.getRange('u1')).toBeNull();
    await s.saveRange('u1', { low: 48, high: 72, source: 'test' });
    await s.saveRange('u2', { low: 40, high: 60, source: 'songs' });
    expect(await s.getRange('u1')).toEqual({ low: 48, high: 72, source: 'test' });
    await s.saveRange('u1', { low: 50, high: 70, source: 'songs' });
    expect(await s.getRange('u1')).toEqual({ low: 50, high: 70, source: 'songs' });
    expect(await s.getRange('u2')).toEqual({ low: 40, high: 60, source: 'songs' });
  });

  it('reads back song ranges and skipped markers, singly and in batch', async () => {
    const s = make();
    expect(await s.getSongRange('queen|bohemian rhapsody')).toBeNull();
    const found = { range: songRange, log: logEntry(1) };
    const skipped = { range: null, log: logEntry(2, 'skipped') };
    await s.putSongRange('queen|bohemian rhapsody', found);
    await s.putSongRange('nobody|unknown', skipped);
    expect(await s.getSongRange('queen|bohemian rhapsody')).toEqual(found);
    expect(await s.getSongRange('nobody|unknown')).toEqual(skipped);
    const batch = await s.getSongRanges(['queen|bohemian rhapsody', 'nobody|unknown', 'missing']);
    expect(batch.size).toBe(2);
    expect(batch.get('nobody|unknown')).toEqual(skipped);
    // overwrite
    await s.putSongRange('nobody|unknown', found);
    expect(await s.getSongRange('nobody|unknown')).toEqual(found);
    expect((await s.getSongRanges([])).size).toBe(0);
  });

  it('lists measured song ranges for one artist (note files and recordings, never estimates)', async () => {
    const s = make();
    const nf = (low: number) => ({ ...songRange, low, source: 'note-file' as const, confidence: 'high' as const });
    await s.putSongRange('queen|bohemian rhapsody', { range: nf(50), log: logEntry(1) });
    await s.putSongRange('queen|somebody to love', { range: nf(52), log: logEntry(2) });
    await s.putSongRange('queen|guess', { range: { ...nf(40), source: 'artist-typical', confidence: 'low' }, log: logEntry(3) });
    await s.putSongRange('queen|skipped', { range: null, log: logEntry(4, 'skipped') });
    await s.putSongRange('queens of the stone age|no one knows', { range: nf(45), log: logEntry(5) });
    await s.putSongRange('queen|radio ga ga', { range: { ...nf(53), source: 'audio-full', method: 'pyin-v1/app-range-v1' }, log: logEntry(6, 'audio-full') });
    await s.putSongRange('queen|rough', { range: { ...nf(54), source: 'audio-full', confidence: 'low' }, log: logEntry(7, 'audio-full') });
    await s.putSongRange('queen|published', { range: { ...nf(41), source: 'artist-external', confidence: 'low' }, log: logEntry(8) });
    const listed = await s.listMeasuredRangesByArtist('queen');
    expect(listed.map((r) => r.low).sort()).toEqual([50, 52, 53, 54]);
    expect(listed.find((r) => r.low === 53)).toMatchObject({ source: 'audio-full', method: 'pyin-v1/app-range-v1' });
    expect(await s.listMeasuredRangesByArtist('nobody')).toEqual([]);
    // Every stored range for the artist, estimates included, keyed by song; skips and other artists left out.
    const all = await s.listSongRangesByArtist('queen');
    expect([...all.keys()].sort()).toEqual([
      'queen|bohemian rhapsody',
      'queen|guess',
      'queen|published',
      'queen|radio ga ga',
      'queen|rough',
      'queen|somebody to love',
    ]);
    expect(all.get('queen|radio ga ga')?.range).toMatchObject({ source: 'audio-full' });
    expect((await s.listSongRangesByArtist('nobody')).size).toBe(0);
  });

  it('keeps a USDB song index: upserts by id, finds the most-viewed per key, reports size and newest change', async () => {
    const s = make();
    expect(await s.usdbIndexStats()).toEqual({ count: 0, newestChange: null });
    await s.putUsdbSongs([
      { id: 1, key: 'queen|bohemian rhapsody', artist: 'Queen', title: 'Bohemian Rhapsody', views: 100, rating: 4.5, lastChange: 1700 },
      { id: 2, key: 'queen|bohemian rhapsody', artist: 'Queen', title: 'Bohemian Rhapsody (Live)', views: 900, lastChange: 1800 },
      { id: 3, key: 'abba|sos', artist: 'ABBA', title: 'SOS' },
    ]);
    await s.putUsdbSongs([{ id: 3, key: 'abba|sos', artist: 'ABBA', title: 'SOS', views: 7, lastChange: 1750 }]);
    const found = await s.findUsdbSongs(['queen|bohemian rhapsody', 'abba|sos', 'nobody|x']);
    expect(found.get('queen|bohemian rhapsody')?.id).toBe(2);
    expect(found.get('abba|sos')).toEqual({ id: 3, key: 'abba|sos', artist: 'ABBA', title: 'SOS', views: 7, lastChange: 1750 });
    expect(found.has('nobody|x')).toBe(false);
    expect(await s.usdbIndexStats()).toEqual({ count: 3, newestChange: 1800 });
    expect((await s.listUsdbSongs()).map((e) => e.id)).toEqual([2, 1, 3]);
    expect((await s.findUsdbSongs(['queen|bohemian rhapsody'])).get('queen|bohemian rhapsody')).not.toHaveProperty('rating');
  });

  describe('catalogue', () => {
    const recording = { ...songRange, source: 'audio-full' as const, method: 'pyin-v1/app-range-v1' };
    const estimate = (source: 'artist-typical' | 'artist-external') => ({ ...songRange, source, confidence: 'low' as const });
    /** A stored row whose log line has the display names, as a library lookup or import writes it. */
    const row = (artist: string, title: string, range: SongRange | null) => ({
      range,
      log: { trackId: 'spotify-track-id', title, artist, outcome: range?.source ?? ('skipped' as const), reason: 'r', at: '2026-01-01T00:00:00.000Z' },
    });
    const rows = {
      'queen|bohemian rhapsody': row('Queen', 'Bohemian Rhapsody - Remastered 2011', songRange),
      'abba|sos': row('ABBA', 'SOS', recording),
      'abba|waterloo': row('ABBA', 'Waterloo', songRange),
      'toto|africa': row('Toto', 'Africa', recording),
      'a-ha|take on me': row('a-ha', 'Take On Me', songRange),
      'queen|rough': row('Queen', 'Rough', { ...recording, confidence: 'low' as const }),
      'queen|guess': row('Queen', 'Guess', estimate('artist-typical')),
      'queen|published': row('Queen', 'Published', estimate('artist-external')),
      'nobody|skipped': row('Nobody', 'Skipped', null),
    };
    const usdb = {
      bohemianStudio: { id: 1, key: 'queen|bohemian rhapsody', artist: 'Queen', title: 'Bohemian Rhapsody', views: 100, rating: 4.5 },
      bohemianLive: { id: 2, key: 'queen|bohemian rhapsody', artist: 'Queen', title: 'Bohemian Rhapsody (Live)', views: 900 },
      sos: { id: 3, key: 'abba|sos', artist: 'ABBA', title: 'SOS', views: 900, rating: 3 },
      waterlooLater: { id: 7, key: 'abba|waterloo', artist: 'ABBA', title: 'Waterloo (Duet)', views: 50, rating: 5 },
      waterloo: { id: 6, key: 'abba|waterloo', artist: 'ABBA', title: 'Waterloo', views: 50, rating: 2 },
      guess: { id: 4, key: 'queen|guess', artist: 'Queen', title: 'Guess', views: 99_999 },
      skipped: { id: 5, key: 'nobody|skipped', artist: 'Nobody', title: 'Skipped', views: 99_999 },
    };
    async function filled(): Promise<Store> {
      const s = make();
      for (const [key, rec] of Object.entries(rows)) await s.putSongRange(key, rec);
      await s.putUsdbSongs(Object.values(usdb));
      return s;
    }

    it('is empty with no song ranges', async () => {
      expect(await make().listCatalogue(10)).toEqual([]);
    });

    it('has one row per song with its most-viewed USDB row (a tie goes to the lower id)', async () => {
      const all = await (await filled()).listCatalogue(100);
      expect(new Set(all.map((c) => c.key)).size).toBe(all.length);
      const byKey = new Map(all.map((c) => [c.key, c]));
      expect(byKey.get('queen|bohemian rhapsody')!.usdb).toEqual(usdb.bohemianLive);
      expect(byKey.get('abba|sos')!.usdb).toEqual(usdb.sos);
      expect(byKey.get('abba|waterloo')!.usdb).toEqual(usdb.waterloo);
      expect(byKey.get('toto|africa')).not.toHaveProperty('usdb');
    });

    it('leaves out skipped songs and artist estimates, even with a USDB row, and keeps rough recordings', async () => {
      const keys = (await (await filled()).listCatalogue(100)).map((c) => c.key);
      for (const left of ['queen|guess', 'queen|published', 'nobody|skipped']) expect(keys).not.toContain(left);
      expect(keys).toContain('queen|rough');
    });

    it('orders by popularity from USDB views and stars, then songs with none by key, and cuts to the limit', async () => {
      const s = await filled();
      const order = ['abba|sos', 'queen|bohemian rhapsody', 'abba|waterloo', 'a-ha|take on me', 'queen|rough', 'toto|africa'];
      expect((await s.listCatalogue(100)).map((c) => c.key)).toEqual(order);
      expect((await s.listCatalogue(2)).map((c) => c.key)).toEqual(order.slice(0, 2));
      expect(await s.listCatalogue(0)).toEqual([]);
    });

    it('also orders by karaoke popularity and the range’s own USDB views, so a recording with no USDB row makes the cut (QWW-32)', async () => {
      const s = await filled();
      await s.putSongRange('a-ha|take on me', row('a-ha', 'Take On Me', { ...songRange, usdbViews: 5_000 }));
      const pop = (key: string, p: Partial<SongPopularityRecord>): SongPopularityRecord => ({ key, source: 'karafun+billboard', ...p });
      await s.putSongPopularity([
        // Scores below are on the committed popularity scale (src/lib/songs/popularityScale.ts);
        // recalibrating can move them.
        pop('toto|africa', { karaokeViews: 40_000_000 }), // a recording with no USDB row: 1, the top of the scale
        pop('queen|rough', { chartRank: 15, chartYear: 1999 }), // top-20 Year-End floor: 0.73
        pop('abba|waterloo', { chartRank: 90, chartYear: 1990 }), // lifted from 0.01 to the 0.62 floor
        pop('queen|guess', { karaokeViews: 40_000_000 }), // an estimate: still left out
        pop('nobody|skipped', { karaokeViews: 40_000_000 }), // skipped: still left out
      ]);
      // a-ha's own range views (0.97) count as the catalogue scores them; sos and Bohemian tie at 0.88, then by key.
      const order = ['toto|africa', 'a-ha|take on me', 'abba|sos', 'queen|bohemian rhapsody', 'queen|rough', 'abba|waterloo'];
      expect((await s.listCatalogue(100)).map((c) => c.key)).toEqual(order);
      // Past the limit, Year-End songs are still read: Rough and Waterloo, not SOS or Bohemian.
      expect((await s.listCatalogue(2)).map((c) => c.key)).toEqual(['toto|africa', 'a-ha|take on me', 'queen|rough', 'abba|waterloo']);
      const waterloo = (await s.listCatalogue(100)).find((c) => c.key === 'abba|waterloo')!;
      expect(waterloo.usdb).toEqual(usdb.waterloo); // the row is still the most-viewed one (a tie goes to the lower id)
    });

    it('takes display names from the log line and returns the stored range and log as they are', async () => {
      const all = await (await filled()).listCatalogue(100);
      const queen = all.find((c) => c.key === 'queen|bohemian rhapsody')!;
      expect(queen).toEqual({
        key: 'queen|bohemian rhapsody',
        artist: 'Queen',
        title: 'Bohemian Rhapsody - Remastered 2011',
        range: songRange,
        log: rows['queen|bohemian rhapsody'].log,
        usdb: usdb.bohemianLive,
      });
      expect(all.find((c) => c.key === 'a-ha|take on me')).toMatchObject({ artist: 'a-ha', title: 'Take On Me', range: songRange });
      expect(all.find((c) => c.key === 'abba|sos')!.range).toEqual(recording);
    });
  });

  it('reads back genre, year and language in the USDB index, and replaces them on update', async () => {
    const s = make();
    const full = { id: 1, key: 'queen|bohemian rhapsody', artist: 'Queen', title: 'Bohemian Rhapsody', views: 100, genre: 'Rock', year: 1975, language: 'English' };
    const bare = { id: 2, key: 'abba|sos', artist: 'ABBA', title: 'SOS' };
    await s.putUsdbSongs([full, bare]);
    expect((await s.findUsdbSongs(['queen|bohemian rhapsody'])).get('queen|bohemian rhapsody')).toStrictEqual(full);
    expect(await s.listUsdbSongs()).toStrictEqual([full, bare]);
    // A newer list row is the whole truth: a cleared year or language goes, a changed genre replaces the old one.
    await s.putUsdbSongs([{ id: 1, key: full.key, artist: 'Queen', title: 'Bohemian Rhapsody', views: 120, genre: 'Classic Rock' }]);
    expect((await s.findUsdbSongs([full.key])).get(full.key)).toStrictEqual({ id: 1, key: full.key, artist: 'Queen', title: 'Bohemian Rhapsody', views: 120, genre: 'Classic Rock' });
  });

  it('lists log entries newest first with a limit', async () => {
    const s = make();
    for (const n of [1, 3, 2]) await s.appendLog(logEntry(n, n === 2 ? 'skipped' : 'artist-typical'));
    const all = await s.listLog();
    expect(all.map((e) => e.trackId)).toEqual(['t3', 't2', 't1']);
    expect(all[1]).toEqual(logEntry(2, 'skipped'));
    expect(await s.listLog(1)).toEqual([logEntry(3, 'artist-typical')]);
  });

  it('reads back beta events: the newest `limit`, oldest first, optionally for one device', async () => {
    const s = make();
    const at = (n: number) => new Date(Date.UTC(2026, 10, 3, 0, 0, n)).toISOString();
    const opened = { name: 'song_opened', at: at(1), props: { sort: 'top', position: 2, fits: true, mood: null } };
    // An anonId inside the event must not override the device the call is for.
    const spoofed = { name: 'results_viewed', at: at(4), anonId: 'device-zzzz' };
    await s.appendEvents('device-aaaa', [opened, spoofed]);
    await s.appendEvents('device-bbbb', [{ name: 'range_shown', at: at(3) }, { name: 'landing_viewed', at: at(2) }]);
    const all = await s.listEvents();
    expect(all).toEqual([
      { anonId: 'device-aaaa', ...opened },
      { anonId: 'device-bbbb', name: 'landing_viewed', at: at(2) },
      { anonId: 'device-bbbb', name: 'range_shown', at: at(3) },
      { anonId: 'device-aaaa', name: 'results_viewed', at: at(4) },
    ]);
    expect(all[1]).not.toHaveProperty('props');
    expect((await s.listEvents({ limit: 2 })).map((e) => e.name)).toEqual(['range_shown', 'results_viewed']);
    expect((await s.listEvents({ anonId: 'device-aaaa' })).map((e) => e.name)).toEqual(['song_opened', 'results_viewed']);
    expect(await s.listEvents({ anonId: 'device-aaaa', limit: 1 })).toEqual([{ anonId: 'device-aaaa', name: 'results_viewed', at: at(4) }]);
    expect(await s.listEvents({ anonId: 'device-zzzz' })).toEqual([]);
  });

  it('keeps beta events with the same time in the order they arrived', async () => {
    const s = make();
    const at = '2026-11-03T00:00:00.000Z';
    await s.appendEvents('device-aaaa', [{ name: 'first', at }, { name: 'second', at }]);
    await s.appendEvents('device-bbbb', [{ name: 'third', at }]);
    expect((await s.listEvents()).map((e) => e.name)).toEqual(['first', 'second', 'third']);
    expect((await s.listEvents({ limit: 2 })).map((e) => e.name)).toEqual(['second', 'third']);
  });

  it('lists 5,000 beta events unless asked, and never more than 20,000', async () => {
    const s = make();
    const start = Date.UTC(2026, 10, 1);
    const many = Array.from({ length: 20_005 }, (_, i) => ({ name: 'tap', at: new Date(start + i * 1000).toISOString() }));
    await s.appendEvents('device-aaaa', many);
    const latest = await s.listEvents();
    expect(latest).toHaveLength(5_000);
    expect([latest[0]!.at, latest.at(-1)!.at]).toEqual([many[15_005]!.at, many[20_004]!.at]);
    expect(await s.listEvents({ limit: 50_000 })).toHaveLength(20_000);
  }, 30_000); // pg-mem takes a few seconds to insert 20,005 rows

  it('reads back feedback, newest first, filtered by user', async () => {
    const s = make();
    await s.saveFeedback(feedback('u1', 1));
    await s.saveFeedback(feedback('u2', 2));
    await s.saveFeedback(feedback('u1', 3));
    expect(await s.listFeedback()).toEqual([feedback('u1', 3), feedback('u2', 2), feedback('u1', 1)]);
    expect(await s.listFeedback({ userId: 'u1' })).toEqual([feedback('u1', 3), feedback('u1', 1)]);
    expect(await s.listFeedback({ limit: 1 })).toEqual([feedback('u1', 3)]);
  });

  it('reads back the song range stored with feedback, and the Maybe label', async () => {
    const s = make();
    const measured = { ...feedback('u1', 1), songRange: { source: 'audio-full' as const, method: 'pyin-v1/app-range-v1', low: 52, high: 65 } };
    const estimate = { ...feedback('u1', 2), difficulty: 'maybe' as const, songRange: { source: 'artist-typical' as const, low: 50.5, high: 70 } };
    const skipped = { ...feedback('u1', 3), songRange: { source: 'skipped' as const } };
    for (const f of [measured, estimate, skipped]) await s.saveFeedback(f);
    expect(await s.listFeedback()).toEqual([skipped, estimate, measured]);
  });

  it('reads back mood labels by song key, and a relabel replaces the whole row', async () => {
    const s = make();
    const method = 'claude-haiku-5-5/moods-v1';
    const both: SongMoodsRecord = { key: 'whitney houston|i wanna dance with somebody', moods: ['upbeat', 'heartfelt'], method, source: 'claude' };
    const none: SongMoodsRecord = { key: 'nirvana|smells like teen spirit', moods: [], method, source: 'claude' };
    expect((await s.getSongMoods([both.key])).size).toBe(0);
    await s.putSongMoods([both, none]);
    const read = await s.getSongMoods([both.key, none.key, 'nobody|missing']);
    expect([...read.keys()].sort()).toEqual([none.key, both.key]);
    expect(read.get(both.key)).toEqual(both);
    expect(read.get(none.key)).toEqual(none);

    // Upsert by key; within one call the last entry for a key wins.
    const relabel: SongMoodsRecord = { ...both, moods: ['heartfelt'], method: 'claude-sonnet-5-5/moods-v2' };
    await s.putSongMoods([{ ...none, moods: ['upbeat'], source: 'hand' }, relabel, { ...none, moods: ['heartfelt'], source: 'hand' }]);
    const again = await s.getSongMoods([both.key, none.key]);
    expect(again.get(both.key)).toEqual(relabel);
    expect(again.get(none.key)).toEqual({ ...none, moods: ['heartfelt'], source: 'hand' });
    expect((await s.getSongMoods([])).size).toBe(0);
    await s.putSongMoods([]);
  });

  it('writes and reads mood labels in bulk', async () => {
    const s = make();
    const many: SongMoodsRecord[] = Array.from({ length: 250 }, (_, i) => ({
      key: `artist ${i}|song ${i}`,
      moods: i % 3 === 0 ? ['upbeat'] : [],
      method: 'claude-haiku-5-5/moods-v1',
      source: 'claude',
    }));
    await s.putSongMoods(many);
    const read = await s.getSongMoods(many.map((m) => m.key));
    expect(read.size).toBe(250);
    expect(read.get('artist 249|song 249')).toEqual(many[249]);
  });

  it('reads back song popularity by key, and a new row replaces the whole old one', async () => {
    const s = make();
    // Views past 2^31 (karaoke_views is a BIGINT) and rows with only one file's numbers.
    const both: SongPopularityRecord = { key: 'the examples|first song', karaokeViews: 3_200_000_000, chartRank: 12, chartYear: 2004, source: 'karafun+billboard' };
    const views: SongPopularityRecord = { key: 'the examples|second song', karaokeViews: 4_100, source: 'karafun' };
    const chart: SongPopularityRecord = { key: 'lead singer|duet song', chartRank: 97, chartYear: 1999, source: 'billboard' };
    expect((await s.getSongPopularity([both.key])).size).toBe(0);
    await s.putSongPopularity([both, views, chart]);
    const read = await s.getSongPopularity([both.key, views.key, chart.key, 'nobody|missing', both.key]);
    expect([...read.keys()].sort()).toEqual([chart.key, both.key, views.key]);
    expect(read.get(both.key)).toStrictEqual(both);
    expect(read.get(views.key)).toStrictEqual(views);
    expect(read.get(chart.key)).toStrictEqual(chart);

    // Upsert by key, replacing the whole row; within one call the last entry for a key wins.
    const rechart: SongPopularityRecord = { key: both.key, chartRank: 3, chartYear: 2005, source: 'billboard' };
    await s.putSongPopularity([{ ...views, karaokeViews: 1 }, rechart, { ...views, karaokeViews: 9_000 }]);
    const again = await s.getSongPopularity([both.key, views.key, chart.key]);
    expect(again.get(both.key)).toStrictEqual(rechart);
    expect(again.get(views.key)).toStrictEqual({ ...views, karaokeViews: 9_000 });
    expect(again.get(chart.key)).toStrictEqual(chart);
    expect((await s.getSongPopularity([])).size).toBe(0);
    await s.putSongPopularity([]);
  });

  it('writes and reads song popularity in bulk', async () => {
    const s = make();
    const many: SongPopularityRecord[] = Array.from({ length: 2_500 }, (_, i) => ({ key: `artist ${i}|song ${i}`, karaokeViews: 1_000 + i, source: 'karafun' }));
    await s.putSongPopularity(many);
    const read = await s.getSongPopularity(many.map((p) => p.key));
    expect(read.size).toBe(2_500);
    expect(read.get('artist 2499|song 2499')).toStrictEqual(many[2_499]);
  });

  it('keeps Deezer ranks apart: popularity reads carry them, and a new popularity row leaves them alone (QWW-37)', async () => {
    const s = make();
    const karaoke: SongPopularityRecord = { key: 'toto|africa', karaokeViews: 40_000, source: 'karafun' };
    await s.putSongPopularity([karaoke]);
    await s.putSongDeezer([
      { key: 'toto|africa', rank: 964_180, deezerId: 3_135_556_000, checkedAt: '2026-11-06T12:00:00.000Z' },
      { key: 'kehlani|folded', rank: 794_554, checkedAt: '2026-11-06T12:00:01.000Z' },
      { key: 'nobody|missing', checkedAt: '2026-11-06T12:00:02.000Z' }, // a miss
    ]);
    const read = await s.getSongPopularity(['toto|africa', 'kehlani|folded', 'nobody|missing']);
    expect([...read.keys()].sort()).toEqual(['kehlani|folded', 'toto|africa']);
    expect(read.get('toto|africa')).toStrictEqual({ ...karaoke, deezerRank: 964_180 });
    expect(read.get('kehlani|folded')).toStrictEqual({ key: 'kehlani|folded', source: 'deezer', deezerRank: 794_554 });

    // popularity:import replaces the whole popularity row; the Deezer rank stays.
    await s.putSongPopularity([{ key: 'toto|africa', chartRank: 40, chartYear: 1983, source: 'billboard' }]);
    expect((await s.getSongPopularity(['toto|africa'])).get('toto|africa')).toStrictEqual({
      key: 'toto|africa',
      chartRank: 40,
      chartYear: 1983,
      source: 'billboard',
      deezerRank: 964_180,
    });

    // Every lookup, misses included, for the rerun to skip; a new lookup replaces the old one.
    await s.putSongDeezer([{ key: 'nobody|missing', rank: 5, checkedAt: '2026-11-07T00:00:00.000Z' }]);
    const all = await s.listSongDeezer();
    expect(all.size).toBe(3);
    expect(all.get('nobody|missing')).toStrictEqual({ key: 'nobody|missing', rank: 5, checkedAt: '2026-11-07T00:00:00.000Z' });
    expect(all.get('toto|africa')!.deezerId).toBe(3_135_556_000);
  });

  it('keeps tempo per source: a write sets only the fields it names (QWW-40)', async () => {
    const s = make();
    await s.putSongTempo([{ key: 'a-ha|take on me', ultrastarBpm: 456 }, { key: 'toto|africa', ultrastarBpm: 372 }]);
    await s.putSongTempo([{ key: 'toto|africa', deezerBpm: 93.5, deezerVersions: 2, previewUrl: 'https://cdn/x.mp3', checkedAt: '2026-11-06T12:00:00.000Z' }]);
    await s.putSongTempo([{ key: 'nobody|missing', checkedAt: '2026-11-06T12:00:01.000Z' }]); // a miss
    // the fill script writing a tracker tempo leaves Deezer's and UltraStar's alone
    await s.putSongTempo([{ key: 'toto|africa', trackerBpm: 92, checkedAt: '2026-11-06T13:00:00.000Z' }]);
    const read = await s.getSongTempos(['toto|africa', 'a-ha|take on me', 'unknown|song']);
    expect([...read.keys()].sort()).toEqual(['a-ha|take on me', 'toto|africa']);
    expect(read.get('toto|africa')).toStrictEqual({
      key: 'toto|africa',
      deezerBpm: 93.5,
      deezerVersions: 2,
      trackerBpm: 92,
      ultrastarBpm: 372,
      previewUrl: 'https://cdn/x.mp3',
      checkedAt: '2026-11-06T13:00:00.000Z',
    });
    expect(read.get('a-ha|take on me')).toStrictEqual({ key: 'a-ha|take on me', ultrastarBpm: 456 });
    expect((await s.listSongTempos()).size).toBe(3);
    // more keys than one query carries
    const many = Array.from({ length: 2_500 }, (_, i) => ({ key: `artist ${i}|song ${i}`, deezerBpm: 100 + (i % 50) }));
    await s.putSongTempo(many);
    expect((await s.getSongTempos(many.map((m) => m.key))).size).toBe(2_500);
  });

  it('keeps one Spotify block for the whole app: a later time wins and an earlier one never shortens it (QWW-55)', async () => {
    const s = make();
    expect(await s.getSpotifyBlock()).toBeNull();
    await s.setSpotifyBlock(1_800_000_000_000);
    expect(await s.getSpotifyBlock()).toBe(1_800_000_000_000);
    await s.setSpotifyBlock(1_700_000_000_000); // a short 429 arriving after a long one
    expect(await s.getSpotifyBlock()).toBe(1_800_000_000_000);
    await s.setSpotifyBlock(1_800_000_012_000);
    expect(await s.getSpotifyBlock()).toBe(1_800_000_012_000);
  });

  it('reads back the results view stored with feedback, and no view for a tap without one', async () => {
    const s = make();
    const filtered = {
      ...feedback('u1', 1),
      view: { difficulty: 0.1, familiarity: null, popularity: 0.75, tempo: null, decade: '80s' as const, mood: 'upbeat' as const, duetsOnly: true },
    };
    const plain = { ...feedback('u1', 2), view: { difficulty: null, familiarity: null, popularity: null, tempo: null, decade: null, mood: null, duetsOnly: false } };
    const older = feedback('u1', 3);
    for (const f of [filtered, plain, older]) await s.saveFeedback(f);
    const [o, p, f] = await s.listFeedback();
    expect(f).toStrictEqual(filtered);
    expect(p).toStrictEqual(plain);
    expect(o).toStrictEqual(older);
    expect(o).not.toHaveProperty('view');
  });
});

describe('schema and store selection', () => {
  it('db/schema.sql matches the inlined copy', () => {
    const file = readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf8');
    expect(SCHEMA_SQL).toBe(file);
  });

  it('migrate creates every table', async () => {
    const q = pgMemQuery();
    await migrate(q);
    expect(schemaStatements().length).toBeGreaterThanOrEqual(5);
    for (const t of ['users', 'vocal_ranges', 'song_ranges', 'source_log', 'feedback', 'song_popularity', 'spotify_block']) {
      await expect(q(`SELECT * FROM ${t}`)).resolves.toEqual([]);
    }
  });

  it('migrate adds the feedback range columns to a table made before them, and can run again', async () => {
    // pg-mem rejects CREATE TABLE IF NOT EXISTS on an existing table unless this check is off (Postgres does not).
    const q = pgMemQuery({ noAstCoverageCheck: true });
    await q(`CREATE TABLE feedback (id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, track_id TEXT NOT NULL, thumbs TEXT NOT NULL,
      user_low INTEGER NOT NULL, user_high INTEGER NOT NULL, user_range_source TEXT NOT NULL, difficulty TEXT NOT NULL,
      octave TEXT NOT NULL, at TEXT NOT NULL)`);
    const old = feedback('u1', 1);
    await q(
      `INSERT INTO feedback (user_id, track_id, thumbs, user_low, user_high, user_range_source, difficulty, octave, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [old.userId, old.trackId, old.thumbs, old.userRange.low, old.userRange.high, old.userRange.source, old.difficulty, old.octave, old.at],
    );
    await migrate(q);
    await migrate(q);
    const s = createPostgresStore(q, { autoMigrate: false });
    const fresh = {
      ...feedback('u1', 2),
      songRange: { source: 'audio-full' as const, method: 'm', low: 52, high: 65 },
      view: { difficulty: 1, familiarity: 0.5, popularity: null, tempo: null, decade: '20s' as const, mood: null, duetsOnly: false },
    };
    await s.saveFeedback(fresh);
    expect(await s.listFeedback()).toEqual([fresh, old]);
    // A tap saved before the view column existed comes back with no view.
    expect((await s.listFeedback())[1]).not.toHaveProperty('view');
  });

  it('picks memory unless a DATABASE_URL is set and KARAOKE_STORE is not memory', () => {
    expect(pickStoreKind({})).toBe('memory');
    expect(pickStoreKind({ DATABASE_URL: '  ' })).toBe('memory');
    expect(pickStoreKind({ DATABASE_URL: 'postgres://x', KARAOKE_STORE: 'memory' })).toBe('memory');
    expect(pickStoreKind({ DATABASE_URL: 'postgres://x' })).toBe('postgres');
  });
});
