import { describe, expect, it } from 'vitest';
import type { DataSourceLogEntry, SongRange } from '../../src/lib/contracts';
import { readOnlyStore } from '../../src/lib/report/readOnlyStore';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { createSongService } from '../../src/lib/server/songService';

const range: SongRange = { low: 50, high: 69, tessitura: 60, source: 'note-file', confidence: 'high', fastLyrics: false };
const log: DataSourceLogEntry = { trackId: 't1', title: 'Song', artist: 'Band', outcome: 'note-file', reason: 'r', at: '2026-01-01T00:00:00.000Z' };
const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: 1 };

describe('readOnlyStore', () => {
  it('passes reads through and drops every write', async () => {
    const store = createMemoryStore();
    await store.upsertUser({ id: 'u1', displayName: 'Ann', spotify: tokens });
    await store.putSongRange('band|song', { range, log });
    const ro = readOnlyStore(store);
    expect(await ro.getUser('u1')).toMatchObject({ displayName: 'Ann' });
    expect(await ro.getSongRange('band|song')).toEqual({ range, log });
    expect(await ro.listUserIds()).toEqual(['u1']);

    await ro.upsertUser({ id: 'u1', displayName: 'Changed', spotify: { ...tokens, refreshToken: 'mock-refresh' } });
    await ro.saveRange('u1', { low: 48, high: 72, source: 'test' });
    await ro.putSongRange('band|other', { range, log });
    await ro.putUsdbSongs([{ id: 1, key: 'band|song', artist: 'Band', title: 'Song' }]);
    await ro.appendLog(log);
    await ro.saveFeedback({ userId: 'u1', trackId: 't1', thumbs: 'up', userRange: { low: 48, high: 72, source: 'test' }, difficulty: 'easy', octave: 'none', at: log.at });
    await ro.appendEvents('device', [{ name: 'landing_viewed', at: log.at }]);
    await ro.putSongMoods([{ key: 'band|song', moods: ['upbeat'], method: 'm', source: 'hand' }]);

    expect(await store.getUser('u1')).toMatchObject({ displayName: 'Ann', spotify: tokens });
    expect(await store.getRange('u1')).toBeNull();
    expect(await store.getSongRange('band|other')).toBeNull();
    expect(await store.usdbIndexStats()).toEqual({ count: 0, newestChange: null });
    expect(await store.listLog()).toEqual([]);
    expect(await store.listFeedback()).toEqual([]);
  });

  it('lets the song service look songs up without caching or logging them', async () => {
    const store = createMemoryStore();
    const svc = createSongService(readOnlyStore(store), {
      songKey: (a, t) => `${a}|${t}`.toLowerCase(),
      resolveSongRange: async (t) => ({ range, log: { ...log, trackId: t.id } }),
      matchSong: (track, r) => ({ track, range: r, difficulty: 'easy', octave: 'none' }),
      rankMatches: (m) => m,
      paginate: (items) => ({ items, nextOffset: null }),
    });
    const track = { id: 't1', title: 'Song', artist: 'Band', artistId: 'b', spotifyUrl: '', playRank: 0 };
    const res = await svc.recommend([track], { low: 45, high: 72, source: 'test' }, 0, 0, { all: true });
    expect(res.matches).toHaveLength(1);
    expect(await store.getSongRange('band|song')).toBeNull();
    expect(await store.listLog()).toEqual([]);
  });
});
