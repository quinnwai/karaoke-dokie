// Tempos a person has checked by ear (data/tempo-gold.json), by song key. They are the felt tempo:
// the pulse where the snare lands on beats 2 and 4. They stand ahead of every measured source,
// because Deezer's bpm, the beat tracker and UltraStar's grid all get slow songs wrong by a factor of
// two now and then, and no rule can tell Hey Jude (74, Deezer says 148) from Take On Me (169, Deezer
// says 169) from the numbers alone.

import gold from '../../../data/tempo-gold.json';

const REVIEWED = new Map<string, number>((gold as { key: string; bpm: number }[]).map((g) => [g.key, g.bpm]));

/** The tempo checked by ear for the song with this key, in bpm as written, or undefined when nobody has checked it. */
export const reviewedBpm = (key: string): number | undefined => REVIEWED.get(key);
