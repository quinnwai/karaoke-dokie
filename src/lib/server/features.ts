// Duets and moods are hidden for the first tester release (QWW-43) behind one switch,
// DUETS_AND_MOODS=on (config.ts). This is the only place the switch is applied, and it is applied to
// a response after the songs are ranked, so it cannot change which songs come back or in what order.
//
// Hidden means the response says nothing about them: no mood labels, and none of the duet markers
// (the duet flag, the singers' parts, which part to take). Every duet and mood control on the screen
// is built from those fields (the Duets and mood chips, the "Duet: take ..." line on a row and on
// the song page, the mood pills on the song page), so they go together.
//
// The fields are listed by name. A field added to Match or SongRange later that says anything about
// duets or moods has to be added here too, and to the lists in tests/server/routes.test.ts.
//
// Nothing is deleted. The screen code for the chips stays, and so does the part matching in
// match.ts: a duet is still scored and ranked on the part that fits the singer, only the words
// about it are gone. That matching runs before this file, which is why the flag cannot change the
// ranking for anyone.

import type { KnownSongsResponse, Match, Mood, SongRange } from '../contracts';
import { attachMoods } from './moods';
import type { Store } from './store';

/** The range without the duet flag and the singers' parts. A new object. */
export function withoutDuetRange(range: SongRange): SongRange {
  const { duet: _duet, parts: _parts, ...rest } = range;
  return rest;
}

/**
 * The match without its mood labels or any duet marker. A new object: nothing here may change the
 * input, because a match can be shared with a cache.
 */
export function withoutDuetsAndMoods(m: Match): Match {
  const { part: _part, partSinger: _partSinger, moods: _moods, ...rest } = m;
  return { ...rest, range: withoutDuetRange(m.range) };
}

/**
 * What the screen may know about duets and moods. Off: none of it, and no read of the mood labels.
 * On: the moods MOODS_SHIPPED lists (QWW-11), and the duet markers as they are.
 */
export async function applyDuetsAndMoods(
  matches: Match[],
  store: Pick<Store, 'getSongMoods'>,
  config: { duetsAndMoods: boolean; moodsShipped: Mood[] },
): Promise<Match[]> {
  if (!config.duetsAndMoods) return matches.map(withoutDuetsAndMoods);
  return attachMoods(matches, store, config.moodsShipped);
}

/** The "pick songs you sing well" list (GET /api/songs/known) carries each song's range, duet parts included. */
export function applyDuetsToKnownSongs(body: KnownSongsResponse, config: { duetsAndMoods: boolean }): KnownSongsResponse {
  if (config.duetsAndMoods) return body;
  return { ...body, songs: body.songs.map((s) => ({ ...s, range: withoutDuetRange(s.range) })) };
}
