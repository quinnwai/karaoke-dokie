// What a list row shows (spec §5): rank, title over "Artist · Era", and the song's mini difficulty lane. Presentation
// only: the order, the era and the lane's difficulty all come from the engine.

import { difficultyLabel } from '../client/display';
import type { Match } from '../contracts';
import { rowLane, type RowLane } from './art';
import { ERA_LABEL } from './eras';
import type { EraId, SetlistSong } from './types';

export interface SetlistRow {
  /** The track id; the list keys rows by it so a song keeps its row while it moves. */
  id: string;
  match: Match;
  title: string;
  artist: string;
  era: EraId | null;
  /** "Artist · ’90s", or just the artist for a song with no known year. */
  sub: string;
  /** The lane at the end of the row, from the song's place on the Difficulty gear. null draws no lane: the range is not trusted. */
  lane: RowLane | null;
  /** What a screen reader says for the row's button: the lane is a picture, so the label says it. */
  label: string;
}

export function toRow(song: SetlistSong): SetlistRow {
  const { match } = song;
  const eraLabel = song.era ? ERA_LABEL[song.era] : null;
  const difficulty = song.gears.difficulty;
  return {
    id: match.track.id,
    match,
    title: match.track.title,
    artist: match.track.artist,
    era: song.era,
    sub: eraLabel ? `${match.track.artist} · ${eraLabel}` : match.track.artist,
    lane: difficulty === null ? null : rowLane(difficulty),
    label: `${match.track.title} by ${match.track.artist}${eraLabel ? `, ${eraLabel}` : ''}, ${difficultyLabel(match.difficulty)}`,
  };
}

export const toRows = (songs: SetlistSong[]): SetlistRow[] => songs.map(toRow);
