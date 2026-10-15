// Coverage report for one person's library: every song, whether we have its range (note file,
// artist estimate or nothing), whether it fits their voice, where the app ranks it, and for songs
// without a note file, why (not on USDB, or on USDB under a slightly different name).

import { midiToNoteName } from '../audio/notes';
import type { Match, SongRange, Track, VocalRange } from '../contracts';
import type { UsdbIndexEntry } from '../server/store';
import { matchSong } from '../songs/match';
import { rankMatches } from '../songs/rank';
import { songKey } from '../songs/resolve';
import { scoreMatch } from '../songs/score';
import { usdbSongUrl } from '../usdb/client';

export type CoverageStatus = 'note file' | 'artist estimate' | 'none';

export interface CoverageRow {
  /** Order by how much you play it (1 = most). */
  playOrder: number;
  title: string;
  artist: string;
  status: CoverageStatus;
  songRange: string;
  /** "fits", "fits an octave up/down", or why not. */
  fit: string;
  /** Position in the app's results, when shown. */
  appRank: number | null;
  score: number | null;
  reasons: string;
  /** For songs without a note file: why we have none. */
  why: string;
  usdbMatch: string;
  usdbLink: string;
}

export interface CoverageSummary {
  songs: number;
  noteFile: number;
  artistEstimate: number;
  none: number;
  shown: number;
  /** Songs without a note file that USDB seems to have under a slightly different name. */
  nameMismatches: number;
}

/** First listed artist, without "The", with "&" as "and", letters and digits only. */
function looseArtist(artistPart: string): string {
  const first = artistPart.split(/\s*(?:,|;|\s+x\s+|\s+&\s+|\s+and\s+|\s+with\s+|\s+vs\.?\s+)\s*/)[0] ?? artistPart;
  return first.replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
}

function looseTitle(titlePart: string): string {
  return titlePart.replace(/&/g, ' and ').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
}

/** A looser song key than songKey: ignores "The", "&" vs "and", punctuation, spacing and co-artists. */
export function looseKey(artist: string, title: string): string {
  const [a, t] = songKey(artist, title).split('|') as [string, string];
  return `${looseArtist(a.replace(/&/g, ' & '))}|${looseTitle(t)}`;
}

const fitLabel = (octave: Match['octave']) =>
  octave === 'none' ? 'fits' : octave === 'up' ? 'fits an octave up' : 'fits an octave down';

function whyNotFit(user: VocalRange, range: SongRange): string {
  if (range.high - range.low > user.high - user.low) return 'wider than your range';
  if (range.high > user.high) return 'too high, even an octave down';
  return 'too low, even an octave up';
}

export function coverageReport({
  tracks,
  ranges,
  index,
  userRange,
}: {
  tracks: Track[];
  /** Range per song key (null = none), as the app would use it. */
  ranges: Map<string, SongRange | null>;
  index: UsdbIndexEntry[];
  userRange: VocalRange;
}): { rows: CoverageRow[]; summary: CoverageSummary } {
  const byKey = new Map<string, UsdbIndexEntry>();
  const byLoose = new Map<string, UsdbIndexEntry>();
  const songsByArtist = new Map<string, number>();
  for (const e of index) {
    if (!byKey.has(e.key)) byKey.set(e.key, e);
    const loose = looseKey(e.artist, e.title);
    if (!byLoose.has(loose)) byLoose.set(loose, e);
    const artist = loose.split('|')[0]!;
    songsByArtist.set(artist, (songsByArtist.get(artist) ?? 0) + 1);
  }

  const ordered = [...tracks].sort((a, b) => a.playRank - b.playRank);
  const matches: Match[] = [];
  for (const track of ordered) {
    const range = ranges.get(songKey(track.artist, track.title));
    const fit = range ? matchSong(userRange, range) : null;
    if (range && fit) matches.push(scoreMatch(userRange, { track, range, ...fit }));
  }
  const ranked = rankMatches(matches);
  const appRank = new Map(ranked.map((m, i) => [m.track.id, i + 1]));
  const matchById = new Map(ranked.map((m) => [m.track.id, m]));

  const summary: CoverageSummary = { songs: ordered.length, noteFile: 0, artistEstimate: 0, none: 0, shown: ranked.length, nameMismatches: 0 };
  const rows = ordered.map((track, i): CoverageRow => {
    const key = songKey(track.artist, track.title);
    const range = ranges.get(key) ?? null;
    const status: CoverageStatus = !range ? 'none' : range.source === 'note-file' ? 'note file' : 'artist estimate';
    if (status === 'note file') summary.noteFile++;
    else if (status === 'artist estimate') summary.artistEstimate++;
    else summary.none++;

    const m = matchById.get(track.id);
    let why = '';
    let candidate: UsdbIndexEntry | undefined;
    if (status !== 'note file') {
      candidate = byKey.get(key) ?? byLoose.get(looseKey(track.artist, track.title));
      const artistSongs = songsByArtist.get(looseKey(track.artist, '').split('|')[0]!) ?? 0;
      if (candidate) {
        why = 'On USDB under a slightly different name';
        summary.nameMismatches++;
      } else if (artistSongs > 0) {
        why = `Not on USDB (USDB has ${artistSongs} other song${artistSongs === 1 ? '' : 's'} by this artist)`;
      } else {
        why = 'Artist not on USDB';
      }
    }
    const usdbId = candidate?.id ?? range?.usdbId;

    return {
      playOrder: i + 1,
      title: track.title,
      artist: track.artist,
      status,
      songRange: range ? `${midiToNoteName(range.low)}–${midiToNoteName(range.high)}` : '',
      fit: !range ? '' : m ? fitLabel(m.octave) : whyNotFit(userRange, range),
      appRank: appRank.get(track.id) ?? null,
      score: m?.score !== undefined ? Math.round(m.score * 100) / 100 : null,
      reasons: m?.reasons?.join('; ') ?? '',
      why,
      usdbMatch: candidate ? `${candidate.artist} - ${candidate.title}` : '',
      usdbLink: usdbId !== undefined ? usdbSongUrl(usdbId) : '',
    };
  });
  return { rows, summary };
}

const HEADERS: [keyof CoverageRow, string][] = [
  ['playOrder', 'Play order'],
  ['title', 'Title'],
  ['artist', 'Artist'],
  ['status', 'Range from'],
  ['songRange', 'Song range'],
  ['fit', 'Fits you?'],
  ['appRank', 'Rank in app'],
  ['score', 'Score'],
  ['reasons', 'Reasons'],
  ['why', 'Why no note file'],
  ['usdbMatch', 'Possible USDB match'],
  ['usdbLink', 'USDB link'],
];

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function coverageCsv(rows: CoverageRow[]): string {
  return [HEADERS.map(([, h]) => h).join(','), ...rows.map((r) => HEADERS.map(([k]) => cell(r[k])).join(','))].join('\n') + '\n';
}
