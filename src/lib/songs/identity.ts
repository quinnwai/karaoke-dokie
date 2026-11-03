// Groups a person's Spotify listings into songs.
//
// Spotify lists one recording under many track ids (a single, the album, compilations), so a
// library has several rows for one song. A song is what you would sing: the same melody, lyrics and
// arrangement by the same artists. A remix, a live take or a sped-up copy is another song.
//
// Four signals decide (design: docs/identity.md):
//   ISRC     the same ISRC is the same recording (it can chain), unless the different-version tags
//            in the two titles differ.
//   words    the different-version tags in a title (remix, live, sped up, ...) must be the same on
//            both sides. Packaging tags (remaster, single mix, explicit, feat. X) are ignored. A tag
//            in brackets that is on no list is usually a subtitle, so length checks it instead. One
//            after a " - " that is on no list is a label: it keeps a listing from joining another by
//            title and length, but an equal ISRC still joins them.
//   length   within 4 s: the same recording. Within 10 s: the same song if the titles match
//            exactly. Further apart: different, unless a cut tag explains it ("X - Radio Edit"
//            against a plain "X"). Under 60 s is a snippet, not a song.
//   artists  the same set of credited artists (Spotify ids); a guest either title names does not
//            count, but two titles that name different guests are different recordings.
// Words, length and artists are checked against a song's anchor, the listing played most, and never
// chained. A wrong merge hides a song silently while a missed one shows a duplicate, so every
// default is strict. Without ISRC (Spotify has withdrawn it before) the other signals still work.
//
// ISRC, length and the credited artists come with every Spotify track. The app keeps them in memory
// with the library and removes them before a response (withoutListingDetails); it never stores them.

import type { Track } from '../contracts';
import { hasLittleSinging } from './resolve';

/** Listings this close in length are one recording (the pipeline's DURATION_TOLERANCE_S). */
export const SAME_RECORDING_S = 4;
/** Another edit of the same song: exact title and artists, lengths within this (the pipeline's RELAXED_TOLERANCE_S). */
export const SAME_SONG_S = 10;
/** Shorter listings are snippets, interludes or previews, not songs to sing (the pipeline's MIN_LENGTH_S). */
export const MIN_SONG_S = 60;
/** A cut tag explains a different length only if the shorter is at least this share of the longer: a 61 s "radio edit" is not a 400 s song. */
export const CUT_MIN_RATIO = 0.4;

// Lengths are compared in whole milliseconds, so a gap of exactly 4 s is not lost to float rounding.
const SAME_RECORDING_MS = SAME_RECORDING_S * 1000;
const SAME_SONG_MS = SAME_SONG_S * 1000;
const MIN_SONG_MS = MIN_SONG_S * 1000;

// ---- title tags ----

/**
 * What a tag in a title ("(Live)", "[feat. X]", "- Remastered 2011") says about the listing:
 * `cut` the song edited to another length (radio edit, re-recording), `packaging` a wrapper that
 * changes nothing, `featured` a guest artist, `version` a different version of the song, `unlisted`
 * anything else in brackets (usually a subtitle), `label` anything else after a " - " (a version
 * label, or a soundtrack or edition credit: we cannot tell).
 */
export type TagKind = 'cut' | 'packaging' | 'featured' | 'version' | 'unlisted' | 'label';

export interface Tag {
  /** Folded text without the brackets, e.g. "gigamesh remix". */
  text: string;
  kind: TagKind;
}

// Whole-tag patterns, so "human nature radio mix" (a named remix) is not "radio mix" (the radio edit).
const CUT_TAGS = [
  /^(?:(?:uk|us|international|dj|original|clean|explicit) )*(?:single|radio|short|video|edited) (?:version|ver\.?|edit|mix|cut)$/,
  /^(?:(?:uk|us|international|clean|explicit|mono|stereo|original) )?edit$/,
  /^7(?:"|[ -]?inch| ?in) (?:version|mix|edit)$/,
  /^(?:radio|short) cut$/,
  /^(?:taylor'?s version|re-?record(?:ed|ing)|new recording)$/,
];
const PACKAGING_TAGS = [
  /^(?:(?:\d{4}|digital|digitally|stereo|mono|hd|new) )*remaster(?:ed)?(?: (?:version|edition|mix|\d{4}))*$/,
  /^\d{4} (?:mix|version)$/,
  /^(?:\d{4} |original |remastered )?(?:stereo|mono)(?: (?:mix|version|edit|remaster(?:ed)?))?$/,
  /^(?:explicit|clean)(?: version)?$/,
  /^(?:album|original|lp|main|studio) (?:version|ver\.?|edit|mix)$/,
  /^(?:deluxe|bonus|expanded|anniversary|special|collector's|standard|super deluxe)(?: (?:version|edition|track))?$/,
  /^(?:single|album|ep)$/,
  /^(?:original )?(?:(?:motion picture|movie|film) )?soundtrack(?: version| recording)?$/,
];
// Packaging with extra words ("2015 Paisley Park Remaster", "25th Anniversary Edition"), once no version word matched.
const LOOSE_PACKAGING = [/re-?master/, /\banniversary\b|\bedition$/, /^(?:bonus|deluxe)\b/];
const FEATURED = /^(?:feat\.?|ft\.?|featuring|with) (.+)$/;
// "feat. B Remix" names a remix, not a guest; "feat. The Piano Guys" and "with Live Nation" name guests.
const VERSION_ENDING = /\b(?:remix|rmx|mix|live|acoustic|version|edit|cover|demo|unplugged)$/;
// "From "Frozen"", "Theme from "Top Gun"", "Goblin OST Part.1" credit a soundtrack; "From Live at Wembley" does not.
const SOUNDTRACK = /^(?:(?:love |main |end |opening |ending |title )?theme )?from /;
const OST = /\b(?:ost|soundtrack|score)\b/;
const PERFORMANCE = /\b(?:live(?![- ]action)|sessions?|concert|demo|unplugged|acoustic)\b/;
const LANGUAGES =
  'spanish|french|german|italian|portuguese|japanese|korean|chinese|mandarin|cantonese|english|latin|hindi|tamil|telugu|bengali|punjabi|urdu|arabic|persian|hebrew|turkish|greek|russian|ukrainian|polish|czech|hungarian|dutch|swedish|norwegian|danish|finnish|thai|vietnamese|indonesian|malay|tagalog|filipino|espanol|francais|francaise|deutsch|italiano|portugues|nederlands';
// A different recording or arrangement of the song. Compared by their full text, so two remixers'
// mixes differ. The pipeline's version words (ingestion-pipeline docs/pipeline.md), minus the ones
// the app already hides (instrumental, karaoke, dub: resolve.ts hasLittleSinging).
const VERSION_TAGS = [
  /\b(?:remix|remixed|rmx|mash-?up|vip|re-?work|reworked|re-?edit|flip|bootleg|refix|mix)\b/,
  /\b(?:live(?![- ]action)|unplugged|sessions?|tiny desk|acoustic|acoustique|acustic[oa]|stripped|piano|a[ -]?capp?ella|orchestra|orchestral|demo|in concert|concert|spotify singles|ao vivo|en vivo|en directo|reimagined)\b/,
  /\b(?:extended|club|12[ -]?inch)\b|\b12"/,
  /\b(?:sped[ -]?up|speed[ -]?up|slowed|reverb(?:ed)?|nightcore|daycore|chopped|screwed|bass[ -]?boost(?:ed)?|lo-?fi|\d+d(?: audio)?)\b/,
  /\b(?:duet|alternate|alternative|alt\.? version|film version|movie version|tv (?:size|version|edit)|cover|tribute|medley|take \d+)\b/,
  new RegExp(`\\b(?:${LANGUAGES}|eng|jpn|kor|chn|chi|esp|spa|fra|ger|ita|por)\\.? (?:version|ver\\.?)\\b`),
  new RegExp(`^(?:${LANGUAGES})$`),
  new RegExp(`\\b(?:version|versione|versao) (?:${LANGUAGES})\\b`),
  /\b(?:version|versione|versao) (?:en|in|em|auf) \w+|\bin (?:english|spanish|french|german|italian|portuguese|japanese|korean)\b/,
  /\b(?:reprise|interlude|skit|intro|outro)\b/,
  /\b(?:pt|part)\.? ?(?:\d+|[ivx]{1,5}|one|two|three|four|five|six|seven|eight|nine|ten)\b/,
  /\b(?:off[ -]?vocal|inst\.?|instrumentals?|minus one|without vocals?|backing tracks?)\b/, // spellings hasLittleSinging does not hide
  /\bedit$/, // a named edit ("kygo edit"); the plain cuts were taken above
];
/** Titles that name no song: different songs by one artist share them, so only ISRC joins these. */
const GENERIC_TITLE = /^(?:intro|outro|interlude|skit|untitled|prelude|prologue|epilogue|overture|reprise|hidden track|bonus track|track \d+)(?: \d+)?$/;

/** Lower case, no accents on Latin letters (て and で, Всё and Все stay different), one kind of quote, single spaces. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/(?<=\p{Script=Latin})\p{M}+/gu, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'") // curly and slanted apostrophes
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
/** Words only, for comparing names: "Jay-Z" and "JAY Z", "Tyler, The Creator" and "tyler the creator", "&" and "and". */
const words = (text: string) => fold(text).replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** A title base for comparing: "Hey Ya!" and "Hey Ya", "Mr." and "Mr", "Don't" and "Dont", "&" and "and"; "3.5" stays. */
const compare = (text: string) =>
  fold(text)
    .replace(/&/g, ' and ')
    .replace(/'/g, '')
    .replace(/(?<!\d)[.,]|[.,](?!\d)/g, '')
    .replace(/[!?:;"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
/** "Live" and "Live Version", "Pt. 2" and "Part 2", "Sped-Up" and "Sped Up", "Remix" and "Remixed" are one tag. */
const canonicalVersion = (text: string) =>
  text
    .replace(/[-+]/g, ' ')
    .replace(/\b(?:version|ver)\b\.?/g, ' ')
    .replace(/\bpt\b\.?/g, 'part')
    .replace(/\bremixed\b/g, 'remix')
    .replace(/\s+/g, ' ')
    .trim();

function classify(raw: string, fromDash = false): Tag {
  const text = fold(raw).replace(/^[\s.,;:!-]+|[\s.,;:!-]+$/g, '');
  const unquoted = text.replace(/"[^"]*"/g, ' '); // a quoted film title ("Live and Let Die") holds no version word
  const is = (patterns: RegExp[], on = text) => patterns.some((r) => r.test(on));
  let kind: TagKind;
  if (is(CUT_TAGS)) kind = 'cut';
  else if (is(PACKAGING_TAGS)) kind = 'packaging';
  else if (FEATURED.test(text) && !VERSION_ENDING.test(text)) kind = 'featured';
  else if ((SOUNDTRACK.test(text) || OST.test(unquoted)) && !PERFORMANCE.test(unquoted)) kind = 'packaging';
  else if (is(VERSION_TAGS, unquoted)) kind = 'version';
  else if (is(LOOSE_PACKAGING)) kind = 'packaging';
  else kind = fromDash ? 'label' : 'unlisted';
  return { text, kind };
}

// (...) with one level of nesting, [...], and the lenticular brackets Japanese and Chinese titles use.
const BRACKETS = /\(((?:[^()]|\([^()]*\))*)\)|\[([^\]]*)\]|【([^】]*)】/g;

/**
 * A title split into its base and its tags: every bracketed group, everything after a dash (split
 * at " / ") as the same places songKey drops (resolve.ts), and a bare "feat. X". "Folded (Remix)
 * [feat. Ne-Yo]" is the base "folded" with the tags "remix" (version) and "feat. ne-yo" (featured).
 * A leading group is part of the title, as in "(Don't Fear) The Reaper"; a title that is only a
 * tag, "(Intro)", is that word.
 */
export function parseTitle(raw: string): { base: string; tags: Tag[] } {
  const title = raw.normalize('NFKC').trim(); // full-width brackets and punctuation become plain ones
  const tags: Tag[] = [];
  let rest = title.replace(BRACKETS, (group: string, round?: string, square?: string, heavy?: string, offset?: number) => {
    const inner = round ?? square ?? heavy ?? '';
    if (offset === 0 && title.slice(group.length).trim()) return ` ${inner} `;
    tags.push(classify(inner));
    return ' ';
  });
  const dash = /\s+\p{Pd}\s+(.*)$/u.exec(rest);
  if (dash) {
    for (const part of dash[1]!.split(/\s+\/\s+/)) tags.push(classify(part, true));
    rest = rest.slice(0, dash.index);
  }
  const bare = /\s+(?:feat\.|featuring)\s+(.+)$/i.exec(rest);
  if (bare) {
    tags.push(classify(`feat. ${bare[1]}`));
    rest = rest.slice(0, bare.index);
  }
  const base = compare(rest);
  return base ? { base, tags: tags.filter((t) => t.text) } : { base: compare(title.replace(/[()[\]【】]/g, ' ')) || fold(title), tags: [] };
}

// ---- listings ----

/** What identity looks at in one listing. */
export interface Profile {
  /** The title without its tags, folded. */
  base: string;
  /** Different-version tags, canonical and sorted: part of the song's identity. */
  versions: string[];
  /** Unlisted labels after a dash, sorted: they keep a listing from joining by title and length, not by ISRC. */
  labels: string[];
  /** Unlisted tags in brackets, sorted: usually a subtitle, so only an exact title match holds them. */
  unlisted: string[];
  /** Has a cut tag (radio edit, re-recording): a different length is expected. */
  cut: boolean;
  /** What each "feat." tag names, as words with a space on each side; empty when no tag names a guest. */
  mentions: string[];
  /** Every credited artist, name as words. */
  credited: { id: string; name: string }[];
  /** Length in whole milliseconds. */
  ms?: number;
  isrc?: string;
}

const sortedTexts = (tags: Tag[], kind: TagKind, map: (text: string) => string = (t) => t) =>
  [...new Set(tags.filter((t) => t.kind === kind).map((t) => map(t.text)).filter(Boolean))].sort();

export function listingProfile(track: Track): Profile {
  const { base, tags } = parseTitle(track.title);
  const profile: Profile = {
    base,
    versions: sortedTexts(tags, 'version', canonicalVersion),
    labels: sortedTexts(tags, 'label'),
    unlisted: sortedTexts(tags, 'unlisted'),
    cut: tags.some((t) => t.kind === 'cut'),
    mentions: tags.filter((t) => t.kind === 'featured').map((t) => ` ${words(FEATURED.exec(t.text)?.[1] ?? '')} `),
    credited: (track.artists?.length ? track.artists : [{ id: track.artistId, name: track.artist }]).map((a) => ({ id: a.id, name: words(a.name) })),
  };
  if (Number.isFinite(track.durationMs) && track.durationMs! > 0) profile.ms = Math.round(track.durationMs!);
  if (track.isrc) profile.isrc = track.isrc;
  return profile;
}

/** What groups titles together: the title without its tags, and the different-version tags. */
export const titleKey = (p: Profile) => `${p.base}\u0000${p.versions.join('|')}`;

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The same credited artists. A guest either title names is set aside from both lists, whether or
 * not the other title names it. Two titles that each name a credited guest, and not the same one
 * ("feat. B" and "feat. C"), are different recordings.
 */
export function sameArtists(a: Profile, b: Profile): boolean {
  const named = (p: Profile, from: string[]) => p.credited.filter((c) => c.name && from.some((m) => m.includes(` ${c.name} `)));
  const ids = (cs: { id: string }[]) => cs.map((c) => c.id).sort().join(',');
  const [ownA, ownB] = [ids(named(a, a.mentions)), ids(named(b, b.mentions))];
  if (ownA && ownB && ownA !== ownB) return false;
  const mentions = [...a.mentions, ...b.mentions];
  const lead = (p: Profile) => {
    const aside = new Set(named(p, mentions).map((c) => c.id));
    const rest = p.credited.filter((c) => !aside.has(c.id));
    return ids(rest.length ? rest : p.credited);
  };
  return lead(a) === lead(b);
}

const gapMs = (a: Profile, b: Profile) => (a.ms !== undefined && b.ms !== undefined ? Math.abs(a.ms - b.ms) : undefined);

// ---- grouping ----

/** Why a listing joined a song: its ISRC, or title, artists and length (4 s, another edit within 10 s, or a cut tag). */
export type MergeBasis = 'isrc' | 'names+length' | 'edit' | 'packaging';

export interface Member {
  track: Track;
  /** 'anchor' for the listing the song is named after, else how this one matched it. */
  basis: 'anchor' | MergeBasis;
  /** Seconds between this listing's length and the anchor's, when both are known. */
  lengthGapS?: number;
}

export interface Song {
  /** The listing played most: its title, link and art stand for the song. */
  anchor: Track;
  /** Anchor first, then the others in play order. */
  members: Member[];
  /** Different-version tags every listing carries, e.g. "gigamesh remix"; empty for an original. */
  versionTags: string[];
}

export interface Dropped {
  track: Track;
  /** An instrumental, karaoke or dub version, or a listing under 60 s. */
  reason: 'little-singing' | 'snippet';
}

export interface Grouping {
  /** Most-played first. */
  songs: Song[];
  dropped: Dropped[];
}

/** Title, artists and length against the song's anchor: how this listing matches it, or null. */
function softMatch(anchor: Profile, p: Profile): { basis: MergeBasis; gap: number } | null {
  if (!anchor.base || GENERIC_TITLE.test(anchor.base) || anchor.base !== p.base) return null;
  if (!sameList(anchor.versions, p.versions) || !sameList(anchor.labels, p.labels) || !sameArtists(anchor, p)) return null;
  const gap = gapMs(anchor, p);
  if (gap === undefined) return null;
  if (gap <= SAME_RECORDING_MS) return { basis: 'names+length', gap };
  // "X - Radio Edit" against a plain "X" (with the same subtitle, if any): the cut explains the length.
  const explains = (cut: Profile, plain: Profile) => cut.cut && !plain.cut && sameList(cut.unlisted, plain.unlisted);
  const ratio = Math.min(anchor.ms!, p.ms!) / Math.max(anchor.ms!, p.ms!);
  if (ratio >= CUT_MIN_RATIO && (explains(anchor, p) || explains(p, anchor))) return { basis: 'packaging', gap };
  if (gap <= SAME_SONG_MS && sameList(anchor.unlisted, p.unlisted)) return { basis: 'edit', gap };
  return null;
}

const mostPlayedFirst = (a: Track, b: Track) => a.playRank - b.playRank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Groups listings into songs, most-played first. Listings with little singing (instrumental,
 * karaoke, dub) and snippets under 60 s are left out and returned in `dropped`. A listing without
 * length or credited artists (tracks cached before they were read) joins a song only by ISRC.
 */
export function groupListings(listings: Track[]): Grouping {
  const dropped: Dropped[] = [];
  const kept: { track: Track; profile: Profile }[] = [];
  for (const track of [...listings].sort(mostPlayedFirst)) {
    const profile = listingProfile(track);
    if (hasLittleSinging(track.title)) dropped.push({ track, reason: 'little-singing' });
    else if (profile.ms !== undefined && profile.ms < MIN_SONG_MS) dropped.push({ track, reason: 'snippet' });
    else kept.push({ track, profile });
  }

  const songs: Song[] = [];
  const anchors: Profile[] = []; // parallel to songs
  const byTitle = new Map<string, number[]>(); // base and version tags -> songs, so a listing meets few anchors
  const byIsrc = new Map<string, number>();
  for (const { track, profile } of kept) {
    let at = -1;
    let basis: MergeBasis = 'isrc';
    let gap: number | undefined;
    const owner = profile.isrc ? byIsrc.get(profile.isrc) : undefined;
    if (owner !== undefined && sameList(anchors[owner]!.versions, profile.versions)) {
      at = owner;
      gap = gapMs(anchors[owner]!, profile);
    } else {
      for (const i of byTitle.get(titleKey(profile)) ?? []) {
        const m = softMatch(anchors[i]!, profile);
        if (m) {
          at = i;
          basis = m.basis;
          gap = m.gap;
          break;
        }
      }
    }
    if (at < 0) {
      at = songs.length;
      songs.push({ anchor: track, members: [{ track, basis: 'anchor' }], versionTags: profile.versions });
      anchors.push(profile);
      byTitle.set(titleKey(profile), [...(byTitle.get(titleKey(profile)) ?? []), at]);
    } else {
      const member: Member = { track, basis };
      if (gap !== undefined) member.lengthGapS = gap / 1000;
      songs[at]!.members.push(member);
    }
    if (profile.isrc && !byIsrc.has(profile.isrc)) byIsrc.set(profile.isrc, at);
  }
  return { songs, dropped };
}

/** The track as a browser may see it: without the listing details kept for identity. */
export function withoutListingDetails(track: Track): Track {
  if (track.isrc === undefined && track.durationMs === undefined && track.artists === undefined) return track;
  const { isrc: _isrc, durationMs: _durationMs, artists: _artists, ...rest } = track;
  return rest;
}
