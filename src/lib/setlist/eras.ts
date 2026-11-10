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

/** The era of a release year, or null for a song with no year. */
export function eraOf(year: number | undefined): EraId | null {
  const decade = decadeOf(year);
  return decade ? ERA_OF_DECADE[decade] : null;
}
