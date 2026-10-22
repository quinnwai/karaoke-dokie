// Works out a range for one Spotify track, trying the best source first:
//   1. an UltraStar note file for the song itself (high confidence),
//   2. the typical range of the artist's other songs that have note files or measured recordings,
//   3. the artist's published career range, narrowed to its middle half,
//   4. otherwise the song is skipped (never shown).
// Every result comes with a plain-English log line for the info button and
// the admin page. Lookups are injected so this module stays pure and testable;
// errors thrown by a lookup propagate to the caller. A note file that fails
// to parse counts as missing.
//
// songKey normalises "artist|title" so Spotify names ("Song - Remastered
// 2011", "Song (feat. X)") line up with note-file names ("Song").

import type { DataSourceLogEntry, SongRange, Track } from '../contracts';
import { artistTypicalRange, measuredSongs, narrowExternalArtistRange } from './artistFallback';
import { songRangeFromUltrastar } from './range';

export interface ResolveDeps {
  /** Raw UltraStar text for a song, or null. Called with the Spotify artist and title as-is. */
  getNoteFile(artist: string, title: string): Promise<string | null>;
  /** Ranges of the artist's other songs (the one titled excludeTitle left out). */
  getArtistSongRanges(artist: string, excludeTitle: string): Promise<SongRange[]>;
  /** A published career-wide range for the artist, in MIDI, or null. */
  getExternalArtistRange(artist: string): Promise<{ low: number; high: number } | null>;
  /** Clock for the log timestamp; defaults to the current time. */
  now?: () => Date;
}

export interface ResolvedRange {
  range: SongRange | null;
  log: DataSourceLogEntry;
}

export async function resolveSongRange(track: Track, deps: ResolveDeps): Promise<ResolvedRange> {
  const { artist, title } = track;
  const done = (range: SongRange | null, reason: string): ResolvedRange => ({
    range,
    log: {
      trackId: track.id,
      title,
      artist,
      outcome: range ? range.source : 'skipped',
      reason,
      at: (deps.now?.() ?? new Date()).toISOString(),
    },
  });

  let noNoteFile = 'No note file found';
  const text = await deps.getNoteFile(artist, title);
  if (text !== null) {
    try {
      return done(songRangeFromUltrastar(text), 'Used the UltraStar note file for this song.');
    } catch {
      noNoteFile = 'The note file could not be read';
    }
  }

  const others = measuredSongs(await deps.getArtistSongRanges(artist, title));
  const typical = artistTypicalRange(others);
  if (typical) {
    const songs = others.length === 1 ? 'song' : 'songs';
    return done(typical, `${noNoteFile}; used the typical range of ${others.length} other ${songs} by ${artist}.`);
  }

  const external = await deps.getExternalArtistRange(artist);
  if (external) {
    return done(
      narrowExternalArtistRange(external.low, external.high),
      `${noNoteFile} and no other songs by ${artist} have one; used ${artist}'s published vocal range, narrowed to its middle half.`,
    );
  }

  return done(
    null,
    `${noNoteFile}, no other songs by ${artist} have one, and no published vocal range for ${artist}; skipped.`,
  );
}

function normalizePart(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // combining accents
    .toLowerCase()
    .replace(/\s+-\s.*$/, '') // " - Remastered 2011", " - Live"
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ') // "(Live Aid)", "[2011 Mix]", "(feat. X)"
    .replace(/(^|\s)(feat\.|ft\.|featuring)\s.*$/, '') // "feat. X" without brackets
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lookup key "artist|title", tolerant of remaster tags, featured artists, accents and case. */
export function songKey(artist: string, title: string): string {
  return `${normalizePart(artist)}|${normalizePart(title)}`;
}

const LITTLE_SINGING = /\b(instrumental|karaoke|backing track|dub|beat only|no vocals?)\b/i;

/**
 * True for versions with little or no singing, named in the title's version tag:
 * "Back To Life - Satta Dub", "Song (Instrumental)", "Song [Karaoke Version]". These share the
 * original's songKey, so without this check they would inherit its range. Remixes, live and
 * acoustic versions keep the vocal and still match.
 */
export function hasLittleSinging(title: string): boolean {
  const tags = [...title.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].map((m) => m[1] ?? m[2] ?? '');
  const dash = title.match(/\s+-\s(.*)$/);
  if (dash) tags.push(dash[1]!);
  return tags.some((t) => LITTLE_SINGING.test(t));
}
