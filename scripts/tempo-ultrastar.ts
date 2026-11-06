// Stores each note-file song's UltraStar #BPM in song_tempo.ultrastar_bpm (QWW-40). It is the note
// grid's tempo, usually four times the song's and often double or half again, so it only fills in
// when Deezer and the beat tracker have nothing, and breaks their ties (src/lib/tempo/tempo.ts).
// Reads folders of note files like ranges:build, writes numbers only. Earlier folders win.
// Usage: npm run tempo:ultrastar -- [--dry-run] <name>=<folder> [<name>=<folder> ...]   (needs DATABASE_URL)

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { decodeNoteFile } from '../src/lib/notes/bulkImport';
import { neonQuery } from '../src/lib/server/getStore';
import { createPostgresStore } from '../src/lib/server/postgresStore';
import type { SongTempoRecord } from '../src/lib/server/store';
import { songKey } from '../src/lib/songs/resolve';

async function* noteFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* noteFiles(path);
    else if (entry.name.toLowerCase().endsWith('.txt')) yield path;
  }
}

/** The artist, title and BPM in a note file's header, or null. A decimal comma is read as a point. */
export function readHeader(text: string): { artist: string; title: string; bpm: number } | null {
  const tag = (name: string) => new RegExp(`^#${name}:(.*)$`, 'mi').exec(text)?.[1]?.trim();
  const artist = tag('ARTIST');
  const title = tag('TITLE');
  const bpm = Number(tag('BPM')?.replace(',', '.'));
  return artist && title && Number.isFinite(bpm) && bpm > 0 ? { artist, title, bpm } : null;
}

async function main() {
  const { values, positionals } = parseArgs({ options: { 'dry-run': { type: 'boolean' } }, allowPositionals: true });
  if (!positionals.length) throw new Error('Usage: <name>=<folder> ...');
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('Set DATABASE_URL');
  const store = createPostgresStore(neonQuery(url));
  const byKey = new Map<string, SongTempoRecord>();
  for (const arg of positionals) {
    const [, dir] = arg.split('=') as [string, string];
    let files = 0;
    for await (const path of noteFiles(dir)) {
      files++;
      const h = readHeader(decodeNoteFile(await readFile(path)));
      if (!h) continue;
      const key = songKey(h.artist, h.title);
      if (!key.startsWith('|') && !key.endsWith('|') && !byKey.has(key)) byKey.set(key, { key, ultrastarBpm: h.bpm });
    }
    console.log(`${arg}: ${files} files, ${byKey.size} songs so far`);
  }
  if (!values['dry-run']) await store.putSongTempo([...byKey.values()]);
  console.log(`${byKey.size} songs with a BPM${values['dry-run'] ? ' (dry run, nothing saved)' : ' saved'}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
