// Puts shipped mood labels (QWW-11) on matches, for the mood chips. A label ships only when its
// mood passed the precision gate and is listed in MOODS_SHIPPED; until then no mood reaches
// the screen, whatever the labelling produced.

import type { Match, Mood } from '../contracts';
import { MOODS } from '../contracts';
import { songKey } from '../songs/resolve';
import type { Store } from './store';

/** MOODS_SHIPPED="upbeat,heartfelt" -> the moods allowed on screen. Unknown names are ignored. */
export function parseShippedMoods(value: string | undefined): Mood[] {
  const wanted = new Set((value ?? '').split(',').map((s) => s.trim().toLowerCase()));
  return MOODS.filter((m) => wanted.has(m));
}

/** The song key for a match: catalogue tracks carry it in their id ("cat:<key>"). */
export function matchKey(m: Match): string {
  return m.track.id.startsWith('cat:') ? m.track.id.slice(4) : songKey(m.track.artist, m.track.title);
}

/** Returns the matches with `moods` set from the store, keeping only shipped moods. One batched read. */
export async function attachMoods(matches: Match[], store: Pick<Store, 'getSongMoods'>, shipped: Mood[]): Promise<Match[]> {
  if (!shipped.length || !matches.length) return matches;
  const labels = await store.getSongMoods([...new Set(matches.map(matchKey))]);
  return matches.map((m) => {
    const moods = labels.get(matchKey(m))?.moods.filter((mood) => shipped.includes(mood));
    return moods?.length ? { ...m, moods } : m;
  });
}
