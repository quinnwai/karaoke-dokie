// PLACEHOLDER song logic so the backend runs before src/lib/songs lands.
// wiring.ts uses these; swap them for the real songKey / matchSong / rankMatches / paginate
// from src/lib/songs once that module is merged. Keep the signatures in SongDeps.
import type { Difficulty, Match, OctaveShift, SongRange, Track, VocalRange } from '../contracts';

/** Lowercased "artist|title" without punctuation, "feat." credits or "- Remastered" style suffixes. */
export function songKey(artist: string, title: string): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\s+-\s+.*(remaster|version|live|edit|mono|stereo).*$/i, '')
      .replace(/\((feat|with|ft)\.?[^)]*\)/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  return `${clean(artist)}|${clean(title)}`;
}

const SHIFTS: [OctaveShift, number][] = [
  ['none', 0],
  ['down', -12],
  ['up', 12],
];
const DIFFICULTY_ORDER: Difficulty[] = ['easy', 'medium', 'hard'];

/** Fits when the (possibly octave-shifted) song is inside the user's range, with 1 semitone of slack. */
export function matchSong(track: Track, range: SongRange, user: VocalRange): Match | null {
  for (const [octave, shift] of SHIFTS) {
    const low = range.low + shift;
    const high = range.high + shift;
    const margin = Math.min(low - user.low, user.high - high);
    if (margin < -1) continue;
    let level = margin >= 3 ? 0 : margin >= 0 ? 1 : 2;
    if (range.fastLyrics) level = Math.min(2, level + 1);
    return { track, range, difficulty: DIFFICULTY_ORDER[level]!, octave };
  }
  return null;
}

/** Easier first, then as written before octave shifts, then most played. */
export function rankMatches(matches: Match[]): Match[] {
  const octaveCost = (o: OctaveShift) => (o === 'none' ? 0 : 1);
  return [...matches].sort(
    (a, b) =>
      DIFFICULTY_ORDER.indexOf(a.difficulty) - DIFFICULTY_ORDER.indexOf(b.difficulty) ||
      octaveCost(a.octave) - octaveCost(b.octave) ||
      a.track.playRank - b.track.playRank,
  );
}

export function paginate<T>(items: T[], offset: number, limit: number): { items: T[]; nextOffset: number | null } {
  const page = items.slice(offset, offset + limit);
  return { items: page, nextOffset: offset + limit < items.length ? offset + limit : null };
}
