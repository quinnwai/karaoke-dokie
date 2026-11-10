// Flags a sung range that is probably not the user's real singing range: a growl, vocal fry or
// whistle can land far past where songs go, and a range that is too wide makes every song look
// easy and mislabels difficulty. Pop songs stay roughly within E2..C6.

import { midiToNoteName } from '../audio/notes';
import type { VocalRange } from '../contracts';

/** E2: lower than almost any pop melody. */
export const LOWEST_LIKELY = 40;
/** C6: higher than almost any pop melody. */
export const HIGHEST_LIKELY = 84;
/** Two and a half octaves. */
export const WIDEST_LIKELY = 30;

export interface RangeWarning {
  /** The end most likely to be wrong, or null when only the width is unusual. */
  end: 'low' | 'high' | null;
  message: string;
}

export function rangeWarning(range: VocalRange): RangeWarning | null {
  const low = midiToNoteName(range.low);
  const high = midiToNoteName(range.high);
  if (range.low < LOWEST_LIKELY) {
    return { end: 'low', message: `${low} is lower than almost any pop song goes. Was that a growl or vocal fry?` };
  }
  if (range.high > HIGHEST_LIKELY) {
    return { end: 'high', message: `${high} is higher than almost any pop song goes. Was that a whistle or a squeak?` };
  }
  if (range.high - range.low > WIDEST_LIKELY) {
    return { end: null, message: `${low} to ${high} is wider than two and a half octaves, which is rare. If one end was a stretch, sing it again.` };
  }
  return null;
}
