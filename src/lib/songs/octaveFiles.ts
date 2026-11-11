// Reads the two evidence files the octave fix uses and merges them (octave.ts withHandChecked). Node only:
// scripts and tests load the evidence here, so they cannot disagree about what "the evidence" is.

import { readFileSync } from 'node:fs';
import { withHandChecked, type OctaveEvidence, type OctaveHandChecked } from './octave';

export const EVIDENCE_FILE = 'data/octave-evidence.json';
export const HAND_CHECKED_FILE = 'data/octave-hand-checked.json';

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

/** The generated evidence with the hand-checked file merged in. Paths are relative to where the process runs. */
export function loadOctaveEvidence(paths: { evidence?: string; hand?: string } = {}): OctaveEvidence {
  return withHandChecked(readJson<OctaveEvidence>(paths.evidence ?? EVIDENCE_FILE), readJson<OctaveHandChecked>(paths.hand ?? HAND_CHECKED_FILE));
}
