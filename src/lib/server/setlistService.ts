// The Setlist tuner's answer (QWW-47): the catalogue's songs that fit the singer, plus a signed-in singer's own
// library songs, ranked by the engine (songs/setlist.ts) and cut to the page asked for. Nothing here ranks.

import type { DataSourceLogEntry, SetlistRequest, SetlistResponse } from '../contracts';
import type { LanguageWeights } from '../songs/score';
import { libraryCandidate, prepareSetlist, rankPrepared, type SetlistCandidate } from '../songs/setlist';
import { SETLIST_PAGE } from '../songs/setlistConfig';
import { catalogueKey, type CatalogueSetlist } from './catalogue';
import { compact, type LibraryMatches } from './songService';

/**
 * The catalogue's songs that fit plus the library's, one entry per song. A song in both is the library's: it carries
 * how much the singer plays it, and their own Spotify track. A catalogue song keeps what a language weight reads from it
 * (its signals); a library song has none, so no language weight ever moves it.
 */
export function withLibrary(
  base: CatalogueSetlist,
  library: LibraryMatches,
): { candidates: SetlistCandidate[]; logs: Map<string, DataSourceLogEntry> } {
  const bySong = new Map<string, SetlistCandidate>();
  for (const match of base.matches) bySong.set(catalogueKey(match.track.id) ?? match.track.id, { match, ...base.signals.get(match.track.id) });
  const logs = new Map(base.logs);
  for (const match of library.matches) {
    const key = library.keys.get(match.track.id) ?? match.track.id;
    const replaced = bySong.get(key);
    if (replaced) logs.delete(replaced.match.track.id);
    bySong.set(key, libraryCandidate(match));
    const log = library.logs.get(match.track.id);
    if (log) logs.set(match.track.id, log);
  }
  return { candidates: [...bySong.values()], logs };
}

/**
 * The response for a request: the catalogue's list, or with `library` (the singer is signed in and it was read) the
 * catalogue's songs and theirs, with the History gear counting. Songs on the page are stripped of their pitch
 * histograms, like every whole-list response. Duets and moods are applied afterwards (features.ts), so never to the order.
 * `languageWeights` replaces the engine's choice of language weights for this request (rankPrepared, QWW-59).
 */
export function setlistFor(base: CatalogueSetlist, library: LibraryMatches | null, req: SetlistRequest, languageWeights?: LanguageWeights): SetlistResponse {
  let prepared = base.prepared;
  let logs = base.logs;
  if (library) {
    const merged = withLibrary(base, library);
    prepared = prepareSetlist(merged.candidates, req.range);
    logs = merged.logs;
  }
  // Left to the engine, German, Polish and French songs that rank on USDB views alone are lowered when no library was
  // read (QWW-59: score.ts LANGUAGE_POPULARITY_WEIGHTS), and nothing is when one was.
  const state = { gears: req.gears, off: req.off, eras: req.eras, loggedIn: library !== null };
  const ranked = rankPrepared(prepared, languageWeights ? { ...state, languageWeights } : state);

  const offset = req.offset ?? 0;
  const limit = req.limit ?? SETLIST_PAGE.default;
  const songs = ranked.songs.slice(offset, offset + limit).map((s) => ({ ...s, match: compact(s.match) }));
  const end = offset + songs.length;
  const sources: Record<string, DataSourceLogEntry> = {};
  for (const { match } of songs) {
    const log = logs.get(match.track.id);
    if (log) sources[match.track.id] = log;
  }
  const body: SetlistResponse = {
    songs,
    total: ranked.songs.length,
    nextOffset: end < ranked.songs.length ? end : null,
    sources,
    applied: ranked.applied,
  };
  if (ranked.empty) body.empty = ranked.empty;
  return body;
}
