// Deezer track rank (QWW-37): one more popularity number, for songs with no USDB views, karaoke
// views or Year-End chart entry (mostly artist estimates from a library). Deezer's public search
// API needs no key or login and gives every track a `rank` (a whole number, higher is more
// popular). `npm run popularity:deezer` looks songs up in a batch and stores the rank per song key
// (song_deezer); `npm run popularity:calibrate` matches it to the shared scale. Deezer is never
// called while a page loads.
//
// The search is plain text ("artist title"): the quoted form artist:"..." track:"..." returned
// nothing when tried in November 2026. A result counts only when its artist and title match the
// song's key (matchesKey), a bracketed part of its title read as the title too: Deezer's "Good
// Riddance (Time of Your Life)" is our "Time Of Your Life". Among the results that match, the
// original studio recording wins (QWW-59, pickDeezerHit): a live take, a remix, a sped-up edit, a
// cover, a commentary track or a language version is never taken unless our title names that kind
// of recording, and a re-recording ("(2023 Version)", "(Taylor's Version)") only when the artist
// has no original among the results. The artist's own credit comes before a longer name that
// contains it, so a tribute act's plain title never beats the artist's re-recording.
//
// The plain search often buries the original under karaoke and cover tracks, or misses an artist Deezer
// names another way (QWW-67). So when it finds no original by the artist's own credit, findDeezerTrack
// also reads the artist's top 100 tracks and then searches the title alone, and pickDeezerHit decides
// among everything found. An album named live, remix and so on counts against a track as its title's
// tags do, and a credit Deezer spells its own way ("Pink" is "P!nk") goes by Deezer's name.

import { hasLittleSinging, songKey } from '../songs/resolve';
import { classifyTag } from '../songs/title';

/** One Deezer search result, the fields we read. */
export interface DeezerTrack {
  id: number;
  title: string;
  title_short?: string;
  /** The part of `title` Deezer counts as the version, e.g. "(2023 Version)" or "(Live Aid)"; unset or empty when none. */
  title_version?: string;
  rank: number;
  artist: { name: string };
  /** The album the track is on (QWW-67): a live or remix album counts against it, and a soundtrack names its film. */
  album?: { title: string };
  /** Length in seconds. */
  duration?: number;
}

/** One Deezer track by id (GET /track/<id>), the fields tempo reads (QWW-40). */
export interface DeezerTrackDetail extends DeezerTrack {
  /** Beats per minute; 0 when Deezer has none. */
  bpm: number;
  /** Link to a 30 second MP3 preview on Deezer's CDN. */
  preview?: string;
  /** "YYYY-MM-DD" (QWW-67). */
  release_date?: string;
}

/** One Deezer artist search result (GET /search/artist), the fields we read. */
export interface DeezerArtist {
  id: number;
  name: string;
  /** Deezer fans: of several artists with one name, the one people mean has the most. */
  nb_fan?: number;
}

/** What a lookup found: the best-ranked matching track, with what is stored about it (QWW-67). */
export interface DeezerHit {
  rank: number;
  deezerId: number;
  artist: string;
  title: string;
  album?: string;
  duration?: number;
  /** "YYYY-MM-DD", when the track was read by id. */
  releaseDate?: string;
}

/** Results per search: enough for the original plus its live and remastered takes. */
export const SEARCH_LIMIT = 10;
/** Results for a search on the title alone (QWW-67): other artists' songs with that title come first, so more. */
export const TITLE_SEARCH_LIMIT = 25;
/** An artist's top tracks read when the search finds no original (QWW-67): Deezer gives up to 100. */
export const ARTIST_TOP_LIMIT = 100;
/** Artists per artist search: the one with the name and the most fans is among the first. */
export const ARTIST_SEARCH_LIMIT = 10;

/**
 * Deezer's API limit is 50 requests per 5 seconds, but its CDN refused us (HTTP 403) after about
 * 45 minutes at 8 a second (Nov 2026), so this stays well under it.
 */
export const REQUESTS_PER_SECOND = 5;

/** The search text for a song: its artist and title, without version tags or featured artists. */
export function deezerQuery(artist: string, title: string): string {
  const [a, t] = songKey(artist, title).split('|');
  return `${a} ${t}`;
}

/**
 * A key part with punctuation dropped and "&" or "+" read as "and": "paint it, black" is "paint it black",
 * "kc & the sunshine band" is "kc and the sunshine band", "shut up + dance" is "shut up and dance". An apostrophe
 * joins the word up, so "fool's garden" is Deezer's "fools garden".
 */
const loose = (part: string) =>
  part
    .replace(/['’‘`´]/g, '')
    .replace(/[&+]/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Words in an artist name that make it someone else's recording: "OneRepublic Tribute Band", "Karaoke Hits of ...". */
const COVER_ARTIST = /\b(?:tribute|karaoke|covers?|made famous|in the style of|originally|as performed)\b/;
/** Words before a name that still credit the same singer: "Ms. Lauryn Hill", "The Notorious B.I.G.". */
const SAME_BEFORE = /^(?:(?:ms|mr|mrs|miss|dr|sir|dame|the) )*$/;
/** Words after a name that credit others alongside the same singer: "Bob Marley & The Wailers", "Lady Gaga & Bradley Cooper". */
const SAME_AFTER = /^$|^(?:and|with|x|vs|feat|featuring|ft) /;

/**
 * 'exact' when the artist names credit the same singer: the same name, or one with a title before it or co-credits after
 * it ("ms lauryn hill", "bob marley and the wailers"). 'contained' when one is the other with other words added ("elvis",
 * "elvis presley"; also a "We Love Taylor Swift" act, which is why it comes second). null otherwise, and null when the
 * words added make it a cover act ("taylor swift tribute").
 */
function artistMatch(a: string, b: string): 'exact' | 'contained' | null {
  if (a === b) return 'exact';
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  const padded = ` ${long} `;
  const at = padded.indexOf(` ${short} `);
  if (short.length < 3 || at < 0) return null;
  const before = padded.slice(1, at + 1);
  const after = padded.slice(at + short.length + 2);
  if (COVER_ARTIST.test(`${before}${after}`)) return null;
  return SAME_BEFORE.test(before) && SAME_AFTER.test(after) ? 'exact' : 'contained';
}

// ---------- other names for a credit (QWW-67) ----------

/**
 * Deezer's name for an act we credit another way, keyed by our credit as `loose` reads it: a spelling of its own ("Pink"
 * is "P!nk", "★N Sync" is "*NSYNC"), a new name ("Dixie Chicks" are "The Chicks") or a short one ("EAV"). The search
 * and the artist lookup use Deezer's name, and a track credited to it is the artist's own. Deezer also has an artist
 * named exactly "Pink" (15,607 fans to P!nk's 4.7 million, Nov 2026), which is why a name that matches is not enough.
 */
export const ARTIST_ALIASES: ReadonlyMap<string, string> = new Map([
  ['pink', 'P!nk'],
  ['n sync', '*NSYNC'],
  ['dixie chicks', 'The Chicks'],
  ['lady antebellum', 'Lady A'],
  ['erste allgemeine verunsicherung', 'EAV'],
  ['bibi and tina', 'Bibi und Tina'],
]);

/** Deezer's name for an act (a credit or one act of it, as a key reads it), or the act itself. */
const aliasOf = (act: string) => ARTIST_ALIASES.get(loose(act)) ?? act;
/** A credit as a key reads it, then as `loose` reads that: the form names are compared in. */
const creditOf = (name: string) => loose(songKey(name, '').split('|')[0] ?? '');
/** A title as a key reads it: lower case, without tags. Everything after the key's "|", since a title can hold one. */
const titlePart = (title: string) => songKey('', title).slice(1);

/**
 * What joins acts in one credit: "U2 and Green Day", "Sean Kingston / Justin Bieber", "Kid Cudi vs. Crookers", "Imagine
 * Dragons x J.I.D.", "Bryan Adams, Rod Stewart & Sting", "Ariana Grande & The Weeknd". A band's own name splits too
 * ("Bob Marley & The Wailers"); its acts are only tried after the whole credit.
 */
const JOIN = /\s*(?:,|\/|\bvs\.?(?=\s)|\bwith\b|\bx\b|&|\+|\band\b)\s*/;

/** The acts a credit names when it names more than one, each as a key part: "u2 and green day" is ["u2", "green day"]. */
export function creditedActs(credit: string): string[] {
  const acts = credit
    .split(JOIN)
    .map((a) => a.trim())
    .filter((a) => loose(a).length >= 2);
  return acts.length > 1 ? acts : [];
}

/** Words in an album title that make it a film's or a show's soundtrack or cast recording. */
const SOUNDTRACK = /\b(?:soundtrack|motion picture|cast recording|original cast|broadway cast|musical|ost|bande originale|filmmusik|original score)\b/;
/** "Disney’s " before a film's name: the credit names the film, not the singer. */
const DISNEY = /^(?:walt )?disney['’]s\s+/;

/** What may follow the work's name in its soundtrack's title: nothing, a subtitle, or soundtrack words. */
const AFTER_WORK = /^$|^\s*[:\-–—]|^\s+(?:the\s+)?(?:movie|film|original|motion picture|soundtrack|ost|musical|score|cast)\b/;
const apostrophes = (s: string) => s.replace(/[’‘`´]/g, "'");

/**
 * True when `album` is the soundtrack of the film or show a credit names: "Disney’s Aladdin" is "Aladdin (Original Motion
 * Picture Soundtrack)", "Disney’s Camp Rock 2" is "Camp Rock 2: The Final Jam (...)", "Hamilton" is "Hamilton (Original
 * Broadway Cast Recording)". Deezer credits such a song to its singers, so the album is what says it is the one. The
 * album's title starts with the work's name and goes on, if at all, with a subtitle or soundtrack words, so "Queen Of The
 * Damned (Soundtrack)" is not Queen's.
 */
function soundtrackOf(credit: string, album: string | undefined): boolean {
  if (!album) return false;
  const work = apostrophes(credit.replace(DISNEY, '')).trim();
  const base = apostrophes(titlePart(album));
  const whole = loose(album.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase());
  return work.length >= 4 && SOUNDTRACK.test(whole) && base.startsWith(work) && AFTER_WORK.test(base.slice(work.length));
}

// ---------- which recording a title names (QWW-59) ----------

/**
 * A recording that is not the song's original studio one. `version` is another recording of it by the artist: a
 * re-recording ("(2023 Version)", "(Taylor's Version)"), another take ("(Acoustic)", "(Piano Version)"), or a version
 * part Deezer splits off the title that no rule here names. `other-song` is what songs/title.ts keeps as a song of its
 * own: a language version ("(Spanish Version)") or a part. The others are never the original.
 */
export type Recording = 'live' | 'remix' | 'sped-up' | 'cover' | 'not-a-song' | 'other-song' | 'version';
/** Kinds a match is never taken as, unless our own title names the same kind. A `version` is only a fallback. */
const NEVER: ReadonlySet<Recording> = new Set(['live', 'remix', 'sped-up', 'cover', 'not-a-song', 'other-song']);

const SPED_UP = /\b(?:sped|speed)[ -]?up\b|\bslowed\b|\bnightcore\b|\breverb\b/;
const COVER = /\bcover(?:ed)?\b|\boriginally\b|\bmade famous\b|\bin the style of\b|\btribute\b|\bas performed\b/;
const NOT_A_SONG = /\bcommentary\b|\binterview\b|\bvoice memo\b|\brehearsal\b|\bspeech\b|\bdialogue\b|\btake \d+\b|\balternate take\b|\bouttake\b/;
/** A remix wherever the word sits: "(From "Frozen"/Dave Audé Club Remix)" names the film first; "(The Remixes)". */
const REMIXED = /\bre-?mix(?:e[sd])?\b|\brmx\b|\bbootleg\b|\bmash-?up\b/;
/** Another take by the artist: "(2017 Acoustic)", "(Piano Version)", "(Symphonic Version)", "(Demo)". */
const OTHER_TAKE = /\b(?:acoustic|piano|orchestral|symphonic|a ?cappella|stripped|demo|re-?record(?:ed|ing)?)\b/;
/** A re-recording by the artist, named so: "(2023 Version)", "(Taylor's Version)". */
const RE_RECORDED = /\b(?:19|20)\d\d version\b|\btaylor's version\b|\bre-?record(?:ed|ing)?\b/;
/** A take for a radio show or a streaming service, sung live in a studio (QWW-67): "(Recorded at Deezer, Sao Paulo)", "Deezer Session". */
const SESSION = /\brecorded (?:at|live|in)\b|\b(?:deezer|spotify|bbc|live|peel|tiny desk|mtv|kexp|apple music|amazon music|vevo|youtube) sessions?\b/;
/**
 * An album title, its tags left out, that says its tracks are live (QWW-67): "MTV Unplugged In New York", "Live at Wembley",
 * "Oral Fixation and Pies Descalzos LIVE", "Live 1975-85", "Caetano e Bethânia Ao Vivo". A title that only starts with the
 * word, like "Live Through This", is a studio album.
 */
const LIVE_ALBUM =
  /\bunplugged\b|\blive (?:at|in|from|on|aus|au|en)\b|(?:^|\s)live!?$|^live\b(?=\s*(?:$|[\d(:[–-]))|\bin concert\b|\b(?:ao|en|dal) vivo\b|\ben direct[eo]?\b/;
/** An album of remixes by its title (QWW-67): "The Remixes". */
const REMIX_ALBUM = /\bre-?mix(?:e[sd])?\b|\bmixes\b/;
/**
 * An album of someone else's recordings, anywhere in its title, tags included (QWW-67): "Anti-Hero (Karaoke Version)",
 * "Songs Made Famous By Adele", "Taylor Swift - Piano Covers". Not the bare word "cover": "Cover To Cover" is a best-of.
 */
const COVER_ALBUM = /\bkaraoke\b|\binstrumentals?\b|\btribute\b|\bmade famous\b|\bin the style of\b|\bas performed\b|\boriginally performed\b|\bcovers\b/;
/** Words that only say how the original recording was released: "(Single Version)", "(Radio Edit)", "(Original Mix)". */
const RELEASE_WORDS = new Set(
  'single album radio original main lp ep 7 12 inch mono stereo explicit clean edited edit uncensored censored uncut extended short long full deluxe bonus track us uk digital official audio video film movie soundtrack ost mix mixed version ver the a'.split(
    ' ',
  ),
);

/** The tags of a title: what is in each pair of brackets, and what follows a dash ("Song - Remastered 2011"). */
function tagsOf(title: string): string[] {
  const tags = [...title.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].map((m) => m[1] ?? m[2] ?? '');
  const dash = title.match(/\s+-\s(.*)$/);
  if (dash) tags.push(dash[1]!);
  return tags.filter((t) => t.trim());
}

/**
 * The kind of recording one tag names, or null when it names the original: a release tag ("(Radio Edit)",
 * "(Remastered 2011)", "(Deluxe Edition)", "(From "Frozen")", "(feat. X)") or a real subtitle ("(Time of Your Life)").
 * The tag grammar is QWW-49's (songs/title.ts classifyTag, what the song list strips); here a release tag stays the
 * original only when every word of it is a release word, so "(Single Version)" is the original and "(2023 Version)" is
 * not. `from`: whose title the tag is in. In a Deezer title, "live" anywhere is a live take ("(Live Aid)"); in our own,
 * only where the list strips it, since "(Live It Up)" can be a subtitle. Deezer's own version part (title_version) is
 * a version even when no rule names it.
 */
function recordingOf(tag: string, from: 'ours' | 'deezer' | 'deezer-version' = 'ours'): Recording | null {
  const t = tag.normalize('NFKC').toLowerCase().replace(/[’‘`´]/g, "'");
  if (SPED_UP.test(t)) return 'sped-up';
  if (COVER.test(t)) return 'cover';
  if (NOT_A_SONG.test(t)) return 'not-a-song';
  if (REMIXED.test(t)) return 'remix';
  const kind = classifyTag(tag)?.kind;
  if (kind === 'live' || ((kind !== undefined || from !== 'ours') && (/\blive\b/.test(t) || SESSION.test(t)))) return 'live';
  if (OTHER_TAKE.test(t)) return 'version';
  if (kind === undefined) {
    // Not a tag the list strips. Release words alone ("(Album Version Explicit)", QWW-67) still name the original; with
    // another word beside a version word it is one title.ts keeps on purpose, a language version or a part.
    if (t.split(/[^\p{L}\p{N}']+/u).filter(Boolean).every((w) => RELEASE_WORDS.has(w))) return null;
    if (/\b(?:version|ver|edit|mix)\b/.test(t)) return 'other-song';
    return from === 'deezer-version' ? 'version' : null;
  }
  if (kind === 'remix') return 'remix';
  if (kind === 'duet') return 'version';
  if (kind === 'edition' && /\bedition$/.test(t)) return null; // "(Deluxe Edition)", "(20th Anniversary Edition)"
  if (kind === 'version' || kind === 'edition' || kind === 'edit') {
    if (/remaster/.test(t)) return null;
    const words = t.split(/[^\p{L}\p{N}']+/u).filter(Boolean);
    // A year says which mix ("1985 Single Mix"), but which recording when it names a version ("2023 Version").
    if (words.every((w) => RELEASE_WORDS.has(w) || (kind === 'edit' && /^(?:19|20)\d{2}$/.test(w)))) return null;
    return kind === 'edit' ? 'remix' : 'version';
  }
  return null; // remaster, feat, context, tv, video: the original recording, released another way
}

/** The kinds of recording a title names, from its tags. */
export function recordingsOf(title: string): Set<Recording> {
  return new Set(tagsOf(title).flatMap((tag) => recordingOf(tag) ?? []));
}

/**
 * The kinds of recording an album's title says its tracks are (QWW-67): a tag as in a track's title ("(Live)", "(Acoustic
 * Version)", "(Taylor's Version)"), or the title itself ("MTV Unplugged In New York", "Deezer Session", "The Remixes",
 * "Karaoke Hits"). A tag that only says which release it is ("(Deluxe Edition)", "(Original Motion Picture Soundtrack)",
 * "(International Version)") names no kind: an album is reissued far more often than a song is re-recorded. A single or
 * an EP named after the song (`song`, a title as a key reads it) says nothing more than that it is a karaoke or cover
 * release: it carries several versions, each named in its own title, so "Girl on Fire (Remixes) - EP" and "I Hope You’re
 * Happy Now (Live)" hold the original too.
 */
export function albumRecordings(album: string, song = ''): Set<Recording> {
  const kinds = new Set<Recording>();
  if (COVER_ALBUM.test(album.normalize('NFKC').toLowerCase())) kinds.add('cover');
  const base = titlePart(album); // lower case, without tags
  if (song && loose(base) === loose(song)) return kinds;
  for (const tag of tagsOf(album)) {
    const kind = recordingOf(tag, 'deezer');
    if (kind === null || kind === 'other-song') continue;
    const t = tag.normalize('NFKC').toLowerCase().replace(/[’‘`´]/g, "'");
    if (kind !== 'version' || OTHER_TAKE.test(t) || RE_RECORDED.test(t)) kinds.add(kind);
  }
  if (LIVE_ALBUM.test(base) || SESSION.test(base)) kinds.add('live');
  if (REMIX_ALBUM.test(base)) kinds.add('remix');
  if (SPED_UP.test(base)) kinds.add('sped-up');
  return kinds;
}

/**
 * The kinds of recording a Deezer track is. Its version part (title_version) is read as a version whatever it says, and its
 * album's title counts as its own tags do (QWW-67) unless the album is named after the song (`song`, as a key reads it).
 */
function trackRecordings(track: Pick<DeezerTrack, 'title' | 'title_short' | 'title_version' | 'album'>, song = ''): Set<Recording> {
  const version = track.title_version?.trim() ? track.title_version : '';
  const title = version ? (track.title_short ?? track.title.replace(version, '')) : track.title;
  // A version part with no brackets ("Live") is one tag.
  const versionTags = version ? (tagsOf(version).length ? tagsOf(version) : [version]) : [];
  return new Set([
    ...tagsOf(title).flatMap((tag) => recordingOf(tag, 'deezer') ?? []),
    ...versionTags.flatMap((tag) => recordingOf(tag, 'deezer-version') ?? []),
    ...(track.album?.title ? albumRecordings(track.album.title, song) : []),
  ]);
}

/**
 * The title and each plain bracketed part of it (a subtitle, not a version tag) as a title of its own. That is the
 * title with its bracketed part swapped, since a key drops what is in brackets: "Good Riddance (Time of Your Life)"
 * also reads as "Time of Your Life".
 */
function titleReadings(title: string): string[] {
  const parts = [...title.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].map((m) => m[1] ?? m[2] ?? '');
  return [title, ...parts.filter((p) => p.trim() && classifyTag(p) === null && recordingOf(p, 'deezer') === null)];
}

/**
 * How a track's credit matches the song's, best first (QWW-67): 0 the artist's own credit ('exact', or Deezer's name for
 * the act in ARTIST_ALIASES), 1 one act of a shared credit ("U2" for "U2 and Green Day"), 2 a longer name that contains
 * the credit ('contained'), 3 the soundtrack of the film or show the credit names.
 */
type Credit = 0 | 1 | 2 | 3;

/** How the track's credit matches the key's, or null when the track is not the song with key `key`. */
function keyMatch(key: string, track: Pick<DeezerTrack, 'title' | 'title_short' | 'artist' | 'album'>): Credit | null {
  if (hasLittleSinging(track.title)) return null; // karaoke and instrumental versions share the title
  const [credit = '', ourTitle = ''] = key.split('|');
  const title = loose(ourTitle);
  // A medley title counts by its first song: "Hard to Say I'm Sorry / Get Away".
  const titles = [track.title, track.title_short ?? ''].flatMap(titleReadings).flatMap((t) => [t, t.split(' / ')[0]!]);
  if (!titles.some((t) => loose(songKey('', t).split('|')[1] ?? '') === title)) return null;
  const dArtist = creditOf(track.artist.name);
  // For an act Deezer names another way, only Deezer's name counts: an artist with our spelling is a namesake ("Pink").
  const how = artistMatch(creditOf(aliasOf(credit)), dArtist);
  if (how === 'exact') return 0;
  if (creditedActs(credit).some((act) => artistMatch(creditOf(aliasOf(act)), dArtist) === 'exact')) return 1;
  if (how === 'contained') return 2;
  return soundtrackOf(credit, track.album?.title) ? 3 : null;
}

/** True when a Deezer track is the song with key `key`. */
export function matchesKey(key: string, track: Pick<DeezerTrack, 'title' | 'title_short' | 'artist' | 'album'>): boolean {
  return keyMatch(key, track) !== null;
}

/** True when `a` sorts before `b`: the first place they differ decides, lower first. */
const sortsBefore = (a: number[], b: number[]) => {
  const i = a.findIndex((v, k) => v !== b[k]);
  return i >= 0 && a[i]! < b[i]!;
};

/**
 * The result that is the song's original studio recording, or null when none will do. `title` is our own title for the
 * song (not just its key): a version it names ("Song (Live at Donington)", "Song (Taylor's Version)") is not passed
 * over. Among the results that match `key`:
 *   - a live take, a remix, a sped-up edit, a cover, a commentary track or a language version is passed over, unless
 *     our title names that kind;
 *   - first, the artist's own credit (the same name, or with a title or co-credits: artistMatch 'exact') beats a
 *     longer name that contains it, so a "We Love Taylor Swift" act's plain title never beats Taylor Swift's track;
 *   - then the original (no tag, or only release tags like "(Remastered 2011)", "(Radio Edit)" or "(From "Frozen")"),
 *     even for a title that names a version: the list shows the song, its rank is the song's popularity, and the
 *     original is what people know. Then a version our title names, then, only when there is nothing better, a
 *     re-recording or another version Deezer names ("(2023 Version)", "(Taylor's Version)": Deezer's search has no
 *     "Shake It Off" but Taylor's Version);
 *   - then the best rank.
 * After QWW-67 the credit goes in finer steps (Credit): the artist's own, then one act of a shared credit, then a longer
 * name, then a soundtrack; and the album's title counts as the track's own tags do.
 */
export function pickDeezerHit(key: string, results: DeezerTrack[], title = ''): DeezerHit | null {
  const best = bestTrack(key, results, title);
  return best ? toHit(best.track) : null;
}

/** pickDeezerHit's choice and how it ranks: [credit, tier, -rank], lower first. Tier 0 is the original recording. */
function bestTrack(key: string, results: DeezerTrack[], title: string): { track: DeezerTrack; order: number[] } | undefined {
  const named = recordingsOf(title);
  let best: { track: DeezerTrack; order: number[] } | undefined;
  for (const t of results) {
    const credit = typeof t.rank === 'number' ? keyMatch(key, t) : null;
    if (credit === null) continue;
    const kinds = [...trackRecordings(t, key.split('|')[1])];
    if (kinds.some((k) => NEVER.has(k) && !named.has(k))) continue;
    const tier = kinds.length === 0 ? 0 : kinds.every((k) => named.has(k)) ? 1 : 2;
    const order = [credit, tier, -t.rank];
    if (!best || sortsBefore(order, best.order)) best = { track: t, order };
  }
  return best;
}

/** What is kept of a track that matched. */
function toHit(t: DeezerTrack | DeezerTrackDetail): DeezerHit {
  const hit: DeezerHit = { rank: t.rank, deezerId: t.id, artist: t.artist.name, title: t.title };
  if (t.album?.title) hit.album = t.album.title;
  if (typeof t.duration === 'number') hit.duration = t.duration;
  if ('release_date' in t && t.release_date) hit.releaseDate = t.release_date;
  return hit;
}

// ---------- the lookup: search, then the artist's top tracks, then the title alone (QWW-67) ----------

/**
 * Songs whose Deezer track was checked by hand (QWW-48, 12 Nov). Deezer's search and OneRepublic's top 100 hold only the
 * 2023 re-recording of Counting Stars, never its 2013 original, so a lookup would take the re-recording again. A lookup of
 * one of these reads the track by its id instead.
 */
export const HAND_CHECKED: ReadonlyMap<string, number> = new Map([
  ['onerepublic|counting stars', 65759979],
  ['green day|time of your life', 778429],
]);

/**
 * Where a lookup found its track: the plain search, a search naming every act (`acts`), the artist's top tracks, a search
 * on the title alone, or a hand check.
 */
export type DeezerRoute = 'search' | 'acts' | 'artist' | 'title' | 'hand';

/** What findDeezerTrack found, and where; `calls` counts the requests it made. */
export interface DeezerLookup {
  hit: DeezerHit | null;
  route?: DeezerRoute;
  calls: number;
}

/**
 * The search's original settles a lookup only when it ranks near the best-ranked track of the song under the artist's
 * own credit, of any version (QWW-67). A copy on a compilation can rank under 1% of that: "Too Close" on "Ultra Dance 14"
 * is 1,806 against 357,456 for the acoustic take, and Alex Clare's top tracks have the album's at 353,172.
 */
const SETTLED_SHARE = 0.25;

/** Of the artists a search found, the one named `name` (the same act as a credit reads it, "The Buggles" for "Buggles") with the most fans. */
function namedArtist(artists: DeezerArtist[], name: string): DeezerArtist | undefined {
  const wanted = creditOf(name);
  return artists.filter((a) => artistMatch(wanted, creditOf(a.name)) === 'exact').sort((a, b) => (b.nb_fan ?? 0) - (a.nb_fan ?? 0))[0];
}

/** Words that join acts, left out when comparing two searches. */
const JOIN_WORDS = /\b(?:and|feat|ft|featuring|with|vs|x)\b/g;
const bare = (q: string) => loose(q.toLowerCase()).replace(JOIN_WORDS, ' ').replace(/\s+/g, ' ').trim();

/**
 * The search with every act the credit and the title name (QWW-67), or null when it is the plain search: "Ariana Grande
 * feat. Zedd" and "Break Free" is "ariana grande zedd break free". A key leaves the featured acts out, and Deezer's
 * search often finds the original only with them: the plain search has "Break Free" as a live take and an a cappella only.
 */
export function everyActQuery(artist: string, title: string): string | null {
  if (!loose(titlePart(title))) return null;
  const featured = [...title.matchAll(/[([](?:feat|ft|featuring|with)\.?\s+([^)\]]+)[)\]]/gi)].map((m) => m[1]!);
  const acts = `${artist} ${featured.join(' ')}`.toLowerCase().replace(/\b(?:feat|ft|featuring)\b\.?/g, ' ');
  const query = `${acts} ${titlePart(title)}`.replace(/\s+/g, ' ').trim();
  return bare(query) === bare(deezerQuery(artist, title)) ? null : query;
}

/**
 * The song's Deezer track (QWW-67). First the plain search, "artist title" (with Deezer's name for the act, ARTIST_ALIASES).
 * When that has no original recording under the artist's own credit, or only a copy ranked far below the song's best
 * (SETTLED_SHARE): a search naming every act (everyActQuery), the artist's top 100 tracks (the artist with the name and the
 * most fans; then each act of a shared credit), then a search on the title alone, until one turns up the original.
 * pickDeezerHit's rules decide among everything found, so a fallback can only replace the search's choice with a better
 * one. A song in HAND_CHECKED is read by its id. With `releaseDate`, the chosen track is read by its id too, for its
 * release date (one call more).
 */
export async function findDeezerTrack(
  client: Pick<DeezerClient, 'search' | 'artists' | 'artistTop' | 'track'>,
  artist: string,
  title: string,
  opts: { releaseDate?: boolean } = {},
): Promise<DeezerLookup> {
  const key = songKey(artist, title);
  let calls = 0;
  const pinned = HAND_CHECKED.get(key);
  if (pinned !== undefined) {
    const track = await client.track(pinned);
    return track ? { hit: toHit(track), route: 'hand', calls: 1 } : { hit: null, calls: 1 };
  }
  const [credit = '', keyTitle = ''] = key.split('|');
  const alias = ARTIST_ALIASES.get(loose(credit));
  const found = new Map<number, { track: DeezerTrack; route: DeezerRoute }>();
  const add = (tracks: DeezerTrack[], route: DeezerRoute) => {
    calls++;
    for (const t of tracks) if (!found.has(t.id)) found.set(t.id, { track: t, route });
  };
  const best = () => bestTrack(key, [...found.values()].map((f) => f.track), title);
  /** An original recording under the artist's own credit, ranked near the song's best: enough, so no more calls. */
  const settled = () => {
    const b = best();
    if (b === undefined || b.order[0] !== 0 || b.order[1] !== 0) return false;
    const top = Math.max(...[...found.values()].map(({ track }) => (keyMatch(key, track) === 0 ? track.rank : 0)));
    return b.track.rank >= SETTLED_SHARE * top;
  };

  /** The artist's top tracks, when Deezer has an artist with that name; false when it has none. */
  const artistRoute = async (name: string) => {
    calls++;
    const named = namedArtist(await client.artists(name), name);
    if (named) add(await client.artistTop(named.id), 'artist');
    return named !== undefined;
  };

  // Deezer answers an empty query with an error, which the client would retry: a key part can be empty ("(Intro)").
  const plain = deezerQuery(alias ?? artist, title);
  if (loose(plain)) add(await client.search(plain), 'search');
  const acts = everyActQuery(alias ?? artist, title);
  if (!settled() && acts !== null) add(await client.search(acts), 'acts');
  // The whole credit's artist first; its acts only when Deezer has no artist by the whole name, so "AC/DC" is never "AC".
  if (!settled() && loose(credit) && !(await artistRoute(alias ?? credit)) && !alias) {
    for (const act of creditedActs(credit)) {
      if (settled()) break;
      await artistRoute(aliasOf(act));
    }
  }
  if (!settled() && loose(keyTitle)) add(await client.search(keyTitle, TITLE_SEARCH_LIMIT), 'title');

  const chosen = best();
  if (!chosen) return { hit: null, calls };
  const route = found.get(chosen.track.id)!.route;
  if (!opts.releaseDate) return { hit: toHit(chosen.track), route, calls };
  calls++;
  // The release date is only kept for audits: a failed read keeps the hit without it.
  const detail = await client.track(chosen.track.id).catch(() => null);
  return { hit: toHit(detail?.release_date ? { ...chosen.track, release_date: detail.release_date } : chosen.track), route, calls };
}

export class DeezerError extends Error {}

export type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface DeezerClientOptions {
  fetch?: Fetch;
  perSecond?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Tries per search before giving up, on a quota error or a server error. */
  tries?: number;
}

/**
 * Searches Deezer, spacing requests to stay under its limit and waiting out a quota error
 * (Deezer answers 200 with `{"error":{"code":4}}` when over it).
 */
export function createDeezerClient(opts: DeezerClientOptions = {}) {
  const doFetch: Fetch = opts.fetch ?? ((url) => fetch(url));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gap = 1000 / (opts.perSecond ?? REQUESTS_PER_SECOND);
  const tries = opts.tries ?? 5;
  let next = 0;
  /** Waits for this request's turn; turns are handed out one gap apart. */
  const turn = async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gap;
    if (at > now) await sleep(at - now);
  };
  /** One GET to `url` under the pacing and retry rules; null when Deezer has no such thing (error 800). */
  async function get<T>(url: string, what: string): Promise<T | null> {
    for (let i = 1; ; i++) {
      await turn();
      const res = await doFetch(url);
      const body = res.ok ? ((await res.json()) as { error?: { code?: number; message?: string } } & T) : undefined;
      if (body && !body.error) return body;
      if (body?.error?.code === 800) return null;
      const why = body?.error ? `error ${body.error.code}: ${body.error.message}` : `HTTP ${res.status}`;
      if (i >= tries || res.status === 403) throw new DeezerError(`Deezer ${what} failed (${why})`);
      await sleep(5000 * i);
    }
  }
  return {
    /** Waits for a turn: for requests that are not API calls (preview downloads) but count against the same limit. */
    wait: turn,
    /** One track by id: its bpm (0 when Deezer has none), 30 s preview link and title (QWW-40), or null when gone. */
    async track(id: number): Promise<DeezerTrackDetail | null> {
      return get<DeezerTrackDetail>(`https://api.deezer.com/track/${id}`, `track ${id}`);
    },
    /** Artists Deezer finds for `name` (QWW-67), the likeliest first. */
    async artists(name: string): Promise<DeezerArtist[]> {
      const body = await get<{ data?: DeezerArtist[] }>(
        `https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=${ARTIST_SEARCH_LIMIT}`,
        `artist search: ${name}`,
      );
      return body?.data ?? [];
    },
    /** An artist's most played tracks, up to ARTIST_TOP_LIMIT (QWW-67). */
    async artistTop(id: number): Promise<DeezerTrack[]> {
      const body = await get<{ data?: DeezerTrack[] }>(`https://api.deezer.com/artist/${id}/top?limit=${ARTIST_TOP_LIMIT}`, `artist ${id} top tracks`);
      return body?.data ?? [];
    },
    async search(q: string, limit: number = SEARCH_LIMIT): Promise<DeezerTrack[]> {
      const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=${limit}`;
      for (let i = 1; ; i++) {
        await turn();
        const res = await doFetch(url);
        const body = res.ok ? ((await res.json()) as { data?: DeezerTrack[]; error?: { code?: number; message?: string } }) : undefined;
        if (body && !body.error) return body.data ?? [];
        const why = body?.error ? `error ${body.error.code}: ${body.error.message}` : `HTTP ${res.status}`;
        // A 403 is the CDN refusing us, not a quota: retrying only prolongs it.
        if (i >= tries || res.status === 403) throw new DeezerError(`Deezer search failed (${why}): ${q}`);
        await sleep(5000 * i); // the quota counts 5 seconds back
      }
    },
  };
}

export type DeezerClient = ReturnType<typeof createDeezerClient>;
