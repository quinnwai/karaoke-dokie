// How many in-range catalogue songs each part of a stored Spotify library finds (QWW-55 PR 2, item 5): it says what
// reading more of the library is worth, now that the whole library can be kept.
import type { SongRange, Track, VocalRange } from '../contracts';
import { matchSong } from '../songs/match';
import { songKey } from '../songs/resolve';

/** A library split by where each song was found, as the stored library keeps it. Likes are newest first. */
export interface LibraryParts {
  top: Track[];
  recent: Track[];
  saved: Track[];
  playlists: Track[];
}

export interface MeasureRow {
  step: string;
  /** Distinct library songs read so far. */
  librarySongs: number;
  /** Distinct catalogue songs among them that fit the singer's range (matchSong). */
  inRange: number;
  /** Distinct catalogue songs among them, in range or not. */
  inCatalogue: number;
}

/** The newest likes the first row after "top and recent" adds (the cap the stored library replaces). */
export const NEWEST_LIKES = 200;

/**
 * Four cumulative rows: top tracks and recent plays only; plus the newest 200 likes; plus all likes; plus playlists.
 * `catalogue` is the catalogue's songs by key with their ranges.
 */
export function measureLibrary(parts: LibraryParts, catalogue: Map<string, SongRange>, range: VocalRange): MeasureRow[] {
  const seen = new Set<string>();
  const inCatalogue = new Set<string>();
  const inRange = new Set<string>();
  const add = (tracks: Track[]) => {
    for (const t of tracks) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const key = songKey(t.artist, t.title);
      const song = catalogue.get(key);
      if (!song) continue;
      inCatalogue.add(key);
      if (matchSong(range, song)) inRange.add(key);
    }
  };
  const row = (step: string): MeasureRow => ({ step, librarySongs: seen.size, inRange: inRange.size, inCatalogue: inCatalogue.size });
  add([...parts.top, ...parts.recent]);
  const rows = [row('top tracks and recent plays only')];
  add(parts.saved.slice(0, NEWEST_LIKES));
  rows.push(row(`+ the newest ${NEWEST_LIKES} likes`));
  add(parts.saved);
  rows.push(row('+ all likes'));
  add(parts.playlists);
  rows.push(row('+ playlists'));
  return rows;
}

/** The rows as a markdown table, with what each step adds over the one before. */
export function measureTable(rows: MeasureRow[]): string {
  const lines = ['| Read | Library songs | In the catalogue | In range | Added |', '|---|---:|---:|---:|---:|'];
  rows.forEach((r, i) => {
    const added = i === 0 ? r.inRange : r.inRange - rows[i - 1]!.inRange;
    lines.push(`| ${r.step} | ${r.librarySongs} | ${r.inCatalogue} | ${r.inRange} | ${i === 0 ? '' : '+'}${added} |`);
  });
  return lines.join('\n') + '\n';
}
