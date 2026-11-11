// Tempos checked against a published source (data/tempo-gold.json), by song key: the tempo mark of the sheet music for
// the song, which is the felt tempo, the pulse where the snare lands on beats 2 and 4 (QWW-54 replaced values written from
// memory with these; each entry names its source and page). They stand ahead of every measured source, because Deezer's
// bpm, the beat tracker and UltraStar's grid all get slow songs wrong by a factor of two now and then, and no rule can
// tell Hey Jude (74, Deezer says 148) from Take On Me (169, Deezer says 169) from the numbers alone.

import gold from '../../../data/tempo-gold.json';

const REVIEWED = new Map<string, number>((gold as { key: string; bpm: number }[]).map((g) => [g.key, g.bpm]));

/** The published tempo for the song with this key, in bpm as written, or undefined when none was found. */
export const reviewedBpm = (key: string): number | undefined => REVIEWED.get(key);
