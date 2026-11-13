// The one-song-one-row build (QWW-49) as a person reviews it: what a run would write, the numbers to
// check first, and the list for a set of ranges before and after. The build itself is
// songs/canonical.ts; scripts/song-titles.ts wires this to a database.

import type { Match, VocalRange } from '../contracts';
import { CATALOGUE_SIZE, catalogueTracks, loadCatalogue, recommendCatalogue, type CatalogueDeps } from '../server/catalogue';
import type { Store } from '../server/store';
import { MAX_RANGE_GAP, buildCanonical, gapOf, octaveApart, type CanonicalBuild, type CanonicalInput, type SongCanonical } from '../songs/canonical';
import { byCatalogueRank, pickCatalogue } from '../songs/score';
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
  /** What was stored when the plan was made, so a report can say what each changed record replaces. */
  stored: Map<string, SongCanonical>;
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
  return { build, changed, unchanged: build.records.length - changed.length, stored };
}

/** A song the list would show as a Maybe although a row of it is confident (QWW-62). */
export interface MaybeOnScreen {
  /** The row the list shows for the song. */
  onScreen: CanonicalInput;
  /** A confident row of the song: the one with the lowest key. */
  confident: CanonicalInput;
  /** Why: the row shown is itself a Maybe (the build's doing), or it is not among the rows the app reads and the first row that is, is a Maybe. */
  why: 'the row shown is a Maybe' | 'the row shown is outside the rows the app reads, so the list keeps the first row of the song that it does read';
}

/**
 * The songs the list would show as a Maybe although a row of the song is confident, for a mapping (the stored one or a planned one),
 * worked out the way the app works it out (server/catalogue.ts): it reads the `readSize` most popular rows and every Year-End row
 * (`pickCatalogue`, the cut itself), and applyCanonical shows the row the mapping names, or, when that row was not read, the
 * first row of the song that was. So a confident row the mapping shows still leaves the Maybe on screen when it ranks outside the
 * read. A song with no row among those read is not on the list at all. A record whose row is not among `inputs` is left out.
 * Sorted by the key of the row on screen.
 */
export function maybeOnScreen(inputs: CanonicalInput[], records: Iterable<SongCanonical>, readSize: number = CATALOGUE_SIZE): MaybeOnScreen[] {
  const byKey = new Map(inputs.map((i) => [i.key, i]));
  const read = new Set(pickCatalogue(inputs.map((i) => ({ key: i.key, rank: i.rank, charted: i.charted === true })), readSize).map((r) => r.key));
  const order = [...inputs].sort(byCatalogueRank);
  const songs = new Map<string, Set<CanonicalInput>>();
  for (const r of records) {
    const row = byKey.get(r.key);
    if (row) songs.set(r.canonicalKey, (songs.get(r.canonicalKey) ?? new Set()).add(row));
  }
  const out: MaybeOnScreen[] = [];
  for (const [shownKey, rows] of songs) {
    const shown = byKey.get(shownKey);
    if (!shown) continue;
    const onScreen = read.has(shownKey) ? shown : order.find((m) => rows.has(m) && read.has(m.key));
    const confident = [...rows].filter((m) => m.confidence !== 'low').sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))[0];
    if (!onScreen || onScreen.confidence !== 'low' || !confident) continue;
    out.push({ onScreen, confident, why: onScreen === shown ? 'the row shown is a Maybe' : 'the row shown is outside the rows the app reads, so the list keeps the first row of the song that it does read' });
  }
  return out.sort((a, b) => (a.onScreen.key < b.onScreen.key ? -1 : a.onScreen.key > b.onScreen.key ? 1 : 0));
}

/**
 * Rows hidden behind a row shown more than MAX_RANGE_GAP semitones from them, other than an octave fold (which is that far by
 * design). A group is held together by each row's distance to its most popular row, so when the row shown is another row, two
 * rows of the group can be further apart than that. `records` is a mapping, the stored one or a planned one.
 */
export function farFolded(inputs: CanonicalInput[], records: Iterable<SongCanonical>): { row: CanonicalInput; shown: CanonicalInput; gap: number }[] {
  const byKey = new Map(inputs.map((i) => [i.key, i]));
  const out: { row: CanonicalInput; shown: CanonicalInput; gap: number }[] = [];
  for (const r of records) {
    const row = byKey.get(r.key);
    const shown = byKey.get(r.canonicalKey);
    if (!row || !shown || r.canonicalKey === r.key) continue;
    const gap = gapOf(row, shown);
    if (gap > MAX_RANGE_GAP && !octaveApart(row, shown)) out.push({ row, shown, gap });
  }
  return out.sort((a, b) => (a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : 0));
}

/** Where each row stands in catalogue order, 1 the most popular: the app reads the first CATALOGUE_SIZE rows (and every Year-End song). */
function cataloguePositions(inputs: CanonicalInput[]): Map<string, number> {
  return new Map([...inputs].sort(byCatalogueRank).map((m, i) => [m.key, i + 1] as const));
}

const sourceName = (m: CanonicalInput) => (m.source === 'audio-full' ? 'recording' : m.source === 'note-file' ? 'note file' : 'source unknown');

/** Rows a dry run lists one by one; beyond this it says how many more there are. */
export const CHANGED_LISTED = 200;

/**
 * The rows a run would write, each with what it replaces: shown or folded into which row (with that row's range, source and
 * confidence as they are now, which for a row restored since the mapping was stored is not what they were then), or not
 * stored. A record that differs only in its text says which fields.
 */
function describeChanged(inputs: CanonicalInput[], plan: CanonicalPlan, limit: number): string[] {
  const byKey = new Map(inputs.map((i) => [i.key, i]));
  const look = (key: string) => {
    const m = byKey.get(key);
    return m ? `${m.low}-${m.high}, ${sourceName(m)}, confidence ${m.confidence ?? 'unknown'}` : 'row not measured';
  };
  const where = (r: SongCanonical | undefined) => (!r ? 'not stored' : r.canonicalKey === r.key ? `shown (${look(r.key)})` : `folded into ${r.canonicalKey} (${look(r.canonicalKey)})`);
  const fields = ['title', 'artist', 'method', 'reason', 'sourceTitle', 'sourceArtist'] as const;
  const lines = [`Rows this run would write (${plan.changed.length}${plan.changed.length > limit ? `, the first ${limit} listed` : ', all listed'}), with the ranges the rows have now:`];
  for (const r of plan.changed.slice(0, limit)) {
    const was = plan.stored.get(r.key);
    const same = was && was.canonicalKey === r.canonicalKey;
    lines.push(`  ${r.key}: ${same ? `same row shown, ${fields.filter((f) => was[f] !== r[f]).join(', ')} differ` : `${where(was)} -> ${where(r)}`}`);
  }
  return lines;
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
    `  ${octaves.length} groups hold rows an octave apart, folded into the better evidenced part (listed in full below).`,
    `  ${count('cleaned')} rows shown with a cleaned title or artist line, ${count('same')} shown as stored, ${folded} folded.`,
    `  Tags removed from titles: ${[...byKind].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}.`,
    `  To write: ${plan.changed.length} rows (${plan.unchanged} already stored and equal).`,
  ];
  const big = groups.filter((g) => g.members.length > 4);
  if (big.length) lines.push(`  CHECK: ${big.length} groups have more than 4 rows: ${big.slice(0, 5).map((g) => g.canonicalKey).join('; ')}`);
  // A Maybe over a confident row (QWW-62): what the list would show now against what it would show after this run. The row shown
  // carries the song's popularity, and the app reads only the CATALOGUE_SIZE most popular rows (and Year-End rows), so a confident
  // row that ranks outside that is not loaded and the song keeps the Maybe it was.
  const maybeNow = plan.stored.size ? maybeOnScreen(inputs, plan.stored.values()) : [];
  const maybeAfter = maybeOnScreen(inputs, records);
  lines.push(`  CHECK: songs the list would show as a Maybe although a row folded into them is confident: ${plan.stored.size ? `${maybeNow.length} stored now` : 'none stored yet'}, ${maybeAfter.length} after this run${maybeAfter.length ? ' (each listed below: its confident row will not show until it ranks inside the rows the app reads)' : ''}.`);
  const position = cataloguePositions(inputs);
  const read = new Set(pickCatalogue(inputs.map((i) => ({ key: i.key, rank: i.rank, charted: i.charted === true })), CATALOGUE_SIZE).map((r) => r.key));
  const standing = (m: CanonicalInput) =>
    `popularity ${m.rank < 0 ? 'unknown' : m.rank.toFixed(2)}, catalogue position ${position.get(m.key)}${m.charted ? ', Year-End' : ''}${read.has(m.key) ? '' : `, outside the ${CATALOGUE_SIZE} read`}`;
  const describeMaybe = (when: string, { onScreen, confident, why }: MaybeOnScreen) =>
    `      ${when}: ${onScreen.artist} - ${onScreen.title} [${onScreen.key}] shows ${onScreen.low}-${onScreen.high} (${sourceName(onScreen)}, low; ${standing(onScreen)}); confident: [${confident.key}] ${confident.low}-${confident.high} (${sourceName(confident)}; ${standing(confident)}); ${why}`;
  for (const m of maybeNow.slice(0, 30)) lines.push(describeMaybe('stored now', m));
  for (const m of maybeAfter.slice(0, 50)) lines.push(describeMaybe('after this run', m));
  // Rows hidden behind a row more than MAX_RANGE_GAP away: the rows a run newly puts there are listed.
  const farNow = plan.stored.size ? farFolded(inputs, plan.stored.values()) : [];
  const farAfter = farFolded(inputs, records);
  const farBefore = new Set(farNow.map((f) => `${f.row.key}>${f.shown.key}`));
  lines.push(`  CHECK: rows folded into a row more than ${MAX_RANGE_GAP} semitones from them, other than an octave fold: ${plan.stored.size ? `${farNow.length} stored now` : 'none stored yet'}, ${farAfter.length} after this run (a row listed below is hidden behind a row it was not hidden behind).`);
  for (const { row, shown, gap } of farAfter.filter((f) => !farBefore.has(`${f.row.key}>${f.shown.key}`)).slice(0, 30)) {
    lines.push(`      new: ${row.artist} - ${row.title} [${row.key}] ${row.low}-${row.high} is hidden behind [${shown.key}] ${shown.low}-${shown.high}, ${gap} semitones off`);
  }
  lines.push('', ...describeChanged(inputs, plan, CHANGED_LISTED));
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
  // Every octave group, not a sample: each one hides a row from the singers it fits, so each is read. The evidence is
  // printed as stored, beside the trust it came to.
  const evidence = (m: CanonicalInput) => `${sourceName(m)}, octaveFrom ${m.octaveFrom ?? 'none'}, confidence ${m.confidence ?? 'unknown'}, trust ${m.trust}`;
  const octaveByPopularity = [...octaves].sort((a, b) => Math.max(...b.members.map((m) => m.rank)) - Math.max(...a.members.map((m) => m.rank)));
  lines.push('', `Rows an octave apart folded into the better evidenced part (all ${octaves.length}, most popular first); => marks the row shown:`);
  for (const g of octaveByPopularity) {
    for (const m of g.members) lines.push(`      ${m.key === g.canonicalKey ? '=>' : '  '} ${m.artist} - ${m.title} (${m.low}-${m.high}, ${evidence(m)})  [${m.key}]`);
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
