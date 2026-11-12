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
// cover or a commentary track is never taken unless our title names that kind of recording, and a
// re-recording ("(2023 Version)", "(Taylor's Version)") only when there is no original to take.

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
}

/** One Deezer track by id (GET /track/<id>), the fields tempo reads (QWW-40). */
export interface DeezerTrackDetail extends DeezerTrack {
  /** Beats per minute; 0 when Deezer has none. */
  bpm: number;
  /** Link to a 30 second MP3 preview on Deezer's CDN. */
  preview?: string;
}

/** What a lookup found: the best-ranked matching track. */
export interface DeezerHit {
  rank: number;
  deezerId: number;
  artist: string;
  title: string;
}

/** Results per search: enough for the original plus its live and remastered takes. */
export const SEARCH_LIMIT = 10;

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

/**
 * 'exact' when the artist names are the same, 'contained' when one is the other with words added ("ms lauryn hill",
 * "lauryn hill"), null otherwise, and null too when the words added make it a cover act ("taylor swift tribute").
 */
function artistMatch(a: string, b: string): 'exact' | 'contained' | null {
  if (a === b) return 'exact';
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  if (short.length < 3 || !` ${long} `.includes(` ${short} `)) return null;
  return COVER_ARTIST.test(` ${long} `.replace(` ${short} `, ' ')) ? null : 'contained';
}

// ---------- which recording a title names (QWW-59) ----------

/**
 * A recording that is not the song's original studio one. `version` is another recording or release of it: a
 * re-recording ("(2023 Version)", "(Taylor's Version)", "(Acoustic)"), a language version, or a version part Deezer
 * splits off the title that no rule here names. The others are never the original.
 */
export type Recording = 'live' | 'remix' | 'sped-up' | 'cover' | 'not-a-song' | 'version';
/** Kinds a match is never taken as, unless our own title names the same kind. A `version` is only a fallback. */
const NEVER: ReadonlySet<Recording> = new Set(['live', 'remix', 'sped-up', 'cover', 'not-a-song']);

const SPED_UP = /\b(?:sped|speed)[ -]?up\b|\bslowed\b|\bnightcore\b|\breverb\b/;
const COVER = /\bcover(?:ed)?\b|\boriginally\b|\bmade famous\b|\bin the style of\b|\btribute\b|\bas performed\b/;
const NOT_A_SONG = /\bcommentary\b|\binterview\b|\bvoice memo\b|\brehearsal\b|\bspeech\b|\bdialogue\b|\btake \d+\b|\balternate take\b|\bouttake\b/;
/** A remix wherever the word sits: "(From "Frozen"/Dave Audé Club Remix)" names the film first. */
const REMIXED = /\bre-?mix(?:ed)?\b|\brmx\b|\bbootleg\b|\bmash-?up\b/;
/** Another take by the artist: "(2017 Acoustic)", "(Piano Version)", "(Symphonic Version)", "(Demo)". */
const OTHER_TAKE = /\b(?:acoustic|piano|orchestral|symphonic|a ?cappella|stripped|demo|re-?record(?:ed|ing)?)\b/;
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
 * "(Remastered 2011)", "(From "Frozen")", "(feat. X)") or a real subtitle ("(Time of Your Life)"). The tag grammar is
 * QWW-49's (songs/title.ts classifyTag, what the song list strips); here a release tag stays the original only when
 * every word of it is a release word, so "(Single Version)" is the original and "(2023 Version)" is not.
 * `deezerVersion`: the tag is Deezer's own version part (title_version), so it is a version even when no rule names
 * it, and "live" anywhere in it is a live take ("(Live Aid)").
 */
function recordingOf(tag: string, deezerVersion = false): Recording | null {
  const t = tag.normalize('NFKC').toLowerCase().replace(/[’‘`´]/g, "'");
  if (SPED_UP.test(t)) return 'sped-up';
  if (COVER.test(t)) return 'cover';
  if (NOT_A_SONG.test(t)) return 'not-a-song';
  if (REMIXED.test(t)) return 'remix';
  const kind = classifyTag(tag)?.kind;
  // "Live" in a tag the list strips ("(Live Version)") or in Deezer's version part ("(Live Aid)"), not in a subtitle ("(Live It Up)").
  if (kind === 'live' || ((kind !== undefined || deezerVersion) && /\blive\b/.test(t))) return 'live';
  if (OTHER_TAKE.test(t)) return 'version';
  // Not a tag the list strips: a subtitle, or a version title.ts keeps on purpose (a language version, a part).
  if (kind === undefined) return deezerVersion || /\b(?:version|ver|edit|mix)\b/.test(t) ? 'version' : null;
  if (kind === 'remix') return 'remix';
  if (kind === 'duet') return 'version';
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

/** The kinds of recording a Deezer track is. Its version part (title_version) is read as a version whatever it says. */
function trackRecordings(track: Pick<DeezerTrack, 'title' | 'title_short' | 'title_version'>): Set<Recording> {
  const version = track.title_version?.trim() ? track.title_version : '';
  const title = version ? (track.title_short ?? track.title.replace(version, '')) : track.title;
  return new Set([...tagsOf(title).flatMap((tag) => recordingOf(tag) ?? []), ...tagsOf(version).flatMap((tag) => recordingOf(tag, true) ?? [])]);
}

/**
 * The title and, for each plain bracketed part of it (a subtitle, not a version tag), that part as the title: the title
 * and its bracketed part swapped, so "Good Riddance (Time of Your Life)" also reads "Time of Your Life (Good Riddance)".
 */
function titleReadings(title: string): string[] {
  const parts = [...title.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].map((m) => m[1] ?? m[2] ?? '');
  return [title, ...parts.filter((p) => p.trim() && classifyTag(p) === null && recordingOf(p) === null)];
}

/** How the track's artist matches the key's, or null when the track is not the song with key `key`. */
function keyMatch(key: string, track: Pick<DeezerTrack, 'title' | 'title_short' | 'artist'>): 'exact' | 'contained' | null {
  if (hasLittleSinging(track.title)) return null; // karaoke and instrumental versions share the title
  const [artist = '', title = ''] = key.split('|').map(loose);
  const [dArtist = ''] = songKey(track.artist.name, '').split('|').map(loose);
  const how = artistMatch(artist, dArtist);
  if (!how) return null;
  // A medley title counts by its first song: "Hard to Say I'm Sorry / Get Away".
  const titles = [track.title, track.title_short ?? ''].flatMap(titleReadings).flatMap((t) => [t, t.split(' / ')[0]!]);
  return titles.some((t) => loose(songKey('', t).split('|')[1] ?? '') === title) ? how : null;
}

/** True when a Deezer track is the song with key `key`. */
export function matchesKey(key: string, track: Pick<DeezerTrack, 'title' | 'title_short' | 'artist'>): boolean {
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
 *   - a live take, a remix, a sped-up edit, a cover or a commentary track is passed over, unless our title names
 *     that kind;
 *   - the original comes first (no tag, or only release tags like "(Remastered 2011)", "(Radio Edit)" or
 *     "(From "Frozen")"), even for a title that names a version: the list shows the song, its rank is the song's
 *     popularity, and the original is what people know. Then a version our title names, then, only when there is
 *     nothing better, a re-recording or another version Deezer names ("(2023 Version)", "(Taylor's Version)": Deezer's
 *     search has no "Shake It Off" but Taylor's Version);
 *   - before all that, an artist named exactly beats one named with words added, so a "We Love Taylor Swift" act's
 *     plain title never beats Taylor Swift's own track;
 *   - then the best rank.
 */
export function pickDeezerHit(key: string, results: DeezerTrack[], title = ''): DeezerHit | null {
  const named = recordingsOf(title);
  let best: { track: DeezerTrack; order: number[] } | undefined;
  for (const t of results) {
    const how = typeof t.rank === 'number' ? keyMatch(key, t) : null;
    if (!how) continue;
    const kinds = [...trackRecordings(t)];
    if (kinds.some((k) => NEVER.has(k) && !named.has(k))) continue;
    const tier = kinds.length === 0 ? 0 : kinds.every((k) => named.has(k)) ? 1 : 2;
    const order = [how === 'exact' ? 0 : 1, tier, -t.rank];
    if (!best || sortsBefore(order, best.order)) best = { track: t, order };
  }
  const hit = best?.track;
  return hit ? { rank: hit.rank, deezerId: hit.id, artist: hit.artist.name, title: hit.title } : null;
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
    async search(q: string): Promise<DeezerTrack[]> {
      const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}`;
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
