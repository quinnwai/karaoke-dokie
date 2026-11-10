// Counts the in-range catalogue songs each part of a stored Spotify library finds (QWW-55 PR 2, item 5): top tracks and
// recent plays only, plus the newest 200 likes, plus all likes, plus playlists. Prints a markdown table.
// Read-only, and it makes no Spotify request: it reads the library the site stored (user_library, user_saved), so sign
// in on the site first, or give it a file.
// Usage: npm run report:library -- [spotifyUserId] [--range 39:74] [--file library.json]   (needs DATABASE_URL unless --file)
//   --range LOW:HIGH   the singer's range in MIDI notes (default: the user's saved range; D#2 to D5 is 39:74)
//   --file             a JSON object { top, recent, saved, playlists } of songs (saved newest first) instead of the database
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { SongRange, Track, VocalRange } from '../src/lib/contracts';
import { measureLibrary, measureTable, type LibraryParts } from '../src/lib/report/libraryMeasure';
import { readOnlyStore } from '../src/lib/report/readOnlyStore';
import { loadCatalogue } from '../src/lib/server/catalogue';
import { getStore, neonQuery, pickStoreKind } from '../src/lib/server/getStore';
import { createPostgresStore } from '../src/lib/server/postgresStore';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { range: { type: 'string' }, file: { type: 'string' } } });
  // Not the app's getStore() for Postgres: that one migrates the schema on first use.
  const store = readOnlyStore(
    pickStoreKind() === 'postgres' ? createPostgresStore(neonQuery(process.env.DATABASE_URL!.trim()), { autoMigrate: false }) : getStore(),
  );

  let parts: LibraryParts;
  let range: VocalRange | null = null;
  let who: string;
  if (values.file) {
    const f = JSON.parse(await readFile(values.file, 'utf8')) as Partial<LibraryParts>;
    parts = { top: f.top ?? [], recent: f.recent ?? [], saved: f.saved ?? [], playlists: f.playlists ?? [] };
    who = values.file;
  } else {
    const userId = positionals[0] ?? (await store.listUserIds())[0];
    if (!userId) throw new Error('No signed-in users yet');
    const stored = await store.getLibraryState(userId);
    if (!stored) throw new Error(`No stored library for ${userId}: they have not signed in since the library was stored`);
    const { state } = stored;
    const lists = (rs: ({ tracks: Track[] } | undefined)[]) => rs.flatMap((r) => r?.tracks ?? []);
    parts = {
      top: lists(Object.values(state.top)),
      recent: state.recent?.tracks ?? [],
      saved: await store.listSavedTracks(userId),
      playlists: lists(Object.values(state.playlists)),
    };
    if (!state.savedComplete) console.warn(`Note: ${userId}'s first read is not finished, so the likes are partial.`);
    range = await store.getRange(userId);
    who = userId;
  }
  if (values.range) {
    const [low, high] = values.range.split(':').map(Number);
    if (!Number.isInteger(low) || !Number.isInteger(high) || low! >= high!) throw new Error('--range wants LOW:HIGH in MIDI notes, e.g. 39:74');
    range = { low: low!, high: high!, source: 'songs' };
  }
  if (!range) throw new Error('No range: give --range LOW:HIGH');

  const catalogue = new Map<string, SongRange>((await loadCatalogue(store)).map((c) => [c.key, c.range]));
  console.log(`${who}, range ${range.low} to ${range.high} (MIDI), ${catalogue.size} catalogue songs\n`);
  process.stdout.write(measureTable(measureLibrary(parts, catalogue, range)));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
