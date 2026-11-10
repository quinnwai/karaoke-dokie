// Release eval (QWW-52): the pass/fail checks for the QWW-42 success criteria 1 to 4 and 6, on five
// fixed test ranges. Everything here is pure: it takes the ranked matches and the facts the script
// looked up (Billboard, Deezer, the tempo judge's labels) and returns structured results. It asserts
// on ranked ids and labels only, never on model prose. scripts/eval-release.ts does the reading.
//
// How the list is cut for each check lives in VIEWS, the one place that knows the results view's
// shape. When the tuner changes it (QWW-46: multi-select era, gears; QWW-47: the ranking), update
// VIEWS and the checks keep working.

import type { Decade, Match, ResultsView, VocalRange } from '../contracts';
import { DECADES, DEFAULT_VIEW, viewMatches } from '../songs/browse';
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

// ---------- the views each check reads (update with QWW-46 / QWW-47) ----------

export type Era = Decade;
export type TempoEnd = 'slow' | 'upbeat';
/** The gears a logged-out singer has, at either end. History needs a login, so it is left out. */
export const GEARS = ['difficulty', 'popularity', 'tempo'] as const;
export type Gear = (typeof GEARS)[number];
export const ERAS: Era[] = DECADES.map((d) => d.id);

const view = (patch: Partial<ResultsView>): ResultsView => ({ ...DEFAULT_VIEW, ...patch });

export const VIEWS = {
  /** What a logged-out singer sees first. */
  default: (ms: Match[], r: VocalRange) => viewMatches(ms, view({}), r, 'catalogue'),
  /** Difficulty all the way to Locked in. */
  maxDifficulty: (ms: Match[], r: VocalRange) => viewMatches(ms, view({ difficulty: 1 }), r, 'catalogue'),
  /** One era picked (null: none picked) and the tempo gear at one end. */
  eraTempo: (ms: Match[], r: VocalRange, era: Era | null, end: TempoEnd) =>
    viewMatches(ms, view({ decade: era, tempo: end === 'slow' ? 0 : 1 }), r, 'catalogue'),
  /** One era (or none) and one gear at one end. */
  eraGear: (ms: Match[], r: VocalRange, era: Era | null, gear: Gear, at: 0 | 1) =>
    viewMatches(ms, view({ decade: era, [gear]: at }), r, 'catalogue'),
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

/** The same song twice: same lead artist and the same title once version tags are gone. */
export const sameSongKey = (m: Match) => songKey(leadArtist(m.track.artist), m.track.title);

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

/**
 * Whether a song fits its end of the tempo gear, over every judge run: it fits only when every run
 * gave the end's label. A song the runs disagree on is flaky and counts as a miss.
 */
export function fitsEnd(labels: JudgeLabel[], end: TempoEnd): { fits: boolean; flaky: boolean } {
  const flaky = new Set(labels).size > 1;
  return { fits: labels.length > 0 && labels.every((l) => l === end), flaky };
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
  /** The catalogue's ranked matches for the range, as the API sends them (all=1). */
  matches: Match[];
}

export function checkRecognisable(t: RangeInput, billboard: Set<string>, facts: Map<string, SongFacts>): Check {
  const top = VIEWS.default(t.matches, t.test.range).slice(0, 20);
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
  const { matches, test } = t;
  const notes: string[] = [];
  const hardest = VIEWS.maxDifficulty(matches, test.range).length;
  if (hardest < 10) notes.push(`max difficulty: ${hardest} songs`);
  for (const era of [null, ...ERAS]) {
    for (const gear of GEARS) {
      for (const at of [0, 1] as const) {
        const n = VIEWS.eraGear(matches, test.range, era, gear, at).length;
        if (n === 0) notes.push(`${era ?? 'no era'} + ${gear} at ${at}: 0 songs`);
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
  const top = VIEWS.default(t.matches, t.test.range).slice(0, 50);
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
  const top = VIEWS.default(t.matches, t.test.range).slice(0, 20);
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

export function tempoLists(t: RangeInput): TempoList[] {
  const out: TempoList[] = [];
  for (const era of [null, ...ERAS]) {
    for (const end of ['slow', 'upbeat'] as const) {
      out.push({ range: t.test.id, era, end, songs: VIEWS.eraTempo(t.matches, t.test.range, era, end).slice(0, 20) });
    }
  }
  return out;
}

export interface TempoResult {
  list: TempoList;
  top10: number;
  top20: number;
  flaky: number;
  pass: boolean;
}

/**
 * 10/10 of the top 10 and 18/20 of the top 20 fit. A list shorter than 20 is held to the same share:
 * all of its first ten, and all but one in ten of the rest (the details name short lists). An empty list fails.
 */
export function judgeList(list: TempoList, labels: Map<string, JudgeLabel[]>): TempoResult {
  const fits = list.songs.map((m) => fitsEnd(labels.get(key(m)) ?? [], list.end));
  const n10 = Math.min(10, fits.length);
  const n20 = fits.length;
  const top10 = fits.slice(0, 10).filter((f) => f.fits).length;
  const top20 = fits.filter((f) => f.fits).length;
  const flaky = fits.filter((f) => f.flaky).length;
  // An empty list fails here too, not only under criterion 3.
  return { list, top10, top20, flaky, pass: n20 > 0 && top10 === n10 && top20 >= Math.ceil(n20 * 0.9) };
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
      (r) => `${r.list.era ?? 'any era'} ${r.list.end}${r.list.songs.length < 20 ? ` (only ${r.list.songs.length} songs)` : ''}: top 10 ${r.top10}/${Math.min(10, r.list.songs.length)}, top 20 ${r.top20}/${r.list.songs.length}${r.flaky ? `, ${r.flaky} flaky` : ''}`,
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
  2: '2. Tempo ends per era (LLM judge x3)',
  3: '3. Never empty',
  4: '4. Titles (top 50)',
  6: '6. Play (top 20 with a Deezer preview)',
};

export interface Report {
  title: string;
  checks: Check[];
  top10: { range: TestRange; songs: ReturnType<typeof brief>[] }[];
  tempoSample: { artist: string; title: string; year?: number; bpm?: number; era: string; end: TempoEnd; labels: JudgeLabel[] }[];
  /** Notes about the run (which database, model, what was skipped). */
  meta: string[];
}

export function topTen(t: RangeInput) {
  return VIEWS.default(t.matches, t.test.range).slice(0, 10).map(brief);
}

/** A fixed pseudo-random sample, so two runs on the same data pick the same songs for the human check. */
export function sample<T>(items: T[], n: number, seed = 52): T[] {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
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
    'Targets: 1 at least 15/20; 2 every era and end at 10/10 of the top 10 and 18/20 of the top 20; 3 max difficulty at least 10 and no empty era + gear combination; 4 zero version titles and duplicates; 6 at least 90%.',
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
  if (r.tempoSample.length) {
    lines.push('### Tempo: 20 songs for a human check', '', '| Song | Year | Era list | End | Stored bpm | Judge (3 runs) |', '|---|---|---|---|---|---|');
    for (const s of r.tempoSample) lines.push(`| ${s.artist} - ${s.title} | ${s.year ?? ''} | ${s.era} | ${s.end} | ${s.bpm ?? ''} | ${s.labels.join(', ')} |`);
  }
  return lines.join('\n') + '\n';
}
