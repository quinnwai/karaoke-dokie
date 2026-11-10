import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import type { SongRange } from '../../src/lib/contracts';
import { createPostgresStore, schemaStatements, type QueryFn } from '../../src/lib/server/postgresStore';
import { run } from '../../scripts/song-titles';

const range: SongRange = { low: 55, high: 67, tessitura: 61, source: 'note-file', confidence: 'high', fastLyrics: false };

/**
 * A pg-mem database called `name`, with every table but song_canonical (as a database before this change is) and
 * a few measured songs: one under two spellings, one with a tag, one plain.
 */
async function database(name: string) {
  const db = newDb();
  db.public.registerFunction({ name: 'current_database', returns: DataType.text, implementation: () => name });
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const query: QueryFn = async (text, params) => (await pool.query(text, params)).rows;
  for (const stmt of schemaStatements()) if (!stmt.includes('song_canonical')) await query(stmt);
  const store = createPostgresStore(query, { autoMigrate: false });
  for (const [artist, title] of [['Aaliyah', "I Don't Wanna"], ['Aaliyah', 'I Don’t Wanna'], ['10cc', 'Dreadlock Holiday (Album Version)'], ['Toto', 'Africa']]) {
    const key = `${artist}|${title}`.toLowerCase();
    await store.putSongRange(key, { range, log: { trackId: '', title: title!, artist: artist!, outcome: 'note-file', reason: '', at: '2026-11-10T00:00:00.000Z' } });
  }
  return { query, store };
}
const exists = async (query: QueryFn) => {
  try {
    await query('SELECT * FROM song_canonical', []);
    return true;
  } catch {
    return false;
  }
};
const go = async (query: QueryFn, argv: string[]) => {
  const lines: string[] = [];
  await run({ argv, query, host: 'db.example', log: (l) => lines.push(l) });
  return lines.join('\n');
};

describe('npm run titles:build', () => {
  it('is a dry run by default: it reads, reports, and does not even create the table', async () => {
    const { query } = await database('karaoke_pr4_preview');
    const out = await go(query, []);
    expect(out).toContain('Database karaoke_pr4_preview on db.example (dry run: nothing is written)');
    expect(out).toContain('song_canonical does not exist yet');
    expect(out).toContain('4 measured songs -> 3 after folding.');
    expect(out).toContain('npm run titles:build -- --apply --confirm-database karaoke_pr4_preview');
    expect(await exists(query)).toBe(false);
  });

  it('writes nothing without --confirm-database naming the database it is connected to', async () => {
    const { query } = await database('karaoke_pr4_preview');
    await expect(go(query, ['--apply'])).rejects.toThrow(/--confirm-database must name the database being written \(karaoke_pr4_preview\); got nothing/);
    await expect(go(query, ['--apply', '--confirm-database', 'neondb'])).rejects.toThrow(/got neondb\. Nothing was written/);
    expect(await exists(query)).toBe(false);
  });

  it('treats a database named neondb as production: --confirm-database is not enough, it needs --production', async () => {
    const { query } = await database('neondb');
    await expect(go(query, ['--apply', '--confirm-database', 'neondb'])).rejects.toThrow(/neondb is production.*Pass --production/);
    expect(await exists(query)).toBe(false);
    // the dry run tells the person what the real command takes
    expect(await go(query, [])).toContain('--apply --confirm-database neondb --production');
    expect(await go(query, ['--apply', '--confirm-database', 'neondb', '--production'])).toContain('Done. 4 rows in song_canonical, read back and equal.');
    expect(await exists(query)).toBe(true);
  });

  it('writes, reads back, and is then finished: a rerun has nothing to write', async () => {
    const { query, store } = await database('karaoke_pr4_preview');
    const out = await go(query, ['--apply', '--confirm-database', 'karaoke_pr4_preview']);
    expect(out).toContain('Done. 4 rows in song_canonical, read back and equal.');
    const stored = await store.listSongCanonical();
    expect(stored.size).toBe(4);
    expect([...stored.values()].filter((r) => r.reason === 'folded')).toHaveLength(1);
    expect(stored.get('10cc|dreadlock holiday (album version)')).toMatchObject({ title: 'Dreadlock Holiday', reason: 'cleaned', sourceTitle: 'Dreadlock Holiday (Album Version)' });
    const again = await go(query, []);
    expect(again).toContain('4 rows stored.');
    expect(again).toContain('To write: 0 rows (4 already stored and equal)');
  });

  it('finishes a run that stopped: only the missing rows are written', async () => {
    const { query, store } = await database('karaoke_pr4_preview');
    await go(query, ['--apply', '--confirm-database', 'karaoke_pr4_preview']);
    await query('DELETE FROM song_canonical WHERE song_key = $1', ['toto|africa']);
    expect((await store.listSongCanonical()).size).toBe(3);
    const out = await go(query, ['--apply', '--confirm-database', 'karaoke_pr4_preview']);
    expect(out).toContain('To write: 1 rows (3 already stored and equal)');
    expect((await store.listSongCanonical()).size).toBe(4);
  });

  it('writes the before and after lists as Markdown when asked, and still writes nothing', async () => {
    const { query } = await database('karaoke_pr4_preview');
    const files = new Map<string, string>();
    const lines: string[] = [];
    await run({ argv: ['--lists', 'out.md'], query, host: 'h', log: (l) => lines.push(l), writeFile: (path, text) => void files.set(path, text) });
    expect(files.get('out.md')).toContain('# Titles and duplicates, before and after (QWW-49)');
    expect(files.get('out.md')).toContain('**10cc - Dreadlock Holiday**');
    expect(lines.join('\n')).toContain('Lists for 5 ranges written to out.md.');
    expect(await exists(query)).toBe(false);
  });

  it('refuses --apply with --dry-run, and a database with no measured songs', async () => {
    const { query } = await database('karaoke_pr4_preview');
    await expect(go(query, ['--apply', '--dry-run'])).rejects.toThrow('Pass --apply or --dry-run, not both');
    await query('DELETE FROM song_ranges', []);
    await expect(go(query, [])).rejects.toThrow('No measured songs in this database; nothing to build');
  });

  it('does not take a read error for a missing table', async () => {
    const { query } = await database('karaoke_pr4_preview');
    const broken: QueryFn = async (text, params) => {
      if (text.includes('FROM song_canonical')) throw new Error('permission denied for table song_canonical');
      return query(text, params);
    };
    await expect(go(broken, [])).rejects.toThrow('permission denied');
  });
});
