import { newDb } from 'pg-mem';
import { describe, expect, it, vi } from 'vitest';
import type { SongRange } from '../../src/lib/contracts';
import { runGenreFetch, type GenreClient } from '../../src/lib/genres/deezer';
import { createPostgresStore, schemaStatements, type QueryFn } from '../../src/lib/server/postgresStore';
import { genreStore, printCoverage } from '../../scripts/genres-deezer';

const range: SongRange = { low: 55, high: 67, tessitura: 61, source: 'note-file', confidence: 'high', fastLyrics: false };

/** An empty pg-mem database. */
function pgMem(): QueryFn {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  return async (text, params) => (await pool.query(text, params)).rows;
}

/**
 * A pg-mem database with every table but song_genre (as production is before this change) and three measured songs:
 * one USDB names a genre for, one only Deezer could, and one with no Deezer match.
 */
async function database() {
  const query = pgMem();
  for (const stmt of schemaStatements()) if (!stmt.includes('song_genre')) await query(stmt);
  const setup = createPostgresStore(query, { autoMigrate: false });
  const songs = [
    { artist: 'Wet Leg', title: 'Chaise Longue', genre: 'Post-punk', deezerId: 1 },
    { artist: 'Wallows', title: 'Are You Bored Yet?', deezerId: 2 },
    { artist: 'Nobody', title: 'Unmatched' },
  ];
  for (const [i, s] of songs.entries()) {
    const key = `${s.artist}|${s.title}`.toLowerCase();
    await setup.putSongRange(key, { range, log: { trackId: '', title: s.title, artist: s.artist, outcome: 'note-file', reason: '', at: '2026-11-10T00:00:00.000Z' } });
    await setup.putUsdbSongs([{ id: i + 1, key, artist: s.artist, title: s.title, views: 100, ...(s.genre ? { genre: s.genre } : {}) }]);
    await setup.putSongDeezer([{ key, checkedAt: '2026-11-06T00:00:00.000Z', ...(s.deezerId ? { deezerId: s.deezerId, rank: 500_000 } : {}) }]);
  }
  return query;
}

/** A Deezer client that fails the test if it is asked anything. */
const noDeezer: GenreClient = {
  trackAlbum: async () => {
    throw new Error('a dry run must not ask Deezer');
  },
  albumGenres: async () => {
    throw new Error('a dry run must not ask Deezer');
  },
};

describe('npm run genres:deezer -- --dry-run (QWW-61)', () => {
  it('only reads: every statement is a SELECT, song_genre is not created, and Deezer is not asked', async () => {
    const query = await database();
    const sent: string[] = [];
    const recording: QueryFn = async (text, params) => {
      sent.push(text);
      return query(text, params);
    };
    const lines: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); // "song_genre does not exist"
    const store = genreStore(recording, true);
    const result = await runGenreFetch(store, noDeezer, { dryRun: true, log: (l) => lines.push(l) });
    await printCoverage(store, new Set(result.due.map((s) => s.key)), (l) => lines.push(l));
    warn.mockRestore();

    expect(sent.length).toBeGreaterThan(5);
    for (const text of sent) expect(text.trim(), text.slice(0, 60)).toMatch(/^(select|with)\b/i);
    await expect(query('SELECT * FROM song_genre')).rejects.toThrow(/song_genre/);
    expect(lines[0]).toBe('2 songs with a Deezer track: 0 done, 2 due (1 with no USDB genre, looked up first); dry run, nothing fetched or written');
    expect(lines).toContain('Measured songs with a genre: 33.3% now, at most 66.7% after a full run (of 3)');
    expect(lines).toContain('Logged-out lists (Setlist tuner at its defaults) with a genre, now -> at most after a full run:');
  });

  it('a real run migrates first, which creates song_genre', async () => {
    const query = pgMem();
    await genreStore(query, false).listSongGenres();
    await expect(query('SELECT * FROM song_genre')).resolves.toEqual([]);
  });
});
