// The one-song-one-row build (QWW-49) as a person reviews it: what a run would write, the numbers to
// check first, and the list for a set of ranges before and after. The build itself is
// songs/canonical.ts; scripts/song-titles.ts wires this to a database.

import type { Match, VocalRange } from '../contracts';
import { catalogueTracks, loadCatalogue, recommendCatalogue, type CatalogueDeps } from '../server/catalogue';
import type { Store } from '../server/store';
import { MAX_RANGE_GAP, buildCanonical, type CanonicalBuild, type CanonicalInput, type SongCanonical } from '../songs/canonical';
import { cleanTitle, foldKey, hasVersionTag, type TagKind } from '../songs/title';

/**
 * The five test ranges of the release eval harness (QWW-52, `TEST_RANGES` in src/lib/eval/release.ts), as the test
 * screen would record them, so this report's lists are the ones the harness grades: Quinn-Wai's own range as the low
 * male voice, a high male, a low female and a high female voice, and a narrow beginner. Midi numbers, C4 = 60.
 */
export const TEST_RANGES: [string, VocalRange][] = [
  ['low male (F2 to C5, Quinn-Wai)', { low: 41, high: 72, source: 'test' }],
  ['high male (C3 to C5)', { low: 48, high: 72, source: 'test' }],
  ['low female (F3 to F5)', { low: 53, high: 77, source: 'test' }],
  ['high female (A3 to A5)', { low: 57, high: 81, source: 'test' }],
  ['narrow beginner (G3 to A4)', { low: 55, high: 69, source: 'test' }],
];

export interface CanonicalPlan {
  build: CanonicalBuild;
  /** The records that are not stored yet or differ from the stored ones: all a run has to write. */
  changed: SongCanonical[];
  /** How many of the build's records were stored already, equal. */
  unchanged: number;
}

export const sameRecord = (a: SongCanonical, b: SongCanonical | undefined) =>
  !!b &&
  a.canonicalKey === b.canonicalKey &&
  a.title === b.title &&
  a.artist === b.artist &&
  a.method === b.method &&
  a.reason === b.reason &&
  a.sourceTitle === b.sourceTitle &&
  a.sourceArtist === b.sourceArtist;

/** Builds the mapping for `inputs` and compares it with what is `stored`. */
export function planCanonical(inputs: CanonicalInput[], stored: Map<string, SongCanonical>): CanonicalPlan {
  const build = buildCanonical(inputs);
  const changed = build.records.filter((r) => !sameRecord(r, stored.get(r.key)));
  return { build, changed, unchanged: build.records.length - changed.length };
}

/**
 * Writes the changed records in batches, in key order. A run that stops partway is finished by running
 * it again: the plan then only holds what is still missing.
 */
export async function writePlan(
  store: Pick<Store, 'putSongCanonical'>,
  plan: CanonicalPlan,
  opts: { batch?: number; onBatch?: (done: number, total: number) => void } = {},
): Promise<void> {
  const batch = opts.batch ?? 500;
  for (let i = 0; i < plan.changed.length; i += batch) {
    await store.putSongCanonical(plan.changed.slice(i, i + batch));
    opts.onBatch?.(Math.min(i + batch, plan.changed.length), plan.changed.length);
  }
}

/** The numbers to read before applying a plan, as lines of text. */
export function summarizePlan(inputs: CanonicalInput[], plan: CanonicalPlan, samples = 25): string[] {
  const { records, groups } = plan.build;
  const count = (reason: SongCanonical['reason']) => records.filter((r) => r.reason === reason).length;
  const byKind = new Map<TagKind, number>();
  const tagText = new Map<string, number>();
  for (const i of inputs) {
    for (const t of cleanTitle(i.title).removed) {
      byKind.set(t.kind, (byKind.get(t.kind) ?? 0) + 1);
      if (t.kind !== 'duet' && t.kind !== 'tv') tagText.set(`${t.kind}: ${t.text.toLowerCase()}`, (tagText.get(`${t.kind}: ${t.text.toLowerCase()}`) ?? 0) + 1);
    }
  }
  // The brackets and dash tails still in the shown titles: real subtitles, and any tag the rules do not know.
  const kept = new Map<string, number>();
  const shownTitle = new Map(records.map((r) => [r.key, r.title]));
  for (const i of inputs) {
    const title = shownTitle.get(i.key) ?? i.title;
    for (const m of title.matchAll(/\(([^()]*)\)|\[([^[\]]*)\]/g)) kept.set((m[1] ?? m[2] ?? '').trim(), (kept.get((m[1] ?? m[2] ?? '').trim()) ?? 0) + 1);
  }
  const folded = count('folded');
  const alternates = groups.filter((g) => g.alternate);
  const octaves = groups.filter((g) => g.octave);
  const sizes = new Map<number, number>();
  for (const g of groups) sizes.set(g.members.length, (sizes.get(g.members.length) ?? 0) + 1);
  const row = (m: { key: string; artist: string; title: string; rank: number }, shown: boolean) => `      ${shown ? '=>' : '  '} ${m.artist} - ${m.title}  [${m.key}] (popularity ${m.rank < 0 ? 'unknown' : m.rank.toFixed(2)})`;
  const lines = [
    `${inputs.length} measured songs -> ${inputs.length - folded} after folding.`,
    `  ${folded} rows folded into another row of the same song, in ${groups.length} groups (sizes: ${[...sizes].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${c} of ${n}`).join(', ') || 'none'}).`,
    `  ${alternates.length} groups show an alternate version because it is clearly more popular than the main one.`,
    `  ${octaves.length} groups hold rows an octave apart, folded into the row measured from a recording or corrected from one.`,
    `  ${count('cleaned')} rows shown with a cleaned title or artist line, ${count('same')} shown as stored, ${folded} folded.`,
    `  Tags removed from titles: ${[...byKind].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}.`,
    `  To write: ${plan.changed.length} rows (${plan.unchanged} already stored and equal).`,
  ];
  const big = groups.filter((g) => g.members.length > 4);
  if (big.length) lines.push(`  CHECK: ${big.length} groups have more than 4 rows: ${big.slice(0, 5).map((g) => g.canonicalKey).join('; ')}`);
  lines.push('', `Most common tags removed (${Math.min(30, tagText.size)} of ${tagText.size} kinds of text):`);
  for (const [t, n] of [...tagText].sort((a, b) => b[1] - a[1]).slice(0, 30)) lines.push(`  ${String(n).padStart(4)}  ${t}`);
  lines.push('', `Brackets still in shown titles (${kept.size} different; the most common 30, to check for tags the rules do not know):`);
  for (const [t, n] of [...kept].sort((a, b) => b[1] - a[1]).slice(0, 30)) lines.push(`  ${String(n).padStart(4)}  (${t})`);
  const apart = [...plan.build.apart].sort((x, y) => Math.max(...y.parts.map((m) => m.rank)) - Math.max(...x.parts.map((m) => m.rank)));
  const octave = apart.filter((g) => g.gap >= 11 && g.gap <= 13).length;
  const note = (n: number) => (n % 12 === 0 ? `${n / 12} octave${n === 12 ? '' : 's'}` : `${n} semitones`);
  lines.push(
    '',
    `Kept as separate rows because their ranges disagree by more than ${MAX_RANGE_GAP} semitones at either end: ${apart.length} songs (${octave} about an octave apart). A singer both fit sees such a song twice; one it fits only one of is not shown the other. The most popular ${Math.min(10, apart.length)}:`,
  );
  for (const g of apart.slice(0, 10)) lines.push(`  ${g.parts.map((m) => `${m.artist} - ${m.title} (${m.low}-${m.high})`).join('  |  ')}  [${note(g.gap)} apart]`);
  const trustName = ['note file', 'corrected note file', 'recording'] as const;
  const octaveByPopularity = [...octaves].sort((a, b) => Math.max(...b.members.map((m) => m.rank)) - Math.max(...a.members.map((m) => m.rank)));
  lines.push('', `Rows an octave apart folded into the better evidenced row (${Math.min(10, octaves.length)} of ${octaves.length}, most popular first); => marks the row shown:`);
  for (const g of octaveByPopularity.slice(0, 10)) {
    for (const m of g.members) lines.push(`      ${m.key === g.canonicalKey ? '=>' : '  '} ${m.artist} - ${m.title} (${m.low}-${m.high}, ${trustName[m.trust]})  [${m.key}]`);
    lines.push('');
  }
  const byPopularity = [...groups].sort((a, b) => Math.max(...b.members.map((m) => m.rank)) - Math.max(...a.members.map((m) => m.rank)));
  lines.push('', `Folded songs, most popular first (${Math.min(samples, groups.length)} of ${groups.length}); => marks the row shown:`);
  for (const g of byPopularity.slice(0, samples)) {
    lines.push(`  ${g.members.length} rows${g.alternate ? ' (alternate shown)' : ''}:`);
    for (const m of g.members) lines.push(row(m, m.key === g.canonicalKey));
  }
  if (alternates.length) {
    lines.push('', 'Groups where an alternate version is shown:');
    for (const g of alternates.slice(0, samples)) for (const m of g.members) lines.push(row(m, m.key === g.canonicalKey));
  }
  return lines;
}

/** `store` with the one-song-one-row mapping replaced by `records` (none = how the list was before the build). */
function withMapping(store: Store, records: SongCanonical[]): Store {
  const byKey = new Map(records.map((r) => [r.key, r]));
  return {
    ...store,
    getSongCanonical: async (keys: string[]) => new Map(keys.flatMap((k) => (byKey.has(k) ? [[k, byKey.get(k)!] as const] : []))),
  };
}

/** The reads that do not depend on the mapping, done once: the cut of the catalogue and the numbers behind it. */
function memoized(store: Store): Store {
  let listed: ReturnType<Store['listCatalogue']> | undefined;
  return { ...store, listCatalogue: (limit: number) => (listed ??= store.listCatalogue(limit)) };
}

export interface RangeLists {
  label: string;
  range: VocalRange;
  before: Match[];
  after: Match[];
}

/**
 * The logged-out list for each range, as the app builds it: once with no mapping (today's list) and
 * once with `records` applied. Reads the store only.
 */
export async function listsBeforeAfter(
  store: Store,
  records: SongCanonical[],
  deps: CatalogueDeps,
  ranges: [string, VocalRange][] = TEST_RANGES,
): Promise<RangeLists[]> {
  const shared = memoized(store);
  const before = catalogueTracks(await loadCatalogue(withMapping(shared, []), undefined, { canonical: true }));
  const after = catalogueTracks(await loadCatalogue(withMapping(shared, records), undefined, { canonical: true }));
  return ranges.map(([label, range]) => ({
    label,
    range,
    before: recommendCatalogue(before, range, deps, { all: true }).matches,
    after: recommendCatalogue(after, range, deps, { all: true }).matches,
  }));
}

export interface ListCheck {
  /** Rows (1-based positions) whose title still carries a version tag the rules know. */
  tagged: number[];
  /** Groups of positions showing the same song: same artist line and title as far as the fold rules see. */
  duplicates: number[][];
  /**
   * Groups the fold rules keep apart that a person may still read as one song: the same title and the
   * same lead artist, ignoring every bracket. Looser than the rules on purpose, written separately from
   * them, and for a person to look at: not part of the pass/fail.
   */
  near: number[][];
}

const plainKey = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
const nearLead = (artist: string) => artist.split(/\s+(?:feat\.?|ft\.?|featuring|&|and|vs\.?|x|\+)\s+|,/i)[0] ?? artist;

/** What is wrong in the first `window` rows of a list. */
export function checkList(matches: Match[], window: number): ListCheck {
  const rows = matches.slice(0, window);
  const group = (key: (m: Match) => string | null) => {
    const seen = new Map<string, number[]>();
    rows.forEach((m, i) => {
      const k = key(m);
      if (k) seen.set(k, [...(seen.get(k) ?? []), i + 1]);
    });
    return [...seen.values()].filter((g) => g.length > 1);
  };
  const duplicates = group((m) => foldKey(m.track.artist, m.track.title));
  const strict = new Set(duplicates.flat());
  const near = group((m) => {
    const t = plainKey(m.track.title);
    const a = plainKey(nearLead(m.track.artist));
    return t && a ? `${a}|${t}` : null;
  }).filter((g) => !g.every((p) => strict.has(p)));
  return { tagged: rows.flatMap((m, i) => (hasVersionTag(m.track.title) ? [i + 1] : [])), duplicates, near };
}

const line = (m: Match | undefined) => (m ? `${m.track.artist} - ${m.track.title}`.replace(/\|/g, '\\|') : '');

/** The before and after lists as Markdown: a count table, then the first `top` rows of each range side by side. */
export function renderLists(lists: RangeLists[], top = 50, windows = [50, 200, 1000]): string {
  const out: string[] = ['# Titles and duplicates, before and after (QWW-49)', ''];
  out.push('Counts are rows with a version tag in the title (`tagged`) and groups showing one song more than once (`dup`), in the first N rows of the logged-out list.', '');
  out.push(`| range | ${windows.map((w) => `top ${w} before | top ${w} after`).join(' | ')} |`, `| --- | ${windows.map(() => '--- | ---').join(' | ')} |`);
  for (const l of lists) {
    const cells = windows.flatMap((w) => [l.before, l.after].map((ms) => {
      const c = checkList(ms, w);
      return `tagged ${c.tagged.length}, dup ${c.duplicates.length}`;
    }));
    out.push(`| ${l.label} | ${cells.join(' | ')} |`);
  }
  for (const l of lists) {
    const after = checkList(l.after, top);
    out.push('', `## ${l.label}`, '');
    if (after.near.length) out.push(`Near-duplicates the rules keep apart in the first ${top} (for a person to judge): ${after.near.map((g) => g.map((p) => `#${p} ${line(l.after[p - 1])}`).join(' / ')).join('; ')}`, '');
    out.push('| # | before | after |', '| --- | --- | --- |');
    for (let i = 0; i < top; i++) {
      const b = line(l.before[i]);
      const a = line(l.after[i]);
      out.push(`| ${i + 1} | ${b} | ${a === b ? a : `**${a}**`} |`);
    }
  }
  return out.join('\n') + '\n';
}
