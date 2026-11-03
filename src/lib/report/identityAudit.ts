// Identity audit for one person's library: how their Spotify listings group into songs
// (src/lib/songs/identity.ts) and what looks doubtful, so the rules can be checked against real
// data before the app uses them. Pure: scripts/identity-audit.ts reads the library and the database.
// The summary holds counts and a few example titles, no ISRCs or track ids; the CSV holds both and
// stays on the machine that made it.

import type { Track } from '../contracts';
import type { SongRangeRecord, UsdbIndexEntry } from '../server/store';
import {
  groupListings,
  listingProfile,
  MIN_SONG_S,
  parseTitle,
  SAME_RECORDING_S,
  SAME_SONG_S,
  sameArtists,
  titleKey,
  type MergeBasis,
  type Profile,
  type Song,
} from '../songs/identity';
import { songKey } from '../songs/resolve';

export interface AuditInput {
  /** The library as the app reads it from Spotify (getUserTracks). */
  tracks: Track[];
  /** The library's lists as Spotify returned them, before they were merged: what each endpoint sends. */
  sources?: { name: string; tracks: Track[] }[];
  /** Stored range per song key (song_ranges). Leave out when there is no database. */
  ranges?: Map<string, SongRangeRecord>;
  /** The USDB song index (usdb_songs). Leave out when there is no database. */
  usdbIndex?: UsdbIndexEntry[];
}

export interface AuditList {
  id: string;
  title: string;
  /** null: not checked, there was no database to check against. */
  total: number | null;
  /** Up to EXAMPLES, as titles, artists and lengths. */
  examples: string[];
}

export interface AuditRow {
  song: number | '';
  role: string;
  basis: string;
  lengthGapS: number | '';
  title: string;
  artists: string;
  length: string;
  isrc: string;
  trackId: string;
  playRank: number;
  lookupKey: string;
  versionTags: string;
  flags: string;
}

/** What one list of the library carries: Spotify sends ISRC, length and credited artists with every track. */
export interface SourceStats {
  name: string;
  listings: number;
  isrc: number;
  length: number;
  severalArtists: number;
}

export interface AuditSummary {
  listings: number;
  sources: SourceStats[];
  /** Listings that came with each detail. */
  with: { isrc: number; length: number; severalArtists: number; popularity: number };
  dropped: { littleSinging: number; snippets: number };
  songs: number;
  songsWithSeveralListings: number;
  largestSong: number;
  /** Listings that joined a song, by how. */
  mergedBy: Record<MergeBasis, number>;
  /** Songs by the tags in the title of the listing played most. */
  songsByWords: { plain: number; packagingOnly: number; unlistedOnly: number; differentVersion: number };
  /** What the database held for this library; null when it was not read. */
  database: { lookupKeys: number; withStoredRange: number; usdbEntries: number } | null;
}

export interface Audit {
  summary: AuditSummary;
  lists: AuditList[];
  /** Most common tag texts across the library: the candidates for the word lists. */
  topTags: { version: [string, number][]; unlisted: [string, number][]; labels: [string, number][] };
  rows: AuditRow[];
}

const EXAMPLES = 8;

function mmss(durationMs: number | undefined): string {
  if (durationMs === undefined) return '-';
  const total = Math.round(durationMs / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
const credited = (t: Track) => (t.artists?.length ? t.artists.map((a) => a.name) : [t.artist]).join(' & ');
const label = (t: Track) => `"${t.title}" by ${credited(t)} (${mmss(t.durationMs)})`;
const hasVersionTag = (title: string) => parseTitle(title).tags.some((t) => t.kind === 'version');
const lookupKeys = (song: Song) => [...new Set(song.members.map((m) => songKey(m.track.artist, m.track.title)))];
const gap = (s: number) => Math.round(s * 10) / 10;

function tally(texts: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const t of texts) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 20);
}

export function identityAudit({ tracks, sources = [], ranges, usdbIndex }: AuditInput): Audit {
  const { songs, dropped } = groupListings(tracks);
  const flagged = new Map<string, Set<string>>(); // track id -> list ids
  const flag = (track: Track, id: string) => (flagged.get(track.id) ?? flagged.set(track.id, new Set()).get(track.id)!).add(id);
  const lists: AuditList[] = [];
  const list = (id: string, title: string, items: { text: string; tracks: Track[] }[]) => {
    for (const item of items) for (const t of item.tracks) flag(t, id);
    lists.push({ id, title, total: items.length, examples: items.slice(0, EXAMPLES).map((i) => i.text) });
  };
  const notChecked = (id: string, title: string) => lists.push({ id, title, total: null, examples: [] });

  // ---- merges to eyeball ----
  const members = songs.flatMap((s) => s.members.filter((m) => m.basis !== 'anchor').map((m) => ({ song: s, member: m })));
  const merged = (basis: MergeBasis[], keep: (lengthGapS: number) => boolean = () => true) =>
    members
      .filter(({ member: m }) => basis.includes(m.basis as MergeBasis) && keep(m.lengthGapS ?? 0))
      .map(({ song: s, member: m }) => ({
        text: `${label(m.track)} joined ${label(s.anchor)}, ${gap(m.lengthGapS ?? 0)} s apart (${m.basis})`,
        tracks: [m.track],
      }));
  list('soft-merge', 'Joined without ISRC (title, artists and length): the merges most likely to be wrong', merged(['names+length', 'edit', 'packaging']));
  list('isrc-far', `Joined by ISRC but more than ${SAME_SONG_S} s apart`, merged(['isrc'], (s) => s > SAME_SONG_S));
  list('packaging-far', `Joined only because a cut tag (radio edit, re-recording) explains a gap over ${SAME_SONG_S} s`, merged(['packaging'], (s) => s > SAME_SONG_S));
  list(
    'isrc-title',
    'Joined by ISRC although the title or the credited artists differ',
    members
      .filter(({ member: m }) => m.basis === 'isrc')
      .filter(({ song: s, member: m }) => {
        const [a, b] = [listingProfile(s.anchor), listingProfile(m.track)];
        return a.base !== b.base || !sameArtists(a, b);
      })
      .map(({ song: s, member: m }) => ({ text: `${label(m.track)} joined ${label(s.anchor)}`, tracks: [m.track] })),
  );

  // ---- songs that look alike but were kept apart ----
  const profiles = songs.map((s) => listingProfile(s.anchor));
  const byTitle = new Map<string, number[]>();
  profiles.forEach((p, i) => byTitle.set(titleKey(p), [...(byTitle.get(titleKey(p)) ?? []), i]));
  const nearMisses: { text: string; tracks: Track[] }[] = [];
  for (const group of byTitle.values()) {
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        const pa: Profile = profiles[group[a]!]!;
        const pb: Profile = profiles[group[b]!]!;
        if (pa.ms === undefined || pb.ms === undefined || !sameArtists(pa, pb)) continue;
        const [x, y] = [songs[group[a]!]!.anchor, songs[group[b]!]!.anchor];
        nearMisses.push({ text: `${label(x)} and ${label(y)}, ${gap(Math.abs(pa.ms - pb.ms) / 1000)} s apart`, tracks: [x, y] });
      }
    }
  }
  list('near-miss', `Same title and artists but kept apart (over ${SAME_RECORDING_S} s apart, or an unlisted tag differs)`, nearMisses);

  // ---- left out ----
  const snippets = dropped.filter((d) => d.reason === 'snippet');
  const quiet = dropped.filter((d) => d.reason === 'little-singing');
  list('snippet', `Under ${MIN_SONG_S} s, left out as snippets`, snippets.map((d) => ({ text: label(d.track), tracks: [d.track] })));
  list('little-singing', 'Instrumental, karaoke or dub versions, left out', quiet.map((d) => ({ text: label(d.track), tracks: [d.track] })));

  // ---- possible untagged remixes and collaborations ----
  list(
    'collab',
    'Two or more credited artists, no "feat." and no version tag (a collaboration, or an untagged remix)',
    songs
      .filter((_s, i) => profiles[i]!.versions.length === 0 && profiles[i]!.mentions.length === 0 && profiles[i]!.credited.length >= 2)
      .map((s) => ({ text: label(s.anchor), tracks: [s.anchor] })),
  );

  // ---- the range lookup key, which stays as it is ----
  const keyOwners = new Map<string, Song[]>();
  for (const s of songs) for (const k of lookupKeys(s)) keyOwners.set(k, [...(keyOwners.get(k) ?? []), s]);
  list(
    'shared-key',
    'One lookup key shared by several songs (they read the same stored range)',
    [...keyOwners]
      .filter(([, owners]) => owners.length > 1)
      .map(([k, owners]) => ({ text: `${k}: ${owners.map((s) => `"${s.anchor.title}"`).join(', ')}`, tracks: owners.map((s) => s.anchor) })),
  );
  const VARIANT = 'Different-version songs that read a stored range today (they would show in Maybe, as an estimate)';
  const WRONG = 'A plain song whose stored range came from a duet, live or remix USDB entry although a plain entry exists';
  if (ranges && usdbIndex) {
    list(
      'variant-range',
      VARIANT,
      songs
        .filter((s) => s.versionTags.length > 0)
        .flatMap((s) => {
          const range = lookupKeys(s).map((k) => ranges.get(k)?.range).find((r) => r);
          return range ? [{ text: `${label(s.anchor)}: ${range.source}, ${range.confidence} confidence`, tracks: [s.anchor] }] : [];
        }),
    );
    const byId = new Map(usdbIndex.map((e) => [e.id, e]));
    const plainEntry = new Set(usdbIndex.filter((e) => !hasVersionTag(e.title)).map((e) => e.key));
    list(
      'wrong-entry',
      WRONG,
      songs
        .filter((s) => s.versionTags.length === 0)
        .flatMap((s) =>
          lookupKeys(s).flatMap((k) => {
            const entry = byId.get(ranges.get(k)?.range?.usdbId ?? -1);
            return entry && hasVersionTag(entry.title) && plainEntry.has(k) ? [{ text: `${label(s.anchor)}: range from USDB "${entry.title}"`, tracks: [s.anchor] }] : [];
          }),
        ),
    );
  } else {
    notChecked('variant-range', VARIANT);
    notChecked('wrong-entry', WRONG);
  }

  // ---- numbers ----
  const mergedBy: Record<MergeBasis, number> = { isrc: 0, 'names+length': 0, edit: 0, packaging: 0 };
  for (const { member } of members) mergedBy[member.basis as MergeBasis]++;
  const songsByWords = { plain: 0, packagingOnly: 0, unlistedOnly: 0, differentVersion: 0 };
  for (const s of songs) {
    const kinds = new Set(parseTitle(s.anchor.title).tags.map((t) => t.kind));
    if (s.versionTags.length) songsByWords.differentVersion++;
    else if (kinds.has('unlisted') || kinds.has('label')) songsByWords.unlistedOnly++;
    else if (kinds.size) songsByWords.packagingOnly++;
    else songsByWords.plain++;
  }
  const stats = (name: string, from: Track[]): SourceStats => ({
    name,
    listings: from.length,
    isrc: from.filter((t) => t.isrc).length,
    length: from.filter((t) => t.durationMs !== undefined).length,
    severalArtists: from.filter((t) => (t.artists?.length ?? 1) >= 2).length,
  });
  const keys = new Set(songs.flatMap(lookupKeys));
  const summary: AuditSummary = {
    listings: tracks.length,
    sources: sources.map((s) => stats(s.name, s.tracks)),
    with: { ...(({ isrc, length, severalArtists }) => ({ isrc, length, severalArtists }))(stats('', tracks)), popularity: tracks.filter((t) => t.popularity !== undefined).length },
    dropped: { littleSinging: quiet.length, snippets: snippets.length },
    songs: songs.length,
    songsWithSeveralListings: songs.filter((s) => s.members.length > 1).length,
    largestSong: Math.max(0, ...songs.map((s) => s.members.length)),
    mergedBy,
    songsByWords,
    database: ranges && usdbIndex ? { lookupKeys: keys.size, withStoredRange: [...keys].filter((k) => ranges.get(k)?.range).length, usdbEntries: usdbIndex.length } : null,
  };
  const keptProfiles = songs.flatMap((s) => s.members.map((m) => listingProfile(m.track)));
  const topTags = {
    version: tally(keptProfiles.flatMap((p) => p.versions)),
    unlisted: tally(keptProfiles.flatMap((p) => p.unlisted)),
    labels: tally(keptProfiles.flatMap((p) => p.labels)),
  };

  // ---- one row per listing, for the CSV ----
  const row = (track: Track, over: Partial<AuditRow>): AuditRow => ({
    song: '',
    role: '',
    basis: '',
    lengthGapS: '',
    title: track.title,
    artists: credited(track),
    length: mmss(track.durationMs),
    isrc: track.isrc ?? '',
    trackId: track.id,
    playRank: track.playRank,
    lookupKey: songKey(track.artist, track.title),
    versionTags: '',
    flags: [...(flagged.get(track.id) ?? [])].join(' '),
    ...over,
  });
  const rows: AuditRow[] = [
    ...songs.flatMap((s, i) =>
      s.members.map((m) =>
        row(m.track, {
          song: i + 1,
          role: m.basis === 'anchor' ? 'anchor' : 'member',
          basis: m.basis === 'anchor' ? '' : m.basis,
          lengthGapS: m.lengthGapS ?? '',
          versionTags: s.versionTags.join('; '),
        }),
      ),
    ),
    ...dropped.map((d) => row(d.track, { role: `left out: ${d.reason}` })),
  ];
  return { summary, lists, topTags, rows };
}

const pct = (n: number, of: number) => `${n} (${of ? Math.round((100 * n) / of) : 0}%)`;

/** The summary to read or paste: counts and example titles, no ISRCs or track ids. */
export function identityAuditText(audit: Audit): string {
  const { summary: s, lists, topTags } = audit;
  const out: string[] = [];
  out.push(`Listings read: ${s.listings}`);
  for (const src of s.sources) {
    out.push(`  ${src.name}: ${src.listings} listings; ISRC on ${pct(src.isrc, src.listings)}, length on ${pct(src.length, src.listings)}, 2+ credited artists on ${pct(src.severalArtists, src.listings)}`);
  }
  out.push(`  all together: ISRC ${pct(s.with.isrc, s.listings)}, length ${pct(s.with.length, s.listings)}, 2+ credited artists ${pct(s.with.severalArtists, s.listings)}, popularity ${pct(s.with.popularity, s.listings)}`);
  out.push(`Left out: ${s.dropped.littleSinging} with little singing (instrumental, karaoke, dub), ${s.dropped.snippets} under ${MIN_SONG_S} s`);
  const kept = s.listings - s.dropped.littleSinging - s.dropped.snippets;
  out.push(`Songs after grouping: ${s.songs} (${kept - s.songs} of ${kept} listings merged into another)`);
  out.push(`  merged by: ISRC ${s.mergedBy.isrc}, title and length within ${SAME_RECORDING_S} s ${s.mergedBy['names+length']}, another edit within ${SAME_SONG_S} s ${s.mergedBy.edit}, cut tag ${s.mergedBy.packaging}`);
  out.push(`  songs with 2+ listings: ${s.songsWithSeveralListings}; most listings in one song: ${s.largestSong}`);
  out.push(`Words in the title of each song: ${s.songsByWords.differentVersion} different version, ${s.songsByWords.packagingOnly} packaging only, ${s.songsByWords.unlistedOnly} unlisted tag, ${s.songsByWords.plain} none`);
  if (!s.database) out.push('Stored ranges and the USDB index: not checked (no database was read)');
  else {
    out.push(`Database: stored ranges for ${s.database.withStoredRange} of ${s.database.lookupKeys} lookup keys; ${s.database.usdbEntries} USDB index entries`);
    if (s.database.withStoredRange === 0 || s.database.usdbEntries === 0) out.push('  WARNING: one of these is empty, so [variant-range] and [wrong-entry] below mean nothing');
  }
  for (const l of lists.filter((x) => x.total !== null && x.total > 0)) {
    out.push('', `[${l.id}] ${l.title}: ${l.total}`);
    for (const e of l.examples) out.push(`    ${e}`);
    if (l.total! > l.examples.length) out.push(`    ... and ${l.total! - l.examples.length} more (see the CSV)`);
  }
  const none = lists.filter((x) => x.total === 0);
  if (none.length) out.push('', `Nothing found for: ${none.map((x) => `[${x.id}]`).join(' ')}`);
  const skipped = lists.filter((x) => x.total === null);
  if (skipped.length) out.push(`Not checked: ${skipped.map((x) => `[${x.id}]`).join(' ')}`);
  out.push('', 'Most common different-version tags: ' + (topTags.version.map(([t, n]) => `${t} ${n}`).join(', ') || 'none'));
  out.push('Most common unlisted tags (candidates for the word lists): ' + (topTags.unlisted.map(([t, n]) => `${t} ${n}`).join(', ') || 'none'));
  out.push('Most common unlisted labels after a dash (a version, or a credit: they keep a listing apart unless the ISRC joins it): ' + (topTags.labels.map(([t, n]) => `${t} ${n}`).join(', ') || 'none'));
  return out.join('\n') + '\n';
}

const HEADERS: [keyof AuditRow, string][] = [
  ['song', 'song'],
  ['role', 'role'],
  ['basis', 'joined by'],
  ['lengthGapS', 'seconds from anchor'],
  ['title', 'title'],
  ['artists', 'credited artists'],
  ['length', 'length'],
  ['isrc', 'ISRC'],
  ['trackId', 'Spotify track id'],
  ['playRank', 'play rank'],
  ['lookupKey', 'lookup key'],
  ['versionTags', 'version tags'],
  ['flags', 'flags'],
];
const cell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export function identityAuditCsv(rows: AuditRow[]): string {
  return [HEADERS.map(([, h]) => h).join(','), ...rows.map((r) => HEADERS.map(([k]) => cell(r[k])).join(','))].join('\n') + '\n';
}
