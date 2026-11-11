// Release eval (QWW-52): the pass/fail checks for the QWW-42 success criteria 1 to 4 and 6, on five
// fixed test ranges. Everything here is pure: it takes the tuner's prepared songs and the facts the
// script looked up (Billboard, Deezer, the tempo judge's labels) and returns structured results. It
// asserts on ranked ids and labels only, never on model prose. scripts/eval-release.ts does the reading.
//
// How the list is cut for each check lives in VIEWS, the one place that knows the tuner's state. The
// lists come from the tuner's engine (QWW-47, POST /api/setlist: songs/setlist.ts rankPrepared), so the
// checks grade the lists a logged-out tester sees.

import type { EraId, GearId, Match, SetlistState, TunerPart, VocalRange } from '../contracts';
import { ERA_IDS, GEAR_IDS } from '../contracts';
import { rankPrepared, type PreparedSetlist } from '../songs/setlist';
import { DEFAULT_OFF, DEFAULTS, ERA_LABEL } from '../songs/setlistConfig';
import { songKey } from '../songs/resolve';
import { leadArtist } from '../popularity/import';

// ---------- the five test ranges ----------

export interface TestRange {
  id: string;
  label: string;
  range: VocalRange;
}

/**
 * Low male is Quinn-Wai's own range (F2 to C5, QWW-3 and QWW-31). The other four are typical
 * ranges (no tester recordings yet): tenor, alto, soprano, and a beginner's octave and a bit.
 */
export const TEST_RANGES: TestRange[] = [
  { id: 'low-male', label: 'Low male (Quinn-Wai, F2-C5)', range: { low: 41, high: 72, source: 'test' } },
  { id: 'high-male', label: 'High male (C3-C5)', range: { low: 48, high: 72, source: 'test' } },
  { id: 'low-female', label: 'Low female (F3-F5)', range: { low: 53, high: 77, source: 'test' } },
  { id: 'high-female', label: 'High female (A3-A5)', range: { low: 57, high: 81, source: 'test' } },
  { id: 'beginner', label: 'Narrow beginner (G3-A4)', range: { low: 55, high: 69, source: 'test' } },
];

// ---------- the views each check reads: the tuner's state, ranked by its engine ----------

export type Era = EraId;
export type TempoEnd = 'slow' | 'upbeat';
/** The gears a logged-out singer has, at either end. History needs a login, so it is left out. */
export const GEARS = ['difficulty', 'popularity', 'tempo'] as const;
export type Gear = (typeof GEARS)[number];
export const ERAS: Era[] = ERA_IDS;
/** An era as the tuner labels it, or "any era" with Era off. */
export const eraName = (era: Era | null) => (era ? ERA_LABEL[era] : 'any era');

const { eras: _eras, ...firstGears } = DEFAULTS;
/** The tuner as the sheet loads (setlistConfig.ts): Popularity and Difficulty on, the rest reset, Era off. */
const FIRST: SetlistState = { gears: firstGears, off: [...DEFAULT_OFF], eras: [] };
/** Every part reset: the base the tempo ends switch Tempo alone on from. */
const NOTHING_ON: SetlistState = { gears: firstGears, off: [...GEAR_IDS, 'era'], eras: [] };

/** `base` with `gear` switched on at `at`, and only `era` picked (null: Era stays off). */
function tuned(base: SetlistState, era: Era | null, gear: GearId, at: number): SetlistState {
  const off: TunerPart[] = base.off.filter((p) => p !== gear && (era === null || p !== 'era'));
  return { gears: { ...base.gears, [gear]: at }, off, eras: era ? [era] : [] };
}

const ranked = (p: PreparedSetlist, s: SetlistState): Match[] => rankPrepared(p, { ...s, loggedIn: false }).songs.map((x) => x.match);

export const VIEWS = {
  /** What a logged-out singer sees first. */
  default: (p: PreparedSetlist) => ranked(p, FIRST),
  /** Difficulty all the way to Locked in. */
  maxDifficulty: (p: PreparedSetlist) => ranked(p, tuned(FIRST, null, 'difficulty', 100)),
  /**
   * Tempo alone at one end, in one era (null: Era off): "with Tempo at the slow end, the 20 slowest by effective
   * tempo" (QWW-54). Popularity and Difficulty are reset so they cannot pull mid songs in.
   */
  eraTempo: (p: PreparedSetlist, era: Era | null, end: TempoEnd) => ranked(p, tuned(NOTHING_ON, era, 'tempo', end === 'slow' ? 0 : 100)),
  /** One era (or none) and one gear at one end, the rest as the sheet loads. */
  eraGear: (p: PreparedSetlist, era: Era | null, gear: Gear, at: 0 | 100) => ranked(p, tuned(FIRST, era, gear, at)),
};

// ---------- facts the script looks up ----------

/** What the script knows about one song (by track id), from sources the ranking does not grade itself on. */
export interface SongFacts {
  deezerRank?: number;
  /** Deezer answered this track with a non-empty 30 s preview; 'error' when Deezer could not be asked (quota, network). */
  playable?: boolean | 'error';
}

/** A Deezer rank at or above this counts as a hit (about the top tenth of the catalogue's ranked songs). */
export const DEEZER_HIGH_RANK = 600_000;

const key = (m: Match) => m.track.id.replace(/^cat:/, '');
const brief = (m: Match) => ({ id: m.track.id, artist: m.track.artist, title: m.track.title, year: m.year });

// ---------- 1. recognisable ----------

export function isRecognisable(m: Match, billboard: Set<string>, facts: SongFacts | undefined): 'billboard' | 'deezer' | null {
  const { artist, title } = m.track;
  if (billboard.has(songKey(artist, title)) || billboard.has(songKey(leadArtist(artist), title))) return 'billboard';
  if ((facts?.deezerRank ?? 0) >= DEEZER_HIGH_RANK) return 'deezer';
  return null;
}

// ---------- 4. titles ----------

const VERSION_WORDS =
  /\b(version|live|remaster(ed)?|edit|mix|remix|acoustic|duet|radio|demo|mono|stereo|album|extended|explicit|clean|unplugged|instrumental|karaoke|cover|deluxe|bonus|re-?recorded|taylor's|sped up|slowed|feat\.?|ft\.|featuring)\b/i;

/**
 * True for a title that names a version: anything in square brackets ("[DUET]"), or a version word
 * in round brackets or after " - " ("(Live)", "- Remastered 2011", "(feat. X)"). Real titles with
 * brackets ("(I Can't Get No) Satisfaction", "Don't You (Forget About Me)") pass.
 */
export function isVersionTitle(title: string): boolean {
  if (/\[[^\]]*\]/.test(title)) return true;
  const tags = [...title.matchAll(/\(([^)]*)\)/g)].map((x) => x[1]!);
  const dash = title.match(/\s+-\s(.*)$/);
  if (dash) tags.push(dash[1]!);
  return tags.some((t) => VERSION_WORDS.test(t));
}

/** Curly apostrophes as straight ones: "Livin’ la vida loca" and "Livin' La Vida Loca" are one song. */
const straight = (s: string) => s.replace(/[‘’]/g, "'");

/** The same song twice: same lead artist and the same title once version tags are gone. */
export const sameSongKey = (m: Match) => songKey(straight(leadArtist(m.track.artist)), straight(m.track.title));

// ---------- 2. tempo judge ----------

export type JudgeLabel = 'slow' | 'mid' | 'upbeat' | 'unknown';
export const JUDGE_LABELS: JudgeLabel[] = ['slow', 'mid', 'upbeat', 'unknown'];

/** What the judge sees: artist, title and year, nothing we stored about tempo or feel. */
export interface JudgeSong {
  id: number;
  artist: string;
  title: string;
  year?: number;
}

export const JUDGE_SYSTEM = [
  'You are a music expert helping check a karaoke app. For each song, say how the original recording feels, from what you know of it:',
  '"slow": a ballad or slow jam, slow and gentle.',
  '"upbeat": fast or energetic, a song people dance or bounce to.',
  '"mid": in between, a mid-tempo song that is neither.',
  '"unknown": you do not know this song well enough to say.',
  'Answer for every id given, with one label each.',
].join('\n');

export const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    labels: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, label: { type: 'string', enum: JUDGE_LABELS } },
        required: ['id', 'label'],
        additionalProperties: false,
      },
    },
  },
  required: ['labels'],
  additionalProperties: false,
};

export function judgePrompt(songs: JudgeSong[]): string {
  return songs.map((s) => `${s.id}. ${s.artist} - ${s.title}${s.year ? ` (${s.year})` : ''}`).join('\n');
}

/**
 * `items` in a fixed pseudo-random order, one order per seed (mulberry32). The tempo lists are sorted by stored
 * tempo, so sending their songs in list order would tell the judge which ones we think are slow. Each run gets
 * its own seed, so no order is shared by the runs that vote.
 */
export function shuffled<T>(items: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/** The labels in one reply, by id; ids the reply skipped or mangled are left out (they count as unknown). */
export function parseJudgeReply(text: string): Map<number, JudgeLabel> {
  const out = new Map<number, JudgeLabel>();
  try {
    const json = JSON.parse(text) as { labels?: { id?: unknown; label?: unknown }[] };
    for (const l of json.labels ?? []) {
      if (typeof l.id === 'number' && JUDGE_LABELS.includes(l.label as JudgeLabel)) out.set(l.id, l.label as JudgeLabel);
    }
  } catch {
    // an unparseable reply labels nothing
  }
  return out;
}

// The grading Quinn-Wai set for criterion 2 (QWW-42, 11 Nov 14:45 UTC): every era is graded at both ends,
// whatever the size of its pool; a song counts when at least 2 of 3 judge runs give the end's label; an end
// passes when at least 18 of its top 20 count.

/** The judge runs each song gets. */
export const JUDGE_RUNS = 3;
/** The runs that must give the end's label for a song to count. */
export const JUDGE_AGREE = 2;
/** The songs graded at each end. */
export const END_TOP = 20;
/** The songs of the top END_TOP that must count for the end to pass. */
export const END_PASS = 18;

/** Whether a song counts at its end of the tempo gear: at least JUDGE_AGREE of the runs gave the end's label. */
export function fitsEnd(labels: JudgeLabel[], end: TempoEnd): boolean {
  return labels.filter((l) => l === end).length >= JUDGE_AGREE;
}

// ---------- the checks ----------

export interface Check {
  criterion: 1 | 2 | 3 | 4 | 6;
  range: string;
  pass: boolean;
  /** The number the criterion is judged on, e.g. "17/20". */
  value: string;
  want: string;
  /** Ids or short notes behind a failure, for the details section. */
  notes: string[];
}

export interface RangeInput {
  test: TestRange;
  /** The catalogue's songs that fit the range, with their places on every gear, as POST /api/setlist ranks them. */
  prepared: PreparedSetlist;
}

export function checkRecognisable(t: RangeInput, billboard: Set<string>, facts: Map<string, SongFacts>): Check {
  const top = VIEWS.default(t.prepared).slice(0, 20);
  const misses = top.filter((m) => !isRecognisable(m, billboard, facts.get(m.track.id)));
  const hits = top.length - misses.length;
  return {
    criterion: 1,
    range: t.test.id,
    pass: top.length >= 20 && hits >= 15,
    value: `${hits}/${top.length}`,
    want: '>=15/20',
    notes: misses.map((m) => `${m.track.artist} - ${m.track.title}`),
  };
}

export function checkNeverEmpty(t: RangeInput): Check {
  const { prepared, test } = t;
  const notes: string[] = [];
  const hardest = VIEWS.maxDifficulty(prepared).length;
  if (hardest < 10) notes.push(`max difficulty: ${hardest} songs`);
  for (const era of [null, ...ERAS]) {
    for (const gear of GEARS) {
      for (const at of [0, 100] as const) {
        const n = VIEWS.eraGear(prepared, era, gear, at).length;
        if (n === 0) notes.push(`${eraName(era)} + ${gear} at ${at}: 0 songs`);
      }
    }
  }
  return {
    criterion: 3,
    range: test.id,
    pass: notes.length === 0,
    value: `max difficulty ${hardest}; ${notes.filter((n) => n.endsWith(': 0 songs')).length} empty combos`,
    want: '>=10; 0 empty',
    notes,
  };
}

export function checkTitles(t: RangeInput): Check {
  const top = VIEWS.default(t.prepared).slice(0, 50);
  const versions = top.filter((m) => isVersionTitle(m.track.title));
  const seen = new Map<string, Match>();
  const dupes: string[] = [];
  for (const m of top) {
    const k = sameSongKey(m);
    const first = seen.get(k);
    if (first) dupes.push(`${m.track.artist} - ${m.track.title} (same as ${first.track.artist} - ${first.track.title})`);
    else seen.set(k, m);
  }
  return {
    criterion: 4,
    range: t.test.id,
    pass: versions.length === 0 && dupes.length === 0,
    value: `${versions.length} version, ${dupes.length} duplicate`,
    want: '0, 0',
    notes: [...versions.map((m) => `version title: ${m.track.artist} - ${m.track.title}`), ...dupes.map((d) => `duplicate: ${d}`)],
  };
}

export function checkPlay(t: RangeInput, facts: Map<string, SongFacts>): Check {
  const top = VIEWS.default(t.prepared).slice(0, 20);
  const missing = top.filter((m) => facts.get(m.track.id)?.playable !== true);
  const errors = missing.filter((m) => facts.get(m.track.id)?.playable === 'error').length;
  const ok = top.length - missing.length;
  return {
    criterion: 6,
    range: t.test.id,
    pass: top.length > 0 && ok / top.length >= 0.9,
    value: `${ok}/${top.length}${errors ? ` (${errors} not checked: Deezer error)` : ''}`,
    want: '>=90%',
    notes: missing.map((m) => `${facts.get(m.track.id)?.playable === 'error' ? 'Deezer error' : 'no preview'}: ${m.track.artist} - ${m.track.title}`),
  };
}

/** One tempo list: the top 20 of one range, one era (or none) and one end of the tempo gear. */
export interface TempoList {
  range: string;
  era: Era | null;
  end: TempoEnd;
  songs: Match[];
}

/** Both ends of every era, and of Era off, for one range. No era is left out, however few songs it has. */
export function tempoLists(t: RangeInput): TempoList[] {
  const out: TempoList[] = [];
  for (const era of [null, ...ERAS]) {
    for (const end of ['slow', 'upbeat'] as const) {
      out.push({ range: t.test.id, era, end, songs: VIEWS.eraTempo(t.prepared, era, end).slice(0, END_TOP) });
    }
  }
  return out;
}

export interface TempoResult {
  list: TempoList;
  /** The songs of the top END_TOP that count (fitsEnd). */
  counted: number;
  /** The ones that do not, as "Artist - Title (the runs' labels)". */
  missed: string[];
  pass: boolean;
}

/**
 * An end passes when at least END_PASS of its top END_TOP count. There is no minimum pool size: a thin era is
 * graded like the rest, so one whose list is short, or filled out with songs of the wrong feel, fails.
 */
export function judgeList(list: TempoList, labels: Map<string, JudgeLabel[]>): TempoResult {
  const missed: string[] = [];
  let counted = 0;
  for (const m of list.songs.slice(0, END_TOP)) {
    const ls = labels.get(key(m)) ?? [];
    if (fitsEnd(ls, list.end)) counted++;
    else missed.push(`${m.track.artist} - ${m.track.title} (${ls.join(', ') || 'no labels'})`);
  }
  return { list, counted, missed, pass: counted >= END_PASS };
}

export function checkTempo(range: string, results: TempoResult[]): Check {
  const mine = results.filter((r) => r.list.range === range);
  const failed = mine.filter((r) => !r.pass);
  return {
    criterion: 2,
    range,
    pass: mine.length > 0 && failed.length === 0,
    value: `${mine.length - failed.length}/${mine.length} era-ends`,
    want: 'all',
    notes: failed.map(
      (r) =>
        `${eraName(r.list.era)} ${r.list.end}: ${r.counted}/${END_TOP} count${r.list.songs.length < END_TOP ? ` (only ${r.list.songs.length} songs in the pool)` : ''}` +
        (r.missed.length ? `. Not counted: ${r.missed.join('; ')}` : ''),
    ),
  };
}

/** The song keys the judge needs, once each, with what it may see. */
export function judgeSongs(lists: TempoList[]): { key: string; song: Omit<JudgeSong, 'id'> }[] {
  const seen = new Map<string, Omit<JudgeSong, 'id'>>();
  for (const l of lists) for (const m of l.songs) if (!seen.has(key(m))) seen.set(key(m), { artist: m.track.artist, title: m.track.title, year: m.year });
  return [...seen].map(([k, song]) => ({ key: k, song }));
}

// ---------- report ----------

const CRITERIA: Record<Check['criterion'], string> = {
  1: '1. Recognisable (top 20)',
  2: '2. Tempo ends, every era (judge: 2 of 3 runs)',
  3: '3. Never empty',
  4: '4. Titles (top 50)',
  6: '6. Play (top 20 with a Deezer preview)',
};

/** The lists Quinn-Wai checks by ear, criterion 2's sampled human check: the ’90s for F2 to C5, as QWW-54 proposed. */
export const HAND_CHECK: { range: string; era: Era } = { range: 'low-male', era: 's90' };

export interface HandCheck {
  range: string;
  era: Era;
  ends: {
    end: TempoEnd;
    songs: { artist: string; title: string; year?: number; bpm?: number; labels: JudgeLabel[]; counts: boolean }[];
  }[];
}

/** Both ends of the HAND_CHECK era, as graded: each song with the judge's labels and whether it counts. */
export function handCheck(lists: TempoList[], labels: Map<string, JudgeLabel[]>): HandCheck {
  const ends = (['slow', 'upbeat'] as const).map((end) => {
    const list = lists.find((l) => l.range === HAND_CHECK.range && l.era === HAND_CHECK.era && l.end === end);
    const songs = (list?.songs ?? []).map((m) => {
      const ls = labels.get(key(m)) ?? [];
      return { artist: m.track.artist, title: m.track.title, year: m.year, bpm: m.tempo, labels: ls, counts: fitsEnd(ls, end) };
    });
    return { end, songs };
  });
  return { ...HAND_CHECK, ends };
}

export interface Report {
  title: string;
  checks: Check[];
  top10: { range: TestRange; songs: ReturnType<typeof brief>[] }[];
  /** Null when the judge did not run. */
  handCheck: HandCheck | null;
  /** Notes about the run (which database, model, what was skipped). */
  meta: string[];
}

export function topTen(t: RangeInput) {
  return VIEWS.default(t.prepared).slice(0, 10).map(brief);
}

/**
 * PASS needs every criterion checked on every range, and all of them passing: a skipped criterion is
 * not a pass. INCOMPLETE when everything that ran passed but something was skipped.
 */
export function verdict(checks: Check[]): 'PASS' | 'FAIL' | 'INCOMPLETE' {
  if (checks.some((c) => !c.pass)) return 'FAIL';
  const crits = Object.keys(CRITERIA).map(Number) as Check['criterion'][];
  const complete = crits.every((c) => TEST_RANGES.every((t) => checks.some((x) => x.criterion === c && x.range === t.id)));
  return complete ? 'PASS' : 'INCOMPLETE';
}

export function toMarkdown(r: Report): string {
  const ranges = TEST_RANGES.map((t) => t.id);
  const cell = (c: Check | undefined) => (c ? `${c.pass ? 'PASS' : '**FAIL**'} ${c.value}` : 'not run');
  const crits = (Object.keys(CRITERIA).map(Number) as Check['criterion'][]).filter((c) => r.checks.some((x) => x.criterion === c));
  const lines = [
    `## ${r.title}: ${verdict(r.checks)}`,
    '',
    ...r.meta.map((m) => `- ${m}`),
    '',
    `| Criterion | ${ranges.join(' | ')} |`,
    `|---|${ranges.map(() => '---').join('|')}|`,
    ...crits.map((c) => `| ${CRITERIA[c]} | ${ranges.map((id) => cell(r.checks.find((x) => x.criterion === c && x.range === id))).join(' | ')} |`),
    '',
    `Targets: 1 at least 15/20; 2 every era (and Era off), at both ends, has at least ${END_PASS} of its top ${END_TOP} counting, a song counting when at least ${JUDGE_AGREE} of ${JUDGE_RUNS} judge runs give the end's label; 3 max difficulty at least 10 and no empty era + gear combination; 4 zero version titles and duplicates; 6 at least 90%.`,
  ];
  const failed = r.checks.filter((c) => !c.pass && c.notes.length);
  if (failed.length) {
    lines.push('', '<details><summary>Failure details</summary>', '');
    for (const c of failed) {
      lines.push(`**${CRITERIA[c.criterion]}, ${c.range}**`, '', ...c.notes.slice(0, 25).map((n) => `- ${n}`));
      if (c.notes.length > 25) lines.push(`- ... and ${c.notes.length - 25} more`);
      lines.push('');
    }
    lines.push('</details>');
  }
  lines.push('', '### Top 10 per range (for the recognisability check, criterion 1b)', '');
  for (const t of r.top10) {
    lines.push(`**${t.range.label}**`, '', ...t.songs.map((s, i) => `${i + 1}. ${s.artist} - ${s.title}${s.year ? ` (${s.year})` : ''}`), '');
  }
  if (r.handCheck) {
    const h = r.handCheck;
    const label = TEST_RANGES.find((t) => t.id === h.range)?.label ?? h.range;
    lines.push(`### Tempo hand check: ${label}, ${eraName(h.era)}`, '');
    for (const { end, songs } of h.ends) {
      lines.push(`**${end === 'slow' ? 'Slow' : 'Upbeat'} end, top ${songs.length}: ${songs.filter((s) => s.counts).length} count**`, '');
      lines.push(`| # | Song | Year | Effective bpm | Judge (${JUDGE_RUNS} runs) | Counts |`, '|---|---|---|---|---|---|');
      songs.forEach((s, i) =>
        lines.push(`| ${i + 1} | ${s.artist} - ${s.title} | ${s.year ?? ''} | ${s.bpm === undefined ? '' : Math.round(s.bpm)} | ${s.labels.join(', ')} | ${s.counts ? 'yes' : '**no**'} |`),
      );
      lines.push('');
    }
  }
  return lines.join('\n') + '\n';
}
