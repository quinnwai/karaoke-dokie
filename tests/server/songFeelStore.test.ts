import { describe, expect, it } from 'vitest';
import { isMissingTable } from '../../src/lib/server/songFeel';
import { createPostgresStore, type QueryFn } from '../../src/lib/server/postgresStore';

describe('putSongFeel on Postgres', () => {
  it('never puts one key in a statement twice: a real Postgres refuses an upsert that touches a row twice, and pg-mem does not', async () => {
    const statements: { text: string; params: unknown[] }[] = [];
    const query: QueryFn = async (text, params = []) => {
      statements.push({ text, params });
      return [];
    };
    const store = createPostgresStore(query, { autoMigrate: false });
    // 450 entries over 300 keys, so the repeats fall in different 200-row statements and in the same one
    const entries = Array.from({ length: 450 }, (_, i) => ({ key: `artist|song ${i % 300}`, feel: (i < 300 ? 'slow' : 'upbeat') as 'slow' | 'upbeat', source: 'test/v1' }));
    await store.putSongFeel(entries);
    const keysOf = (params: unknown[]) => params.filter((_, i) => i % 4 === 0); // four parameters to a row, the key first
    for (const { text, params } of statements) expect(new Set(keysOf(params)).size, text.slice(0, 50)).toBe(keysOf(params).length);
    expect(statements.flatMap((s) => keysOf(s.params))).toHaveLength(300);
    // the last entry for a key is the one written
    const written = new Map(statements.flatMap((s) => Array.from({ length: s.params.length / 4 }, (_, r) => [s.params[r * 4], s.params[r * 4 + 1]] as const)));
    expect(written.get('artist|song 5')).toBe('upbeat'); // entries 5 (slow) and 305 (upbeat): the later one is written
    expect(written.get('artist|song 149')).toBe('upbeat'); // 149 and 449
    expect(written.get('artist|song 150')).toBe('slow'); // only entry 150: nothing repeats it
  });
});

describe('isMissingTable', () => {
  it('knows Postgres\' wording for a table that is not there, with or without the code, and nothing else', () => {
    expect(isMissingTable(Object.assign(new Error('boom'), { code: '42P01' }))).toBe(true);
    expect(isMissingTable(new Error('relation "song_feel" does not exist'))).toBe(true);
    expect(isMissingTable(new Error('relation public.song_feel does not exist'))).toBe(true);
    expect(isMissingTable(new Error('fetch failed'))).toBe(false);
    expect(isMissingTable(Object.assign(new Error('timeout'), { code: '57014' }))).toBe(false);
    expect(isMissingTable(null)).toBe(false);
    expect(isMissingTable('relation "x" does not exist')).toBe(false); // a bare string is not an error
  });
});
