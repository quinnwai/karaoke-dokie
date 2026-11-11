// Eras: the labels (spec §2), and which era a release year belongs to.

import { decadeOf } from '../songs/browse';
import type { Decade } from '../contracts';
import type { EraId } from './types';

/** The apostrophe is U+2019. */
export const ERA_LABEL: Record<EraId, string> = {
  pre: 'Pre-’70s',
  s70: '’70s',
  s80: '’80s',
  s90: '’90s',
  s00: '’00s',
  s10: '’10s',
  s20: '’20s',
};

const ERA_OF_DECADE: Record<Decade, EraId> = { '60s': 'pre', '70s': 's70', '80s': 's80', '90s': 's90', '00s': 's00', '10s': 's10', '20s': 's20' };

/** "1 song", "1,204 songs": a count of songs, with a thousands comma. */
export function songCountText(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'song' : 'songs'}`;
}

/**
 * What the Era panel's header says after "ERA" (Round 6A §8): how many songs fit the range and the picked eras while Era
 * is on, and "OFF · all eras" while it is off. `total` is `SetlistResponse.total`, every song that fits, not just the
 * page on screen; null until the engine has answered once, when there is nothing to say yet.
 */
export function eraCountText(total: number | null, off: boolean): string {
  if (off) return '· OFF · all eras';
  return total === null ? '' : `· ${songCountText(total)}`;
}

/** The era of a release year, or null for a song with no year. */
export function eraOf(year: number | undefined): EraId | null {
  const decade = decadeOf(year);
  return decade ? ERA_OF_DECADE[decade] : null;
}
