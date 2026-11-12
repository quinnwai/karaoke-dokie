// Deezer's genres per song (QWW-61), for npm run genres:deezer. Deezer gives genres to albums, not tracks: for the Deezer
// track a song was matched to (song_deezer.deezer_id, npm run popularity:deezer), GET /track/<id> names its album, and
// GET /album/<id> lists the album's genres. Many songs share an album, so each album is read once. What is found is stored
// per song key in song_genre; a song shows it only when USDB lists no genre (genres.ts). Deezer is never called while a page
// loads. Kept apart from src/lib/popularity/deezer.ts, which matches songs to tracks.

import { isMissingTable } from '../server/songFeel';
import type { SongDeezerRecord, SongGenreRecord, Store } from '../server/store';
import { nonBlank } from './genres';

/** song_genre's source for the rows written here. */
export const GENRE_SOURCE = 'deezer-album';
/**
 * Deezer allows 50 requests per 5 seconds, but its CDN refused the popularity lookups (HTTP 403) after about 45 minutes at
 * 8 a second (src/lib/popularity/deezer.ts), so this stays at 5 a second, half the limit.
 */
export const REQUESTS_PER_SECOND = 5;
/** How long a miss stands before a rerun asks Deezer again. Genres, once found, are kept while the song's Deezer match stands. */
export const RECHECK_DAYS = 90;
/** Songs looked up at a time; the client spaces their requests. */
const CONCURRENCY = 5;
/** Rows saved per write. */
const BATCH = 100;
/** Failed lookups in a row that stop the run: Deezer is refusing us, so carry on later. */
const STOP_AFTER_ERRORS = 20;

export type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface GenreClientOptions {
  fetch?: Fetch;
  perSecond?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Tries per request before giving up, on a quota error or a server error. */
  tries?: number;
}

export interface GenreClient {
  /** The id of the track's album, or null when Deezer no longer has the track or names no album for it. */
  trackAlbum(trackId: number): Promise<number | null>;
  /** The album's genre names in Deezer's order (empty when it lists none), or null when Deezer no longer has the album. */
  albumGenres(albumId: number): Promise<string[] | null>;
}

/**
 * Reads Deezer's track and album API, spacing requests to stay under its limit and waiting out a quota error (Deezer
 * answers 200 with `{"error":{"code":4}}` when over it).
 */
export function createGenreClient(opts: GenreClientOptions = {}): GenreClient {
  const doFetch: Fetch = opts.fetch ?? ((url) => fetch(url, { signal: AbortSignal.timeout(20_000) }));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gap = 1000 / (opts.perSecond ?? REQUESTS_PER_SECOND);
  const tries = opts.tries ?? 5;
  let next = 0;
  /** Waits for this request's turn; turns are handed out one gap apart. */
  const turn = async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gap;
    if (at > now) await sleep(at - now);
  };
  /** One GET under the pacing and retry rules; null when Deezer has no such thing (error 800). */
  async function get<T>(path: string): Promise<T | null> {
    for (let i = 1; ; i++) {
      await turn();
      const res = await doFetch(`https://api.deezer.com/${path}`);
      const body = res.ok ? ((await res.json()) as { error?: { code?: number; message?: string } } & T) : undefined;
      if (body && !body.error) return body;
      if (body?.error?.code === 800) return null;
      const why = body?.error ? `error ${body.error.code}: ${body.error.message}` : `HTTP ${res.status}`;
      // A 403 is the CDN refusing us, not a quota: retrying only prolongs it.
      if (i >= tries || res.status === 403) throw new Error(`Deezer ${path} failed (${why})`);
      await sleep(5000 * i); // the quota counts 5 seconds back
    }
  }
  return {
    async trackAlbum(trackId) {
      const id = (await get<{ album?: { id?: unknown } }>(`track/${trackId}`))?.album?.id;
      return typeof id === 'number' ? id : null;
    },
    async albumGenres(albumId) {
      const album = await get<{ genres?: { data?: { name?: unknown }[] } }>(`album/${albumId}`);
      if (!album) return null;
      return (album.genres?.data ?? []).flatMap((g) => (typeof g.name === 'string' && g.name.trim() ? [g.name.trim()] : []));
    },
  };
}

/** A song to look up: its key and Deezer track, and whether USDB already gives it a genre. */
export interface GenreSong {
  key: string;
  deezerId: number;
  rank: number;
  usdbGenre: boolean;
}

/**
 * The songs to look up, in order: every song with a Deezer track that has no song_genre row, only a miss older than
 * RECHECK_DAYS, or a row older than its Deezer match (popularity:deezer checked the song again since, and may have picked
 * another track, on another album). Songs USDB gives no genre come first, since only theirs are shown, then the most
 * popular (best Deezer rank).
 */
export function genresDue(
  deezer: Iterable<SongDeezerRecord>,
  done: Map<string, SongGenreRecord>,
  usdbGenre: (key: string) => boolean,
  now: number,
): GenreSong[] {
  const stands = (g: SongGenreRecord | undefined, d: SongDeezerRecord) =>
    g !== undefined &&
    !(Date.parse(d.checkedAt) > Date.parse(g.checkedAt)) && // an unreadable time never counts as newer
    (nonBlank(g.genres) !== undefined || now - Date.parse(g.checkedAt) < RECHECK_DAYS * 86_400_000);
  const due: GenreSong[] = [];
  for (const d of deezer) {
    if (d.deezerId === undefined || stands(done.get(d.key), d)) continue;
    due.push({ key: d.key, deezerId: d.deezerId, rank: d.rank ?? 0, usdbGenre: usdbGenre(d.key) });
  }
  return due.sort((a, b) => Number(a.usdbGenre) - Number(b.usdbGenre) || b.rank - a.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export interface GenreRunOptions {
  /** Count what is due, and nothing more: Deezer is not asked and nothing is written. */
  dryRun?: boolean;
  /** Look up at most this many songs. */
  limit?: number;
  /** No song is started after this time (epoch ms); a rerun carries on. */
  deadline?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface GenreRunResult {
  /** Songs with a Deezer track. */
  songs: number;
  /** Every song due, in the order they are looked up. */
  due: GenreSong[];
  /** Songs this run set out to look up: `due` cut to the limit (none on a dry run). */
  todo: number;
  hits: number;
  misses: number;
  /** Lookups that failed; nothing is recorded for them, so the next run tries them again. */
  errors: number;
  /** Albums read from Deezer (each once, however many songs are on it). */
  albumsRead: number;
}

/** One run of npm run genres:deezer: works out what is due, then looks it up and writes song_genre in batches. */
export async function runGenreFetch(
  store: Pick<Store, 'listSongDeezer' | 'findUsdbSongs' | 'listSongGenres' | 'putSongGenre'>,
  client: GenreClient,
  opts: GenreRunOptions = {},
): Promise<GenreRunResult> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((line: string) => console.log(line));
  const deadline = opts.deadline ?? Infinity;
  const withTrack = [...(await store.listSongDeezer()).values()].filter((d) => d.deezerId !== undefined);
  // A database the table has not reached yet (a dry run does not migrate) has no rows.
  const done = await store.listSongGenres().catch((err: unknown) => {
    if (isMissingTable(err)) return new Map<string, SongGenreRecord>();
    throw err;
  });
  const usdb = await store.findUsdbSongs(withTrack.map((d) => d.key));
  const due = genresDue(withTrack, done, (key) => nonBlank(usdb.get(key)?.genre) !== undefined, now().getTime());
  const todo = opts.dryRun ? [] : due.slice(0, opts.limit);
  const gaps = due.filter((s) => !s.usdbGenre).length;
  log(
    `${withTrack.length} songs with a Deezer track: ${withTrack.length - due.length} done, ${due.length} due (${gaps} with no USDB genre, looked up first); ` +
      (opts.dryRun ? 'dry run, nothing fetched or written' : `looking up ${todo.length}`),
  );
  if (opts.dryRun && due.length) {
    const most = Math.min(due.length, opts.limit ?? Infinity) * 2;
    log(`That is at most ${most} requests (each track, and each album once), at most ${Math.ceil(most / REQUESTS_PER_SECOND / 60)} minutes at ${REQUESTS_PER_SECOND} a second.`);
  }

  // Each album is read once: the first song on it starts the read, and the others wait for it. Albums whose genres an
  // earlier run found are known already, so a song on one needs only its track looked up.
  const albums = new Map<number, Promise<string[] | null>>();
  for (const g of done.values()) {
    const genres = nonBlank(g.genres);
    if (g.albumId !== undefined && genres) albums.set(g.albumId, Promise.resolve(genres.split(', ')));
  }
  let albumsRead = 0;
  const genresOf = (albumId: number) => {
    let read = albums.get(albumId);
    if (!read) {
      albumsRead++;
      read = client.albumGenres(albumId);
      albums.set(albumId, read);
      // A failed read is not kept: the next song on the album asks again.
      read.catch(() => {
        if (albums.get(albumId) === read) albums.delete(albumId);
      });
    }
    return read;
  };
  const lookUp = async (song: GenreSong): Promise<SongGenreRecord> => {
    const albumId = await client.trackAlbum(song.deezerId);
    const names = albumId === null ? null : await genresOf(albumId);
    const record: SongGenreRecord = { key: song.key, source: GENRE_SOURCE, checkedAt: now().toISOString() };
    if (albumId !== null) record.albumId = albumId;
    if (names?.length) record.genres = names.join(', ');
    return record;
  };

  const pending: SongGenreRecord[] = [];
  const counts = { hits: 0, misses: 0, errors: 0 };
  let next = 0;
  let inARow = 0;
  const flush = async () => {
    const batch = pending.splice(0);
    if (batch.length) await store.putSongGenre(batch);
  };
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < todo.length && Date.now() < deadline && inARow < STOP_AFTER_ERRORS) {
        const song = todo[next++]!;
        try {
          const record = await lookUp(song);
          if (record.genres) counts.hits++;
          else counts.misses++;
          pending.push(record);
          inARow = 0;
        } catch (err) {
          counts.errors++; // not recorded, so the next run tries again
          inARow++;
          log(`${song.key}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (pending.length >= BATCH) await flush();
        const n = counts.hits + counts.misses + counts.errors;
        if (n % 500 === 0) log(`${n}/${todo.length}: ${counts.hits} with genres, ${counts.misses} misses, ${counts.errors} errors, ${albumsRead} albums read`);
      }
    }),
  );
  await flush();
  if (!opts.dryRun) {
    const left = todo.length - (counts.hits + counts.misses + counts.errors);
    log(
      `Done: ${counts.hits} with genres, ${counts.misses} misses, ${counts.errors} errors, ${albumsRead} albums read` +
        `${inARow >= STOP_AFTER_ERRORS ? `; stopped after ${inARow} failures in a row` : ''}${left > 0 ? `; ${left} left, run again to carry on` : ''}`,
    );
  }
  return { songs: withTrack.length, due, todo: todo.length, ...counts, albumsRead };
}
