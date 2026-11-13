import { describe, expect, it, vi } from 'vitest';
import { backupSongFeel, backupTableRefusal, isMissingTable } from '../../src/lib/server/songFeel';
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

describe('backupTableRefusal', () => {
  it('takes song_feel_bak_ and a lower case name, and nothing that could carry other SQL', () => {
    expect(backupTableRefusal('song_feel_bak_qww54b')).toBeNull();
    for (const bad of ['song_feel', 'song_feel_bak_', 'song_feel_bak_QWW', 'song_feel_bak_x; DROP TABLE song_feel', 'song_feel_bak_x y', 'other_table', `song_feel_bak_${'x'.repeat(41)}`]) {
      expect(backupTableRefusal(bad), bad).toMatch(/--backup must name a table/);
    }
  });
});

describe('backupSongFeel', () => {
  /**
   * Postgres as far as the backup is concerned. pg-mem cannot run CREATE TABLE ... AS SELECT, so the statement is answered
   * the way Postgres answers it: a copy of the rows, error 42P01 when song_feel is missing, 42P07 when the copy exists, and
   * count(*) as a string, as Neon returns it.
   */
  function fakeDb() {
    const tables = new Map<string, { song_key: string; feel: string }[]>();
    const query: QueryFn = async (text) => {
      const copy = /^CREATE TABLE (\w+) AS SELECT \* FROM song_feel$/.exec(text);
      if (copy) {
        const source = tables.get('song_feel');
        if (!source) throw Object.assign(new Error('relation "song_feel" does not exist'), { code: '42P01' });
        if (tables.has(copy[1]!)) throw Object.assign(new Error(`relation "${copy[1]}" already exists`), { code: '42P07' });
        tables.set(copy[1]!, source.map((r) => ({ ...r })));
        return [];
      }
      const count = /^SELECT count\(\*\) AS n FROM (\w+)$/.exec(text);
      if (count) return [{ n: String(tables.get(count[1]!)!.length) }];
      throw new Error(`unexpected statement: ${text}`);
    };
    return { tables, query };
  }

  it('copies song_feel, keeps an existing copy as it is, and has nothing to copy before song_feel exists', async () => {
    const { tables, query } = fakeDb();
    expect(await backupSongFeel(query, 'song_feel_bak_t')).toEqual({ status: 'nothing-to-back-up' });
    expect(tables.has('song_feel_bak_t')).toBe(false);
    tables.set('song_feel', [
      { song_key: 'ed sheeran|i see fire', feel: 'mid' },
      { song_key: 'a-ha|take on me', feel: 'upbeat' },
    ]);
    expect(await backupSongFeel(query, 'song_feel_bak_t')).toEqual({ status: 'created', rows: 2 });
    tables.get('song_feel')![0]!.feel = 'slow'; // the write the backup is for
    // a rerun, as after a stop, keeps the copy made before the first write
    expect(await backupSongFeel(query, 'song_feel_bak_t')).toEqual({ status: 'kept', rows: 2 });
    expect(tables.get('song_feel_bak_t')![0]!.feel).toBe('mid');
  });

  it('refuses a name that is not a backup table before it touches the database', async () => {
    const query = vi.fn();
    await expect(backupSongFeel(query, 'song_feel; DROP TABLE song_feel')).rejects.toThrow(/--backup must name a table/);
    expect(query).not.toHaveBeenCalled();
  });

  it('lets any other failure through, so a stop is never read as "nothing to back up"', async () => {
    const query: QueryFn = async () => {
      throw new Error('fetch failed');
    };
    await expect(backupSongFeel(query, 'song_feel_bak_t')).rejects.toThrow('fetch failed');
  });
});
