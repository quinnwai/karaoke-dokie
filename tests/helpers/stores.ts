// Both store implementations, for tests that must show data survives a real write and read: the
// memory store, and the Postgres store on pg-mem (song ranges go through its range_json column).
import { newDb } from 'pg-mem';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { createPostgresStore } from '../../src/lib/server/postgresStore';
import type { Store } from '../../src/lib/server/store';

export const STORES: [name: string, make: () => Store][] = [
  ['memory', () => createMemoryStore()],
  [
    'postgres (pg-mem)',
    () => {
      const { Pool } = newDb().adapters.createPg();
      const pool = new Pool();
      return createPostgresStore(async (text, params) => (await pool.query(text, params)).rows);
    },
  ],
];
