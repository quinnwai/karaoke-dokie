// Clean titles for the song list (QWW-49). A catalogue song's title is whatever spelling its source
// used: "Dreadlock Holiday (Album Version)", "Barbie Girl [DUET]", "L'amour toujours (Radio Edit)",
// "Song - Remastered 2011", "Song (feat. X)". The list shows the song, not the release, so those tags
// come off the title; "feat." moves to the artist line.
//
// What is removed is a closed list of version tags (below). Each rule reads the WHOLE text of a bracket
// or dash tail and says what it is: a tag word at the end ("(Radio Edit)", "(Robin Schulz Remix)"), a
// known opening ("(Live at Donington)"), or the whole text ("(Duet)"). Anything the list does not know
// stays: "(I Can't Get No) Satisfaction", "Sweet Dreams (Are Made of This)" and "Running Up That Hill
// (A Deal With God)" are the song's real title. A missed tag only leaves a bracket on screen; a wrong
// one turns a different song into its neighbour, so every doubtful rule is left out. Kept on purpose:
//  - language versions ("(German Version)", "(Spanish Radio Edit)", "(Eng. Ver.)"): the lyrics differ, so
//    it is not the song a visitor wants to sing;
//  - instrumental, karaoke and dub tags: resolve.ts hasLittleSinging hides those songs on the tag;
//  - a bracket that names a part, a reprise or an interlude ("(Part 2 - Live)"): a track of its own.
//
// Pure functions: the catalogue build (songs/canonical.ts) runs them offline and stores the result.

import { hasLittleSinging } from './resolve';

export type TagKind = 'version' | 'edit' | 'remix' | 'live' | 'remaster' | 'duet' | 'tv' | 'video' | 'edition' | 'context' | 'feat';

export interface RemovedTag {
  /** The tag as written, without its brackets or dash. */
  text: string;
  kind: TagKind;
}

export interface CleanedTitle {
  /** The title to show. The input unchanged when no tag was removed. */
  title: string;
  /** Featured artists named by "(feat. X)" tags, for the artist line (artistLine). */
  featured: string[];
  removed: RemovedTag[];
}

/** No real title or artist line is longer (the longest in the catalogue is 103); the cap keeps the regexes below fast on garbage. */
const MAX_LENGTH = 300;

/** Lower case, one kind of quote and dash, single spaces: what the tag rules read. */
function norm(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘ʼ′`´]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—‐‑−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const LANGUAGES =
  'english|german|deutsch|deutsche|spanish|espanol|español|french|francais|français|italian|italiano|portuguese|japanese|korean|chinese|mandarin|cantonese|dutch|swedish|norwegian|danish|finnish|polish|russian|turkish|arabic|hindi|greek|hebrew|czech|hungarian|romanian|ukrainian|thai|vietnamese|indonesian|tagalog|filipino|persian|tamil|spanglish|japanglish|castilian|catalan|irish|welsh|yiddish';
const LANGUAGE_ABBREVIATIONS = 'eng|kor|jpn|jap|ger|deu|fra|fre|spa|esp|ita|por|rus|chn|chi|swe|dut|pol';
/** A tag that names a language ("(Original Spanish Version)", "(German Edit)", "(Eng. Ver.)") is another song to sing. */
const LANGUAGE = new RegExp(`\\b(?:${LANGUAGES})\\b|\\b(?:${LANGUAGE_ABBREVIATIONS})\\b\\.? ?(?:ver|version)\\b`);
/** A part, a reprise, an interlude: a track of its own, so a bracket that names one stays whole, "(Part 2 - Live)" included. */
const SEPARATE_TRACK = /\b(?:part|pt|vol|volume|chapter|act|reprise|interlude|skit)\b/;

const YEAR = '(?:[ ,]+(?:19|20)\\d{2})?';
const REMIX = new RegExp(
  `(?:^|[ -])(?:remix(?:ed)?|rmx|bootleg|mashup|re-?work(?:ed)?|re-?edit|refix)(?: (?:edit|version|mix|radio|dub|extended|short|club))*${YEAR}$|'s twist$`,
);
const VERSION = new RegExp(`\\b(?:version|ver)${YEAR}$|(?<!\\bunder )\\bcover$`); // "(Album Version)", "(Extended Cover)"
const EDIT = new RegExp(`\\b(?:edit|mix|mixed)${YEAR}$`);
const REMASTER = /^(?:(?:\d{4}|digital|digitally|mono|stereo|new|deluxe|hd|hq|\d\.\d) )*remaster(?:ed|ing)?(?: (?:\d{4}|version|edition|mix|in \d{4}))*$/;
/** Live tags open with a known word and go on with a place, a date or a show; "(Live It Up)" or "(Live and Let Die)" are titles. */
const LIVE: RegExp[] = [
  /^live$/,
  /^(?:en|dal) vivo$|^ao vivo$|^en direct[eo]?$/,
  /^(?:acoustic live|live acoustic)$/,
  /^live (?:at|from|@|with|session|sessions|acoustic|video|version|edit|mix|recording|take|cut|lounge|stream|concert|show|tour|festival|performance|scenes|bei|olympia|bbc|nbc|mtv|earth|bercy|after death|still reigning)\b/,
  // "live in london", "live in los angeles": a place, unless what follows reads as a phrase ("Live in Love")
  /^live in (?!(?:love|the|a|an|my|your|me|you|us|it|fear|peace|sin|vain|harmony|color|colour|style|hell|heaven|paradise|dreams?|tears|silence|motion|time)\b)\S/,
  /^live ?@/,
  /^live (?:\S+ ){0,4}(?:19|20)\d{2}\b/, // "live 1969", "live aid 1985", "live bonez tour 2005"
  /^(?:\S+ ){0,3}live (?:at|from|@)\b/, // "zoo tv live from sydney", "acoustic live at ..."
  /^(?:the )?(?:mtv )?unplugged(?: in [a-z ]+)?(?: \d{4})?$/,
  /^(?:the )?concert (?:in|at|for|from)\b/,
  /\blive lounge$/,
  /\bsessions?$/,
];
const PACKAGING =
  /^(?:single|album|radio|original|explicit|clean|edited|uncensored|censored|uncut|extended|short|long|full|mono|stereo|acoustic|ac[uú]stico|unplugged|demo|deluxe|bonus(?: track)?|orchestral|restrung|high notes|low notes|from the vault|stripped|outtake|alternate take|director's cut|official audio|audio|visuali[sz]er|re-?record(?:ed)?(?: \d{4})?|\d{4} re-?record)$|\bedition$|^deluxe\b|\bbonus track$/;
/**
 * Where the song was used, not another recording of it: "(From "Frozen")", "(Once OST)", "(ESC 2015 Romania)",
 * "(La Casa De Papel Opening)". A bracket of one word before "theme", "intro" and the like ("(Love Theme)",
 * "(Happy Ending)", "(Album Intro)") could be a real subtitle, so the show must take two words or more.
 */
const CONTEXT =
  /^from (?:the )?(?:film|movie|motion picture|original|series|show|game|soundtrack|musical)\b|^from ["']|^(?:esc|eurovision) ?\d{4}\b|^\S+(?: \S+)* (?:ost|soundtrack)$|^(?:\S+ ){2,}(?:opening|ending|intro|outro|theme)(?: (?:theme|song|\d+))?$/;
const FEAT = /^(?:feat|ft|featuring)\.? +(.+)$/i;

type Tag = { kind: TagKind; featured?: string };

/** The credit in "feat. Drake, Radio Edit": the names up to a trailing part that is a tag itself ("feat. Earth, Wind & Fire" keeps all of it). */
function featuredCredit(rest: string): string {
  const pieces = rest.split(/(\s*[,/;]\s*)/); // names and the separators between them
  let end = pieces.length;
  while (end > 1 && pieces[end - 1] !== undefined && classifyTag(pieces[end - 1]!)) end -= 2;
  return pieces.slice(0, Math.max(1, end)).join('').trim();
}

/** What a bracket or dash-tail text is, or null when it is not a version tag we remove. */
export function classifyTag(text: string): Tag | null {
  if (text.length > MAX_LENGTH) return null;
  const t = norm(text).replace(/\.+$/, '');
  if (!t) return null;
  if (hasLittleSinging(`(${t})`) || LANGUAGE.test(t) || SEPARATE_TRACK.test(t)) return null;
  if (CONTEXT.test(t)) return { kind: 'context' };
  if (REMIX.test(t)) return { kind: 'remix' };
  const feat = FEAT.exec(text.trim());
  if (feat) return { kind: 'feat', featured: featuredCredit(feat[1]!) };
  if (VERSION.test(t)) return { kind: 'version' };
  if (EDIT.test(t)) return { kind: 'edit' };
  if (LIVE.some((re) => re.test(t))) return { kind: 'live' };
  if (REMASTER.test(t)) return { kind: 'remaster' };
  if (t === 'duet') return { kind: 'duet' };
  if (/^tv(?: (?:size|cut))?$/.test(t)) return { kind: 'tv' };
  if (/\bvideo$/.test(t)) return { kind: 'video' };
  if (PACKAGING.test(t)) return { kind: 'edition' };
  // "Single Version, Remastered" or "Radio Edit / feat. X": a tag when every part is one.
  const parts = text.split(/\s*[,/;]\s*|\s+-\s+/).filter(Boolean);
  if (parts.length > 1) {
    const tags = parts.map(classifyTag);
    if (tags.every((k) => k !== null)) {
      const featured = tags.flatMap((k) => (k!.featured ? [k!.featured] : [])).join(' & ');
      return { kind: (tags.find((k) => k!.kind !== 'feat') ?? tags[0])!.kind, ...(featured ? { featured } : {}) };
    }
  }
  return null;
}

const BRACKETS = /\(([^()]*)\)|\[([^[\]]*)\]/g;
const DASH_TAIL = /^(.*\S)\s+[-–—‐‑−]\s+([^]*)$/;
/** True when every bracket in `s` closes: a dash inside "(Pt. 2 - feat. X)" is not the start of a tail. */
const balanced = (s: string) => (s.match(/\(/g)?.length ?? 0) === (s.match(/\)/g)?.length ?? 0) && (s.match(/\[/g)?.length ?? 0) === (s.match(/\]/g)?.length ?? 0);

/** One pass: the bracketed tags, wherever they sit, then the dash tails from the end while they are tags. */
function pass(s: string, take: (text: string, tag: Tag) => void): string {
  let took = false;
  s = s.replace(BRACKETS, (whole, round: string | undefined, square: string | undefined) => {
    const inner = round ?? square ?? '';
    const tag = classifyTag(inner);
    if (!tag) return whole;
    take(inner, tag);
    took = true;
    return ' ';
  });
  // A bracket that held only a tag ("Song ((Live))") is left empty: take that away too.
  if (took) s = s.replace(/\(\s*\)|\[\s*\]/g, ' ');
  s = s.replace(/\s{2,}/g, ' ').trim();
  for (let m = DASH_TAIL.exec(s); m && balanced(m[1]!) && balanced(m[2]!); m = DASH_TAIL.exec(s)) {
    const tag = classifyTag(m[2]!);
    if (!tag) break;
    take(m[2]!, tag);
    s = m[1]!;
  }
  return s;
}

/**
 * The title without its version tags: bracketed tags and dash-tail tags from the list above, anywhere in
 * the title, until none is left. A title that would be left empty (or with nothing but punctuation) is
 * returned as it was, and so is a title too long to be one.
 */
export function cleanTitle(raw: string): CleanedTitle {
  if (raw.length > MAX_LENGTH) return { title: raw, featured: [], removed: [] };
  const removed: RemovedTag[] = [];
  const featured: string[] = [];
  const take = (text: string, tag: Tag) => {
    removed.push({ text: text.trim(), kind: tag.kind });
    if (tag.featured) featured.push(tag.featured);
  };
  let s = raw.trim();
  // A tag inside a tag ("Song (Live (Remastered))") shows only after the inner one is gone, so go again until nothing changes.
  for (let i = 0, before = ''; s !== before && i < 4; i++) {
    before = s;
    s = pass(s, take);
  }
  s = s.replace(/\s+[-–—]+$/, '').replace(/[\s,;:]+$/, '');
  if (removed.length === 0 || !/[\p{L}\p{N}]/u.test(s)) return { title: raw, featured: [], removed: [] };
  return { title: s, featured, removed };
}

/** True when cleanTitle would remove something: the title carries a version tag. */
export function hasVersionTag(raw: string): boolean {
  return cleanTitle(raw).removed.length > 0;
}

/** Lower case, no Latin accents, "&" read as "and", and only letters, marks and digits left (the marks of other scripts are letters' halves). */
function loose(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]+/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
}

const JOINER = /\s*(?:,|&|\+|\band\b|\bwith\b|\bvs\.?|\bfeat\.?|\bft\.?|\bfeaturing)\s*/i;

/** The credited artists of an artist line, each in loose form, as a sorted set: "A & B", "B and A" and "A feat. B" credit the same two. */
function credits(artist: string): string[] {
  if (artist.length > MAX_LENGTH) return [];
  const names = artist
    .split(JOINER)
    .map((name) => loose(name.replace(/^\s*the\s+(?=\S)/i, '')))
    .filter(Boolean);
  return [...new Set(names)].sort();
}

/** The artist line to show: the artist, plus the artists a "(feat. X)" tag named when it does not name them already. */
export function artistLine(artist: string, featured: string[]): string {
  const have = new Set(credits(artist));
  const extra: string[] = [];
  const seen = new Set<string>();
  for (const f of featured.map((x) => x.trim()).filter(Boolean)) {
    const names = credits(f);
    const id = names.join('+');
    if (names.length === 0 || seen.has(id) || names.every((n) => have.has(n))) continue;
    seen.add(id);
    extra.push(f);
  }
  if (extra.length === 0) return artist;
  return /\b(?:feat|ft|featuring)\b/i.test(artist) ? `${artist} & ${extra.join(' & ')}` : `${artist} feat. ${extra.join(' & ')}`;
}

/** The first credited artist of an artist line, in loose form: "Calvin Harris & Dua Lipa" and "Calvin Harris feat. X" are "calvinharris". */
function leadCredit(artist: string): string {
  if (artist.length > MAX_LENGTH) return '';
  for (const name of artist.split(JOINER)) {
    const lead = loose(name.replace(/^\s*the\s+(?=\S)/i, ''));
    if (lead) return lead;
  }
  return '';
}

/**
 * What two listings must share to be one song: the lead artist (the first credit; featured artists and further
 * credits are set aside, so "Calvin Harris" and "Calvin Harris & Dua Lipa" credit one song, as the release eval
 * harness counts duplicates) and the title, compared with case, Latin accents, quote marks, dashes, "&" against
 * "and", spaces and other punctuation set aside. Both are what is shown, tags already removed. "the" in front of an
 * artist is set aside too ("The Killers", "Killers"); in a title it is part of the song. Null when either side is
 * left empty (a title of only symbols), so such songs never fold.
 */
export function foldKey(artist: string, title: string): string | null {
  if (title.length > MAX_LENGTH) return null;
  const a = leadCredit(artist);
  const t = loose(title);
  return a && t ? `${a}|${t}` : null;
}
