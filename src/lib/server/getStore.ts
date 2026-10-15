import { neon } from '@neondatabase/serverless';
import { createMemoryStore } from './memoryStore';
import { createPostgresStore, type QueryFn } from './postgresStore';
import type { Store } from './store';

export type StoreKind = 'memory' | 'postgres';

/** memory when KARAOKE_STORE=memory or DATABASE_URL is empty, else postgres. */
export function pickStoreKind(env: Record<string, string | undefined> = process.env): StoreKind {
  if (env.KARAOKE_STORE === 'memory' || !env.DATABASE_URL?.trim()) return 'memory';
  return 'postgres';
}

export function neonQuery(databaseUrl: string): QueryFn {
  const sql = neon(databaseUrl);
  return (text, params = []) => sql.query(text, params) as Promise<Record<string, unknown>[]>;
}

// One instance per server process. Kept on globalThis so every route bundle and
// dev hot reloads share it (otherwise the memory store would split per module copy).
const g = globalThis as unknown as { __karaokeStore?: { kind: StoreKind; store: Store } };

export function getStore(): Store {
  const kind = pickStoreKind();
  if (!g.__karaokeStore || g.__karaokeStore.kind !== kind) {
    const store =
      kind === 'memory' ? createMemoryStore() : createPostgresStore(neonQuery(process.env.DATABASE_URL!.trim()));
    g.__karaokeStore = { kind, store };
  }
  return g.__karaokeStore.store;
}

/** Tests only: drop the process-wide store so the next getStore() starts empty. */
export function resetStoreForTests(): void {
  delete g.__karaokeStore;
}
