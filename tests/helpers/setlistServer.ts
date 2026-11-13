// POST /api/setlist for e2e specs that mock the API: the server's own ranking (src/lib/songs/setlist.ts) of a list of
// matches, paged as the server pages. `signedIn` is what the session would decide: the library counts, and History with it.

import type { RecommendationsResponse, SetlistRequest, SetlistResponse } from '../../src/lib/contracts';
import { libraryCandidate, rankSetlist } from '../../src/lib/songs/setlist';

export function setlistAnswer(page: RecommendationsResponse, req: SetlistRequest, signedIn: boolean, flags: Partial<SetlistResponse> = {}): SetlistResponse {
  const fits = page.matches.filter((m) => m.range.low <= req.range.high && m.range.high >= req.range.low);
  const ranked = rankSetlist(fits.map((match) => (signedIn ? libraryCandidate(match) : { match })), { ...req, loggedIn: signedIn });
  const offset = req.offset ?? 0;
  const songs = ranked.songs.slice(offset, offset + (req.limit ?? 100));
  const end = offset + songs.length;
  return {
    songs,
    total: ranked.songs.length,
    nextOffset: end < ranked.songs.length ? end : null,
    sources: page.sources ?? {},
    applied: ranked.applied,
    ...(ranked.empty ? { empty: ranked.empty } : {}),
    ...flags,
  };
}
