// What a list row shows (Round 6A §4): the title over "Artist · Era", a reason line, and a difficulty badge. Presentation
// only: the order, the era and every place on every gear come from the engine, in the SetlistSong it returns.
//
// The reason line is README §4's `whyOf`, run on real data. The engine's places are percentiles among the songs that fit
// the singer, 0 to 100, so the rules read them as they are written. A place that is null (we do not know it, or the song is
// not in the singer's library) skips its rule, which is why a signed-out singer never sees "On repeat" or "Rediscover". A song
// that fits only an octave up or down says "Shifted up/down to fit range" and nothing else (R13).

import { difficultyLabel } from '../client/display';
import type { Match } from '../contracts';
import { ERA_LABEL } from './eras';
import type { EraId, SetlistSong, TunerState } from './types';

/** The word in the badge at the end of a row. */
export type RowBadge = 'Easy' | 'Medium' | 'Hard';

export interface SetlistRow {
  /** The track id; the list keys rows by it so a song keeps its row while it moves. */
  id: string;
  match: Match;
  title: string;
  artist: string;
  era: EraId | null;
  /** "Artist · ’90s", or just the artist for a song with no known year. */
  sub: string;
  /** The reason line under the sub-line: up to two reasons joined by " · ". Never empty. */
  why: string;
  /**
   * The badge at the end of the row: the song's own label, the word the song page shows. null for a Maybe song, whose
   * range is only an estimate, so no difficulty is shown anywhere. It is the label and not the song's place on the
   * Difficulty gear: Medium places start at 33.3, so a cut at 34 would call some Medium songs Easy.
   */
  badge: RowBadge | null;
  /**
   * What a screen reader says for the row's button: "title by artist, era, difficulty". The difficulty is in it because the
   * badge is the same word (the old lane was a picture). The reason line is the button's description (aria-describedby), so
   * it is read after the name, and the name still ends with the song's label, which the other specs and tools read.
   */
  label: string;
}

/** The part of the tuner that the reason line reads: whether Difficulty counts, and where it is set. */
export type WhyTuner = Pick<TunerState, 'difficulty' | 'off'>;

/** How far the song's place on Difficulty may be from the slider and still be "in your sweet spot". */
export const SWEET_SPOT = 15;

/**
 * What the reason line says of a song that fits the singer's range only an octave away from the artist's (QWW-57, R13, from
 * QWW-58; Quinn-Wai chose the words, 11 Nov). `up` is a song that fits if sung an octave higher, `down` one an octave lower.
 */
export const SHIFT_REASON = { up: 'Shifted up to fit range', down: 'Shifted down to fit range' } as const;

/**
 * The reason line of a song (README §4): the first two reasons that hold, in this order, joined by " · ". A song that fits
 * only an octave away says so and nothing else (R13): it fits after the shift, so it claims no sweet spot, and the line is that
 * one reason, which fits a phone's row whole where a second reason was cut off. Its badge stays.
 */
export function whyOf(song: SetlistSong, tuner: WhyTuner): string {
  const { difficulty, popularity, history, tempo } = song.gears;
  const { octave } = song.match;
  if (octave !== 'none') return SHIFT_REASON[octave];
  const reasons: string[] = [];
  // 1. Difficulty counts, and the song sits near where it is set.
  if (!tuner.off.includes('difficulty') && difficulty !== null && Math.abs(difficulty - tuner.difficulty) <= SWEET_SPOT) reasons.push('In your sweet spot');
  // 2. Among the best known songs, or the least known.
  if (popularity !== null) {
    if (popularity >= 85) reasons.push('Crowd favourite');
    else if (popularity <= 35) reasons.push('Deep cut');
  }
  // 3. In the singer's top and liked songs, or the least played.
  if (history !== null) {
    if (history >= 85) reasons.push('On repeat');
    else if (history <= 20) reasons.push('Rediscover');
  }
  // 4. Nothing else to say: what it sounds like. A song with no tempo is a solid pick.
  if (reasons.length === 0) reasons.push(tempo !== null && tempo >= 70 ? 'Gets the room moving' : tempo !== null && tempo <= 25 ? 'Slow burner' : 'Solid pick');
  return reasons.slice(0, 2).join(' · ');
}

/** The badge of a song: its own label (Easy, Medium, Hard), or null for a Maybe song. */
export function badgeOf(match: Pick<Match, 'difficulty'>): RowBadge | null {
  const label = match.difficulty;
  return label === 'maybe' ? null : (difficultyLabel(label) as RowBadge);
}

export function toRow(song: SetlistSong, tuner: WhyTuner): SetlistRow {
  const { match } = song;
  const eraLabel = song.era ? ERA_LABEL[song.era] : null;
  const why = whyOf(song, tuner);
  return {
    id: match.track.id,
    match,
    title: match.track.title,
    artist: match.track.artist,
    era: song.era,
    sub: eraLabel ? `${match.track.artist} · ${eraLabel}` : match.track.artist,
    why,
    badge: badgeOf(match),
    label: `${match.track.title} by ${match.track.artist}${eraLabel ? `, ${eraLabel}` : ''}, ${difficultyLabel(match.difficulty)}`,
  };
}

export const toRows = (songs: SetlistSong[], tuner: WhyTuner): SetlistRow[] => songs.map((s) => toRow(s, tuner));
