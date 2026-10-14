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

function pgMemQuery(): QueryFn {
  const db = newDb();
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

  it('lists note-file song ranges for one artist, for the artist fallback', async () => {
    const s = make();
    const nf = (low: number) => ({ ...songRange, low, source: 'note-file' as const, confidence: 'high' as const });
    await s.putSongRange('queen|bohemian rhapsody', { range: nf(50), log: logEntry(1) });
    await s.putSongRange('queen|somebody to love', { range: nf(52), log: logEntry(2) });
    await s.putSongRange('queen|guess', { range: { ...nf(40), source: 'artist-typical', confidence: 'low' }, log: logEntry(3) });
    await s.putSongRange('queen|skipped', { range: null, log: logEntry(4, 'skipped') });
    await s.putSongRange('queens of the stone age|no one knows', { range: nf(45), log: logEntry(5) });
    const lows = (await s.listNoteFileRangesByArtist('queen')).map((r) => r.low).sort();
    expect(lows).toEqual([50, 52]);
    expect(await s.listNoteFileRangesByArtist('nobody')).toEqual([]);
  });

  it('lists log entries newest first with a limit', async () => {
    const s = make();
    for (const n of [1, 3, 2]) await s.appendLog(logEntry(n, n === 2 ? 'skipped' : 'artist-typical'));
    const all = await s.listLog();
    expect(all.map((e) => e.trackId)).toEqual(['t3', 't2', 't1']);
    expect(all[1]).toEqual(logEntry(2, 'skipped'));
    expect(await s.listLog(1)).toEqual([logEntry(3, 'artist-typical')]);
  });

  it('reads back feedback, newest first, filtered by user', async () => {
    const s = make();
    await s.saveFeedback(feedback('u1', 1));
    await s.saveFeedback(feedback('u2', 2));
    await s.saveFeedback(feedback('u1', 3));
    expect(await s.listFeedback()).toEqual([feedback('u1', 3), feedback('u2', 2), feedback('u1', 1)]);
    expect(await s.listFeedback({ userId: 'u1' })).toEqual([feedback('u1', 3), feedback('u1', 1)]);
    expect(await s.listFeedback({ limit: 1 })).toEqual([feedback('u1', 3)]);
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
    for (const t of ['users', 'vocal_ranges', 'song_ranges', 'source_log', 'feedback']) {
      await expect(q(`SELECT * FROM ${t}`)).resolves.toEqual([]);
    }
  });

  it('picks memory unless a DATABASE_URL is set and KARAOKE_STORE is not memory', () => {
    expect(pickStoreKind({})).toBe('memory');
    expect(pickStoreKind({ DATABASE_URL: '  ' })).toBe('memory');
    expect(pickStoreKind({ DATABASE_URL: 'postgres://x', KARAOKE_STORE: 'memory' })).toBe('memory');
    expect(pickStoreKind({ DATABASE_URL: 'postgres://x' })).toBe('postgres');
  });
});
