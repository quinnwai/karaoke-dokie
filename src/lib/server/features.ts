// Duets and moods are hidden for the first tester release (QWW-43) behind one switch,
// DUETS_AND_MOODS=on (config.ts). This is the only place the switch is applied, and it is applied to
// a response after the songs are ranked, so it cannot change which songs come back or in what order.
//
// Hidden means the response says nothing about them: no mood labels, and none of the duet markers
// (the duet flag, the singers' parts, which part to take). Every duet and mood control on the screen
// is built from those fields (the Duets and mood chips, the "Duet: take ..." line on a row and on
// the song page, the mood pills on the song page), so they go together, and a new control built
// from the same fields would be hidden too.
//
// Nothing is deleted. The screen code for the chips stays, and so does the part matching in
// match.ts: a duet is still scored and ranked on the part that fits the singer, only the words
// about it are gone. That matching runs before this file, which is why the flag cannot change the
// ranking for anyone.

import type { Match, Mood } from '../contracts';
import { attachMoods } from './moods';
import type { Store } from './store';

/**
 * The match without its mood labels or any duet marker. A new object: the matches of a catalogue
 * response are shared with the catalogue's cache, so nothing here may change the input.
 */
export function withoutDuetsAndMoods(m: Match): Match {
  const { part: _part, partSinger: _partSinger, moods: _moods, ...rest } = m;
  const { duet: _duet, parts: _parts, ...range } = m.range;
  return { ...rest, range };
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
